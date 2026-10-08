//! `[mods.<name>]`: every jar a project installs into instances or builds against, from one
//! source each (a local path, a pinned URL, or an entry of another mod),
//! resolved into the store's cache.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use futures_util::{stream, StreamExt, TryStreamExt};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::config::{LoadedBlockwrightConfig, ModSource, ModSpec};
use crate::engine::blocking;
use crate::store::cache::{Cache, CachedFile};
use crate::store::{record_refs, StoreLock};

/// Written next to the project's own state, never into the shared store.
pub const MANIFEST: &str = ".blockwright/mods.json";

const FETCH_CONCURRENCY: usize = 8;

/// Resolves the named mods, plus the mods their `from` entries come out of, into the cache.
pub async fn resolve(
    loaded: &LoadedBlockwrightConfig,
    cache: &Cache,
    names: &[&str],
) -> Result<BTreeMap<String, Vec<CachedFile>>> {
    let mods = &loaded.config.mods;
    let mut direct = BTreeSet::new();
    let mut entries = Vec::new();
    for name in names {
        let mut chain = vec![*name];
        let mut current = *name;
        loop {
            match spec(loaded, current)?.source(current)? {
                ModSource::Entry { from, .. } => {
                    if !entries.contains(&current) {
                        entries.push(current);
                    }
                    if chain.contains(&from) {
                        chain.push(from);
                        bail!(
                            "mods take files from each other in a circle: {}",
                            chain.join(" -> ")
                        );
                    }
                    chain.push(from);
                    current = from;
                }
                _ => {
                    direct.insert(current);
                    break;
                }
            }
        }
    }

    let mut resolved: BTreeMap<String, Vec<CachedFile>> = stream::iter(direct)
        .map(|name| async move {
            let files = fetch(loaded, cache, name, &mods[name])
                .await
                .with_context(|| format!("failed to resolve mod {name:?}"))?;
            Ok::<_, anyhow::Error>((name.to_string(), files))
        })
        .buffered(FETCH_CONCURRENCY)
        .try_collect()
        .await?;

    // An entry comes out of a mod resolved before it; the chains above are acyclic.
    while let Some(index) = entries.iter().position(|name| {
        matches!(mods[*name].source(name), Ok(ModSource::Entry { from, .. }) if resolved.contains_key(from))
    }) {
        let name = entries.remove(index);
        let ModSource::Entry { from, entry } = mods[name].source(name)? else {
            unreachable!("only entries are queued");
        };
        let [archive] = resolved[from].as_slice() else {
            bail!("mod {name:?} takes a file out of {from:?}, which is not a single jar");
        };
        let (cache, archive) = (cache.clone(), archive.clone());
        let (pattern, owned) = (entry.to_string(), name.to_string());
        let file = blocking(move || extract_entry(&cache, &archive, &pattern, &owned)).await?;
        resolved.insert(name.to_string(), vec![file]);
    }
    Ok(resolved)
}

fn spec<'a>(loaded: &'a LoadedBlockwrightConfig, name: &str) -> Result<&'a ModSpec> {
    let mods = &loaded.config.mods;
    mods.get(name).with_context(|| {
        let known: Vec<&str> = mods.keys().map(String::as_str).collect();
        format!(
            "no mod named {name:?} is declared under [mods]; declared: {}",
            if known.is_empty() {
                "(none)".to_string()
            } else {
                known.join(", ")
            }
        )
    })
}

async fn fetch(
    loaded: &LoadedBlockwrightConfig,
    cache: &Cache,
    name: &str,
    spec: &ModSpec,
) -> Result<Vec<CachedFile>> {
    match spec.source(name)? {
        ModSource::Path(path) => {
            let mut files = Vec::new();
            for path in local_jars(&loaded.resolve_path(path))? {
                files.push(local(cache, &path).await?);
            }
            Ok(files)
        }
        ModSource::Url { url, hash } => {
            let filename = url
                .rsplit('/')
                .next()
                .map(|segment| segment.split(['?', '#']).next().unwrap_or(segment))
                .filter(|segment| !segment.trim().is_empty())
                .unwrap_or(name);
            Ok(vec![
                cache
                    .fetch(url, &plain_filename(filename, name)?, hash)
                    .await?,
            ])
        }
        ModSource::Entry { .. } => unreachable!("entries resolve after the mods they come from"),
    }
}

