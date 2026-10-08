pub(crate) mod launch;
pub(crate) mod managed_client;

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::Serialize;
use uuid::Uuid;

use crate::config::{InstanceRole, LoadedBlockwrightConfig, WorldPreset};
use crate::coverage;
use crate::mods;
use crate::neoforge::{self, NeoForgeRuntimeRequirements, ResolvedNeoForgeVersions};
use crate::registry;
use crate::store::{self, cache, StoreLock};

/// Runs blocking filesystem or process work off the async worker threads.
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .context("blocking task panicked")?
}

pub(crate) fn apply_world_preset(props: &mut BTreeMap<String, String>, world: WorldPreset) {
    let Some((level_type, generator_settings)) = world.server_properties() else {
        return;
    };
    if props.contains_key("level-type") || props.contains_key("generator-settings") {
        tracing::warn!(
            ?world,
            "server.properties already sets level-type/generator-settings explicitly; \
             ignoring the `world` preset (explicit properties win)"
        );
        return;
    }
    props.insert("level-type".to_string(), level_type.to_string());
    props.insert(
        "generator-settings".to_string(),
        generator_settings.to_string(),
    );
}

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub role: InstanceRole,
    pub instance_name: Option<String>,
    /// Where the trace is written; defaults to `<trace.dir>/<instance id>.ndjson`.
    pub trace_path: Option<PathBuf>,
    pub control_endpoint: Option<String>,
    pub agent_mod_path: Option<PathBuf>,
    /// Launch into the instance dir as it is (files seeded into it, or what a previous launch
    /// left) instead of clearing it. The dir still goes away on close.
    pub reuse_instance_dir: bool,
    /// Reuse the instance dir and keep it past close and `blockwright gc`.
    pub keep_instance_dir: bool,
    /// Servers freeze their tick rate before the first tick; restarts reuse the same args.
    pub start_frozen: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchPlan {
    pub instance_id: String,
    pub role: InstanceRole,
    pub instance_dir: PathBuf,
    pub trace_path: PathBuf,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub mods: Vec<String>,
    pub resolved: ResolvedNeoForgeVersions,
    pub requirements: NeoForgeRuntimeRequirements,
    pub warnings: Vec<String>,
    pub server_port_file: Option<PathBuf>,
}

/// Where a server launched without a fixed `server-port` records the port it bound, since only
/// the server itself knows it: it binds port 0 so no other launch can take the port first.
pub fn server_port_file(instance_dir: &Path) -> PathBuf {
    instance_dir.join("blockwright-server-port")
}

pub(crate) struct LaunchCommand {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub server_port_file: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
}

/// What a launch holds from before its instance dir is cleared until the instance is
/// registered: the store, shared, so a gc cannot take the dir as abandoned in between; and the
/// instance dir, exclusively, so a second launch under the same instance name cannot fill it at
/// the same time (the registry only covers it once the first one is registered).
pub struct LaunchLock {
    _store: StoreLock,
    _instance: fs::File,
}

impl LaunchLock {
    fn acquire(store_dir: &Path, instance_dir: &Path) -> Result<Self> {
        let store = StoreLock::shared(store_dir)?;
        let parent = instance_dir.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
        let name = instance_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let path = parent.join(format!(".{name}.lock"));
        let Some(instance) = store::flock(&path, libc::LOCK_EX | libc::LOCK_NB)? else {
            anyhow::bail!(
                "another launch is already filling {}; wait for it, or launch under another \
                 instance name",
                instance_dir.display()
            );
        };
        Ok(Self {
            _store: store,
            _instance: instance,
        })
    }
}

