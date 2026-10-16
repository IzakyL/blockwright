use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::{sync::Semaphore, task::JoinSet};
use uuid::Uuid;

use crate::config::{ClientAccountConfig, ClientConfig};

pub(crate) struct ClientLaunchMetadata {
    pub main_class: String,
    pub jvm_args: Vec<String>,
    pub game_args: Vec<String>,
}

pub(crate) async fn ensure_client_libraries(game_dir: &Path, version_id: &str) -> Result<()> {
    let mut version_chain = Vec::new();
    collect_version_chain(game_dir, version_id, &mut version_chain)?;
    let libraries_dir = game_dir.join("libraries");

    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    for json in &version_chain {
        for library in json
            .get("libraries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !rules_allow(library.get("rules")) {
                continue;
            }
            for artifact in library_artifacts(library) {
                let dest = libraries_dir.join(&artifact.path);
                if dest.exists() || !seen.insert(dest.clone()) {
                    continue;
                }
                let label = format!("client library {}", dest.display());
                pending.push(Download {
                    url: artifact.url,
                    dest,
                    label,
                });
            }
        }
    }

    download_all(pending).await
}

struct Download {
    url: String,
    dest: PathBuf,
    label: String,
}

/// Downloads every entry with bounded concurrency, failing on the first error.
async fn download_all(pending: Vec<Download>) -> Result<()> {
    const MAX_CONCURRENT: usize = 32;
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut join_set = JoinSet::new();

    for Download { url, dest, label } in pending {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        join_set.spawn(async move {
            let result = crate::http::download(&url, &dest)
                .await
                .with_context(|| format!("failed to download {label}"));
            drop(permit);
            result
        });
    }

    while let Some(result) = join_set.join_next().await {
        result.context("download task panicked")??;
    }
    Ok(())
}

pub(crate) async fn ensure_client_assets(game_dir: &Path, minecraft_version: &str) -> Result<()> {
    let vanilla_json_path = game_dir
        .join("versions")
        .join(minecraft_version)
        .join(format!("{minecraft_version}.json"));
    let vanilla_json = read_json_file(&vanilla_json_path)?;
    let Some(asset_index) = vanilla_json.get("assetIndex") else {
        return Ok(());
    };
    let Some(id) = asset_index.get("id").and_then(Value::as_str) else {
        return Ok(());
    };
    let index_path = game_dir
        .join("assets")
        .join("indexes")
        .join(format!("{id}.json"));

    if !index_path.exists() {
        let Some(url) = asset_index.get("url").and_then(Value::as_str) else {
            return Ok(());
        };
        crate::http::download(url, &index_path)
            .await
            .with_context(|| format!("failed to download Minecraft asset index from {url}"))?;
    }

    let index_json = read_json_file(&index_path)?;
    let Some(objects) = index_json.get("objects").and_then(Value::as_object) else {
        return Ok(());
    };

    let objects_dir = game_dir.join("assets").join("objects");
    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    for (_name, entry) in objects {
        let Some(hash) = entry.get("hash").and_then(Value::as_str) else {
            continue;
        };
        if hash.len() < 2 {
            continue;
        }
        let prefix = &hash[..2];
        let dest = objects_dir.join(prefix).join(hash);
        if dest.exists() || !seen.insert(hash) {
            continue;
        }
        pending.push(Download {
            url: format!("https://resources.download.minecraft.net/{prefix}/{hash}"),
            dest,
            label: format!("asset object {hash}"),
        });
    }

    if pending.is_empty() {
        return Ok(());
    }

    tracing::info!(
        "downloading {} Minecraft asset objects into {}",
        pending.len(),
        objects_dir.display()
    );
    download_all(pending).await
}

