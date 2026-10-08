use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use anyhow::{Context, Result};
use blockwright::engine::blocking;

pub(crate) async fn validate_java_runtime(command: &str, minimum_java: u16) -> Result<()> {
    if command != "java" && !command.ends_with("/java") {
        return Ok(());
    }

    let owned = command.to_string();
    let detected = blocking(move || java_major_version(&owned)).await?;
    if detected < minimum_java {
        anyhow::bail!(
            "{command} is Java {detected}, but this instance requires Java {minimum_java}+"
        );
    }

    Ok(())
}

/// `java -version` starts a JVM, so the answer is remembered per command for the process.
fn java_major_version(command: &str) -> Result<u16> {
    static DETECTED: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    let cache = DETECTED.get_or_init(Default::default);
    if let Some(version) = cache.lock().unwrap().get(command) {
        return Ok(*version);
    }

    let output = std::process::Command::new(command)
        .arg("-version")
        .output()
        .with_context(|| format!("failed to run {command} -version"))?;
    let detected = parse_java_major_version(&String::from_utf8_lossy(&output.stderr))
        .or_else(|| parse_java_major_version(&String::from_utf8_lossy(&output.stdout)))
        .with_context(|| format!("failed to parse Java version from {command} -version"))?;
    cache.lock().unwrap().insert(command.to_string(), detected);
    Ok(detected)
}

pub(crate) fn parse_java_major_version(version_text: &str) -> Option<u16> {
    let quoted = version_text.split('"').nth(1)?;
    let mut parts = quoted.split('.');
    let first = parts.next()?.parse::<u16>().ok()?;
    if first == 1 {
        parts.next()?.parse::<u16>().ok()
    } else {
        Some(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_java_versions() {
        assert_eq!(
            parse_java_major_version(r#"openjdk version "25.0.2" 2026-01-20"#),
            Some(25)
        );
        assert_eq!(
            parse_java_major_version(r#"java version "1.8.0_402""#),
            Some(8)
        );
    }
}