/// Adds a local jar to the cache under its own file name.
pub async fn local(cache: &Cache, src: &Path) -> Result<CachedFile> {
    let filename = src
        .file_name()
        .and_then(|name| name.to_str())
        .with_context(|| format!("mod source has no filename: {}", src.display()))?
        .to_string();
    let (cache, src) = (cache.clone(), src.to_path_buf());
    blocking(move || cache.put_local(&src, &filename)).await
}

fn plain_filename(filename: &str, name: &str) -> Result<String> {
    match Path::new(filename)
        .file_name()
        .and_then(|file| file.to_str())
    {
        Some(file) if file == filename => Ok(filename.to_string()),
        _ => bail!("mod {name:?} names its file {filename:?}, which is not a plain file name"),
    }
}

fn extract_entry(
    cache: &Cache,
    archive: &CachedFile,
    pattern: &str,
    name: &str,
) -> Result<CachedFile> {
    let matcher = glob::Pattern::new(pattern)
        .with_context(|| format!("mod {name:?} has an invalid entry pattern {pattern:?}"))?;
    let file = fs::File::open(&archive.path)
        .with_context(|| format!("failed to open {} from the store", archive.filename))?;
    let mut zip = zip::ZipArchive::new(file)
        .with_context(|| format!("{} is not a zip archive", archive.filename))?;
    let matches: Vec<String> = zip
        .file_names()
        .filter(|entry| matcher.matches(entry))
        .map(str::to_string)
        .collect();
    let entry = match matches.as_slice() {
        [entry] => entry.clone(),
        [] => bail!(
            "mod {name:?}: no entry of {} matches {pattern:?}",
            archive.filename
        ),
        many => bail!(
            "mod {name:?}: {pattern:?} matches {} entries of {}, it must match one: {}",
            many.len(),
            archive.filename,
            many.join(", ")
        ),
    };
    let filename = plain_filename(entry.rsplit('/').next().unwrap_or(&entry), name)?;

    let tmp = cache.scratch(&filename)?;
    let extracted = (|| -> Result<CachedFile> {
        let mut out = fs::File::create(&tmp)
            .with_context(|| format!("failed to create {}", tmp.display()))?;
        std::io::copy(&mut zip.by_name(&entry)?, &mut out)
            .with_context(|| format!("failed to extract {entry} from {}", archive.filename))?;
        cache.put(&tmp, &filename, None, true)
    })();
    if extracted.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    extracted
}

/// Expands a local source into jars. A glob or directory keeps only the jars the loader would
/// take as mods, so side artifacts a build leaves next to the mod (sources, api) stay out.
fn local_jars(source: &Path) -> Result<Vec<PathBuf>> {
    let source_str = source.display().to_string();
    let (candidates, explicit) = if source_str.contains(['*', '?', '[']) {
        let matched = glob::glob(&source_str)
            .with_context(|| format!("invalid mod glob pattern: {source_str}"))?
            .filter_map(|entry| entry.ok())
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        (matched, false)
    } else if source.is_file() {
        return Ok(vec![source.to_path_buf()]);
    } else if source.is_dir() {
        let jars = WalkDir::new(source)
            .max_depth(1)
            .into_iter()
            .flatten()
            .map(|entry| entry.into_path())
            .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "jar"))
            .collect::<Vec<_>>();
        (jars, true)
    } else {
        bail!("mod source does not exist: {}", source.display());
    };

    let mut mods = Vec::new();
    let mut skipped = Vec::new();
    for path in candidates {
        let side_artifact = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("-sources.jar") || name.ends_with("-dev.jar"));
        if !side_artifact && is_mod_jar(&path)? {
            mods.push(path);
        } else {
            skipped.push(path.display().to_string());
        }
    }
    if mods.is_empty() && !explicit {
        bail!(
            "mod glob pattern matched no mod jars: {source_str}{}",
            if skipped.is_empty() {
                String::new()
            } else {
                format!(" (skipped jars that are not mods: {})", skipped.join(", "))
            }
        );
    }
    Ok(mods)
}

/// Whether the loader takes this jar as a mod: it declares one in a mods.toml, or its manifest
/// names an FML mod type (a library or language provider).
fn is_mod_jar(path: &Path) -> Result<bool> {
    let file =
        fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return Ok(false);
    };
    if zip.index_for_name("META-INF/neoforge.mods.toml").is_some()
        || zip.index_for_name("META-INF/mods.toml").is_some()
    {
        return Ok(true);
    }
    let Ok(mut manifest) = zip.by_name("META-INF/MANIFEST.MF") else {
        return Ok(false);
    };
    let mut body = String::new();
    std::io::Read::read_to_string(&mut manifest, &mut body)
        .with_context(|| format!("failed to read the manifest of {}", path.display()))?;
    Ok(body.lines().any(|line| line.starts_with("FMLModType:")))
}