pub(crate) fn ensure_launcher_profiles(game_dir: &Path) -> Result<()> {
    let path = game_dir.join("launcher_profiles.json");
    if path.exists() {
        return Ok(());
    }

    let profile = json!({
        "profiles": {
            "Blockwright": {
                "name": "Blockwright",
                "type": "custom",
                "created": "2026-01-01T00:00:00.000Z",
                "lastUsed": "2026-01-01T00:00:00.000Z"
            }
        },
        "selectedProfile": "Blockwright",
        "clientToken": Uuid::new_v4().to_string(),
    });
    fs::write(&path, serde_json::to_vec_pretty(&profile)?)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

pub(crate) fn build_client_launch_metadata(
    game_dir: &Path,
    version_id: &str,
    vanilla_client_jar: Option<&Path>,
    account: &ClientAccountConfig,
) -> Result<ClientLaunchMetadata> {
    let mut version_chain = Vec::new();
    collect_version_chain(game_dir, version_id, &mut version_chain)?;

    let main_class = version_chain
        .iter()
        .rev()
        .find_map(|json| json.get("mainClass").and_then(Value::as_str))
        .context("client version metadata did not define mainClass")?
        .to_string();

    let libraries_dir = game_dir.join("libraries");
    let natives_dir = game_dir
        .join(".blockwright")
        .join("natives")
        .join(version_id);
    fs::create_dir_all(&natives_dir)
        .with_context(|| format!("failed to create {}", natives_dir.display()))?;

    let mut classpath = Vec::new();
    let mut classpath_seen = HashSet::new();
    for json in &version_chain {
        for library in json
            .get("libraries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !rules_allow(library.get("rules")) {
                continue;
            }
            for artifact in library_artifacts(library) {
                let jar = libraries_dir.join(&artifact.path);
                if artifact.native {
                    extract_native_jar(&jar, &natives_dir)?;
                } else if jar.exists() {
                    push_unique_path(&mut classpath, &mut classpath_seen, jar);
                }
            }
        }
    }

    if let Some(jar) = vanilla_client_jar {
        if jar.exists() {
            push_unique_path(&mut classpath, &mut classpath_seen, jar.to_path_buf());
        }
    }

    let asset_index = version_chain
        .iter()
        .find_map(|json| {
            json.get("assetIndex")
                .and_then(|asset| asset.get("id"))
                .and_then(Value::as_str)
                .or_else(|| json.get("assets").and_then(Value::as_str))
        })
        .unwrap_or("legacy");

    let replacements = LauncherReplacements {
        game_dir,
        libraries_dir: &libraries_dir,
        natives_dir: &natives_dir,
        classpath: &join_paths(&classpath)?,
        version_name: version_id,
        asset_index,
        account,
    };

    let mut jvm_args = Vec::new();
    let mut game_args = Vec::new();
    for json in &version_chain {
        if let Some(arguments) = json.get("arguments") {
            append_launcher_arguments(arguments.get("jvm"), &replacements, &mut jvm_args);
            append_launcher_arguments(arguments.get("game"), &replacements, &mut game_args);
        } else if let Some(minecraft_args) = json.get("minecraftArguments").and_then(Value::as_str)
        {
            game_args.extend(
                minecraft_args
                    .split_whitespace()
                    .map(|arg| replace_launcher_placeholders(arg, &replacements)),
            );
        }
    }

    Ok(ClientLaunchMetadata {
        main_class,
        jvm_args,
        game_args,
    })
}

pub(crate) fn collect_version_chain(
    game_dir: &Path,
    version_id: &str,
    out: &mut Vec<Value>,
) -> Result<()> {
    let path = game_dir
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.json"));
    let json = read_json_file(&path)?;
    if let Some(parent) = json.get("inheritsFrom").and_then(Value::as_str) {
        collect_version_chain(game_dir, parent, out)?;
    }
    out.push(json);
    Ok(())
}

pub(crate) fn read_json_file(path: &Path) -> Result<Value> {
    let data = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&data).with_context(|| format!("failed to parse {}", path.display()))
}

struct LauncherReplacements<'a> {
    game_dir: &'a Path,
    libraries_dir: &'a Path,
    natives_dir: &'a Path,
    classpath: &'a str,
    version_name: &'a str,
    asset_index: &'a str,
    account: &'a ClientAccountConfig,
}

fn append_launcher_arguments(
    value: Option<&Value>,
    replacements: &LauncherReplacements<'_>,
    out: &mut Vec<String>,
) {
    let Some(Value::Array(args)) = value else {
        return;
    };
    for arg in args {
        append_launcher_argument(arg, replacements, out);
    }
}

fn append_launcher_argument(
    value: &Value,
    replacements: &LauncherReplacements<'_>,
    out: &mut Vec<String>,
) {
    match value {
        Value::String(arg) => out.push(replace_launcher_placeholders(arg, replacements)),
        Value::Object(object) if rules_allow(object.get("rules")) => {
            if let Some(value) = object.get("value") {
                append_launcher_argument(value, replacements, out);
            }
        }
        Value::Array(values) => {
            for value in values {
                append_launcher_argument(value, replacements, out);
            }
        }
        _ => {}
    }
}