/// Lays out an instance dir for one role and returns how to start the game in it. The launch
/// lock comes back with the plan; hold it until the instance is registered.
pub async fn prepare_launch(
    loaded: &LoadedBlockwrightConfig,
    options: LaunchOptions,
) -> Result<(LaunchPlan, LaunchLock)> {
    let config = &loaded.config;
    let neoforge_config = &config.neoforge;
    let role = options.role;
    if role == InstanceRole::Server && !neoforge_config.server.eula {
        anyhow::bail!("Minecraft EULA acceptance is required: read https://www.minecraft.net/eula and set [neoforge.server] eula = true in your config to accept it");
    }

    let instance_id = format!("neoforge-{}-{}", role.as_str(), Uuid::new_v4());
    let instance_name = options
        .instance_name
        .clone()
        .or_else(|| neoforge_config.instance_name.clone())
        .unwrap_or_else(|| format!("neoforge-{}", role.as_str()));
    let store_dir = loaded.store_dir();
    let instance_dir = loaded
        .resolve_path(&neoforge_config.instances_dir)
        .join(store::sanitize_name(&instance_name));
    let (lock_dir, locked_dir) = (store_dir.clone(), instance_dir.clone());
    let lock = blocking(move || LaunchLock::acquire(&lock_dir, &locked_dir)).await?;
    refuse_running_instance_dir(&instance_dir)?;
    if !(options.reuse_instance_dir || options.keep_instance_dir) && instance_dir.exists() {
        let doomed = instance_dir.clone();
        blocking(move || {
            fs::remove_dir_all(&doomed)
                .with_context(|| format!("failed to clear instance dir {}", doomed.display()))
        })
        .await?;
    }
    fs::create_dir_all(&instance_dir)
        .with_context(|| format!("failed to create instance dir {}", instance_dir.display()))?;
    store::gc::mark_kept(&instance_dir, options.keep_instance_dir)?;

    let trace_path = options.trace_path.clone().unwrap_or_else(|| {
        loaded
            .resolve_path(&config.trace.dir)
            .join(format!("{instance_id}.ndjson"))
    });
    let resolved = neoforge::resolve_versions(neoforge_config).await?;
    let requirements = neoforge::runtime_requirements(neoforge_config, &resolved);
    let mut warnings = Vec::new();

    let runtime_key = format!(
        "{}-{}-{}",
        role.as_str(),
        resolved.minecraft_version,
        resolved.loader_version
    );
    let runtime = ensure_runtime(loaded, role, &resolved, &store_dir, &runtime_key)
        .await
        .context("failed to install the NeoForge runtime")?;
    let mods = instance_mods(loaded, &options, &store_dir, &mut warnings).await?;
    let coverage = coverage::prepare_launch(loaded, &store_dir, &instance_id, role)
        .await
        .context("failed to set up coverage")?;
    let mut keys: Vec<String> = mods.iter().map(|file| file.hash.key()).collect();
    keys.push(runtime_key);
    if let Some(coverage) = &coverage {
        keys.extend(coverage.store_keys.iter().cloned());
    }
    store::record_refs(
        &store_dir,
        &loaded.path,
        &loaded.refs_label(role.as_str()),
        keys,
    )
    .context("failed to record which store entries this config uses")?;

    let mod_names = mods.iter().map(|file| file.filename.clone()).collect();
    let target = instance_dir.clone();
    blocking(move || {
        cache::link_tree(&runtime, &target, runtime_placement)?;
        for file in &mods {
            cache::place(&file.path, &target.join("mods").join(&file.filename))?;
        }
        Ok(())
    })
    .await
    .context("failed to fill the instance dir")?;

    if role == InstanceRole::Client {
        ensure_client_options_defaults(&instance_dir, &neoforge_config.client.options)
            .context("failed to seed client options.txt defaults")?;
    }
    let launch = launch::seed_and_launch(
        loaded,
        &options,
        &instance_id,
        &instance_dir,
        &resolved,
        coverage.as_ref().map(|coverage| coverage.jvm_arg.as_str()),
    )
    .context("failed to seed instance files and build launch command")?;

    let mut env = BTreeMap::from([
        ("BLOCKWRIGHT_INSTANCE_ID".to_string(), instance_id.clone()),
        ("BLOCKWRIGHT_ROLE".to_string(), role.as_str().to_string()),
        (
            "BLOCKWRIGHT_GAME_DIR".to_string(),
            instance_dir.display().to_string(),
        ),
    ]);
    if let Some(endpoint) = &options.control_endpoint {
        env.insert("BLOCKWRIGHT_CONTROL_ENDPOINT".to_string(), endpoint.clone());
    }
    env.extend(launch.env);

    let plan = LaunchPlan {
        instance_id,
        role,
        instance_dir,
        trace_path,
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env,
        mods: mod_names,
        resolved,
        requirements,
        warnings,
        server_port_file: launch.server_port_file,
    };
    Ok((plan, lock))
}

