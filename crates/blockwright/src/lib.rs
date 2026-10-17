#[cfg(not(all(
    any(target_os = "linux", target_os = "windows"),
    target_arch = "x86_64"
)))]
compile_error!("blockwright only supports Linux x86_64 and Windows x86_64.");

pub mod config;
pub mod coverage;
pub mod engine;
pub mod http;
pub mod mods;
pub mod neoforge;
pub mod platform;
pub mod process;
pub mod registry;
pub mod store;
pub mod trace;

#[cfg(test)]
pub(crate) mod test_support;
