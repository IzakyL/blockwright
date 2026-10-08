//! `blockwright gc`: drops store entries no config uses any more, and instance dirs and
//! traces no running instance owns, except instance dirs launched with keepInstanceDir.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use uuid::Uuid;
use walkdir::WalkDir;

use super::{cache::Cache, live_refs, StoreLock, RUNTIME_DIR};
use crate::registry;

pub struct GcScope<'a> {
    pub store_dir: &'a Path,
    pub instances_dir: &'a Path,
    pub traces_dir: &'a Path,
    /// Where the registry of running instances lives.
    pub registry_root: &'a Path,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GcReport {
    pub removed: Vec<PathBuf>,
    pub bytes: u64,
}

/// Runs one gc pass, or returns `None` while a launch or sync holds the store.
pub fn gc(scope: &GcScope<'_>, dry_run: bool) -> Result<Option<GcReport>> {
    let Some(_lock) = StoreLock::try_exclusive(scope.store_dir)? else {
        return Ok(None);
    };
    let live = live_refs(scope.store_dir);
    let running = registry::list(scope.registry_root);
    let owned: HashSet<PathBuf> = running
        .iter()
        .flat_map(|record| [Some(record.instance_dir.clone()), record.trace_path.clone()])
        .flatten()
        .collect();

    let mut doomed = Vec::new();
    for dir in [
        scope.store_dir.join(Cache::DIR),
        scope.store_dir.join(RUNTIME_DIR),
    ] {
        doomed.extend(children(&dir).filter(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            name.starts_with('.') || !live.contains(name.as_ref())
        }));
    }
    doomed.extend(
        children(scope.instances_dir)
            .filter(|path| !owned.contains(path) && !path.join(KEEP_MARKER).exists()),
    );
    doomed.extend(children(scope.traces_dir).filter(|path| !owned.contains(path)));

    let mut report = GcReport::default();
    for path in doomed {
        report.bytes += WalkDir::new(&path)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.metadata().ok())
            .filter(|meta| meta.is_file())
            .map(|meta| meta.len())
            .sum::<u64>();
        if !dry_run {
            remove(&path)?;
        }
        report.removed.push(path);
    }
    Ok(Some(report))
}

/// Marks an instance dir launched with keepInstanceDir, which gc leaves alone even once its
/// game is gone.
pub const KEEP_MARKER: &str = ".blockwright-keep";

/// Sets or clears the keep marker, so a dir reused without keepInstanceDir is collectable again.
pub fn mark_kept(instance_dir: &Path, keep: bool) -> Result<()> {
    let marker = instance_dir.join(KEEP_MARKER);
    let result = if keep {
        fs::write(&marker, b"kept\n")
    } else {
        match fs::remove_file(&marker) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    };
    result.with_context(|| format!("failed to update {}", marker.display()))
}

fn children(dir: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
}

