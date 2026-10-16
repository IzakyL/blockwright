use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::InstanceRole;

pub const REGISTRY_DIR: &str = ".blockwright/instances.d";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    pub instance_id: String,
    pub role: InstanceRole,
    pub pid: u32,
    pub instance_dir: PathBuf,
    #[serde(default)]
    pub trace_path: Option<PathBuf>,
    #[serde(default)]
    pub config: Option<PathBuf>,
    #[serde(default)]
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

pub fn registry_dir(root: &Path) -> PathBuf {
    root.join(REGISTRY_DIR)
}

pub fn record_path(root: &Path, instance_id: &str) -> PathBuf {
    registry_dir(root).join(format!("{}.json", crate::store::sanitize_name(instance_id)))
}

pub fn write(root: &Path, record: &InstanceRecord) -> Result<()> {
    let dir = registry_dir(root);
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create instance registry {}", dir.display()))?;
    let path = record_path(root, &record.instance_id);
    fs::write(&path, serde_json::to_string_pretty(record)? + "\n")
        .with_context(|| format!("failed to write instance record {}", path.display()))
}

pub fn remove(root: &Path, instance_id: &str) {
    let _ = fs::remove_file(record_path(root, instance_id));
}

/// The registered instances whose process is still alive; records of dead ones are pruned.
pub fn list(root: &Path) -> Vec<InstanceRecord> {
    let mut records = Vec::new();
    for path in fs::read_dir(registry_dir(root))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
    {
        match fs::read(&path)
            .ok()
            .and_then(|body| serde_json::from_slice::<InstanceRecord>(&body).ok())
        {
            Some(record)
                if record
                    .platform
                    .as_deref()
                    .is_some_and(|platform| platform != crate::platform::TARGET)
                    || crate::process::matches_identity(
                        record.pid,
                        record.process_identity.as_deref(),
                    ) =>
            {
                records.push(record)
            }
            _ => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    records.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
    records
}

/// The running instance a user named by its id, its instance dir name, or a unique part of
/// its id.
pub fn find(root: &Path, needle: &str) -> Result<Option<InstanceRecord>> {
    let records = list(root);
    let by_name = |record: &&InstanceRecord| {
        record
            .instance_dir
            .file_name()
            .and_then(|name| name.to_str())
            == Some(needle)
    };
    if let Some(exact) = records.iter().find(|record| record.instance_id == needle) {
        return Ok(Some(exact.clone()));
    }
    for (matches, what) in [
        (
            records.iter().filter(by_name).collect::<Vec<_>>(),
            "is the instance directory name of",
        ),
        (
            records
                .iter()
                .filter(|record| record.instance_id.contains(needle))
                .collect(),
            "matches",
        ),
    ] {
        match matches.as_slice() {
            [] => continue,
            [record] => return Ok(Some((*record).clone())),
            [first, second, ..] => anyhow::bail!(
                "{needle} {what} more than one running instance: {} and {}",
                first.instance_id,
                second.instance_id
            ),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn record(instance_id: &str, pid: u32) -> InstanceRecord {
        InstanceRecord {
            instance_id: instance_id.to_string(),
            role: InstanceRole::Client,
            pid,
            instance_dir: PathBuf::from("/tmp/instance"),
            trace_path: None,
            config: None,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            process_identity: None,
            platform: None,
        }
    }

    #[test]
    fn a_live_record_round_trips() {
        let tmp = TempDir::new("live");
        let root = tmp.path().to_path_buf();
        let mut entry = record("mcp-client", std::process::id());
        entry.role = InstanceRole::Server;
        write(&root, &entry).unwrap();

        let listed = list(&root);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_id, "mcp-client");
        assert_eq!(listed[0].role, InstanceRole::Server);
    }

    #[test]
    fn reused_pid_is_pruned_but_an_unknown_platform_is_preserved() {
        let tmp = TempDir::new("registry-identity");
        let mut reused = record("reused", std::process::id());
        reused.process_identity = Some("wrong-creation-identity".to_string());
        reused.platform = Some(crate::platform::TARGET.to_string());
        write(tmp.path(), &reused).unwrap();
        assert!(list(tmp.path()).is_empty());
        let mut foreign = reused;
        foreign.platform = Some("another-platform".to_string());
        write(tmp.path(), &foreign).unwrap();
        assert_eq!(list(tmp.path()).len(), 1);
    }

    #[test]
    fn a_record_whose_process_is_gone_is_pruned_rather_than_listed() {
        let tmp = TempDir::new("dead");
        let root = tmp.path().to_path_buf();
        write(&root, &record("gone", 4_294_000_000)).unwrap();
        assert!(list(&root).is_empty());
        assert!(!record_path(&root, "gone").exists());
    }

    #[test]
    fn find_resolves_the_instance_directory_name_because_that_is_the_handle_a_user_typed() {
        let tmp = TempDir::new("find-name");
        let root = tmp.path().to_path_buf();
        let mut server = record("neoforge-server-8ac1", std::process::id());
        server.role = InstanceRole::Server;
        server.instance_dir = PathBuf::from("/tmp/instances/held-pair-server");
        write(&root, &server).unwrap();
        let mut client = record("neoforge-client-9bd2", std::process::id());
        client.instance_dir = PathBuf::from("/tmp/instances/held-pair-client");
        write(&root, &client).unwrap();

        assert_eq!(
            find(&root, "held-pair-server")
                .unwrap()
                .unwrap()
                .instance_id,
            "neoforge-server-8ac1"
        );
        assert_eq!(
            find(&root, "neoforge-client-9bd2")
                .unwrap()
                .unwrap()
                .instance_id,
            "neoforge-client-9bd2"
        );
        assert!(find(&root, "held-pair").unwrap().is_none());
    }

    #[test]
    fn find_accepts_a_substring_but_refuses_an_ambiguous_one() {
        let tmp = TempDir::new("find");
        let root = tmp.path().to_path_buf();
        write(&root, &record("mcp-client-aaa", std::process::id())).unwrap();
        write(&root, &record("mcp-client-bbb", std::process::id())).unwrap();
        write(&root, &record("solo-server", std::process::id())).unwrap();

        assert_eq!(
            find(&root, "solo").unwrap().unwrap().instance_id,
            "solo-server"
        );
        assert_eq!(
            find(&root, "mcp-client-aaa").unwrap().unwrap().instance_id,
            "mcp-client-aaa"
        );
        assert!(find(&root, "mcp-client").is_err());
        assert!(find(&root, "nothing").unwrap().is_none());
    }

    #[test]
    fn an_instance_id_with_path_separators_cannot_escape_the_registry_dir() {
        let tmp = TempDir::new("escape");
        let root = tmp.path().to_path_buf();
        let path = record_path(&root, "../../etc/passwd");
        assert_eq!(path.parent().unwrap(), registry_dir(&root));
    }
}
