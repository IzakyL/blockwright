//! `[coverage]`: measures the code of the mods under test. Every game JVM gets the JaCoCo agent,
//! which records what ran into a data dir of its own outside the instance dir (those go away on
//! close); `blockwright coverage report` merges every data dir into reports with the
//! blockwright-coverage tool.
//!
//! NeoForge and Mixin rewrite classes as they load, so the agent also dumps the classes it saw
//! (`classdumpdir`): the report matches the recorded probes against those, not the jars. Mixins
//! put a mod's code into classes outside its own packages, so the tool's `plan` names those
//! targets too and the agent measures them as well.

use std::collections::BTreeSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::config::{InstanceRole, LoadedBlockwrightConfig, COVERAGE_ENV};
use crate::engine::{blocking, launch};
use crate::mods;
use crate::registry;
use crate::store::cache::{write_replacing, Cache, CachedFile, Hash, HashAlgo};
use crate::store::StoreLock;

const AGENT_URL: &str =
    "https://repo1.maven.org/maven2/org/jacoco/org.jacoco.agent/0.8.13/org.jacoco.agent-0.8.13-runtime.jar";
const AGENT_FILENAME: &str = "org.jacoco.agent-0.8.13-runtime.jar";
const AGENT_SHA512: &str = "f0a09d84bfa5f5c07bdee0ba506911d80922e9838e824a53bf9c64e643e7300f902db4b503339cfb4bd7b4151248ba83d268bdfa40fcd0a55a9a40f8c64c3683";

/// Overrides where the blockwright-coverage jar is found, below `[coverage].tool`.
pub const TOOL_ENV: &str = "BLOCKWRIGHT_COVERAGE_TOOL";
const TOOL_PREFIX: &str = "blockwright-coverage-";

/// Under `[coverage].dir`: one dir per instance, holding `jacoco.exec` and `classes/`.
const DATA_DIR: &str = "data";
/// Under `[coverage].dir`: the tool's plan for each set of mod jars.
const PLANS_DIR: &str = "plans";
const REPORT_DIR: &str = "report";
const EXEC_FILE: &str = "jacoco.exec";
const CLASSES_DIR: &str = "classes";
const INSTANCE_FILE: &str = "instance.json";

/// What the tool's `plan` finds in the mod jars: the packages of their classes, their mixin
/// classes, and the classes those mixins go into.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Plan {
    pub packages: Vec<String>,
    pub mixins: Vec<String>,
    pub targets: Vec<String>,
}

/// What a launch adds for coverage: the `-javaagent` arg, and the store entries it uses.
#[derive(Debug, Clone)]
pub struct LaunchCoverage {
    pub jvm_arg: String,
    pub store_keys: Vec<String>,
    pub data_dir: PathBuf,
}

/// Written into each data dir so a report (or a person) can tell which launch recorded it.
#[derive(Debug, Serialize)]
struct InstanceInfo<'a> {
    instance_id: &'a str,
    role: InstanceRole,
    config: &'a Path,
    profile: Option<&'a str>,
    mods: Vec<&'a Path>,
}

pub fn coverage_dir(loaded: &LoadedBlockwrightConfig) -> PathBuf {
    loaded.resolve_path(&loaded.config.coverage.dir)
}

pub fn data_root(loaded: &LoadedBlockwrightConfig) -> PathBuf {
    coverage_dir(loaded).join(DATA_DIR)
}

pub fn default_report_dir(loaded: &LoadedBlockwrightConfig) -> PathBuf {
    coverage_dir(loaded).join(REPORT_DIR)
}

