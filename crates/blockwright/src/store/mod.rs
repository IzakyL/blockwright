//! The store holds what instances share: the content cache, the runtime bases each role is
//! linked from, and the refs that say which of them a config still uses. Everything under it
//! is addressed by content or version, never by project, so checkouts can share one.

use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub mod cache;
pub mod gc;

pub const RUNTIME_DIR: &str = "runtime";
const REFS_DIR: &str = "refs";

pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn sanitize_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        #[cfg(windows)]
        if windows_reserved_name(&cleaned) {
            return format!("{cleaned}_");
        }
        cleaned
    }
}

#[cfg(windows)]
fn windows_reserved_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper.strip_prefix(prefix).is_some_and(|number| {
                number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9')
            })
        })
}

/// A lock on the store. Launches and syncs share it while they add or link content; `gc`
/// takes it exclusively, so it never deletes what one of them is about to use.
pub struct StoreLock {
    _file: File,
}

impl StoreLock {
    /// Waits for any running gc, then holds the store shared.
    pub fn shared(store_dir: &Path) -> Result<Self> {
        Self::acquire(store_dir, LockMode::Shared).map(|lock| lock.expect("a blocking lock"))
    }

    /// Holds the store exclusively, or returns `None` while anything else holds it.
    pub fn try_exclusive(store_dir: &Path) -> Result<Option<Self>> {
        Self::acquire(store_dir, LockMode::TryExclusive)
    }

    fn acquire(store_dir: &Path, mode: LockMode) -> Result<Option<Self>> {
        std::fs::create_dir_all(store_dir)
            .with_context(|| format!("failed to create store {}", store_dir.display()))?;
        Ok(lock_file(&store_dir.join(".lock"), mode)?.map(|file| Self { _file: file }))
    }
}

pub(crate) enum LockMode {
    Shared,
    TryExclusive,
}

/// Opens (creating) `path` and locks it; `None` when a non-blocking lock is held elsewhere.
pub(crate) fn lock_file(path: &Path, mode: LockMode) -> Result<Option<File>> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("failed to open {}", path.display()))?;
    let result = match mode {
        LockMode::Shared => file.lock_shared().map_err(TryLockError::Error),
        LockMode::TryExclusive => file.try_lock(),
    };
    match result {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => {
            Err(error).with_context(|| format!("failed to lock {}", path.display()))
        }
    }
}

/// What one config uses from the store: cache entries (`Hash::key`) and runtime bases.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Refs {
    pub config: PathBuf,
    pub keys: Vec<String>,
}

/// Records what `config` uses in `role` (a launch role, or `sync`), replacing its last record.
pub fn record_refs(
    store_dir: &Path,
    config: &Path,
    role: &str,
    mut keys: Vec<String>,
) -> Result<()> {
    keys.sort();
    keys.dedup();
    let dir = store_dir.join(REFS_DIR);
    std::fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let id = cache::Hash::of(
        cache::HashAlgo::Sha256,
        config.as_os_str().as_encoded_bytes(),
    );
    let path = dir.join(format!("{}-{role}.json", &id.hex()[..16]));
    let refs = Refs {
        config: config.to_path_buf(),
        keys,
    };
    cache::write_replacing(&path, serde_json::to_vec_pretty(&refs)?)
        .with_context(|| format!("failed to write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn shared_locks_coexist_and_exclude_an_exclusive_lock() {
        let tmp = TempDir::new("store-locks");
        let first = StoreLock::shared(tmp.path()).unwrap();
        let second = StoreLock::shared(tmp.path()).unwrap();
        assert!(StoreLock::try_exclusive(tmp.path()).unwrap().is_none());
        drop((first, second));
        let exclusive = StoreLock::try_exclusive(tmp.path()).unwrap().unwrap();
        assert!(StoreLock::try_exclusive(tmp.path()).unwrap().is_none());
        drop(exclusive);
        assert!(StoreLock::try_exclusive(tmp.path()).unwrap().is_some());
    }

    #[test]
    fn locks_exclude_an_independent_process() {
        let tmp = TempDir::new("store-process-locks");
        let held = StoreLock::shared(tmp.path()).unwrap();
        let run = |blocked: bool| {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "store::tests::lock_probe_subprocess",
                    "--nocapture",
                ])
                .env("BLOCKWRIGHT_LOCK_PROBE_PATH", tmp.path())
                .env(
                    "BLOCKWRIGHT_LOCK_PROBE_BLOCKED",
                    if blocked { "1" } else { "0" },
                )
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(true);
        drop(held);
        run(false);
    }

    #[test]
    fn lock_probe_subprocess() {
        let Some(path) = std::env::var_os("BLOCKWRIGHT_LOCK_PROBE_PATH") else {
            return;
        };
        let blocked = std::env::var("BLOCKWRIGHT_LOCK_PROBE_BLOCKED").unwrap() == "1";
        assert_eq!(
            StoreLock::try_exclusive(Path::new(&path))
                .unwrap()
                .is_none(),
            blocked
        );
    }

    #[cfg(windows)]
    #[test]
    fn instance_names_avoid_windows_devices() {
        for name in [
            "CON", "con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9",
        ] {
            assert_eq!(sanitize_name(name), format!("{name}_"));
        }
        for name in ["console", "COM0", "COM10", "LPT0", "LPT10", "my-instance"] {
            assert_eq!(sanitize_name(name), name);
        }
        assert_eq!(sanitize_name("tail. "), "tail--");
    }
}

/// Every key some existing config still uses; refs of configs that are gone are dropped.
pub fn live_refs(store_dir: &Path) -> std::collections::HashSet<String> {
    let mut live = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(store_dir.join(REFS_DIR)) else {
        return live;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(refs) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Refs>(&bytes).ok())
        else {
            continue;
        };
        if refs.config.exists() {
            live.extend(refs.keys);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    live
}
