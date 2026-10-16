//! Operating-system operations shared by the runtime and native driver.

pub(crate) mod fs;
pub mod process;

pub const TARGET: &str = if cfg!(windows) {
    "win32-x64"
} else {
    "linux-x64"
};

/// Removes an owned instance tree without changing shared file attributes.
pub fn remove_owned_dir_all(path: &std::path::Path) -> std::io::Result<()> {
    fs::remove_dir_all(path)
}