#[derive(Debug)]
pub struct SyncReport {
    pub manifest: PathBuf,
    pub mods: BTreeMap<String, Vec<PathBuf>>,
}

/// Fetches every mod that does not come from a local path, in the base config and each of its
/// profiles, into the store and rewrites this checkout's `mods.json`, which maps each mod name
/// to its jars. A name must resolve to the same jars wherever it is declared.
pub async fn sync(configs: &[LoadedBlockwrightConfig]) -> Result<SyncReport> {
    let loaded = configs.first().context("no config to sync")?;
    let store = loaded.store_dir();
    let lock_dir = store.clone();
    let _lock = blocking(move || StoreLock::shared(&lock_dir)).await?;
    let mut mods: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for config in configs {
        for (name, files) in sync_one(config, &store).await? {
            let paths: Vec<PathBuf> = files.into_iter().map(|file| file.path).collect();
            match mods.get(&name) {
                Some(seen) if *seen != paths => {
                    bail!(
                    "mod {name:?} resolves to different jars in {}{}; give them different names",
                    config.path.display(),
                    config.profile.as_deref().map(|p| format!(" [profile.{p}]")).unwrap_or_default()
                )
                }
                _ => {
                    mods.insert(name, paths);
                }
            }
        }
    }

    let manifest = loaded.root.join(MANIFEST);
    if let Some(parent) = manifest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let tmp = manifest.with_extension(format!("json.{}", Uuid::new_v4()));
    fs::write(&tmp, serde_json::to_vec_pretty(&mods)?)
        .with_context(|| format!("failed to write {}", tmp.display()))?;
    fs::rename(&tmp, &manifest)
        .with_context(|| format!("failed to write {}", manifest.display()))?;
    Ok(SyncReport { manifest, mods })
}