/// Sets up coverage for one launch, or returns `None` when it is off, in which case nothing is
/// fetched or run. The caller holds the store lock.
pub async fn prepare_launch(
    loaded: &LoadedBlockwrightConfig,
    store_dir: &Path,
    instance_id: &str,
    role: InstanceRole,
) -> Result<Option<LaunchCoverage>> {
    let coverage = &loaded.config.coverage;
    if !coverage.is_enabled()? {
        return Ok(None);
    }
    let cache = Cache::new(store_dir);
    let jars = mod_jars(loaded, &cache).await?;
    let agent = cache
        .fetch(
            AGENT_URL,
            AGENT_FILENAME,
            Hash::from_hex(HashAlgo::Sha512, AGENT_SHA512),
        )
        .await
        .context("failed to fetch the JaCoCo agent")?;
    let plan = plan(loaded, &jars).await?;
    let includes = plan_includes(&plan, &coverage.includes);
    if includes.is_empty() {
        bail!(
            "coverage found no classes to measure in the jars of [coverage].mods ({}); \
             name the packages with [coverage].includes",
            coverage.mods.join(", ")
        );
    }
    let data_dir = data_root(loaded).join(instance_id);
    let jvm_arg = agent_arg(&agent.path, &data_dir, &includes, &coverage.excludes)?;

    let info = serde_json::to_vec_pretty(&InstanceInfo {
        instance_id,
        role,
        config: &loaded.path,
        profile: loaded.profile.as_deref(),
        mods: jars.iter().map(|jar| jar.path.as_path()).collect(),
    })?;
    let dir = data_dir.clone();
    blocking(move || {
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        write_replacing(&dir.join(INSTANCE_FILE), info)
    })
    .await
    .context("failed to set up the coverage data dir")?;

    let mut store_keys: Vec<String> = jars.iter().map(|jar| jar.hash.key()).collect();
    store_keys.push(agent.hash.key());
    Ok(Some(LaunchCoverage {
        jvm_arg,
        store_keys,
        data_dir,
    }))
}

/// The jars of `[coverage].mods`, resolved whether or not they install on the role launching:
/// they say what is measured, not what is installed.
async fn mod_jars(loaded: &LoadedBlockwrightConfig, cache: &Cache) -> Result<Vec<CachedFile>> {
    let mut names: Vec<&str> = Vec::new();
    for name in &loaded.config.coverage.mods {
        if !names.contains(&name.as_str()) {
            names.push(name);
        }
    }
    if names.is_empty() {
        let declared: Vec<&str> = loaded.config.mods.keys().map(String::as_str).collect();
        bail!(
            "coverage is on, but [coverage].mods names no mod to measure; list the [mods] whose \
             jars hold the code under test (declared: {})",
            if declared.is_empty() {
                "(none)".to_string()
            } else {
                declared.join(", ")
            }
        );
    }
    let mut resolved = mods::resolve(loaded, cache, &names)
        .await
        .context("failed to resolve the jars of [coverage].mods")?;
    let jars: Vec<CachedFile> = names
        .iter()
        .flat_map(|name| resolved.remove(*name).unwrap_or_default())
        .collect();
    if jars.is_empty() {
        bail!("[coverage].mods ({}) resolve to no jars", names.join(", "));
    }
    Ok(jars)
}

/// The tool's plan for these jars, kept under `[coverage].dir` by their content so a launch of
/// the same jars does not start a JVM to work it out again.
async fn plan(loaded: &LoadedBlockwrightConfig, jars: &[CachedFile]) -> Result<Plan> {
    let path = coverage_dir(loaded)
        .join(PLANS_DIR)
        .join(format!("{}.json", plan_key(jars)));
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(plan) = serde_json::from_slice::<Plan>(&bytes) {
            return Ok(plan);
        }
    }
    let tool = find_tool(loaded)?;
    let mut args: Vec<OsString> = vec!["plan".into()];
    for jar in jars {
        args.push("--jar".into());
        args.push(jar.path.clone().into());
    }
    let java = &loaded.config.neoforge.java.runtime;
    let output = Command::new(java)
        .arg("-jar")
        .arg(&tool)
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("failed to run {java} -jar {}", tool.display()))?;
    if !output.status.success() {
        bail!(
            "the coverage tool's plan failed with status {}:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let plan: Plan = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "the coverage tool's plan printed something other than a plan:\n{}",
            String::from_utf8_lossy(&output.stdout).trim()
        )
    })?;
    let bytes = serde_json::to_vec_pretty(&plan)?;
    blocking(move || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        write_replacing(&path, bytes)
    })
    .await?;
    Ok(plan)
}

/// Bumped whenever the tool's plan changes for the same jars, so plans cached before are not reused.
const PLAN_VERSION: &str = "plan-v1";