/// Moves a dir aside before deleting it, so an interrupted delete never leaves a half-empty
/// runtime base or cache entry where a launch would take it as complete.
fn remove(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return fs::remove_file(path)
            .with_context(|| format!("failed to remove {}", path.display()));
    }
    let trash = path.with_file_name(format!(".trash-{}", Uuid::new_v4()));
    let target = if fs::rename(path, &trash).is_ok() {
        &trash
    } else {
        path
    };
    fs::remove_dir_all(target).with_context(|| format!("failed to remove {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::InstanceRole;
    use crate::registry::InstanceRecord;
    use crate::store::{cache::Cache, record_refs};
    use crate::test_support::TempDir;

    struct Layout {
        tmp: TempDir,
        store: PathBuf,
        instances: PathBuf,
        traces: PathBuf,
    }

    fn layout(tag: &str) -> Layout {
        let tmp = TempDir::new(tag);
        let root = tmp.path().to_path_buf();
        Layout {
            store: root.join("store"),
            instances: root.join("instances"),
            traces: root.join("traces"),
            tmp,
        }
    }

    fn run(layout: &Layout, dry_run: bool) -> Option<GcReport> {
        let scope = GcScope {
            store_dir: &layout.store,
            instances_dir: &layout.instances,
            traces_dir: &layout.traces,
            registry_root: layout.tmp.path(),
        };
        gc(&scope, dry_run).unwrap()
    }

    #[test]
    fn only_what_a_live_config_references_survives() {
        let layout = layout("gc-live");
        let cache = Cache::new(&layout.store);
        layout.tmp.write("kept.jar", "kept");
        layout.tmp.write("dropped.jar", "dropped");
        let kept = cache
            .put(&layout.tmp.path().join("kept.jar"), "kept.jar", None, false)
            .unwrap();
        let dropped = cache
            .put(
                &layout.tmp.path().join("dropped.jar"),
                "dropped.jar",
                None,
                false,
            )
            .unwrap();
        layout.tmp.write("store/runtime/server-1.21.1-21.1.1/a", "");
        layout.tmp.write("store/runtime/server-1.21.1-21.1.2/a", "");
        layout.tmp.write("blockwright.toml", "");
        let config = layout.tmp.path().join("blockwright.toml");
        let keys = vec![kept.hash.key(), "server-1.21.1-21.1.2".to_string()];
        record_refs(&layout.store, &config, "server", keys).unwrap();

        let report = run(&layout, false).unwrap();

        assert!(kept.path.exists());
        assert!(!dropped.path.exists());
        assert!(layout.store.join("runtime/server-1.21.1-21.1.2").exists());
        assert!(!layout.store.join("runtime/server-1.21.1-21.1.1").exists());
        assert_eq!(report.removed.len(), 2);

        fs::remove_file(&config).unwrap();
        run(&layout, false).unwrap();
        assert!(
            !kept.path.exists(),
            "a deleted config stops pinning its content"
        );
    }

    #[test]
    fn instance_dirs_and_traces_go_unless_a_running_instance_owns_them() {
        let layout = layout("gc-instances");
        layout.tmp.write("instances/stale/options.txt", "");
        layout.tmp.write("instances/running/options.txt", "");
        layout.tmp.write("traces/stale.ndjson", "");
        layout.tmp.write("traces/running.ndjson", "");
        registry::write(
            layout.tmp.path(),
            &InstanceRecord {
                instance_id: "running".to_string(),
                role: InstanceRole::Server,
                pid: std::process::id(),
                instance_dir: layout.instances.join("running"),
                trace_path: Some(layout.traces.join("running.ndjson")),
                config: None,
                    started_at: String::new(),
            },
        )
        .unwrap();

        let dry = run(&layout, true).unwrap();
        assert_eq!(dry.removed.len(), 2);
        assert!(
            layout.instances.join("stale").exists(),
            "a dry run deletes nothing"
        );

        run(&layout, false).unwrap();
        assert!(!layout.instances.join("stale").exists());
        assert!(!layout.traces.join("stale.ndjson").exists());
        assert!(layout.instances.join("running").exists());
        assert!(layout.traces.join("running.ndjson").exists());
    }

    #[test]
    fn a_dead_instance_dir_goes_unless_it_was_launched_to_be_kept() {
        let layout = layout("gc-instances-dead");
        layout.tmp.write("instances/died/options.txt", "");
        layout.tmp.write("instances/kept/options.txt", "");
        mark_kept(&layout.instances.join("kept"), true).unwrap();
        registry::write(
            layout.tmp.path(),
            &InstanceRecord {
                instance_id: "died".to_string(),
                role: InstanceRole::Server,
                pid: 4_294_000_000,
                instance_dir: layout.instances.join("died"),
                trace_path: None,
                config: None,
                    started_at: String::new(),
            },
        )
        .unwrap();

        run(&layout, false).unwrap();

        assert!(
            !layout.instances.join("died").exists(),
            "a record whose process is gone owns nothing"
        );
        assert!(layout.instances.join("kept").exists());

        mark_kept(&layout.instances.join("kept"), false).unwrap();
        run(&layout, false).unwrap();
        assert!(!layout.instances.join("kept").exists());
    }

    #[test]
    fn gc_stands_down_while_the_store_is_held() {
        let layout = layout("gc-locked");
        let held = StoreLock::shared(&layout.store).unwrap();
        assert!(run(&layout, false).is_none());
        drop(held);
        assert!(run(&layout, false).is_some());
    }
}
