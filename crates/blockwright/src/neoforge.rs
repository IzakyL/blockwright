use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::config::NeoForgeConfig;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use urlencoding::encode;

pub(crate) const NEOFORGE_MAVEN_BASE: &str = "https://maven.neoforged.net/releases";
pub(crate) const NEOFORGE_GROUP_PATH: &str = "net/neoforged/neoforge";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedNeoForgeVersions {
    pub minecraft_version: String,
    pub loader_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeoForgeRuntimeRequirements {
    pub java_runtime: String,
    pub minimum_java: u16,
    pub managed_agent_minecraft: String,
    pub managed_agent_loader: String,
    pub managed_agent_java_release: u16,
}

pub async fn resolve_versions(neoforge: &NeoForgeConfig) -> Result<ResolvedNeoForgeVersions> {
    let minecraft_version = neoforge.minecraft_version.clone();
    let loader_version =
        resolve_loader_version(&neoforge.loader_version, &minecraft_version).await?;
    let minecraft_version = if minecraft_version == "latest" {
        minecraft_version_from_loader(&loader_version)
    } else {
        minecraft_version
    };

    Ok(ResolvedNeoForgeVersions {
        minecraft_version,
        loader_version,
    })
}

pub(crate) async fn resolve_loader_version(
    requested: &str,
    minecraft_version: &str,
) -> Result<String> {
    if requested != "latest" {
        return Ok(requested.to_string());
    }

    // Server and client launches in one process resolve the same "latest"; ask Maven once.
    static RESOLVED: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    const FRESH_FOR: Duration = Duration::from_secs(10 * 60);
    let cache = RESOLVED.get_or_init(Default::default);
    if let Some((at, version)) = cache.lock().unwrap().get(minecraft_version) {
        if at.elapsed() < FRESH_FOR {
            return Ok(version.clone());
        }
    }

    let url = format!("{NEOFORGE_MAVEN_BASE}/{NEOFORGE_GROUP_PATH}/maven-metadata.xml");
    let metadata = crate::http::http_client()
        .get(&url)
        .send()
        .await
        .with_context(|| format!("failed to query NeoForge versions from {url}"))?
        .error_for_status()
        .with_context(|| format!("NeoForge version query failed: {url}"))?
        .text()
        .await
        .context("failed to read NeoForge Maven metadata")?;

    let version = latest_loader_version(&parse_maven_versions(&metadata), minecraft_version)?;
    cache.lock().unwrap().insert(
        minecraft_version.to_string(),
        (Instant::now(), version.clone()),
    );
    Ok(version)
}

fn latest_loader_version(versions: &[String], minecraft_version: &str) -> Result<String> {
    if minecraft_version == "latest" {
        return versions
            .last()
            .cloned()
            .context("NeoForge Maven metadata returned no versions");
    }

    let prefix = loader_version_prefix_for_minecraft(minecraft_version);
    versions
        .iter()
        .rev()
        .find(|version| version.starts_with(&prefix))
        .cloned()
        .with_context(|| {
            format!(
                "NeoForge Maven metadata returned no versions matching Minecraft {minecraft_version} ({prefix}*)"
            )
        })
}

pub(crate) fn parse_maven_versions(metadata: &str) -> Vec<String> {
    let mut versions = Vec::new();
    let mut rest = metadata;
    while let Some(start) = rest.find("<version>") {
        rest = &rest[start + "<version>".len()..];
        let Some(end) = rest.find("</version>") else {
            break;
        };
        versions.push(rest[..end].trim().to_string());
        rest = &rest[end + "</version>".len()..];
    }
    versions
}

fn minecraft_version_from_loader(loader_version: &str) -> String {
    let mut parts = loader_version.split('.');
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) => format!("1.{major}.{minor}"),
        _ => loader_version.to_string(),
    }
}

fn loader_version_prefix_for_minecraft(minecraft_version: &str) -> String {
    minecraft_version
        .strip_prefix("1.")
        .unwrap_or(minecraft_version)
        .to_string()
        + "."
}

pub async fn ensure_installer(
    store_dir: &Path,
    versions: &ResolvedNeoForgeVersions,
) -> Result<PathBuf> {
    let filename = format!("neoforge-{}-installer.jar", versions.loader_version);
    let jar_path = store_dir
        .join("neoforge")
        .join("installer")
        .join(&versions.loader_version)
        .join(filename);
    if jar_path.exists() {
        return Ok(jar_path);
    }

    let url = format!(
        "{NEOFORGE_MAVEN_BASE}/{}/{}/neoforge-{}-installer.jar",
        NEOFORGE_GROUP_PATH,
        encode(&versions.loader_version),
        encode(&versions.loader_version)
    );
    crate::http::download(&url, &jar_path)
        .await
        .with_context(|| format!("failed to download NeoForge installer from {url}"))?;

    Ok(jar_path)
}

/// What the bundled agent is built for (neoforge-agent/gradle.properties).
const AGENT_MINECRAFT: &str = "[1.21.1]";
const AGENT_LOADER: &str = "[21.1.233,)";
const AGENT_JAVA_RELEASE: u16 = 21;

pub fn runtime_requirements(
    neoforge: &NeoForgeConfig,
    resolved: &ResolvedNeoForgeVersions,
) -> NeoForgeRuntimeRequirements {
    NeoForgeRuntimeRequirements {
        java_runtime: neoforge.java.runtime.clone(),
        minimum_java: required_java(&resolved.minecraft_version).max(AGENT_JAVA_RELEASE),
        managed_agent_minecraft: AGENT_MINECRAFT.to_string(),
        managed_agent_loader: AGENT_LOADER.to_string(),
        managed_agent_java_release: AGENT_JAVA_RELEASE,
    }
}

/// The Java release a Minecraft version runs on.
fn required_java(minecraft_version: &str) -> u16 {
    let mut parts = minecraft_version
        .split(['.', '-'])
        .map_while(|part| part.parse::<u32>().ok());
    let version = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    match version {
        (major, _, _) if major >= 26 => 25,
        (1, minor, patch) if (minor, patch) >= (20, 5) => 21,
        (1, minor, _) if minor >= 18 => 17,
        (1, 17, _) => 16,
        _ => 8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_java_from_the_minecraft_version() {
        assert_eq!(required_java("26.1.2"), 25);
        assert_eq!(required_java("1.21.1"), 21);
        assert_eq!(required_java("1.20.5"), 21);
        assert_eq!(required_java("1.20.4"), 17);
        assert_eq!(required_java("1.17.1"), 16);
        assert_eq!(required_java("1.16.5"), 8);
    }

    #[test]
    fn extracts_versions_from_maven_metadata() {
        let metadata = r#"
            <metadata>
              <versioning>
                <versions>
                  <version>21.1.232</version>
                  <version>21.1.233</version>
                </versions>
              </versioning>
            </metadata>
        "#;

        assert_eq!(
            parse_maven_versions(metadata),
            vec!["21.1.232".to_string(), "21.1.233".to_string()]
        );
    }

    #[test]
    fn infers_minecraft_version_from_neoforge_loader_version() {
        assert_eq!(minecraft_version_from_loader("21.1.233"), "1.21.1");
        assert_eq!(minecraft_version_from_loader("26.1.2.65-beta"), "1.26.1");
    }

    #[test]
    fn filters_latest_loader_by_configured_minecraft_version() {
        assert_eq!(loader_version_prefix_for_minecraft("1.21.1"), "21.1.");
        assert_eq!(loader_version_prefix_for_minecraft("26.1.2"), "26.1.2.");
    }
}
