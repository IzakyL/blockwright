use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use toml::{Table, Value};

use crate::store::cache::{Hash, HashAlgo};

#[derive(Debug, Clone)]
pub struct LoadedBlockwrightConfig {
    pub path: PathBuf,
    pub root: PathBuf,
    /// The `[profile.<name>]` laid over the file's base config, picked by `path#name`.
    pub profile: Option<String>,
    pub config: BlockwrightConfig,
}

impl LoadedBlockwrightConfig {
    #[cfg(test)]
    pub fn new(path: PathBuf, root: PathBuf, config: BlockwrightConfig) -> Self {
        Self {
            path,
            root,
            profile: None,
            config,
        }
    }

    /// Names a store refs record: the role, prefixed by the profile so profiles do not
    /// overwrite each other's refs.
    pub fn refs_label(&self, role: &str) -> String {
        match &self.profile {
            Some(profile) => format!("{profile}-{role}"),
            None => role.to_string(),
        }
    }

    pub fn store_dir(&self) -> PathBuf {
        match env::var_os(STORE_ENV).filter(|value| !value.is_empty()) {
            Some(value) => {
                let path = PathBuf::from(value);
                if path.is_absolute() {
                    path
                } else {
                    env::current_dir()
                        .map(|cwd| cwd.join(&path))
                        .unwrap_or(path)
                }
            }
            None => self.resolve_path(&self.config.store.dir),
        }
    }

    pub fn resolve_path(&self, path: impl AsRef<Path>) -> PathBuf {
        let path = path.as_ref();
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        }
    }
}

/// The table of named overlays in a config file.
pub const PROFILE_KEY: &str = "profile";

/// Loads `path`, or `path#name` for the file's base config with `[profile.name]` laid over it:
/// tables merge key by key, and anything else (scalars, arrays) replaces what the base set.
pub fn load_config(selector: impl AsRef<Path>) -> Result<LoadedBlockwrightConfig> {
    let (path, profile) = split_selector(selector.as_ref());
    let (path, root, base, mut profiles) = read_document(&path)?;
    let table = match &profile {
        None => base,
        Some(name) => {
            let overlay = profiles.remove(name).with_context(|| {
                let known: Vec<&str> = profiles.keys().map(String::as_str).collect();
                format!(
                    "{} has no [{PROFILE_KEY}.{name}]; its profiles are: {}",
                    path.display(),
                    if known.is_empty() {
                        "none".to_string()
                    } else {
                        known.join(", ")
                    }
                )
            })?;
            let mut merged = base;
            merge_table(&mut merged, overlay.clone());
            return build(path, root, Some((name.clone(), &overlay)), merged);
        }
    };
    build(path, root, None, table)
}

/// The file's base config followed by each of its profiles.
pub fn load_config_profiles(path: impl AsRef<Path>) -> Result<Vec<LoadedBlockwrightConfig>> {
    let (path, _) = split_selector(path.as_ref());
    let (path, root, base, profiles) = read_document(&path)?;
    let mut loaded = Vec::with_capacity(profiles.len() + 1);
    // The base first, so a key it gets wrong is reported against it and not the first profile.
    loaded.push(build(path.clone(), root.clone(), None, base.clone())?);
    for (name, overlay) in profiles {
        let mut merged = base.clone();
        merge_table(&mut merged, overlay.clone());
        loaded.push(build(
            path.clone(),
            root.clone(),
            Some((name, &overlay)),
            merged,
        )?);
    }
    Ok(loaded)
}

fn split_selector(selector: &Path) -> (PathBuf, Option<String>) {
    if let Some((file, name)) = selector.to_str().and_then(|text| text.rsplit_once('#')) {
        if !name.is_empty() && !name.contains('/') {
            return (PathBuf::from(file), Some(name.to_string()));
        }
    }
    (selector.to_path_buf(), None)
}

