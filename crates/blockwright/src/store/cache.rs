//! The content cache: every downloaded or ingested file lives once under
//! `<store>/cache/<algo>-<hex>/<filename>` and is linked, reflinked or copied into instances.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256, Sha512};
use uuid::Uuid;
use walkdir::WalkDir;

use super::hex_lower;
use crate::platform::fs as platform_fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HashAlgo {
    Sha256,
    Sha512,
}

impl HashAlgo {
    pub fn as_str(self) -> &'static str {
        match self {
            HashAlgo::Sha256 => "sha256",
            HashAlgo::Sha512 => "sha512",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hash {
    algo: HashAlgo,
    hex: String,
}

impl Hash {
    pub fn from_hex(algo: HashAlgo, hex: impl Into<String>) -> Self {
        Hash {
            algo,
            hex: hex.into().to_ascii_lowercase(),
        }
    }

    pub fn of(algo: HashAlgo, bytes: &[u8]) -> Self {
        let hex = match algo {
            HashAlgo::Sha256 => hex_lower(&Sha256::digest(bytes)),
            HashAlgo::Sha512 => hex_lower(&Sha512::digest(bytes)),
        };
        Hash { algo, hex }
    }

    pub fn algo(&self) -> HashAlgo {
        self.algo
    }

    pub fn hex(&self) -> &str {
        &self.hex
    }

    /// Fails unless `bytes` hash to this value; `label` names them in the error.
    pub fn verify(&self, label: &str, bytes: &[u8]) -> Result<()> {
        let actual = Hash::of(self.algo, bytes);
        if actual != *self {
            bail!(
                "{} mismatch for {label}: expected {}, got {}",
                self.algo.as_str(),
                self.hex,
                actual.hex
            );
        }
        Ok(())
    }

    /// The cache directory name, which is also how refs name the entry.
    pub fn key(&self) -> String {
        format!("{}-{}", self.algo.as_str(), self.hex)
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.algo.as_str(), self.hex)
    }
}

/// A file in the cache and the name it goes by in an instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedFile {
    pub filename: String,
    pub hash: Hash,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Cache {
    root: PathBuf,
}

impl Cache {
    pub const DIR: &'static str = "cache";

    pub fn new(store_dir: &Path) -> Self {
        Cache {
            root: store_dir.join(Self::DIR),
        }
    }

    fn entry_dir(&self, hash: &Hash) -> PathBuf {
        self.root.join(hash.key())
    }

    /// The cached file with this content, if any.
    pub fn get(&self, hash: &Hash, filename: &str) -> Option<CachedFile> {
        let file = fs::read_dir(self.entry_dir(hash))
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.is_file())?;
        Some(CachedFile {
            filename: filename.to_string(),
            hash: hash.clone(),
            path: file,
        })
    }

    /// Adds `src` under `filename`, moving it when `take` is set (it must then be scratch
    /// space on the store's filesystem) and copying it otherwise. `known` skips hashing.
    pub fn put(
        &self,
        src: &Path,
        filename: &str,
        known: Option<Hash>,
        take: bool,
    ) -> Result<CachedFile> {
        let hash = match known {
            Some(hash) => hash,
            None => hash_file(src)?,
        };
        if let Some(cached) = self.get(&hash, filename) {
            if take {
                let _ = platform_fs::remove_file(src);
            }
            return Ok(cached);
        }

        let staging = self.root.join(format!(".staging-{}", Uuid::new_v4()));
        let staged = staging.join(filename);
        let result = (|| -> Result<()> {
            fs::create_dir_all(&staging)
                .with_context(|| format!("failed to create {}", staging.display()))?;
            if take {
                fs::rename(src, &staged)
            } else {
                platform_fs::copy_independent(src, &staged).map(|_| ())
            }
            .with_context(|| format!("failed to add {} to the cache", src.display()))?;
            platform_fs::set_content_readonly(&staged)?;
            match fs::rename(&staging, self.entry_dir(&hash)) {
                Ok(()) => Ok(()),
                Err(_) if self.get(&hash, filename).is_some() => Ok(()),
                Err(error) => Err(error).context("failed to publish a cache entry"),
            }
        })();
        let _ = platform_fs::remove_dir_all(&staging);
        if take {
            let _ = platform_fs::remove_file(src);
        }
        result?;
        self.get(&hash, filename)
            .context("a cache entry vanished right after it was added")
    }