fn replace_launcher_placeholders(arg: &str, replacements: &LauncherReplacements<'_>) -> String {
    arg.replace("${auth_player_name}", &replacements.account.username)
        .replace("${version_name}", replacements.version_name)
        .replace(
            "${game_directory}",
            &replacements.game_dir.display().to_string(),
        )
        .replace(
            "${assets_root}",
            &replacements.game_dir.join("assets").display().to_string(),
        )
        .replace("${assets_index_name}", replacements.asset_index)
        .replace("${auth_uuid}", &replacements.account.uuid)
        .replace("${auth_access_token}", "0")
        .replace("${clientid}", "")
        .replace("${auth_xuid}", "")
        .replace("${user_type}", "legacy")
        .replace("${version_type}", "release")
        .replace(
            "${library_directory}",
            &replacements.libraries_dir.display().to_string(),
        )
        .replace(
            "${natives_directory}",
            &replacements.natives_dir.display().to_string(),
        )
        .replace("${launcher_name}", "blockwright")
        .replace("${launcher_version}", env!("CARGO_PKG_VERSION"))
        .replace(
            "${classpath_separator}",
            if cfg!(windows) { ";" } else { ":" },
        )
        .replace("${classpath}", replacements.classpath)
}

fn rules_allow(rules: Option<&Value>) -> bool {
    let Some(Value::Array(rules)) = rules else {
        return true;
    };
    let mut allowed = false;
    for rule in rules {
        let Some(object) = rule.as_object() else {
            continue;
        };
        let os_matches = object.get("os").is_none_or(launcher_os_matches);
        let features_match = object.get("features").is_none_or(launcher_features_match);
        if os_matches && features_match {
            allowed = object
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("allow")
                == "allow";
        }
    }
    allowed
}

fn launcher_os_matches(os: &Value) -> bool {
    launcher_os_matches_platform(os, launcher_os_name(), "x86_64", &launcher_os_version())
}

fn launcher_os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn launcher_os_matches_platform(
    os: &Value,
    platform: &str,
    architecture: &str,
    version: &str,
) -> bool {
    let Some(object) = os.as_object() else {
        return true;
    };
    if let Some(name) = object.get("name").and_then(Value::as_str) {
        if name != platform {
            return false;
        }
    }

    if let Some(arch) = object.get("arch").and_then(Value::as_str) {
        if arch != architecture && !(architecture == "x86_64" && arch == "amd64") {
            return false;
        }
    }
    if let Some(pattern) = object.get("version").and_then(Value::as_str) {
        if version.is_empty()
            || !regex::Regex::new(pattern).is_ok_and(|regex| regex.is_match(version))
        {
            return false;
        }
    }
    true
}

fn launcher_os_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        #[cfg(windows)]
        {
            // RtlGetVersion reports the actual NT version even without an application
            // compatibility manifest (Windows 11 also reports major/minor 10.0).
            #[repr(C)]
            struct Version {
                size: u32,
                major: u32,
                minor: u32,
                build: u32,
                platform: u32,
                service_pack: [u16; 128],
            }
            #[link(name = "ntdll")]
            unsafe extern "system" {
                fn RtlGetVersion(version: *mut Version) -> i32;
            }
            let mut value = Version {
                size: std::mem::size_of::<Version>() as u32,
                major: 0,
                minor: 0,
                build: 0,
                platform: 0,
                service_pack: [0; 128],
            };
            if unsafe { RtlGetVersion(&mut value) } >= 0 {
                return format!("{}.{}.{}", value.major, value.minor, value.build);
            }
        }
        #[cfg(unix)]
        {
            let mut value: libc::utsname = unsafe { std::mem::zeroed() };
            if unsafe { libc::uname(&mut value) } == 0 {
                return unsafe { std::ffi::CStr::from_ptr(value.release.as_ptr()) }
                    .to_string_lossy()
                    .into_owned();
            }
        }
        String::new()
    })
}

fn launcher_features_match(features: &Value) -> bool {
    let Some(object) = features.as_object() else {
        return true;
    };
    object.values().all(|value| value.as_bool() == Some(false))
}

fn library_artifact(library: &Value) -> Option<(String, String)> {
    let artifact = library
        .get("downloads")
        .and_then(|downloads| downloads.get("artifact"))?;
    let path = artifact.get("path").and_then(Value::as_str)?;
    let url = artifact.get("url").and_then(Value::as_str)?;
    Some((path.to_string(), url.to_string()))
}

struct LibraryArtifact {
    path: String,
    url: String,
    native: bool,
}