fn read_document(path: &Path) -> Result<(PathBuf, PathBuf, Table, BTreeMap<String, Table>)> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .context("failed to resolve current directory for Blockwright config")?
            .join(path)
    };
    let source = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config {}", path.display()))?;
    let mut table: Table =
        toml::from_str(&source).with_context(|| format!("failed to parse {}", path.display()))?;
    let profiles = match table.remove(PROFILE_KEY) {
        None => BTreeMap::new(),
        Some(Value::Table(profiles)) => profiles
            .into_iter()
            .map(|(name, overlay)| match overlay {
                Value::Table(overlay) => Ok((name, overlay)),
                other => bail!(
                    "[{PROFILE_KEY}.{name}] in {} must be a table, found {}",
                    path.display(),
                    other.type_str()
                ),
            })
            .collect::<Result<_>>()?,
        Some(other) => bail!(
            "`{PROFILE_KEY}` in {} must be a table of profiles, found {}",
            path.display(),
            other.type_str()
        ),
    };
    let root = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    Ok((path, root, table, profiles))
}

fn merge_table(base: &mut Table, overlay: Table) {
    for (key, value) in overlay {
        match (base.get_mut(&key), value) {
            (Some(Value::Table(existing)), Value::Table(incoming)) => {
                merge_table(existing, incoming)
            }
            (_, incoming) => {
                base.insert(key, incoming);
            }
        }
    }
}

/// Deserializes a (merged) config table. `profile` names the overlay that was laid over the base,
/// so an error can say whether the key it is about came from the profile or the base.
fn build(
    path: PathBuf,
    root: PathBuf,
    profile: Option<(String, &Table)>,
    table: Table,
) -> Result<LoadedBlockwrightConfig> {
    let config: BlockwrightConfig = serde_path_to_error::deserialize(Value::Table(table))
        .map_err(|error| {
            let segments: Vec<String> = error.path().iter().map(ToString::to_string).collect();
            let overlay = profile
                .as_ref()
                .map(|(name, table)| (name.as_str(), *table));
            anyhow::anyhow!(describe_error(&segments, error.inner(), overlay))
        })
        .with_context(|| match &profile {
            Some((name, _)) => format!("failed to parse {}#{name}", path.display()),
            None => format!("failed to parse {}", path.display()),
        })?;
    config
        .neoforge
        .client
        .display
        .validate()
        .with_context(|| format!("invalid client display configuration in {}", path.display()))?;
    Ok(LoadedBlockwrightConfig {
        path,
        root,
        profile: profile.map(|(name, _)| name),
        config,
    })
}

/// Turns a deserialize error at `segments` into one that names the key, its section, and whether
/// that section is the base config or `[profile.<name>]`.
fn describe_error(
    segments: &[String],
    inner: &toml::de::Error,
    overlay: Option<(&str, &Table)>,
) -> String {
    // The toml deserializer appends its own "in `a.b`" lines; the section is named below instead.
    let message = inner.to_string();
    let detail = message.lines().next().unwrap_or_default();
    let Some((key, parent)) = segments.split_last() else {
        return detail.to_string();
    };
    let section = match overlay {
        Some((name, table)) if table_has_path(table, segments) => {
            format!("[{PROFILE_KEY}.{name}{}]", dotted_suffix(parent))
        }
        _ => {
            let base = if parent.is_empty() {
                "the top level".to_string()
            } else {
                format!("[{}]", parent.join("."))
            };
            match overlay {
                Some((name, _)) => {
                    format!("{base} (of the base config, which [{PROFILE_KEY}.{name}] extends)")
                }
                None => base,
            }
        }
    };
    let Some(expected) = detail.strip_prefix(&format!("unknown field `{key}`")) else {
        return format!("`{key}` in {section}: {detail}");
    };
    if let (Some((name, _)), [only]) = (overlay, segments) {
        if only == PROFILE_KEY {
            return format!(
                "[{PROFILE_KEY}.{name}] sets `{PROFILE_KEY}`, but profiles do not nest"
            );
        }
    }
    let expected = expected.trim_start_matches(',').trim();
    if expected.is_empty() {
        format!("unknown key `{key}` in {section}")
    } else {
        format!("unknown key `{key}` in {section}; {expected}")
    }
}