/// Names a set of jars by their content, whatever order they come in.
fn plan_key(jars: &[CachedFile]) -> String {
    let keys: BTreeSet<String> = jars.iter().map(|jar| jar.hash.key()).collect();
    let joined = std::iter::once(PLAN_VERSION.to_string())
        .chain(keys)
        .collect::<Vec<_>>()
        .join("\n");
    Hash::of(HashAlgo::Sha256, joined.as_bytes())
        .hex()
        .to_string()
}

/// What the agent measures: every package of the mod jars, every class their mixins go into,
/// and the configured extra patterns.
pub fn plan_includes(plan: &Plan, extra: &[String]) -> Vec<String> {
    let packages = plan
        .packages
        .iter()
        // A class in the default package would make `.*` of nothing: everything.
        .filter(|package| !package.is_empty())
        .map(|package| format!("{package}.*"));
    let mut seen = BTreeSet::new();
    packages
        .chain(plan.targets.iter().cloned())
        .chain(extra.iter().cloned())
        .filter(|pattern| seen.insert(pattern.clone()))
        .collect()
}

/// The `-javaagent` arg for one instance. The agent splits its options on `,` and its include and
/// exclude lists on `:`, and has no escape for either, so a path or pattern holding one is refused
/// rather than passed on to be split in the wrong place.
pub fn agent_arg(
    agent: &Path,
    data_dir: &Path,
    includes: &[String],
    excludes: &[String],
) -> Result<String> {
    let path = |what: &str, path: &Path| -> Result<String> {
        let text = path
            .to_str()
            .with_context(|| format!("the {what} path {} is not UTF-8", path.display()))?;
        if text.contains(',') {
            bail!(
                "the {what} path {text} holds a ',', which the JaCoCo agent reads as the end of \
                 the option; move it (or [coverage].dir) to a path without one"
            );
        }
        Ok(text.to_string())
    };
    let patterns = |key: &str, patterns: &[String]| -> Result<String> {
        for pattern in patterns {
            if pattern.is_empty() || pattern.contains([',', ':']) {
                bail!(
                    "coverage {key} pattern {pattern:?} is empty or holds ',' or ':', which the \
                     JaCoCo agent uses as separators"
                );
            }
        }
        Ok(patterns.join(":"))
    };
    let agent = path("JaCoCo agent", agent)?;
    let data = path("coverage data", data_dir)?;
    let mut arg = format!(
        "-javaagent:{agent}=destfile={data}/{EXEC_FILE},classdumpdir={data}/{CLASSES_DIR},includes={}",
        patterns("includes", includes)?
    );
    if !excludes.is_empty() {
        arg.push_str(&format!(",excludes={}", patterns("excludes", excludes)?));
    }
    Ok(arg)
}

/// The blockwright-coverage jar: `[coverage].tool`, else `BLOCKWRIGHT_COVERAGE_TOOL`, else a
/// built or bundled jar where the agent mod is looked for.
pub fn find_tool(loaded: &LoadedBlockwrightConfig) -> Result<PathBuf> {
    if let Some(path) = &loaded.config.coverage.tool {
        let path = loaded.resolve_path(path);
        if !path.is_file() {
            bail!("[coverage].tool {} does not exist", path.display());
        }
        return Ok(path);
    }
    if let Some(value) = env::var_os(TOOL_ENV).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        let path = if path.is_absolute() {
            path
        } else {
            env::current_dir()
                .map(|cwd| cwd.join(&path))
                .unwrap_or(path)
        };
        if !path.is_file() {
            bail!("{TOOL_ENV}={} does not exist", path.display());
        }
        return Ok(path);
    }
    launch::jar_search_dirs(loaded, Path::new("coverage-report/build/libs"))
        .into_iter()
        .find_map(|dir| launch::find_jar(&dir, TOOL_PREFIX))
        .with_context(|| {
            format!(
                "the coverage tool ({TOOL_PREFIX}*.jar) was not found; build coverage-report, or \
                 point [coverage].tool or {TOOL_ENV} at it"
            )
        })
}

/// The data dirs instances have written to so far: those holding a `jacoco.exec`. A dir without
/// one belongs to an instance still running, or one that died before it could write.
fn recorded_data_dirs(data_root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(data_root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| dir.join(EXEC_FILE).is_file())
        .collect();
    dirs.sort();
    dirs
}

