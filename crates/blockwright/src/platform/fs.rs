//! File operations whose Windows semantics differ from Unix. Replacing or deleting a
//! read-only name must never clear attributes on the underlying file: another hardlink
//! may still belong to the store or a retained instance.

use std::{fs, io, path::Path};

/// Produces an independent file without preventing a build from rewriting the source.
/// Windows CopyFile opens the source with sharing modes that can reject concurrent writes.
pub(crate) fn copy_independent(src: &Path, dest: &Path) -> io::Result<()> {
    #[cfg(unix)]
    return reflink_copy::reflink_or_copy(src, dest).map(|_| ());
    #[cfg(windows)]
    {
        let mut source = fs::File::open(src)?;
        let permissions = source.metadata()?.permissions();
        let mut target = fs::File::options()
            .write(true)
            .create_new(true)
            .open(dest)?;
        io::copy(&mut source, &mut target)?;
        target.set_permissions(permissions)?;
        Ok(())
    }
}

/// Content-addressed jars are data, so Unix execute bits are intentionally removed.
pub(crate) fn set_content_readonly(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o444))
    }
    #[cfg(windows)]
    set_readonly(path)
}

pub(crate) fn set_readonly(path: &Path) -> io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() & 0o555);
    }
    #[cfg(windows)]
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

/// Only call on a newly created, independent file, never an existing instance/store link.
pub(crate) fn make_writable(path: &Path) -> io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() | 0o200);
    }
    #[cfg(windows)]
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

/// Atomically publishes a file staged on the destination filesystem. A failed rename
/// leaves the old destination intact, including its attributes.
pub(crate) fn replace_file(staged: &Path, dest: &Path) -> io::Result<()> {
    #[cfg(unix)]
    return fs::rename(staged, dest);
    #[cfg(windows)]
    return windows::replace_file(staged, dest);
}

pub(crate) fn remove_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    return fs::remove_file(path);
    #[cfg(windows)]
    return windows::remove(path);
}

pub(crate) fn remove_dir_all(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    return fs::remove_dir_all(path);
    #[cfg(windows)]
    {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return windows::remove(path);
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() && !kind.is_symlink() {
                remove_dir_all(&entry.path())?;
            } else {
                windows::remove(&entry.path())?;
            }
        }
        windows::remove(path)
    }
}