    /// The cached file for `hash`, downloading `url` only when the cache lacks it.
    pub async fn fetch(&self, url: &str, filename: &str, hash: Hash) -> Result<CachedFile> {
        if let Some(cached) = self.get(&hash, filename) {
            return Ok(cached);
        }
        let bytes = crate::http::get_bytes(url).await?;
        hash.verify(url, &bytes)?;
        let scratch = self.scratch(filename)?;
        if let Err(error) = fs::write(&scratch, &bytes) {
            let _ = platform_fs::remove_file(&scratch);
            return Err(error).with_context(|| format!("failed to write {}", scratch.display()));
        }
        let cache = self.clone();
        let filename = filename.to_string();
        crate::engine::blocking(move || cache.put(&scratch, &filename, Some(hash), true)).await
    }

    /// Adds a file that may be rewritten while it is read, such as a jar a build is replacing.
    /// The bytes are copied into scratch space first and the hash is taken of that copy, so the
    /// entry always holds exactly the bytes it is named by; the copy is retried while the source
    /// changes under it. A source whose size and mtime are unchanged since it was last added here
    /// is neither copied nor hashed again.
    pub fn put_local(&self, src: &Path, filename: &str) -> Result<CachedFile> {
        static ADDED: OnceLock<Mutex<HashMap<PathBuf, (Stamp, Hash)>>> = OnceLock::new();
        const ATTEMPTS: usize = 3;

        let canonical = fs::canonicalize(src)
            .with_context(|| format!("failed to resolve {}", src.display()))?;
        let added = ADDED.get_or_init(Default::default);
        let mut before = stamp(&canonical)?;
        if let Some((seen, hash)) = added.lock().unwrap().get(&canonical) {
            if *seen == before {
                if let Some(cached) = self.get(hash, filename) {
                    return Ok(cached);
                }
            }
        }
        for attempt in 1..=ATTEMPTS {
            let scratch = self.scratch(filename)?;
            let staged = (|| -> Result<Hash> {
                platform_fs::copy_independent(&canonical, &scratch).with_context(|| {
                    format!("failed to copy {} into the cache", canonical.display())
                })?;
                hash_file(&scratch)
            })();
            let hash = match staged {
                Ok(hash) => hash,
                Err(error) => {
                    let _ = platform_fs::remove_file(&scratch);
                    return Err(error);
                }
            };
            let after = match stamp(&canonical) {
                Ok(stamp) => stamp,
                Err(error) => {
                    let _ = platform_fs::remove_file(&scratch);
                    return Err(error);
                }
            };
            if after != before && attempt < ATTEMPTS {
                // Rewritten mid-copy: the copy may be torn, so take the new bytes instead.
                let _ = platform_fs::remove_file(&scratch);
                before = after;
                continue;
            }
            let cached = self.put(&scratch, filename, Some(hash), true)?;
            if after == before {
                added
                    .lock()
                    .unwrap()
                    .insert(canonical, (before, cached.hash.clone()));
            }
            return Ok(cached);
        }
        unreachable!("the last attempt always returns")
    }

    /// A fresh path on the cache's filesystem for a file about to be added with `take`.
    pub fn scratch(&self, filename: &str) -> Result<PathBuf> {
        fs::create_dir_all(&self.root)
            .with_context(|| format!("failed to create {}", self.root.display()))?;
        Ok(self
            .root
            .join(format!(".scratch-{}-{filename}", Uuid::new_v4())))
    }
}