fn library_artifacts(library: &Value) -> Vec<LibraryArtifact> {
    let native_classifier = library
        .get("name")
        .and_then(Value::as_str)
        .and_then(|name| name.split(':').nth(3))
        .filter(|name| name.starts_with("natives-"));
    if native_classifier.is_some() && !is_native_library(library) {
        return Vec::new();
    }
    let mut artifacts = Vec::new();
    if let Some((path, url)) = library_artifact(library) {
        artifacts.push(LibraryArtifact {
            path,
            url,
            native: native_classifier.is_some(),
        });
    }
    // Older metadata stores the selected native beside the Java artifact instead of
    // declaring a separate Maven library. Only the current OS/x64 classifier is used.
    if let Some(classifier) = library
        .get("natives")
        .and_then(|natives| natives.get(launcher_os_name()))
        .and_then(Value::as_str)
    {
        let classifier = classifier.replace("${arch}", "64");
        let current = format!("natives-{}", launcher_os_name());
        if classifier != current && classifier != format!("{current}-64") {
            return artifacts;
        }
        if let Some(artifact) = library
            .get("downloads")
            .and_then(|downloads| downloads.get("classifiers"))
            .and_then(|classifiers| classifiers.get(&classifier))
        {
            if let (Some(path), Some(url)) = (
                artifact.get("path").and_then(Value::as_str),
                artifact.get("url").and_then(Value::as_str),
            ) {
                artifacts.push(LibraryArtifact {
                    path: path.to_string(),
                    url: url.to_string(),
                    native: true,
                });
            }
        }
    }
    artifacts
}

fn is_native_library(library: &Value) -> bool {
    library
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| {
            name.ends_with(if cfg!(windows) {
                ":natives-windows"
            } else {
                ":natives-linux"
            })
        })
}

fn extract_native_jar(jar: &Path, natives_dir: &Path) -> Result<()> {
    if !jar.exists() {
        return Ok(());
    }
    let file = fs::File::open(jar).with_context(|| format!("failed to open {}", jar.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).with_context(|| format!("failed to read {}", jar.display()))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        if name
            .components()
            .next()
            .is_some_and(|component| component.as_os_str() == "META-INF")
        {
            continue;
        }
        let Some(filename) = name.file_name() else {
            continue;
        };
        #[cfg(windows)]
        if !Path::new(filename)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"))
        {
            continue;
        }
        let dest = natives_dir.join(filename);
        if dest.exists() {
            continue;
        }
        let mut bytes = Vec::new();
        io::Read::read_to_end(&mut entry, &mut bytes)
            .with_context(|| format!("failed to extract native {}", dest.display()))?;
        crate::store::cache::write_replacing(&dest, bytes)
            .with_context(|| format!("failed to publish native {}", dest.display()))?;
    }
    Ok(())
}

fn join_paths(paths: &[PathBuf]) -> Result<String> {
    env::join_paths(paths)
        .context("failed to build managed client classpath")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("managed client classpath contained non-UTF-8 paths"))
}

fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if seen.insert(path.clone()) {
        paths.push(path);
    }
}