/// The configured mods that go into this role, then the agent mod.
async fn instance_mods(
    loaded: &LoadedBlockwrightConfig,
    options: &LaunchOptions,
    store_dir: &Path,
    warnings: &mut Vec<String>,
) -> Result<Vec<cache::CachedFile>> {
    let cache = cache::Cache::new(store_dir);
    let names: Vec<&str> = loaded
        .config
        .mods
        .iter()
        .filter(|(_, spec)| spec.installs_on(options.role))
        .map(|(name, _)| name.as_str())
        .collect();
    let mut resolved = mods::resolve(loaded, &cache, &names).await?;
    let mut files: Vec<cache::CachedFile> = names
        .iter()
        .flat_map(|name| resolved.remove(*name).unwrap_or_default())
        .collect();
    match launch::resolve_agent_mod_path(loaded, options) {
        Some(path) if path.exists() => files.push(mods::local(&cache, &path).await?),
        Some(path) => warnings.push(format!(
            "NeoForge agent mod not found at {}; check neoforge.agent_mod",
            path.display()
        )),
        None => warnings.push("NeoForge agent mod not found; set neoforge.agent_mod".to_string()),
    }
    Ok(files)
}

fn refuse_running_instance_dir(instance_dir: &Path) -> Result<()> {
    let root = std::env::current_dir().context("failed to resolve current directory")?;
    if let Some(record) = registry::list(&root)
        .into_iter()
        .find(|record| record.instance_dir == instance_dir)
    {
        anyhow::bail!(
            "instance {} (pid {}) is still running in {}; close the session that owns it, or \
             launch under another instance name",
            record.instance_id,
            record.pid,
            instance_dir.display()
        );
    }
    Ok(())
}

/// The installed runtime (loader, libraries, assets) a role launches from, built once per
/// Minecraft and loader version and shared by every instance through hardlinks.
async fn ensure_runtime(
    loaded: &LoadedBlockwrightConfig,
    role: InstanceRole,
    resolved: &ResolvedNeoForgeVersions,
    store_dir: &Path,
    key: &str,
) -> Result<PathBuf> {
    let root = store_dir.join(store::RUNTIME_DIR);
    let dir = root.join(key);
    if dir.is_dir() {
        let check = dir.clone();
        if blocking(move || Ok(adopt_runtime(&check))).await? {
            return Ok(dir);
        }
        // Instances linked to the damaged copy keep their inodes; the name goes to a rebuild.
        tracing::warn!(
            runtime = %dir.display(),
            "runtime has truncated or missing files; rebuilding it"
        );
        let trash = root.join(format!(".trash-{}", Uuid::new_v4()));
        if fs::rename(&dir, &trash).is_ok() {
            let _ = blocking(move || Ok(fs::remove_dir_all(&trash)?)).await;
        }
    }
    let staging = root.join(format!(".staging-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging)
        .with_context(|| format!("failed to create {}", staging.display()))?;
    let built = async {
        let installer = neoforge::ensure_installer(store_dir, resolved).await?;
        launch::install_runtime(
            &loaded.config.neoforge,
            role,
            resolved,
            &installer,
            &staging,
        )
        .await?;
        let sealing = staging.clone();
        blocking(move || seal_runtime(&sealing)).await
    }
    .await;
    // A concurrent launch may have published the same runtime first; either copy will do.
    let published = built.and_then(|()| match fs::rename(&staging, &dir) {
        Err(_) if dir.is_dir() => Ok(()),
        other => other.with_context(|| format!("failed to publish {}", dir.display())),
    });
    let _ = fs::remove_dir_all(&staging);
    published.map(|()| dir)
}

/// Where a runtime records the size of every file it was published with.
const RUNTIME_MANIFEST: &str = ".blockwright/runtime-manifest.json";

/// How a runtime file goes into an instance. The installed trees are shared by hardlink; the
/// loose files beside them (`user_jvm_args.txt`, `run.sh`, `launcher_profiles.json`, installer
/// logs, markers) are small and meant to be edited, so each instance gets its own copy.
fn runtime_placement(rel: &Path) -> cache::Placement {
    const SHARED: [&str; 3] = ["libraries", "versions", "assets"];
    if rel == Path::new(RUNTIME_MANIFEST) {
        return cache::Placement::Skip;
    }
    let mut parts = rel.components();
    let top = parts.next().map(|part| part.as_os_str());
    if parts.next().is_some() && SHARED.iter().any(|dir| top == Some(dir.as_ref())) {
        cache::Placement::Link
    } else {
        cache::Placement::Copy
    }
}

/// Makes every file of a runtime read-only, the way cache entries are, and records their sizes.
/// Instances hardlink these files, so a write through any of those links would change every
/// instance and the store at once; read-only, such a write fails where it happens instead.
fn seal_runtime(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut sizes = BTreeMap::new();
    for entry in walkdir::WalkDir::new(dir) {
        let entry = entry.with_context(|| format!("failed to walk {}", dir.display()))?;
        let rel = entry.path().strip_prefix(dir)?;
        if !entry.file_type().is_file() || rel == Path::new(RUNTIME_MANIFEST) {
            continue;
        }
        let meta = entry.metadata()?;
        let mode = meta.permissions().mode() & 0o555;
        fs::set_permissions(entry.path(), fs::Permissions::from_mode(mode))
            .with_context(|| format!("failed to make {} read-only", entry.path().display()))?;
        sizes.insert(rel.to_string_lossy().into_owned(), meta.len());
    }
    let manifest = dir.join(RUNTIME_MANIFEST);
    if let Some(parent) = manifest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    cache::write_replacing(&manifest, serde_json::to_vec(&sizes)?)?;
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o444))
        .with_context(|| format!("failed to make {} read-only", manifest.display()))
}

