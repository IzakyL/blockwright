//! Shared helpers for unit tests.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// Retries `attempt` for up to two seconds until it gives `Some`.
///
/// For a test that expects to take a lock nobody holds: a process another test spawns at
/// that moment inherits every open lock until it execs, so a lock just dropped can still
/// look held for an instant.
pub(crate) fn eventually<T>(mut attempt: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let result = attempt();
        if result.is_some() || std::time::Instant::now() >= deadline {
            return result;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// A fresh directory under the system temp dir, removed when dropped.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub(crate) fn new(name: &str) -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "blockwright-test-{name}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = crate::platform::fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[allow(dead_code)]
    pub(crate) fn write(&self, relative: &str, contents: impl AsRef<str>) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents.as_ref()).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = crate::platform::fs::remove_dir_all(&self.path);
    }
}