/// A file's size and mtime, which change when it is rewritten.
type Stamp = (u64, SystemTime);

fn stamp(path: &Path) -> Result<Stamp> {
    let meta = fs::metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    Ok((meta.len(), meta.modified()?))
}

pub fn hash_file(src: &Path) -> Result<Hash> {
    let mut file = fs::File::open(src)
        .with_context(|| format!("failed to open {} for hashing", src.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .with_context(|| format!("failed to read {} for hashing", src.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(Hash::from_hex(
        HashAlgo::Sha256,
        hex_lower(&hasher.finalize()),
    ))
}

/// Puts `src` at `dest` without copying bytes where the filesystem allows: a reflink, else a
/// hardlink, else a copy on Unix; Windows always gets an independent copy. The file is staged
/// beside `dest` and renamed over it, because `dest`
/// may already be another hardlink of `src` (a concurrent launch placed it), and opening it for
/// writing would truncate the cache entry itself.
pub fn place(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    #[cfg(unix)]
    if platform_fs::same_file(src, dest) {
        return Ok(());
    }
    #[cfg(windows)]
    if platform_fs::same_file(src, dest)
        && fs::canonicalize(src).ok() == fs::canonicalize(dest).ok()
    {
        return Ok(());
    }
    #[cfg(windows)]
    return copy_over(src, dest, false);
    #[cfg(unix)]
    {
        let staged = beside(dest);
        let result = (|| -> Result<()> {
            if reflink_copy::reflink(src, &staged).is_err() && fs::hard_link(src, &staged).is_err()
            {
                fs::copy(src, &staged).with_context(|| {
                    format!("failed to copy {} to {}", src.display(), dest.display())
                })?;
            }
            platform_fs::replace_file(&staged, dest)
                .with_context(|| format!("failed to replace {}", dest.display()))
        })();
        // Renaming one link of a file onto another link of it leaves the staged name behind.
        let _ = platform_fs::remove_file(&staged);
        result
    }
}

/// How `link_tree` puts one file of the base into `dest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// A hardlink on Unix, or an independent copy with the source's permissions on Windows.
    Link,
    /// A writable copy of its own, for files the instance may change.
    Copy,
    Skip,
}

/// Links or copies every file of `base` into `dest` as `placement` says for its relative path,
/// keeping files `dest` already has. Nothing is written through a path that may already be a
/// link into the base: copies are staged beside the target and renamed into place.
pub fn link_tree(base: &Path, dest: &Path, placement: impl Fn(&Path) -> Placement) -> Result<()> {
    for entry in WalkDir::new(base) {
        let entry = entry.with_context(|| format!("failed to walk {}", base.display()))?;
        let rel = entry.path().strip_prefix(base)?;
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)
                .with_context(|| format!("failed to create {}", target.display()))?;
            continue;
        }
        if !entry.file_type().is_file() || fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        match placement(rel) {
            Placement::Skip => {}
            #[cfg(unix)]
            Placement::Link => match fs::hard_link(entry.path(), &target) {
                Ok(()) => {}
                // A concurrent fill got there first; what it put there is kept, as above.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => copy_over(entry.path(), &target, false)?,
            },
            #[cfg(windows)]
            Placement::Link => copy_over(entry.path(), &target, false)?,
            Placement::Copy => copy_over(entry.path(), &target, true)?,
        }
    }
    Ok(())
}

/// Replaces `path` with `bytes` through a rename, so a hardlink into the store that was there is
/// swapped out instead of written through.
pub fn write_replacing(path: &Path, bytes: impl AsRef<[u8]>) -> Result<()> {
    let staged = beside(path);
    let result = fs::write(&staged, bytes)
        .and_then(|()| platform_fs::replace_file(&staged, path))
        .with_context(|| format!("failed to write {}", path.display()));
    if result.is_err() {
        let _ = platform_fs::remove_file(&staged);
    }
    result
}

/// Copies `src` to a fresh file beside `dest` and renames it over `dest`. The copy keeps the
/// source's permissions, plus write access when `writable`. Permission changes affect only
/// the newly copied file, never a link back into the shared store.
fn copy_over(src: &Path, dest: &Path, writable: bool) -> Result<()> {
    let staged = beside(dest);
    let result = (|| -> Result<()> {
        let permissions = fs::metadata(src)
            .with_context(|| format!("failed to stat {}", src.display()))?
            .permissions();
        platform_fs::copy_independent(src, &staged)
            .with_context(|| format!("failed to copy {} into {}", src.display(), dest.display()))?;
        fs::set_permissions(&staged, permissions)
            .with_context(|| format!("failed to set the mode of {}", staged.display()))?;
        if writable {
            platform_fs::make_writable(&staged)
                .with_context(|| format!("failed to make {} writable", staged.display()))?;
        }
        platform_fs::replace_file(&staged, dest)
            .with_context(|| format!("failed to place {}", dest.display()))
    })();
    if result.is_err() {
        let _ = platform_fs::remove_file(&staged);
    }
    result
}

/// A fresh hidden name in `path`'s directory, for a file about to be renamed onto `path`.
fn beside(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn put_hashes_new_content_and_dedups_it() {
        let tmp = TempDir::new("cache-put");
        let cache = Cache::new(tmp.path());
        tmp.write("a.jar", "same bytes");
        tmp.write("b.jar", "same bytes");

        let a = cache
            .put(&tmp.path().join("a.jar"), "a.jar", None, false)
            .unwrap();
        let b = cache
            .put(&tmp.path().join("b.jar"), "b.jar", None, false)
            .unwrap();

        assert_eq!(a.hash, Hash::of(HashAlgo::Sha256, b"same bytes"));
        assert_eq!(a.path, b.path, "one entry per content");
        assert_eq!(b.filename, "b.jar", "each caller keeps its own name");
        assert_eq!(fs::read(&a.path).unwrap(), b"same bytes");
        assert!(
            tmp.path().join("a.jar").exists(),
            "a copy leaves the source alone"
        );
    }

    #[test]
    fn put_local_follows_a_rewritten_source_and_keeps_the_old_entry() {
        let tmp = TempDir::new("cache-put-local");
        let cache = Cache::new(tmp.path());
        let src = tmp.path().join("build/libs/mod.jar");
        tmp.write("build/libs/mod.jar", "first build");
        let first = cache.put_local(&src, "mod.jar").unwrap();
        assert_eq!(first.hash, Hash::of(HashAlgo::Sha256, b"first build"));
        assert_eq!(cache.put_local(&src, "mod.jar").unwrap(), first);

        tmp.write("build/libs/mod.jar", "second build, longer");
        let second = cache.put_local(&src, "mod.jar").unwrap();

        assert_eq!(fs::read(&second.path).unwrap(), b"second build, longer");
        assert_eq!(fs::read(&first.path).unwrap(), b"first build");
    }

    /// Hashing the source and then copying it let a build rewriting the jar in between file
    /// the new (or half-written) bytes under the old hash.
    #[test]
    fn put_local_never_files_bytes_under_another_hash_while_the_source_is_rewritten() {
        let tmp = TempDir::new("cache-put-local-race");
        let cache = Cache::new(tmp.path());
        let src = tmp.path().join("mod.jar");
        tmp.write("mod.jar", "seed");
        let done = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut round = 0u32;
                while !done.load(std::sync::atomic::Ordering::Relaxed) {
                    let body = vec![b'a' + (round % 26) as u8; 256 * 1024 + round as usize];
                    fs::write(&src, body).unwrap();
                    round += 1;
                }
            });
            // Stops the writer even when an assertion fails, or the scope would never end.
            struct Stop<'a>(&'a std::sync::atomic::AtomicBool);
            impl Drop for Stop<'_> {
                fn drop(&mut self) {
                    self.0.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
            let _stop = Stop(&done);
            for _ in 0..200 {
                let cached = cache.put_local(&src, "mod.jar").unwrap();
                let bytes = fs::read(&cached.path).unwrap();
                assert_eq!(Hash::of(HashAlgo::Sha256, &bytes), cached.hash);
            }
        });
    }

    #[test]
    fn verify_rejects_bytes_that_do_not_match() {
        let hash = Hash::of(HashAlgo::Sha512, b"expected");
        hash.verify("x", b"expected").unwrap();
        let upper = Hash::from_hex(HashAlgo::Sha512, hash.hex().to_uppercase());
        upper.verify("x", b"expected").unwrap();
        let error = hash.verify("x", b"other").unwrap_err().to_string();
        assert!(error.contains("sha512 mismatch"), "{error}");
    }

    #[test]
    fn link_tree_places_files_and_keeps_existing_files() {
        let tmp = TempDir::new("cache-link-tree");
        tmp.write("base/libraries/a.jar", "lib");
        tmp.write("base/options.txt", "base");
        tmp.write("dest/options.txt", "mine");
        let (base, dest) = (tmp.path().join("base"), tmp.path().join("dest"));

        link_tree(&base, &dest, |_| Placement::Link).unwrap();

        assert_eq!(
            platform_fs::same_file(&base.join("libraries/a.jar"), &dest.join("libraries/a.jar")),
            cfg!(unix)
        );
        assert_eq!(
            fs::read_to_string(dest.join("options.txt")).unwrap(),
            "mine"
        );
    }

    fn mode(path: &Path) -> u32 {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        }
        #[cfg(windows)]
        {
            if fs::metadata(path).unwrap().permissions().readonly() {
                0o444
            } else {
                0o644
            }
        }
    }

    fn make_readonly(path: &Path) {
        platform_fs::set_readonly(path).unwrap();
    }

    #[test]
    fn link_tree_copies_writable_files_and_skips_what_it_is_told_to() {
        let tmp = TempDir::new("cache-link-tree-placement");
        tmp.write("base/libraries/a.jar", "lib");
        tmp.write("base/user_jvm_args.txt", "-Xmx2G");
        tmp.write("base/manifest.json", "{}");
        let (base, dest) = (tmp.path().join("base"), tmp.path().join("dest"));
        make_readonly(&base.join("user_jvm_args.txt"));

        link_tree(&base, &dest, |rel| match rel.to_str().unwrap() {
            "user_jvm_args.txt" => Placement::Copy,
            "manifest.json" => Placement::Skip,
            _ => Placement::Link,
        })
        .unwrap();

        let copy = dest.join("user_jvm_args.txt");
        assert!(!platform_fs::same_file(
            &copy,
            &base.join("user_jvm_args.txt")
        ));
        assert_eq!(mode(&copy), 0o644, "a private copy is writable");
        fs::write(&copy, "-Xmx4G").unwrap();
        assert_eq!(
            fs::read_to_string(base.join("user_jvm_args.txt")).unwrap(),
            "-Xmx2G"
        );
        assert!(!dest.join("manifest.json").exists());
    }

    #[test]
    fn link_tree_keeps_a_link_another_fill_already_made() {
        let tmp = TempDir::new("cache-link-tree-eexist");
        tmp.write("base/libraries/a.jar", "library bytes");
        let (base, dest) = (tmp.path().join("base"), tmp.path().join("dest"));
        let src = base.join("libraries/a.jar");
        make_readonly(&src);
        fs::create_dir_all(dest.join("libraries")).unwrap();
        fs::hard_link(&src, dest.join("libraries/a.jar")).unwrap();

        link_tree(&base, &dest, |_| Placement::Link).unwrap();
        place(&src, &dest.join("libraries/a.jar")).unwrap();

        assert_eq!(fs::read(&src).unwrap(), b"library bytes");
        #[cfg(unix)]
        assert_eq!(fs::metadata(&src).unwrap().nlink(), 2);
        #[cfg(windows)]
        assert!(!platform_fs::same_file(&src, &dest.join("libraries/a.jar")));
        let leftovers = fs::read_dir(dest.join("libraries")).unwrap().count();
        assert_eq!(leftovers, 1, "no staged file is left beside the target");
    }

    /// Two launches filling one instance dir at once used to truncate shared runtime files:
    /// one lost the `exists` / `hard_link` race and `fs::copy` opened the other's link to the
    /// same inode with O_TRUNC.
    #[test]
    fn concurrent_link_tree_into_one_dir_never_truncates_the_base() {
        let tmp = TempDir::new("cache-link-tree-race");
        let base = tmp.path().join("base");
        for index in 0..64 {
            tmp.write(
                &format!("base/libraries/{index}.jar"),
                format!("library {index}"),
            );
            tmp.write(&format!("base/loose-{index}.txt"), format!("loose {index}"));
        }
        let placement = |rel: &Path| {
            if rel.starts_with("libraries") {
                Placement::Link
            } else {
                Placement::Copy
            }
        };
        for round in 0..40 {
            let dest = tmp.path().join(format!("dest-{round}"));
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| link_tree(&base, &dest, placement).unwrap());
                }
            });
            for index in 0..64 {
                for (dir, rel, body) in [
                    (
                        &base,
                        format!("libraries/{index}.jar"),
                        format!("library {index}"),
                    ),
                    (
                        &dest,
                        format!("libraries/{index}.jar"),
                        format!("library {index}"),
                    ),
                    (
                        &dest,
                        format!("loose-{index}.txt"),
                        format!("loose {index}"),
                    ),
                ] {
                    assert_eq!(fs::read_to_string(dir.join(&rel)).unwrap(), body, "{rel}");
                }
            }
        }
    }

    #[test]
    fn concurrent_place_onto_one_target_never_truncates_the_cache_entry() {
        let tmp = TempDir::new("cache-place-race");
        let cache = Cache::new(tmp.path());
        tmp.write("mod.jar", "mod bytes");
        let cached = cache
            .put(&tmp.path().join("mod.jar"), "mod.jar", None, false)
            .unwrap();
        assert_eq!(mode(&cached.path), 0o444);

        for round in 0..100 {
            let dest = tmp.path().join(format!("instance-{round}/mods/mod.jar"));
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| place(&cached.path, &dest).unwrap());
                }
            });
            assert_eq!(fs::read(&cached.path).unwrap(), b"mod bytes");
            assert_eq!(fs::read(&dest).unwrap(), b"mod bytes");
            let entries = fs::read_dir(dest.parent().unwrap()).unwrap().count();
            assert_eq!(entries, 1, "no staged file is left beside the target");
        }
    }

    #[test]
    fn place_replaces_a_different_file_without_writing_through_it() {
        let tmp = TempDir::new("cache-place-replace");
        tmp.write("new.jar", "new");
        tmp.write("old.jar", "old");
        let dest = tmp.path().join("mods/mod.jar");
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::hard_link(tmp.path().join("old.jar"), &dest).unwrap();

        place(&tmp.path().join("new.jar"), &dest).unwrap();

        assert_eq!(fs::read_to_string(&dest).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(tmp.path().join("old.jar")).unwrap(),
            "old"
        );
    }

    #[test]
    fn write_replacing_breaks_a_link_to_a_read_only_file() {
        let tmp = TempDir::new("cache-write-replacing");
        tmp.write("store/options.txt", "base");
        let base = tmp.path().join("store/options.txt");
        let instance = tmp.path().join("options.txt");
        make_readonly(&base);
        fs::hard_link(&base, &instance).unwrap();

        write_replacing(&instance, "mine").unwrap();

        assert_eq!(fs::read_to_string(&instance).unwrap(), "mine");
        assert_eq!(fs::read_to_string(&base).unwrap(), "base");
    }

    #[test]
    fn failed_write_replacing_keeps_the_old_tree_and_removes_the_staged_file() {
        let tmp = TempDir::new("cache-write-fail");
        tmp.write("target/child", "old");
        let target = tmp.path().join("target");

        assert!(write_replacing(&target, "new").is_err());

        assert_eq!(fs::read(target.join("child")).unwrap(), b"old");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_instances_and_the_store_have_independent_files() {
        let tmp = TempDir::new("cache-windows-isolation");
        tmp.write("input.jar", "cached library");
        tmp.write("runtime/libraries/base.jar", "runtime library");
        tmp.write("runtime/user_jvm_args.txt", "-Xmx2G");
        let cache = Cache::new(&tmp.path().join("store"));
        let cached = cache
            .put(&tmp.path().join("input.jar"), "mod.jar", None, false)
            .unwrap();
        let runtime = tmp.path().join("runtime");
        make_readonly(&runtime.join("libraries/base.jar"));
        make_readonly(&runtime.join("user_jvm_args.txt"));
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        for instance in [&first, &second] {
            place(&cached.path, &instance.join("mods/mod.jar")).unwrap();
            link_tree(&runtime, instance, |rel| {
                if rel.starts_with("libraries") {
                    Placement::Link
                } else {
                    Placement::Copy
                }
            })
            .unwrap();
            assert!(!platform_fs::same_file(
                &cached.path,
                &instance.join("mods/mod.jar")
            ));
            assert!(!platform_fs::same_file(
                &runtime.join("libraries/base.jar"),
                &instance.join("libraries/base.jar")
            ));
            assert!(!fs::metadata(instance.join("user_jvm_args.txt"))
                .unwrap()
                .permissions()
                .readonly());
        }

        // Removing readonly on this independently copied instance must affect no other name.
        for rel in ["mods/mod.jar", "libraries/base.jar"] {
            platform_fs::make_writable(&first.join(rel)).unwrap();
            fs::write(first.join(rel), "instance changed").unwrap();
            assert!(fs::metadata(second.join(rel))
                .unwrap()
                .permissions()
                .readonly());
        }
        fs::write(first.join("user_jvm_args.txt"), "-Xmx4G").unwrap();
        assert_eq!(fs::read(&cached.path).unwrap(), b"cached library");
        assert_eq!(
            fs::read(second.join("mods/mod.jar")).unwrap(),
            b"cached library"
        );
        assert_eq!(
            fs::read(runtime.join("libraries/base.jar")).unwrap(),
            b"runtime library"
        );
        assert_eq!(
            fs::read(second.join("libraries/base.jar")).unwrap(),
            b"runtime library"
        );
        assert_eq!(
            fs::read(runtime.join("user_jvm_args.txt")).unwrap(),
            b"-Xmx2G"
        );
        assert_eq!(
            fs::read(second.join("user_jvm_args.txt")).unwrap(),
            b"-Xmx2G"
        );
        assert!(fs::metadata(&cached.path).unwrap().permissions().readonly());
    }

    #[cfg(windows)]
    #[test]
    fn failed_readonly_placement_preserves_old_bytes_and_cleans_staging() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = TempDir::new("cache-windows-place-fail");
        tmp.write("source", "new");
        tmp.write("mods/mod.jar", "old");
        let source = tmp.path().join("source");
        let dest = tmp.path().join("mods/mod.jar");
        make_readonly(&source);
        make_readonly(&dest);
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&dest)
            .unwrap();

        assert!(place(&source, &dest).is_err());

        assert_eq!(fs::read(&dest).unwrap(), b"old");
        assert_eq!(fs::read(&source).unwrap(), b"new");
        assert!(fs::metadata(&dest).unwrap().permissions().readonly());
        assert!(fs::metadata(&source).unwrap().permissions().readonly());
        assert_eq!(fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);
        drop(held);
    }
}