/// Whether a published runtime can be linked from: every file it was sealed with is there at
/// its recorded size. A runtime published before sealing existed has no manifest; it is sealed
/// now unless it has empty files, which is what a write through a shared link left behind.
fn adopt_runtime(dir: &Path) -> bool {
    let manifest = match fs::read(dir.join(RUNTIME_MANIFEST)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let truncated = walkdir::WalkDir::new(dir)
                .into_iter()
                .flatten()
                .filter(|entry| entry.file_type().is_file())
                .any(|entry| entry.metadata().is_ok_and(|meta| meta.len() == 0));
            return !truncated && seal_runtime(dir).is_ok();
        }
        Err(_) => return false,
    };
    let Ok(sizes) = serde_json::from_slice::<BTreeMap<String, u64>>(&manifest) else {
        return false;
    };
    sizes.iter().all(|(rel, len)| {
        fs::symlink_metadata(dir.join(rel)).is_ok_and(|meta| meta.is_file() && meta.len() == *len)
    })
}

fn ensure_client_options_defaults(
    game_dir: &Path,
    requested: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let path = game_dir.join("options.txt");
    let mut body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err).with_context(|| format!("failed to read {}", path.display())),
    };

    let mut defaults: std::collections::BTreeMap<String, String> =
        [("pauseOnLostFocus".to_string(), "false".to_string())]
            .into_iter()
            .collect();
    for (key, value) in requested {
        defaults.insert(key.clone(), value.clone());
    }

    let mut changed = false;
    for (key, value) in &defaults {
        let present = body.lines().any(|line| {
            line.split_once(':')
                .map(|(k, _)| k.trim() == key.as_str())
                .unwrap_or(false)
        });
        if present {
            continue;
        }
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(key);
        body.push(':');
        body.push_str(value);
        body.push('\n');
        changed = true;
    }

    if !changed && path.exists() {
        return Ok(());
    }
    cache::write_replacing(&path, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn runtime_trees_are_linked_and_loose_files_copied() {
        use cache::Placement::{Copy, Link, Skip};
        for (rel, expected) in [
            (
                "libraries/net/neoforged/neoforge/21.1.1/unix_args.txt",
                Link,
            ),
            ("versions/1.21.1/1.21.1.jar", Link),
            ("assets/objects/ab/abcdef", Link),
            ("user_jvm_args.txt", Copy),
            ("launcher_profiles.json", Copy),
            ("libraries", Copy),
            (".blockwright/neoforge-client-21.1.1.installed", Copy),
            (RUNTIME_MANIFEST, Skip),
        ] {
            assert_eq!(runtime_placement(Path::new(rel)), expected, "{rel}");
        }
    }

    #[test]
    fn a_sealed_runtime_is_read_only_and_checks_out_until_a_file_is_truncated() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("runtime-seal");
        tmp.write("runtime/libraries/a.jar", "library");
        tmp.write("runtime/run.sh", "#!/bin/sh");
        let dir = tmp.path().join("runtime");
        fs::set_permissions(dir.join("run.sh"), fs::Permissions::from_mode(0o775)).unwrap();

        seal_runtime(&dir).unwrap();

        let mode = |rel: &str| fs::metadata(dir.join(rel)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("libraries/a.jar"), 0o444);
        assert_eq!(mode("run.sh"), 0o555, "the exec bits stay");
        let root = unsafe { libc::geteuid() } == 0;
        assert!(root || fs::write(dir.join("libraries/a.jar"), b"").is_err());
        assert!(adopt_runtime(&dir));

        // What a copy through a shared link left behind: the same name, zero bytes.
        fs::remove_file(dir.join("libraries/a.jar")).unwrap();
        fs::write(dir.join("libraries/a.jar"), b"").unwrap();
        assert!(!adopt_runtime(&dir));
    }

    #[test]
    fn a_runtime_from_before_sealing_is_adopted_unless_it_has_empty_files() {
        let tmp = TempDir::new("runtime-legacy");
        tmp.write("clean/libraries/a.jar", "library");
        tmp.write("damaged/libraries/a.jar", "library");
        tmp.write("damaged/libraries/b.jar", "");
        let (clean, damaged) = (tmp.path().join("clean"), tmp.path().join("damaged"));

        assert!(adopt_runtime(&clean));
        assert!(clean.join(RUNTIME_MANIFEST).is_file(), "adopting seals it");
        assert!(!adopt_runtime(&damaged));
    }

    #[test]
    fn a_second_launch_cannot_fill_an_instance_dir_another_is_filling() {
        let tmp = TempDir::new("launch-lock");
        let (store, instance) = (
            tmp.path().join("store"),
            tmp.path().join("instances/client"),
        );

        let held = LaunchLock::acquire(&store, &instance).unwrap();
        let error = LaunchLock::acquire(&store, &instance)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("already filling"), "{error}");
        LaunchLock::acquire(&store, &tmp.path().join("instances/other")).unwrap();

        drop(held);
        // Other tests fork children; one can hold a copy of the lock's fd until it execs.
        let retry = std::iter::repeat_with(|| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            LaunchLock::acquire(&store, &instance)
        });
        assert!(
            retry.take(50).any(|lock| lock.is_ok()),
            "the lock outlives its holder"
        );
    }

    #[test]
    fn apply_world_preset_vanilla_injects_nothing() {
        let mut props = BTreeMap::new();
        apply_world_preset(&mut props, WorldPreset::Vanilla);
        assert!(props.is_empty());
    }

    #[test]
    fn apply_world_preset_flat_injects_both_keys() {
        let mut props = BTreeMap::new();
        apply_world_preset(&mut props, WorldPreset::Flat);
        assert_eq!(
            props.get("level-type").map(String::as_str),
            Some("minecraft:flat")
        );
        assert_eq!(
            props.get("generator-settings").map(String::as_str),
            Some(
                r#"{"biome":"minecraft:the_void","features":false,"lakes":false,"layers":[{"block":"minecraft:bedrock","height":1}],"structure_overrides":[]}"#
            )
        );
    }

    #[test]
    fn apply_world_preset_void_injects_zero_layer_settings() {
        let mut props = BTreeMap::new();
        apply_world_preset(&mut props, WorldPreset::Void);
        assert_eq!(
            props.get("level-type").map(String::as_str),
            Some("minecraft:flat")
        );
        assert_eq!(
            props.get("generator-settings").map(String::as_str),
            Some(
                r#"{"biome":"minecraft:the_void","features":false,"lakes":false,"layers":[],"structure_overrides":[]}"#
            )
        );
    }

    #[test]
    fn explicit_level_type_wins_over_world_preset() {
        let mut props = BTreeMap::new();
        props.insert("level-type".to_string(), "minecraft:normal".to_string());
        apply_world_preset(&mut props, WorldPreset::Flat);
        assert_eq!(
            props.get("level-type").map(String::as_str),
            Some("minecraft:normal")
        );
        assert!(!props.contains_key("generator-settings"));
    }

    #[test]
    fn explicit_generator_settings_wins_over_world_preset() {
        let mut props = BTreeMap::new();
        props.insert("generator-settings".to_string(), "{}".to_string());
        apply_world_preset(&mut props, WorldPreset::Void);
        assert_eq!(
            props.get("generator-settings").map(String::as_str),
            Some("{}")
        );
        assert!(!props.contains_key("level-type"));
    }

    #[test]
    fn creates_options_with_pause_on_lost_focus_default() {
        let tmp = TempDir::new("fresh");
        let game = tmp.path().to_path_buf();
        ensure_client_options_defaults(&game, &BTreeMap::new()).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        assert_eq!(body, "pauseOnLostFocus:false\n");
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn appends_default_to_existing_options_without_key() {
        let tmp = TempDir::new("append");
        let game = tmp.path().to_path_buf();
        fs::write(game.join("options.txt"), "fov:1.0\nrenderDistance:8\n").unwrap();
        ensure_client_options_defaults(&game, &BTreeMap::new()).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        assert_eq!(body, "fov:1.0\nrenderDistance:8\npauseOnLostFocus:false\n");
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn preserves_user_explicit_pause_on_lost_focus() {
        let tmp = TempDir::new("preserve");
        let game = tmp.path().to_path_buf();
        fs::write(game.join("options.txt"), "fov:1.0\npauseOnLostFocus:true\n").unwrap();
        ensure_client_options_defaults(&game, &BTreeMap::new()).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        assert_eq!(
            body, "fov:1.0\npauseOnLostFocus:true\n",
            "user-set value must not be overwritten"
        );
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn appends_newline_before_default_when_file_lacks_trailing_newline() {
        let tmp = TempDir::new("nonewline");
        let game = tmp.path().to_path_buf();
        fs::write(game.join("options.txt"), "fov:1.0").unwrap();
        ensure_client_options_defaults(&game, &BTreeMap::new()).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        assert_eq!(body, "fov:1.0\npauseOnLostFocus:false\n");
        let _ = fs::remove_dir_all(&game);
    }
    #[test]
    fn seeds_configured_options_alongside_the_builtin_default() {
        let tmp = TempDir::new("configured");
        let game = tmp.path().to_path_buf();
        let requested = BTreeMap::from([
            ("guiScale".to_string(), "1".to_string()),
            ("fullscreen".to_string(), "false".to_string()),
        ]);
        ensure_client_options_defaults(&game, &requested).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        for line in ["pauseOnLostFocus:false", "guiScale:1", "fullscreen:false"] {
            assert!(body.contains(line), "{line} missing from {body:?}");
        }
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn configured_option_does_not_overwrite_an_existing_key() {
        let tmp = TempDir::new("configured-existing");
        let game = tmp.path().to_path_buf();
        fs::write(game.join("options.txt"), "guiScale:3\n").unwrap();
        let requested = BTreeMap::from([("guiScale".to_string(), "1".to_string())]);
        ensure_client_options_defaults(&game, &requested).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        assert!(body.contains("guiScale:3"), "{body:?}");
        assert!(!body.contains("guiScale:1"), "{body:?}");
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn configured_option_wins_over_the_builtin_default() {
        let tmp = TempDir::new("configured-builtin");
        let game = tmp.path().to_path_buf();
        let requested = BTreeMap::from([("pauseOnLostFocus".to_string(), "true".to_string())]);
        ensure_client_options_defaults(&game, &requested).expect("seed defaults");
        let body = fs::read_to_string(game.join("options.txt")).unwrap();
        assert_eq!(body, "pauseOnLostFocus:true\n");
        let _ = fs::remove_dir_all(&game);
    }
}