pub(crate) fn same_file(left: &Path, right: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(left), fs::metadata(right)) {
            (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
            _ => false,
        }
    }
    #[cfg(windows)]
    {
        match (windows::identity(left), windows::identity(right)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        fs::{File, OpenOptions},
        mem::{offset_of, size_of},
        os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
        ptr,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfoEx, FileRenameInfoEx, GetFileInformationByHandle,
        SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_RENAME_INFO, FILE_WRITE_ATTRIBUTES,
    };

    fn deletion_handle(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .access_mode(DELETE | FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    pub(super) fn replace_file(staged: &Path, dest: &Path) -> io::Result<()> {
        let file = deletion_handle(staged)?;
        let parent = dest
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = dest.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "replacement target has no file name",
            )
        })?;
        // canonicalize supplies an absolute extended-length Windows path, even if dest
        // does not exist yet. Only the already-existing parent needs resolving.
        let absolute = fs::canonicalize(parent)?.join(name);
        let mut name: Vec<u16> = absolute.as_os_str().encode_wide().collect();
        if name.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        let name_bytes = u32::try_from(
            name.len()
                .checked_mul(2)
                .ok_or(io::ErrorKind::InvalidInput)?,
        )
        .map_err(|_| io::ErrorKind::InvalidInput)?;
        name.push(0);
        let offset = offset_of!(FILE_RENAME_INFO, FileName);
        let bytes = offset + name.len() * 2;
        let info_bytes = u32::try_from(bytes).map_err(|_| io::ErrorKind::InvalidInput)?;
        // usize storage provides the alignment required by FILE_RENAME_INFO, whose
        // trailing FileName field is a variable-length UTF-16 buffer.
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS |
        // FILE_RENAME_IGNORE_READONLY_ATTRIBUTE (documented FileRenameInformationEx flags).
        unsafe {
            (*info).Anonymous.Flags = 0x1 | 0x2 | 0x40;
            (*info).RootDirectory = ptr::null_mut();
            (*info).FileNameLength = name_bytes;
            ptr::copy_nonoverlapping(
                name.as_ptr(),
                ptr::addr_of_mut!((*info).FileName).cast(),
                name.len(),
            );
            if SetFileInformationByHandle(
                file.as_raw_handle(),
                FileRenameInfoEx,
                info.cast(),
                info_bytes,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    pub(super) fn remove(path: &Path) -> io::Result<()> {
        let file = deletion_handle(path)?;
        let info = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        };
        // This removes one directory entry without modifying the shared file's readonly
        // attribute. Unsupported filesystems fail explicitly; attributes are never cleared.
        unsafe {
            if SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfoEx,
                ptr::from_ref(&info).cast(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    pub(super) fn identity(path: &Path) -> io::Result<(u32, u32, u32)> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe {
            if GetFileInformationByHandle(file.as_raw_handle(), &mut info) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok((
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn replace_readonly_hardlink_preserves_the_other_names_permissions_and_bytes() {
        let tmp = TempDir::new("fs-replace-link");
        tmp.write("base", "old");
        tmp.write("staged", "new");
        let base = tmp.path().join("base");
        let dest = tmp.path().join("dest");
        fs::hard_link(&base, &dest).unwrap();
        set_readonly(&base).unwrap();

        replace_file(&tmp.path().join("staged"), &dest).unwrap();

        assert_eq!(fs::read(&base).unwrap(), b"old");
        assert!(fs::metadata(&base).unwrap().permissions().readonly());
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        assert!(!same_file(&base, &dest));
        assert!(!tmp.path().join("staged").exists());
        remove_dir_all(tmp.path()).unwrap();
    }

    #[test]
    fn deleting_a_readonly_hardlink_does_not_unprotect_the_remaining_link() {
        let tmp = TempDir::new("fs-remove-link");
        tmp.write("base", "protected");
        let base = tmp.path().join("base");
        let dest = tmp.path().join("dest");
        fs::hard_link(&base, &dest).unwrap();
        set_readonly(&base).unwrap();

        remove_file(&dest).unwrap();

        assert!(!dest.exists());
        assert_eq!(fs::read(&base).unwrap(), b"protected");
        assert!(fs::metadata(&base).unwrap().permissions().readonly());
        remove_dir_all(tmp.path()).unwrap();
    }

    #[test]
    fn recursive_delete_handles_readonly_files_without_modifying_shared_attributes() {
        let tmp = TempDir::new("fs-remove-tree");
        tmp.write("base", "protected");
        let base = tmp.path().join("base");
        let tree = tmp.path().join("tree");
        fs::create_dir_all(tree.join("nested")).unwrap();
        fs::hard_link(&base, tree.join("nested/link")).unwrap();
        set_readonly(&base).unwrap();

        remove_dir_all(&tree).unwrap();

        assert!(!tree.exists());
        assert!(fs::metadata(&base).unwrap().permissions().readonly());
        remove_dir_all(tmp.path()).unwrap();
    }

    #[test]
    fn failed_replacement_preserves_the_destination_and_staged_file() {
        let tmp = TempDir::new("fs-replace-fail");
        tmp.write("dest/child", "old");
        tmp.write("staged", "new");
        assert!(replace_file(&tmp.path().join("staged"), &tmp.path().join("dest")).is_err());
        assert_eq!(fs::read(tmp.path().join("dest/child")).unwrap(), b"old");
        assert_eq!(fs::read(tmp.path().join("staged")).unwrap(), b"new");
    }

    #[cfg(windows)]
    #[test]
    fn a_handle_denying_delete_makes_replacement_fail_without_changing_readonly() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = TempDir::new("fs-replace-open");
        tmp.write("dest", "old");
        tmp.write("staged", "new");
        let dest = tmp.path().join("dest");
        set_readonly(&dest).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&dest)
            .unwrap();

        assert!(replace_file(&tmp.path().join("staged"), &dest).is_err());

        assert_eq!(fs::read(&dest).unwrap(), b"old");
        assert!(fs::metadata(&dest).unwrap().permissions().readonly());
        assert_eq!(fs::read(tmp.path().join("staged")).unwrap(), b"new");
        drop(held);
        remove_dir_all(tmp.path()).unwrap();
    }
}
