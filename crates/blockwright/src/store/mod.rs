//! The store holds what instances share: the content cache, the runtime bases each role is
//! linked from, and the refs that say which of them a config still uses. Everything under it
//! is addressed by content or version, never by project, so checkouts can share one.

use std::fs::File;
use std::os::unix::io::AsRawFd;
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
        cleaned
    }
}

/// An flock on the store. Launches and syncs share it while they add or link content; `gc`
/// takes it exclusively, so it never deletes what one of them is about to use.
pub struct StoreLock {
    _file: File,
}

impl StoreLock {
    /// Waits for any running gc, then holds the store shared.
    pub fn shared(store_dir: &Path) -> Result<Self> {
        Self::acquire(store_dir, libc::LOCK_SH).map(|lock| lock.expect("a blocking flock"))
    }

    /// Holds the store exclusively, or returns `None` while anything else holds it.
    pub fn try_exclusive(store_dir: &Path) -> Result<Option<Self>> {
        Self::acquire(store_dir, libc::LOCK_EX | libc::LOCK_NB)
    }

    fn acquire(store_dir: &Path, how: libc::c_int) -> Result<Option<Self>> {
        std::fs::create_dir_all(store_dir)
            .with_context(|| format!("failed to create store {}", store_dir.display()))?;
        Ok(flock(&store_dir.join(".lock"), how)?.map(|file| Self { _file: file }))
    }
}

/// Opens (creating) `path` and flocks it `how`; `None` when a non-blocking lock is held elsewhere.
pub(crate) fn flock(path: &Path, how: libc::c_int) -> Result<Option<File>> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("failed to open {}", path.display()))?;
    if unsafe { libc::flock(file.as_raw_fd(), how) } == 0 {
        return Ok(Some(file));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Ok(None);
    }
    Err(error).with_context(|| format!("failed to lock {}", path.display()))
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
    std::fs::write(&path, serde_json::to_vec_pretty(&refs)?)
        .with_context(|| format!("failed to write {}", path.display()))
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