/// The tool's `report` command line, after `java -jar <tool>`. Only the configured patterns are
/// passed: the tool already restricts the report to the classes of the mod jars.
fn report_args(
    jars: &[PathBuf],
    data_dirs: &[PathBuf],
    loaded: &LoadedBlockwrightConfig,
    out: &Path,
    name: &str,
) -> Vec<OsString> {
    let coverage = &loaded.config.coverage;
    let mut args: Vec<OsString> = vec!["report".into()];
    let mut push = |flag: &str, value: OsString| {
        args.push(flag.into());
        args.push(value);
    };
    for jar in jars {
        push("--jar", jar.into());
    }
    for dir in data_dirs {
        push("--data", dir.into());
    }
    for pattern in &coverage.includes {
        push("--include", pattern.into());
    }
    for pattern in &coverage.excludes {
        push("--exclude", pattern.into());
    }
    for source in &coverage.sources {
        push("--sources", loaded.resolve_path(source).into());
    }
    push("--html", out.join("html").into());
    push("--xml", out.join("jacoco.xml").into());
    push("--lcov", out.join("lcov.info").into());
    push("--name", name.into());
    args
}

/// Writes the HTML, XML and LCOV reports of everything recorded so far into `out` (by default
/// `<coverage.dir>/report`), streaming the tool's output through. Returns the dir.
pub async fn report(loaded: &LoadedBlockwrightConfig, out: Option<PathBuf>) -> Result<PathBuf> {
    let data_root = data_root(loaded);
    let data_dirs = recorded_data_dirs(&data_root);
    if data_dirs.is_empty() {
        bail!(
            "no coverage has been recorded under {}; run the tests with {COVERAGE_ENV}=1 first",
            data_root.display()
        );
    }
    let out = out.unwrap_or_else(|| default_report_dir(loaded));
    let store_dir = loaded.store_dir();
    let lock_dir = store_dir.clone();
    let _lock = blocking(move || StoreLock::shared(&lock_dir)).await?;
    let jars: Vec<PathBuf> = mod_jars(loaded, &Cache::new(&store_dir))
        .await?
        .into_iter()
        .map(|jar| jar.path)
        .collect();
    let tool = find_tool(loaded)?;
    let name = match &loaded.profile {
        Some(profile) => profile.clone(),
        None => loaded
            .path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "coverage".to_string()),
    };
    let args = report_args(&jars, &data_dirs, loaded, &out, &name);
    let java = &loaded.config.neoforge.java.runtime;
    let status = Command::new(java)
        .arg("-jar")
        .arg(&tool)
        .args(&args)
        .stdin(Stdio::null())
        .status()
        .await
        .with_context(|| format!("failed to run {java} -jar {}", tool.display()))?;
    if !status.success() {
        bail!("the coverage report failed with status {status}");
    }
    Ok(out)
}

