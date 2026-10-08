#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!(
    "blockwright only supports Linux x86_64 (and, on the GPU side, only the NVIDIA proprietary driver).\
     \nDisplay, audio capture, port allocation and LWJGL native extraction depend on X11/EGL, /proc and :natives-linux,\
     \nand have no implementation on other platforms."
);

pub mod config;
pub mod coverage;
pub mod engine;
pub mod http;
pub mod mods;
pub mod neoforge;
pub mod process;
pub mod registry;
pub mod store;
pub mod trace;

#[cfg(test)]
pub(crate) mod test_support;