fn dotted_suffix(segments: &[String]) -> String {
    segments
        .iter()
        .map(|segment| format!(".{segment}"))
        .collect()
}

fn table_has_path(table: &Table, segments: &[String]) -> bool {
    match segments {
        [] => true,
        [last] => table.contains_key(last),
        [first, rest @ ..] => match table.get(first) {
            Some(Value::Table(inner)) => table_has_path(inner, rest),
            _ => false,
        },
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BlockwrightConfig {
    pub neoforge: NeoForgeConfig,
    pub mods: BTreeMap<String, ModSpec>,
    pub trace: TraceConfig,
    pub store: StoreConfig,
    pub coverage: CoverageConfig,
}

/// Overrides `[store].dir`; a relative value resolves against the working directory.
pub const STORE_ENV: &str = "BLOCKWRIGHT_STORE";

/// Everything under the store is addressed by content or version, never by project, so
/// several checkouts of a project (worktrees) can share one by symlinking it. It sits in a
/// top-level dir of its own, apart from the per-checkout `.blockwright/`, so one link covers it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StoreConfig {
    pub dir: PathBuf,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            dir: PathBuf::from(".blockwright-store"),
        }
    }
}

/// Overrides `[coverage].enabled` when set and non-empty: `1`/`true` or `0`/`false`. A test
/// run turns coverage on from the environment without a profile of its own for it.
pub const COVERAGE_ENV: &str = "BLOCKWRIGHT_COVERAGE";

/// `[coverage]`: measures the code of the named mods with the JaCoCo agent attached to every game
/// JVM, and `blockwright coverage report` turns what the instances recorded into reports.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CoverageConfig {
    pub enabled: bool,
    /// Names declared under `[mods]`; their jars are the code measured.
    pub mods: Vec<String>,
    /// JaCoCo include patterns (dotted class names, `*` and `?`) on top of those the mod jars give.
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    /// Source dirs the HTML report shows lines from.
    pub sources: Vec<PathBuf>,
    /// Outside the instance dirs, which go away on close, so the data outlives the instances.
    pub dir: PathBuf,
    /// The blockwright-coverage jar; found under coverage-report/build/libs when unset.
    pub tool: Option<PathBuf>,
}

impl Default for CoverageConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mods: Vec::new(),
            includes: Vec::new(),
            excludes: Vec::new(),
            sources: Vec::new(),
            dir: PathBuf::from(".blockwright/coverage"),
            tool: None,
        }
    }
}

impl CoverageConfig {
    /// `enabled`, unless `BLOCKWRIGHT_COVERAGE` says otherwise.
    pub fn is_enabled(&self) -> Result<bool> {
        let value = env::var_os(COVERAGE_ENV).map(|value| value.to_string_lossy().into_owned());
        coverage_switch(self.enabled, value.as_deref())
    }
}

/// Whether coverage is on, given the config's `enabled` and the value of `BLOCKWRIGHT_COVERAGE`.
/// A value that is neither on nor off is an error rather than ignored, so a typo cannot silently
/// run a suite without the coverage it was meant to record.
pub fn coverage_switch(configured: bool, env: Option<&str>) -> Result<bool> {
    let Some(value) = env.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(configured);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" => Ok(true),
        "0" | "false" => Ok(false),
        _ => bail!("{COVERAGE_ENV}={value:?} is neither 1/true nor 0/false"),
    }
}

/// One `[mods.<name>]` entry: a single source, and the roles it is installed into.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ModSpec {
    /// A local jar, a directory of jars, or a glob.
    pub path: Option<PathBuf>,
    /// A download pinned by `sha256` or `sha512`.
    pub url: Option<String>,
    pub sha256: Option<String>,
    pub sha512: Option<String>,
    /// Another mod whose archive holds this one (a jar-in-jar), with the `entry` inside it;
    /// `*` matches any run of characters and exactly one entry must match.
    pub from: Option<String>,
    pub entry: Option<String>,
    /// The roles this goes into; both when unset, none (`[]`) for a jar only built against.
    pub target: Option<Vec<InstanceRole>>,
}