/// Deletes what coverage has recorded and the default report, returning what it removed. Refuses
/// while an instance that records into the data dir is still running, since it writes on exit.
pub fn reset(loaded: &LoadedBlockwrightConfig, registry_root: &Path) -> Result<Vec<PathBuf>> {
    let data_root = data_root(loaded);
    if let Some(record) = registry::list(registry_root)
        .into_iter()
        .find(|record| data_root.join(&record.instance_id).exists())
    {
        bail!(
            "instance {} (pid {}) is still running and records coverage into {}; close it first",
            record.instance_id,
            record.pid,
            data_root.display()
        );
    }
    let mut removed = Vec::new();
    for dir in [data_root, default_report_dir(loaded)] {
        match fs::remove_dir_all(&dir) {
            Ok(()) => removed.push(dir),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("failed to remove {}", dir.display()))
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_config;
    use crate::registry::InstanceRecord;
    use crate::test_support::TempDir;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn load(tmp: &TempDir, body: &str) -> LoadedBlockwrightConfig {
        tmp.write("blockwright.toml", body);
        load_config(tmp.path().join("blockwright.toml")).unwrap()
    }

    #[test]
    fn includes_cover_the_packages_the_mixin_targets_and_the_configured_patterns() {
        let plan = Plan {
            packages: strings(&[
                "com.lowdragmc.lowdraglib2",
                "com.lowdragmc.lowdraglib2.gui",
                "",
            ]),
            mixins: strings(&["com.lowdragmc.lowdraglib2.mixin.LevelMixin"]),
            targets: strings(&[
                "net.minecraft.world.level.Level",
                "net.minecraft.client.Minecraft$1",
            ]),
        };
        assert_eq!(
            plan_includes(
                &plan,
                &strings(&["org.extra.*", "net.minecraft.world.level.Level"])
            ),
            strings(&[
                "com.lowdragmc.lowdraglib2.*",
                "com.lowdragmc.lowdraglib2.gui.*",
                "net.minecraft.world.level.Level",
                "net.minecraft.client.Minecraft$1",
                "org.extra.*",
            ])
        );
    }

    #[test]
    fn the_agent_arg_records_into_the_data_dir() {
        let arg = agent_arg(
            Path::new("/store/cache/sha512-ab/jacoco.jar"),
            Path::new("/p/.blockwright/coverage/data/neoforge-server-1"),
            &strings(&["com.a.*", "net.minecraft.world.level.Level"]),
            &[],
        )
        .unwrap();
        assert_eq!(
            arg,
            "-javaagent:/store/cache/sha512-ab/jacoco.jar=\
             destfile=/p/.blockwright/coverage/data/neoforge-server-1/jacoco.exec,\
             classdumpdir=/p/.blockwright/coverage/data/neoforge-server-1/classes,\
             includes=com.a.*:net.minecraft.world.level.Level"
        );
        let arg = agent_arg(
            Path::new("/a.jar"),
            Path::new("/d"),
            &strings(&["com.a.*"]),
            &strings(&["com.a.gen.*", "com.a.Big"]),
        )
        .unwrap();
        assert!(
            arg.ends_with("includes=com.a.*,excludes=com.a.gen.*:com.a.Big"),
            "{arg}"
        );
    }

    #[test]
    fn the_agent_arg_refuses_what_the_agent_would_split() {
        let includes = strings(&["com.a.*"]);
        for (agent, data, includes, excludes, message) in [
            (
                "/a,b/a.jar",
                "/d",
                includes.clone(),
                vec![],
                "JaCoCo agent path",
            ),
            (
                "/a.jar",
                "/d,x",
                includes.clone(),
                vec![],
                "coverage data path",
            ),
            (
                "/a.jar",
                "/d",
                strings(&["com.a.*,x"]),
                vec![],
                "includes pattern",
            ),
            (
                "/a.jar",
                "/d",
                strings(&["com.a.*:x"]),
                vec![],
                "includes pattern",
            ),
            (
                "/a.jar",
                "/d",
                includes.clone(),
                strings(&["b:c"]),
                "excludes pattern",
            ),
            (
                "/a.jar",
                "/d",
                includes.clone(),
                strings(&[""]),
                "excludes pattern",
            ),
        ] {
            let error = agent_arg(Path::new(agent), Path::new(data), &includes, &excludes)
                .unwrap_err()
                .to_string();
            assert!(error.contains(message), "{error}");
        }
    }

    #[test]
    fn plans_are_named_by_the_jars_content_in_any_order() {
        let jar = |hex: &str| CachedFile {
            filename: format!("{hex}.jar"),
            hash: Hash::from_hex(HashAlgo::Sha256, hex),
            path: PathBuf::from(format!("/{hex}.jar")),
        };
        assert_eq!(
            plan_key(&[jar("aa"), jar("bb")]),
            plan_key(&[jar("bb"), jar("aa")])
        );
        assert_ne!(plan_key(&[jar("aa")]), plan_key(&[jar("aa"), jar("bb")]));
    }

    #[tokio::test]
    async fn a_launch_without_coverage_fetches_and_runs_nothing() {
        // Coverage is off unless the environment turns it on; never run it from a test env that does.
        if env::var_os(COVERAGE_ENV).is_some_and(|value| !value.is_empty()) {
            return;
        }
        let tmp = TempDir::new("coverage-off");
        let loaded = load(&tmp, "[coverage]\nmods = [\"nowhere\"]\n");
        let store = tmp.path().join("store");
        let prepared = prepare_launch(&loaded, &store, "neoforge-server-1", InstanceRole::Server)
            .await
            .unwrap();
        assert!(prepared.is_none());
        assert!(!store.exists(), "nothing was fetched");
        assert!(!coverage_dir(&loaded).exists());
    }

    #[tokio::test]
    async fn coverage_must_name_declared_mods() {
        let tmp = TempDir::new("coverage-mods");
        let cache = Cache::new(&tmp.path().join("store"));
        let loaded = load(
            &tmp,
            "[mods.app]\npath = \"app.jar\"\n[coverage]\nenabled = true\n",
        );
        let error = format!("{:#}", mod_jars(&loaded, &cache).await.unwrap_err());
        assert!(
            error.contains("[coverage].mods names no mod") && error.contains("declared: app"),
            "{error}"
        );

        let loaded = load(
            &tmp,
            "[mods.app]\npath = \"app.jar\"\n[coverage]\nenabled = true\nmods = [\"ap\"]\n",
        );
        let error = format!("{:#}", mod_jars(&loaded, &cache).await.unwrap_err());
        assert!(
            error.contains("no mod named \"ap\"") && error.contains("declared: app"),
            "{error}"
        );
    }

    #[test]
    fn the_report_gets_every_recorded_dir_and_only_the_configured_patterns() {
        let tmp = TempDir::new("coverage-report-args");
        let loaded = load(
            &tmp,
            "[coverage]\nmods = [\"app\"]\nincludes = [\"x.*\"]\nexcludes = [\"x.gen.*\"]\n\
             sources = [\"src/main/java\"]\n",
        );
        let data = data_root(&loaded);
        tmp.write(".blockwright/coverage/data/b/jacoco.exec", "");
        tmp.write(".blockwright/coverage/data/a/jacoco.exec", "");
        tmp.write(".blockwright/coverage/data/running/instance.json", "{}");
        let dirs = recorded_data_dirs(&data);
        assert_eq!(dirs, [data.join("a"), data.join("b")]);

        let args = report_args(
            &[PathBuf::from("/app.jar")],
            &dirs,
            &loaded,
            Path::new("/out"),
            "blockwright",
        );
        let args: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let sources = tmp.path().join("src/main/java");
        let expected = [
            "report",
            "--jar",
            "/app.jar",
            "--data",
            &data.join("a").display().to_string(),
            "--data",
            &data.join("b").display().to_string(),
            "--include",
            "x.*",
            "--exclude",
            "x.gen.*",
            "--sources",
            &sources.display().to_string(),
            "--html",
            &Path::new("/out").join("html").display().to_string(),
            "--xml",
            &Path::new("/out").join("jacoco.xml").display().to_string(),
            "--lcov",
            &Path::new("/out").join("lcov.info").display().to_string(),
            "--name",
            "blockwright",
        ];
        assert_eq!(args, expected);
    }

    #[tokio::test]
    async fn a_report_without_data_says_how_to_record_some() {
        let tmp = TempDir::new("coverage-report-empty");
        let loaded = load(&tmp, "[coverage]\nmods = [\"app\"]\n");
        let error = report(&loaded, None).await.unwrap_err().to_string();
        assert!(error.contains("BLOCKWRIGHT_COVERAGE=1"), "{error}");
    }

    #[test]
    fn reset_clears_the_data_unless_an_instance_still_records_into_it() {
        let tmp = TempDir::new("coverage-reset");
        let loaded = load(&tmp, "");
        tmp.write(".blockwright/coverage/data/live/jacoco.exec", "");
        tmp.write(".blockwright/coverage/report/index.html", "");
        tmp.write(".blockwright/coverage/plans/p.json", "{}");
        registry::write(
            tmp.path(),
            &InstanceRecord {
                instance_id: "live".to_string(),
                role: InstanceRole::Server,
                pid: std::process::id(),
                instance_dir: tmp.path().join("instances/live"),
                trace_path: None,
                config: None,
                started_at: String::new(),
                process_identity: None,
                platform: None,
            },
        )
        .unwrap();

        let error = reset(&loaded, tmp.path()).unwrap_err().to_string();
        assert!(error.contains("instance live"), "{error}");

        registry::remove(tmp.path(), "live");
        let removed = reset(&loaded, tmp.path()).unwrap();
        assert_eq!(removed, [data_root(&loaded), default_report_dir(&loaded)]);
        assert!(
            coverage_dir(&loaded).join("plans/p.json").exists(),
            "plans stay"
        );
        assert!(reset(&loaded, tmp.path()).unwrap().is_empty());
    }
}