pub(crate) fn client_extra_game_args(client: &ClientConfig) -> Vec<String> {
    let mut game_args = client.game_args.clone();
    if let Some(connect) = &client.connect {
        let (host, port) = connect
            .rsplit_once(':')
            .filter(|(_, port)| !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()))
            .unwrap_or((connect.as_str(), "25565"));
        game_args.push("--server".to_string());
        game_args.push(host.to_string());
        game_args.push("--port".to_string());
        game_args.push(port.to_string());
    }
    game_args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replacements_for<'a>(account: &'a ClientAccountConfig) -> LauncherReplacements<'a> {
        LauncherReplacements {
            game_dir: Path::new("/game"),
            libraries_dir: Path::new("/game/libraries"),
            natives_dir: Path::new("/game/natives"),
            classpath: "/game/client.jar",
            version_name: "1.21.11",
            asset_index: "26",
            account,
        }
    }

    #[test]
    fn launcher_placeholders_default_to_an_offline_account() {
        let account = ClientAccountConfig::default();
        let replacements = replacements_for(&account);
        assert_eq!(
            replace_launcher_placeholders("${auth_player_name}", &replacements),
            "BlockwrightBot"
        );
        assert_eq!(
            replace_launcher_placeholders("${auth_uuid}", &replacements),
            "00000000000000000000000000000000"
        );
        assert_eq!(
            replace_launcher_placeholders("${auth_access_token}", &replacements),
            "0"
        );
        assert_eq!(
            replace_launcher_placeholders("${user_type}", &replacements),
            "legacy"
        );
    }

    #[test]
    fn only_the_current_x86_64_natives_classifier_is_extracted() {
        let native = |name: &str| json!({ "name": name });
        let selected = format!("org.lwjgl:lwjgl:3.3.3:natives-{}", launcher_os_name());
        assert!(is_native_library(&native(&selected)));
        for rejected in [
            "org.lwjgl:lwjgl:3.3.3:natives-linux",
            "org.lwjgl:lwjgl:3.3.3:natives-linux-arm64",
            "org.lwjgl:lwjgl:3.3.3:natives-macos",
            "org.lwjgl:lwjgl:3.3.3:natives-macos-arm64",
            "org.lwjgl:lwjgl-freetype:3.3.3:natives-macos-patch",
            "org.lwjgl:lwjgl:3.3.3:natives-windows",
            "org.lwjgl:lwjgl:3.3.3:natives-windows-arm64",
            "org.lwjgl:lwjgl:3.3.3:natives-windows-x86",
        ] {
            if rejected == selected {
                continue;
            }
            assert!(
                !is_native_library(&native(rejected)),
                "{rejected} should not be extracted"
            );
        }

        assert!(!is_native_library(&native("org.lwjgl:lwjgl:3.3.3")));
    }

    #[test]
    fn os_rules_admit_only_the_current_platform() {
        let allow = |os: Value| rules_allow(Some(&json!([{ "action": "allow", "os": os }])));
        assert!(allow(json!({ "name": launcher_os_name() })));
        assert!(!allow(json!({ "name": "osx" })));
        assert_eq!(allow(json!({ "name": "windows" })), cfg!(windows));
        assert_eq!(allow(json!({ "name": "linux" })), cfg!(unix));

        assert!(!allow(json!({ "name": launcher_os_name(), "arch": "x86" })));
        assert!(allow(
            json!({ "name": launcher_os_name(), "arch": "x86_64" })
        ));

        assert!(rules_allow(None));
    }

    #[test]
    fn windows_os_rules_match_architecture_and_version_regex() {
        let matches =
            |os: Value| launcher_os_matches_platform(&os, "windows", "x86_64", "10.0.26100");
        assert!(matches(
            json!({"name": "windows", "version": "^10\\.", "arch": "amd64"})
        ));
        assert!(!matches(json!({"name": "windows", "version": "^6\\."})));
        assert!(!matches(json!({"name": "windows", "version": "["})));
        assert!(!matches(json!({"name": "windows", "arch": "arm64"})));
        assert!(!matches(json!({"name": "linux"})));
        assert!(!launcher_os_version().is_empty());
    }

    #[test]
    fn classpath_separator_placeholder_matches_the_platform() {
        let account = ClientAccountConfig::default();
        assert_eq!(
            replace_launcher_placeholders("${classpath_separator}", &replacements_for(&account)),
            if cfg!(windows) { ";" } else { ":" }
        );
    }

    #[test]
    fn legacy_native_download_selects_only_the_current_os_and_architecture() {
        let library = json!({"name": "example:library:1", "natives": {
            "windows": "natives-windows-${arch}", "linux": "natives-linux-${arch}"
        }, "downloads": {"artifact": {"path": "library.jar", "url": "https://example.invalid/library.jar"},
            "classifiers": {
                "natives-windows-64": {"path": "windows.jar", "url": "https://example.invalid/windows.jar"},
                "natives-windows-32": {"path": "x86.jar", "url": "https://example.invalid/x86.jar"},
                "natives-linux-64": {"path": "linux.jar", "url": "https://example.invalid/linux.jar"}
            }
        }});
        let artifacts = library_artifacts(&library);
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].path, "library.jar");
        assert!(!artifacts[0].native);
        assert_eq!(
            artifacts[1].path,
            if cfg!(windows) {
                "windows.jar"
            } else {
                "linux.jar"
            }
        );
        assert!(artifacts[1].native);
        let foreign = json!({"name": "org.lwjgl:lwjgl:3.3.3:natives-windows-arm64",
            "downloads": {"artifact": {"path": "arm64.jar", "url": "https://example.invalid/arm64.jar"}}});
        assert!(library_artifacts(&foreign).is_empty());
    }

    #[test]
    fn library_artifact_prefers_downloads_artifact() {
        let library = json!({
            "name": "com.example:foo:1.0",
            "downloads": {
                "artifact": {
                    "path": "com/example/foo/1.0/foo-1.0.jar",
                    "url": "https://libraries.minecraft.net/com/example/foo/1.0/foo-1.0.jar"
                }
            }
        });
        let (path, url) = library_artifact(&library).unwrap();
        assert_eq!(path, "com/example/foo/1.0/foo-1.0.jar");
        assert_eq!(
            url,
            "https://libraries.minecraft.net/com/example/foo/1.0/foo-1.0.jar"
        );
    }
}