#[derive(Debug, Clone)]
pub enum ModSource<'a> {
    Path(&'a Path),
    Url { url: &'a str, hash: Hash },
    Entry { from: &'a str, entry: &'a str },
}

impl ModSpec {
    pub fn source(&self, name: &str) -> Result<ModSource<'_>> {
        let kinds = [
            ("path", self.path.is_some()),
            ("url", self.url.is_some()),
            ("from", self.from.is_some()),
        ];
        let mut set = kinds.iter().filter(|(_, set)| *set).map(|(kind, _)| *kind);
        let (Some(kind), None) = (set.next(), set.next()) else {
            bail!("mod {name:?} must set exactly one of `path`, `url` or `from`");
        };
        let companions = [
            ("sha256", self.sha256.is_some(), "url"),
            ("sha512", self.sha512.is_some(), "url"),
            ("entry", self.entry.is_some(), "from"),
        ];
        if let Some((field, _, owner)) = companions
            .iter()
            .find(|(_, set, owner)| *set && *owner != kind)
        {
            bail!("mod {name:?} sets `{field}`, which only goes with `{owner}`");
        }
        let missing = |field: &str| format!("mod {name:?} sets `{kind}` but no `{field}`");
        Ok(match kind {
            "path" => ModSource::Path(self.path.as_deref().unwrap()),
            "url" => ModSource::Url {
                url: self.url.as_deref().unwrap(),
                hash: match (&self.sha512, &self.sha256) {
                    (Some(sha512), _) => Hash::from_hex(HashAlgo::Sha512, sha512),
                    (None, Some(sha256)) => Hash::from_hex(HashAlgo::Sha256, sha256),
                    (None, None) => bail!(missing("sha256` or `sha512")),
                },
            },
            _ => ModSource::Entry {
                from: self.from.as_deref().unwrap(),
                entry: self.entry.as_deref().with_context(|| missing("entry"))?,
            },
        })
    }

    pub fn installs_on(&self, role: InstanceRole) -> bool {
        self.target
            .as_ref()
            .is_none_or(|roles| roles.contains(&role))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TraceConfig {
    pub dir: PathBuf,
}

impl Default for TraceConfig {
    fn default() -> Self {
        Self {
            dir: PathBuf::from(".blockwright/traces"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NeoForgeConfig {
    pub minecraft_version: String,
    pub loader_version: String,
    pub java: JavaConfig,
    pub jvm_args: Vec<String>,
    pub instances_dir: PathBuf,
    pub instance_name: Option<String>,
    /// The agent mod jar; found under neoforge-agent/build/libs when unset.
    pub agent_mod: Option<PathBuf>,
    pub server: ServerConfig,
    pub client: ClientConfig,
}

impl Default for NeoForgeConfig {
    fn default() -> Self {
        Self {
            minecraft_version: "1.21.1".to_string(),
            loader_version: "latest".to_string(),
            java: JavaConfig::default(),
            jvm_args: vec!["-Xmx2G".to_string()],
            instances_dir: PathBuf::from(".blockwright/instances"),
            instance_name: None,
            agent_mod: None,
            server: ServerConfig::default(),
            client: ClientConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct JavaConfig {
    pub runtime: String,
}

impl Default for JavaConfig {
    fn default() -> Self {
        Self {
            runtime: "java".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub eula: bool,
    pub args: Vec<String>,
    pub properties: BTreeMap<String, String>,
    pub world: WorldPreset,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            eula: false,
            args: vec!["nogui".to_string()],
            properties: BTreeMap::new(),
            world: WorldPreset::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorldPreset {
    #[default]
    Vanilla,
    Flat,
    Void,
}

impl WorldPreset {
    pub fn server_properties(self) -> Option<(&'static str, &'static str)> {
        let generator_settings = match self {
            Self::Vanilla => return None,
            Self::Flat => {
                r#"{"biome":"minecraft:the_void","features":false,"lakes":false,"layers":[{"block":"minecraft:bedrock","height":1}],"structure_overrides":[]}"#
            }
            Self::Void => {
                r#"{"biome":"minecraft:the_void","features":false,"lakes":false,"layers":[],"structure_overrides":[]}"#
            }
        };
        Some(("minecraft:flat", generator_settings))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClientAccountConfig {
    pub username: String,
    pub uuid: String,
}

impl Default for ClientAccountConfig {
    fn default() -> Self {
        Self {
            username: "BlockwrightBot".to_string(),
            uuid: "00000000000000000000000000000000".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClientConfig {
    pub connect: Option<String>,
    /// Set by the driver, never by a config: join the server that writes its port here.
    #[serde(skip)]
    pub connect_port_file: Option<std::path::PathBuf>,
    pub account: ClientAccountConfig,
    pub game_args: Vec<String>,
    pub options: std::collections::BTreeMap<String, String>,
    pub display: ClientDisplayConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClientDisplayConfig {
    pub width: u32,
    pub height: u32,
    pub device: RenderDevice,
}

impl Default for ClientDisplayConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            device: RenderDevice::default(),
        }
    }
}

impl ClientDisplayConfig {
    pub fn validate(&self) -> Result<()> {
        self.validate_for_platform(std::env::consts::OS)
    }

    fn validate_for_platform(&self, platform: &str) -> Result<()> {
        if platform == "windows" && !matches!(self.device, RenderDevice::Auto | RenderDevice::Gpu) {
            bail!("neoforge.client.display.device = {:?} is not supported on Windows; use auto or gpu (the system selects the GPU)", self.device.to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum RenderDevice {
    #[default]
    Auto,

    Gpu,

    Software,

    Index(u32),
}

impl std::fmt::Display for RenderDevice {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderDevice::Auto => formatter.write_str("auto"),
            RenderDevice::Gpu => formatter.write_str("gpu"),
            RenderDevice::Software => formatter.write_str("software"),
            RenderDevice::Index(index) => write!(formatter, "index:{index}"),
        }
    }
}

impl From<RenderDevice> for String {
    fn from(value: RenderDevice) -> Self {
        value.to_string()
    }
}

impl TryFrom<String> for RenderDevice {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.trim() {
            "auto" => Ok(RenderDevice::Auto),
            "gpu" => Ok(RenderDevice::Gpu),
            "software" => Ok(RenderDevice::Software),
            other => match other.strip_prefix("index:") {
                Some(index) => index
                    .trim()
                    .parse::<u32>()
                    .map(RenderDevice::Index)
                    .map_err(|_| format!("render device {other:?} has a non-numeric index")),
                None => Err(format!(
                    "unknown render device {other:?}; expected auto, gpu, software, or index:<n>"
                )),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstanceRole {
    Server,
    #[default]
    Client,
}

impl InstanceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Client => "client",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_display_rejects_unsupported_devices_before_launching() {
        for device in [
            RenderDevice::Software,
            RenderDevice::Index(0),
            RenderDevice::Index(9),
        ] {
            let display = ClientDisplayConfig {
                device,
                ..Default::default()
            };
            let error = display
                .validate_for_platform("windows")
                .unwrap_err()
                .to_string();
            assert!(error.contains("use auto or gpu"), "{error}");
            assert!(display.validate_for_platform("linux").is_ok());
        }
        for device in [RenderDevice::Auto, RenderDevice::Gpu] {
            assert!(ClientDisplayConfig {
                device,
                ..Default::default()
            }
            .validate_for_platform("windows")
            .is_ok());
        }
    }

    #[test]
    fn render_device_round_trips_through_its_string_form() {
        for (text, device) in [
            ("auto", RenderDevice::Auto),
            ("gpu", RenderDevice::Gpu),
            ("software", RenderDevice::Software),
            ("index:2", RenderDevice::Index(2)),
        ] {
            assert_eq!(RenderDevice::try_from(text.to_string()).unwrap(), device);
            assert_eq!(device.to_string(), text);
        }
    }

    #[test]
    fn render_device_rejects_unknown_names_with_the_allowed_set() {
        let error = RenderDevice::try_from("nvidia".to_string()).unwrap_err();
        assert!(
            error.contains("auto, gpu, software, or index:<n>"),
            "{error}"
        );
        assert!(RenderDevice::try_from("index:x".to_string()).is_err());
    }

    #[test]
    fn a_mod_takes_exactly_one_source_with_its_companions() {
        let mods: BTreeMap<String, ModSpec> = toml::from_str(
            r#"
local = { path = "build/libs/*.jar" }
sodium = { url = "https://example.invalid/sodium.jar", sha256 = "cd", target = ["client"] }
pinned = { url = "https://example.invalid/a.jar", sha512 = "AB" }
inner = { from = "pinned", entry = "META-INF/jarjar/*.jar" }
unpinned = { url = "https://example.invalid/a.jar" }
two = { path = "a.jar", url = "https://example.invalid/a.jar", sha256 = "ab" }
stray = { path = "a.jar", sha256 = "ab" }
"#,
        )
        .unwrap();
        let source = |name: &str| mods[name].source(name);
        assert!(matches!(source("local").unwrap(), ModSource::Path(_)));
        let ModSource::Url { hash, .. } = source("pinned").unwrap() else {
            panic!()
        };
        assert_eq!(hash, Hash::from_hex(HashAlgo::Sha512, "ab"));
        assert!(matches!(
            source("inner").unwrap(),
            ModSource::Entry { from: "pinned", .. }
        ));
        for (name, message) in [
            ("unpinned", "no `sha256` or `sha512`"),
            ("two", "exactly one"),
            ("stray", "`sha256`, which only goes with `url`"),
        ] {
            let error = source(name).unwrap_err().to_string();
            assert!(error.contains(message), "{name}: {error}");
        }
        assert!(mods["sodium"].installs_on(InstanceRole::Client));
        assert!(!mods["sodium"].installs_on(InstanceRole::Server));
        assert!(mods["local"].installs_on(InstanceRole::Server));
        assert!(toml::from_str::<ModSpec>("jar = \"a.jar\"").is_err());
    }

    #[test]
    fn a_profile_lays_its_tables_over_the_base() {
        let dir = std::env::temp_dir().join(format!("bw-profile-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blockwright.toml");
        fs::write(
            &path,
            r#"
[neoforge]
jvm_args = ["-Xmx2G"]
[neoforge.client]
options = { guiScale = "1", fullscreen = "false" }
[mods.app]
path = "app.jar"
[mods.sodium]
url = "https://example.invalid/sodium.jar"
sha256 = "cd"
target = []

[profile.promo.neoforge]
jvm_args = ["-Xmx3G"]
[profile.promo.neoforge.client]
options = { guiScale = "2" }
[profile.promo.mods.sodium]
target = ["client"]
"#,
        )
        .unwrap();

        let base = load_config(&path).unwrap();
        assert_eq!(base.profile, None);
        assert!(!base.config.mods["sodium"].installs_on(InstanceRole::Client));

        let promo = load_config(format!("{}#promo", path.display())).unwrap();
        assert_eq!(promo.path, path);
        assert_eq!(promo.profile.as_deref(), Some("promo"));
        assert_eq!(promo.refs_label("server"), "promo-server");
        assert_eq!(promo.config.neoforge.jvm_args, ["-Xmx3G"]);
        let options = &promo.config.neoforge.client.options;
        assert_eq!(
            (options["guiScale"].as_str(), options["fullscreen"].as_str()),
            ("2", "false")
        );
        assert!(promo.config.mods["sodium"].installs_on(InstanceRole::Client));
        assert_eq!(
            promo.config.mods["sodium"].url.as_deref(),
            Some("https://example.invalid/sodium.jar")
        );
        assert!(promo.config.mods.contains_key("app"));

        let all = load_config_profiles(&path).unwrap();
        assert_eq!(
            all.iter().map(|c| c.profile.clone()).collect::<Vec<_>>(),
            [None, Some("promo".into())]
        );

        let error = load_config(format!("{}#bench", path.display()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("no [profile.bench]") && error.contains("promo"),
            "{error}"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Writes `body` as a config and loads `selector` from it (`""` for the base, `#name` for a
    /// profile), returning the whole error chain.
    fn load_error(body: &str, selector: &str) -> String {
        let dir = std::env::temp_dir().join(format!("bw-keys-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blockwright.toml");
        fs::write(&path, body).unwrap();
        let error = load_config(format!("{}{selector}", path.display()))
            .map(|_| ())
            .expect_err("config should not load");
        let all = load_config_profiles(&path).map(|_| ()).unwrap_err();
        assert_eq!(
            format!("{all:#}"),
            format!("{error:#}"),
            "the same error either way"
        );
        fs::remove_dir_all(&dir).unwrap();
        format!("{error:#}")
    }

    #[test]
    fn unknown_keys_are_rejected_naming_the_key_and_section() {
        for (body, key, section) in [
            ("bogus = 1\n", "unknown key `bogus`", "the top level"),
            (
                "[neoforge]\nminecraft = \"1.21.1\"\n",
                "unknown key `minecraft`",
                "[neoforge]",
            ),
            (
                "[neoforge.client]\nconect = \"localhost\"\n",
                "unknown key `conect`",
                "[neoforge.client]",
            ),
            (
                "[neoforge.client.display]\nwidht = 800\n",
                "unknown key `widht`",
                "[neoforge.client.display]",
            ),
            (
                "[neoforge.server]\nport = 25565\n",
                "unknown key `port`",
                "[neoforge.server]",
            ),
            ("[store]\npath = \"s\"\n", "unknown key `path`", "[store]"),
            (
                "[coverage]\ninclude = [\"a.*\"]\n",
                "unknown key `include`",
                "[coverage]",
            ),
            (
                "[mods.app]\njar = \"a.jar\"\n",
                "unknown key `jar`",
                "[mods.app]",
            ),
        ] {
            let error = load_error(body, "");
            assert!(
                error.contains(&format!("{key} in {section};")) && error.contains("expected"),
                "{body}: {error}"
            );
        }
        // `connect_port_file` is set by the driver, never read from a config.
        let error = load_error("[neoforge.client]\nconnect_port_file = \"p\"\n", "");
        assert!(error.contains("unknown key `connect_port_file`"), "{error}");
    }

    #[test]
    fn unknown_keys_inside_a_profile_name_the_profile() {
        let base = "[neoforge.client]\noptions = { guiScale = \"1\" }\n";
        let error = load_error(
            &format!("{base}[profile.promo.neoforge.client.display]\nwidht = 800\n"),
            "#promo",
        );
        assert!(
            error.contains("blockwright.toml#promo")
                && error
                    .contains("unknown key `widht` in [profile.promo.neoforge.client.display];"),
            "{error}"
        );
        let error = load_error(&format!("{base}[profile.promo]\nbogus = 1\n"), "#promo");
        assert!(
            error.contains("unknown key `bogus` in [profile.promo];"),
            "{error}"
        );

        let error = load_error(&format!("{base}[profile.promo.profile.inner]\n"), "#promo");
        assert!(error.contains("profiles do not nest"), "{error}");

        // A bad key in the base is the base's, even when it is met loading a profile.
        let dir = std::env::temp_dir().join(format!("bw-keys-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blockwright.toml");
        fs::write(
            &path,
            "[neoforge.client]\nconect = \"x\"\n[profile.promo.neoforge.client]\n",
        )
        .unwrap();
        let error = format!(
            "{:#}",
            load_config(format!("{}#promo", path.display())).unwrap_err()
        );
        assert!(
            error.contains("unknown key `conect` in [neoforge.client] (of the base config, which [profile.promo] extends)"),
            "{error}"
        );
        let error = format!("{:#}", load_config_profiles(&path).unwrap_err());
        assert!(
            !error.contains('#') && error.contains("unknown key `conect` in [neoforge.client];"),
            "{error}"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn free_form_tables_take_any_key() {
        let dir = std::env::temp_dir().join(format!("bw-keys-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blockwright.toml");
        fs::write(
            &path,
            r#"
[neoforge.client]
game_args = ["--anything"]
options = { anyOption = "1" }
[neoforge.server.properties]
any-property = "x"
[mods.any-name]
path = "a.jar"
[profile.promo.neoforge.client.options]
another = "2"
"#,
        )
        .unwrap();
        assert_eq!(load_config_profiles(&path).unwrap().len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn coverage_is_off_by_default_and_parses_every_key() {
        let config: BlockwrightConfig = toml::from_str("").unwrap();
        assert!(!config.coverage.enabled);
        assert!(config.coverage.mods.is_empty());
        assert_eq!(config.coverage.dir, Path::new(".blockwright/coverage"));
        assert_eq!(config.coverage.tool, None);

        let config: BlockwrightConfig = toml::from_str(
            r#"
[coverage]
enabled = true
mods = ["app"]
includes = ["com.example.*"]
excludes = ["com.example.gen.*"]
sources = ["src/main/java"]
dir = "cov"
tool = "tools/coverage.jar"
"#,
        )
        .unwrap();
        let coverage = &config.coverage;
        assert!(coverage.enabled);
        assert_eq!(coverage.mods, ["app"]);
        assert_eq!(coverage.includes, ["com.example.*"]);
        assert_eq!(coverage.excludes, ["com.example.gen.*"]);
        assert_eq!(coverage.sources, [PathBuf::from("src/main/java")]);
        assert_eq!(coverage.dir, Path::new("cov"));
        assert_eq!(
            coverage.tool.as_deref(),
            Some(Path::new("tools/coverage.jar"))
        );
    }

    #[test]
    fn the_coverage_env_overrides_the_config_when_it_is_set() {
        for (configured, env, expected) in [
            (false, None, false),
            (true, None, true),
            (true, Some(""), true),
            (false, Some("1"), true),
            (false, Some("TRUE"), true),
            (true, Some("0"), false),
            (true, Some(" false "), false),
        ] {
            assert_eq!(
                coverage_switch(configured, env).unwrap(),
                expected,
                "{configured} {env:?}"
            );
        }
        let error = coverage_switch(false, Some("yes")).unwrap_err().to_string();
        assert!(error.contains("BLOCKWRIGHT_COVERAGE=\"yes\""), "{error}");
    }

    #[test]
    fn a_profile_turns_coverage_on_over_the_base() {
        let tmp = crate::test_support::TempDir::new("coverage-profile");
        tmp.write(
            "blockwright.toml",
            r#"
[mods.app]
path = "app.jar"
[coverage]
mods = ["app"]
excludes = ["a.*"]

[profile.cov.coverage]
enabled = true
excludes = ["b.*"]
"#,
        );
        let path = tmp.path().join("blockwright.toml");
        assert!(!load_config(&path).unwrap().config.coverage.enabled);
        let cov = load_config(format!("{}#cov", path.display())).unwrap();
        assert!(cov.config.coverage.enabled);
        assert_eq!(cov.config.coverage.mods, ["app"]);
        assert_eq!(cov.config.coverage.excludes, ["b.*"]);
    }

    #[test]
    fn every_live_config_loads() {
        let live = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../live");
        let mut count = 0;
        for entry in fs::read_dir(&live).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "toml") {
                let document: Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
                let device = document
                    .get("neoforge")
                    .and_then(|value| value.get("client"))
                    .and_then(|value| value.get("display"))
                    .and_then(|value| value.get("device"))
                    .and_then(Value::as_str)
                    .unwrap_or("auto");
                if cfg!(windows) && (device == "software" || device.starts_with("index:")) {
                    let error = format!("{:#}", load_config(&path).unwrap_err());
                    assert!(
                        error.contains("not supported on Windows")
                            && error.contains("use auto or gpu")
                            && error.contains(device),
                        "{}: {error}",
                        path.display()
                    );
                } else {
                    load_config(&path)
                        .unwrap_or_else(|error| panic!("{}: {error:#}", path.display()));
                }
                count += 1;
            }
        }
        assert!(count > 0);
    }
}