async fn sync_one(
    loaded: &LoadedBlockwrightConfig,
    store: &Path,
) -> Result<BTreeMap<String, Vec<CachedFile>>> {
    let names: Vec<&str> = loaded
        .config
        .mods
        .iter()
        .filter(|(_, spec)| spec.path.is_none())
        .map(|(name, _)| name.as_str())
        .collect();
    let resolved = resolve(loaded, &Cache::new(store), &names).await?;
    let keys = resolved
        .values()
        .flatten()
        .map(|file| file.hash.key())
        .collect();
    record_refs(store, &loaded.path, &loaded.refs_label("sync"), keys)
        .context("failed to record which mods this config uses")?;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_config;
    use crate::store::gc::{gc, GcReport, GcScope};
    use crate::test_support::TempDir;
    use std::io::Write;

    struct Project {
        _tmp: TempDir,
        root: PathBuf,
        store: PathBuf,
        cache: Cache,
    }

    fn project(tag: &str) -> Project {
        let tmp = TempDir::new(tag);
        let root = tmp.path().to_path_buf();
        let store = root.join(".blockwright-store");
        let cache = Cache::new(&store);
        Project {
            _tmp: tmp,
            root,
            store,
            cache,
        }
    }

    /// Puts `bytes` in the CAS so a url lib pinned to it resolves without the network.
    fn seed(project: &Project, bytes: &[u8]) -> String {
        let seed = project.root.join("seed.bin");
        fs::write(&seed, bytes).unwrap();
        let hash = project
            .cache
            .put(&seed, "seed.bin", None, false)
            .unwrap()
            .hash;
        fs::remove_file(&seed).unwrap();
        hash.hex().to_string()
    }

    fn jar_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut buffer);
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        buffer.into_inner()
    }

    fn load(project: &Project, config: &str) -> LoadedBlockwrightConfig {
        let path = project.root.join("blockwright.toml");
        fs::write(&path, config).unwrap();
        load_config(&path).unwrap()
    }

    /// gc stands down while anything holds the store lock, which a process forked by a
    /// parallel test can do for a moment, so a test that needs a pass retries until one runs.
    fn gc_until_it_runs(store: &Path) -> GcReport {
        let nowhere = store.join("nowhere");
        let scope = GcScope {
            store_dir: store,
            instances_dir: &nowhere,
            traces_dir: &nowhere,
            registry_root: &nowhere,
        };
        for _ in 0..100 {
            if let Some(report) = gc(&scope, false).unwrap() {
                return report;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("gc never got the store lock");
    }

    fn manifest(project: &Project) -> BTreeMap<String, Vec<PathBuf>> {
        serde_json::from_slice(&fs::read(project.root.join(MANIFEST)).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn sync_fetches_each_mod_into_the_cache_and_lists_it_in_the_checkout() {
        let project = project("mods-sync");
        let sha = seed(&project, b"create bytes");
        let loaded = load(
            &project,
            &format!(
                "[mods]\ncreate = {{ url = \"https://blockwright.invalid/create-6.0.10.jar\", sha256 = \"{sha}\" }}\n"
            ),
        );

        let report = sync(std::slice::from_ref(&loaded)).await.unwrap();

        let path = &report.mods["create"][0];
        assert!(
            path.starts_with(project.store.join("cache")),
            "{}",
            path.display()
        );
        assert_eq!(fs::read(path).unwrap(), b"create bytes");
        assert_eq!(manifest(&project), report.mods);
        assert!(
            !project.store.join("mods.json").exists(),
            "the manifest never enters the store"
        );
    }

    #[tokio::test]
    async fn an_entry_mod_is_taken_out_of_another_mods_archive() {
        let project = project("mods-entry");
        let sha = seed(
            &project,
            &jar_with(&[
                ("META-INF/jarjar/l2core-3.0.8.jar", b"core"),
                ("META-INF/jarjar/l2serial-3.1.1.jar", b"serial"),
            ]),
        );
        let loaded = load(
            &project,
            &format!(
                r#"[mods]
l2library = {{ url = "https://blockwright.invalid/l2library-3.0.8.jar", sha256 = "{sha}" }}
l2core = {{ from = "l2library", entry = "META-INF/jarjar/l2core-*.jar" }}
"#
            ),
        );

        let report = sync(std::slice::from_ref(&loaded)).await.unwrap();

        let core = &report.mods["l2core"][0];
        assert_eq!(core.file_name().unwrap(), "l2core-3.0.8.jar");
        assert_eq!(fs::read(core).unwrap(), b"core");
    }

    #[tokio::test]
    async fn an_entry_pattern_must_match_exactly_one_file() {
        let project = project("mods-entry-ambiguous");
        let sha = seed(
            &project,
            &jar_with(&[
                ("META-INF/jarjar/a.jar", b"a"),
                ("META-INF/jarjar/b.jar", b"b"),
            ]),
        );
        let loaded = load(
            &project,
            &format!(
                r#"[mods]
outer = {{ url = "https://blockwright.invalid/outer.jar", sha256 = "{sha}" }}
inner = {{ from = "outer", entry = "META-INF/jarjar/*.jar" }}
missing = {{ from = "outer", entry = "nothing-*.jar" }}
"#
            ),
        );

        let error = format!(
            "{:#}",
            resolve(&loaded, &project.cache, &["inner"])
                .await
                .unwrap_err()
        );
        assert!(error.contains("matches 2 entries"), "{error}");
        let error = format!(
            "{:#}",
            resolve(&loaded, &project.cache, &["missing"])
                .await
                .unwrap_err()
        );
        assert!(error.contains("no entry"), "{error}");
    }

    #[tokio::test]
    async fn two_checkouts_pinning_different_versions_share_one_store() {
        let project = project("mods-versions");
        let old = seed(&project, b"create 6.0.9");
        let new = seed(&project, b"create 6.0.10");
        let checkout = |dir: &str, sha: &str, version: &str| {
            let root = project.root.join(dir);
            fs::create_dir_all(&root).unwrap();
            let path = root.join("blockwright.toml");
            fs::write(
                &path,
                format!(
                    "[store]\ndir = \"{}\"\n[mods]\ncreate = {{ url = \"https://blockwright.invalid/create-{version}.jar\", sha256 = \"{sha}\" }}\n",
                    project.store.display()
                ),
            )
            .unwrap();
            load_config(&path).unwrap()
        };

        let first = sync(std::slice::from_ref(&checkout("a", &old, "6.0.9")))
            .await
            .unwrap();
        let second = sync(std::slice::from_ref(&checkout("b", &new, "6.0.10")))
            .await
            .unwrap();
        gc_until_it_runs(&project.store);

        assert_ne!(first.mods["create"], second.mods["create"]);
        assert_eq!(fs::read(&first.mods["create"][0]).unwrap(), b"create 6.0.9");
        assert_eq!(
            fs::read(&second.mods["create"][0]).unwrap(),
            b"create 6.0.10"
        );
        assert_ne!(first.manifest, second.manifest);
    }

    #[tokio::test]
    async fn gc_drops_the_versions_no_config_references_any_more() {
        let project = project("mods-gc");
        let old = seed(&project, b"old");
        let new = seed(&project, b"new");
        let lib = |sha: &str| {
            format!("[mods]\nx = {{ url = \"https://blockwright.invalid/x.jar\", sha256 = \"{sha}\" }}\n")
        };

        let dropped = sync(std::slice::from_ref(&load(&project, &lib(&old))))
            .await
            .unwrap()
            .mods["x"][0]
            .clone();
        let kept = sync(std::slice::from_ref(&load(&project, &lib(&new))))
            .await
            .unwrap()
            .mods["x"][0]
            .clone();
        gc_until_it_runs(&project.store);

        assert!(!dropped.exists());
        assert!(kept.exists());
    }

    #[tokio::test]
    async fn mods_that_take_files_from_each_other_in_a_circle_are_refused() {
        let project = project("mods-circle");
        let loaded = load(
            &project,
            "[mods]\na = { from = \"b\", entry = \"x\" }\nb = { from = \"a\", entry = \"x\" }\n",
        );

        let error = format!(
            "{:#}",
            resolve(&loaded, &project.cache, &["a"]).await.unwrap_err()
        );
        assert!(error.contains("a -> b -> a"), "{error}");
    }

    #[tokio::test]
    async fn an_unknown_mod_lists_the_declared_ones() {
        let project = project("mods-unknown");
        let sha = seed(&project, b"x");
        let loaded = load(
            &project,
            &format!(
                "[mods]\nx = {{ url = \"https://blockwright.invalid/x.jar\", sha256 = \"{sha}\" }}\n\
                 inner = {{ from = \"y\", entry = \"a.jar\" }}\n"
            ),
        );

        let error = format!(
            "{:#}",
            resolve(&loaded, &project.cache, &["inner"])
                .await
                .unwrap_err()
        );
        assert!(error.contains("declared: inner, x"), "{error}");
    }

    fn jar(dir: &Path, name: &str, entries: &[(&str, &str)]) -> PathBuf {
        use std::io::Write;
        let path = dir.join(name);
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (entry, body) in entries {
            zip.start_file(*entry, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn a_glob_keeps_only_the_jars_the_loader_takes_as_mods() {
        let tmp = crate::test_support::TempDir::new("mod-glob");
        let dir = tmp.path();
        let toml = ("META-INF/neoforge.mods.toml", "modLoader = \"javafml\"");
        let main = jar(dir, "mod-1.0.jar", &[toml]);
        jar(dir, "mod-1.0-api.jar", &[("a/Api.class", "")]);
        jar(dir, "mod-1.0-sources.jar", &[toml]);
        let library = jar(
            dir,
            "mod-1.0-lib.jar",
            &[(
                "META-INF/MANIFEST.MF",
                "Manifest-Version: 1.0\nFMLModType: LIBRARY\n",
            )],
        );
        std::fs::write(dir.join("mod-1.0-broken.jar"), b"not a zip").unwrap();

        let mut found = local_jars(&dir.join("mod-*.jar")).unwrap();
        found.sort();
        assert_eq!(found, vec![library.clone(), main.clone()]);

        let mut listed = local_jars(dir).unwrap();
        listed.sort();
        assert_eq!(listed, vec![library, main]);
    }

    #[test]
    fn a_glob_matching_only_side_artifacts_names_what_it_skipped() {
        let tmp = crate::test_support::TempDir::new("mod-glob-none");
        jar(tmp.path(), "mod-1.0-api.jar", &[("a/Api.class", "")]);

        let error = local_jars(&tmp.path().join("mod-*.jar"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("matched no mod jars"), "{error}");
        assert!(error.contains("mod-1.0-api.jar"), "{error}");
    }

    #[test]
    fn an_explicit_path_is_taken_as_given() {
        let tmp = crate::test_support::TempDir::new("mod-explicit");
        let api = jar(tmp.path(), "mod-1.0-api.jar", &[("a/Api.class", "")]);
        assert_eq!(local_jars(&api).unwrap(), vec![api]);
    }
}
