use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use crate::config::{InstanceRole, LoadedBlockwrightConfig, NeoForgeConfig};
use crate::neoforge::ResolvedNeoForgeVersions;
use crate::store::cache::write_replacing;
use anyhow::{bail, Context, Result};
use tokio::process::Command;

use super::managed_client;
use super::{LaunchCommand, LaunchOptions};

pub(super) async fn install_runtime(
    neoforge: &NeoForgeConfig,
    role: InstanceRole,
    resolved: &ResolvedNeoForgeVersions,
    installer: &Path,
    dir: &Path,
) -> Result<()> {
    match role {
        InstanceRole::Server => install_neoforge_server(neoforge, resolved, installer, dir).await,
        InstanceRole::Client => {
            install_neoforge_client(neoforge, resolved, installer, dir).await?;
            let version_id = format!("neoforge-{}", resolved.loader_version);
            managed_client::ensure_client_libraries(dir, &version_id).await?;
            managed_client::ensure_client_assets(dir, &resolved.minecraft_version).await
        }
    }
}

pub(super) fn seed_and_launch(
    loaded: &LoadedBlockwrightConfig,
    options: &LaunchOptions,
    instance_id: &str,
    instance_dir: &Path,
    resolved: &ResolvedNeoForgeVersions,
    coverage_agent: Option<&str>,
) -> Result<LaunchCommand> {
    let neoforge = &loaded.config.neoforge;
    let role = options.role;
    let mut args = blockwright_jvm_args(
        &neoforge.jvm_args,
        instance_id,
        role,
        options,
        coverage_agent,
    );
    if role == InstanceRole::Client {
        args.push("-Djava.awt.headless=false".to_string());
        if let Some(port_file) = &neoforge.client.connect_port_file {
            args.push(format!(
                "-Dblockwright.client.autoConnectPortFile={}",
                port_file.display()
            ));
        } else if let Some(connect) = &neoforge.client.connect {
            args.push(format!("-Dblockwright.client.autoConnect={connect}"));
        }
        let display = &neoforge.client.display;
        args.push(format!("-Dblockwright.display.device={}", display.device));
        args.push(format!("-Dblockwright.display.width={}", display.width));
        args.push(format!("-Dblockwright.display.height={}", display.height));
    }

    Ok(match role {
        InstanceRole::Server => {
            let port_file = super::server_port_file(instance_dir);
            prepare_server_files(neoforge, instance_dir, &port_file)?;
            args.push(format!(
                "-Dblockwright.server.portFile={}",
                port_file.display()
            ));
            let launch_args_file = neoforge_launch_args_file(instance_dir, resolved)?;
            let mut args = java_arguments(instance_dir, &args, &[])?;
            args.push(format!("@{}", launch_args_file.display()));
            args.extend(neoforge.server.args.clone());
            LaunchCommand {
                command: neoforge.java.runtime.clone(),
                args,
                cwd: instance_dir.to_path_buf(),
                server_port_file: Some(port_file),
                env: BTreeMap::new(),
            }
        }
        InstanceRole::Client => {
            prepare_client_files(instance_dir)?;
            let (command, args, cwd) =
                prepare_client_command(neoforge, resolved, &args, instance_dir)?;
            LaunchCommand {
                command,
                args,
                cwd,
                server_port_file: None,
                env: client_env(),
            }
        }
    })
}

async fn install_neoforge_server(
    neoforge: &NeoForgeConfig,
    versions: &ResolvedNeoForgeVersions,
    installer: &Path,
    game_dir: &Path,
) -> Result<()> {
    if neoforge_launch_args_file(game_dir, versions).is_ok() {
        return Ok(());
    }

    let output = crate::platform::process::output(
        Command::new(&neoforge.java.runtime)
            .arg("-jar")
            .arg(installer)
            .arg("--installServer")
            .arg(game_dir)
            .current_dir(game_dir)
            .stdin(Stdio::null()),
    )
    .await
    .with_context(|| format!("failed to run NeoForge installer {}", installer.display()))?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "NeoForge installer failed with status {}.\nstdout:\n{}\nstderr:\n{}",
            output.status,
            stdout.trim(),
            stderr.trim()
        );
    }

    neoforge_launch_args_file(game_dir, versions).map(|_| ())
}

async fn install_neoforge_client(
    neoforge: &NeoForgeConfig,
    versions: &ResolvedNeoForgeVersions,
    installer: &Path,
    game_dir: &Path,
) -> Result<()> {
    let marker = game_dir.join(".blockwright").join(format!(
        "neoforge-client-{}.installed",
        versions.loader_version
    ));
    if marker.exists() && neoforge_client_version_json(game_dir, versions).exists() {
        return Ok(());
    }

    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    managed_client::ensure_launcher_profiles(game_dir)?;

    let output = crate::platform::process::output(
        Command::new(&neoforge.java.runtime)
            .arg("-jar")
            .arg(installer)
            .arg("--installClient")
            .arg(game_dir)
            .current_dir(game_dir)
            .stdin(Stdio::null()),
    )
    .await
    .with_context(|| format!("failed to run NeoForge installer {}", installer.display()))?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "NeoForge client installer failed with status {}.\nstdout:\n{}\nstderr:\n{}",
            output.status,
            stdout.trim(),
            stderr.trim()
        );
    }

    fs::write(&marker, b"installed\n")
        .with_context(|| format!("failed to write {}", marker.display()))?;
    Ok(())
}

fn neoforge_launch_args_file(
    game_dir: &Path,
    versions: &ResolvedNeoForgeVersions,
) -> Result<PathBuf> {
    let version_dir = game_dir
        .join("libraries")
        .join("net")
        .join("neoforged")
        .join("neoforge")
        .join(&versions.loader_version);
    let platform_args = if cfg!(windows) {
        version_dir.join("win_args.txt")
    } else {
        version_dir.join("unix_args.txt")
    };
    if platform_args.exists() {
        return Ok(platform_args);
    }

    let fallback = version_dir.join("server_args.txt");
    if fallback.exists() {
        return Ok(fallback);
    }

    bail!(
        "NeoForge server launch args not found for {} in {}",
        versions.loader_version,
        version_dir.display()
    );
}

fn neoforge_client_version_json(game_dir: &Path, versions: &ResolvedNeoForgeVersions) -> PathBuf {
    let version_id = format!("neoforge-{}", versions.loader_version);
    game_dir
        .join("versions")
        .join(&version_id)
        .join(format!("{version_id}.json"))
}

pub(super) fn resolve_agent_mod_path(
    loaded: &LoadedBlockwrightConfig,
    options: &LaunchOptions,
) -> Option<PathBuf> {
    if let Some(path) = &options.agent_mod_path {
        return Some(loaded.resolve_path(path));
    }

    if let Some(path) = &loaded.config.neoforge.agent_mod {
        return Some(loaded.resolve_path(path));
    }

    jar_search_dirs(loaded, Path::new("neoforge-agent/build/libs"))
        .into_iter()
        .find_map(|dir| find_jar(&dir, "blockwright-neoforge-agent-"))
}

/// Where a jar Blockwright builds or ships is looked for: `build_libs` (a Gradle output dir,
/// relative) under the config root, its parent and the working directory, then beside the
/// executable and in its `agents` dir, where the npm package bundles the jars.
pub(crate) fn jar_search_dirs(loaded: &LoadedBlockwrightConfig, build_libs: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![loaded.resolve_path(build_libs)];
    if let Some(parent) = loaded.root.parent() {
        dirs.push(parent.join(build_libs));
    }
    if let Ok(cwd) = env::current_dir() {
        dirs.push(cwd.join(build_libs));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("agents"));
            dirs.push(exe_dir.to_path_buf());
            // npm bundles the driver in dist/native/<target> and shared jars in dist/agents.
            if let Some(dist) = exe_dir.parent().and_then(Path::parent) {
                dirs.push(dist.join("agents"));
            }
        }
    }
    dirs
}

/// A jar in `dir` named `<prefix>*.jar`, other than the sources and dev jars a build leaves
/// beside it.
pub(crate) fn find_jar(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(prefix)
                        && name.ends_with(".jar")
                        && !name.ends_with("-sources.jar")
                        && !name.ends_with("-dev.jar")
                })
        })
}

fn prepare_server_files(
    neoforge: &NeoForgeConfig,
    game_dir: &Path,
    port_file: &Path,
) -> Result<()> {
    if !neoforge.server.eula {
        bail!("Minecraft EULA acceptance is required: read https://www.minecraft.net/eula and set [neoforge.server] eula = true in your config to accept it");
    }
    remove_stale_port_file(port_file)?;
    write_replacing(&game_dir.join("eula.txt"), "eula=true\n")?;

    {
        let mut props = BTreeMap::new();
        props.insert("online-mode".to_string(), "false".to_string());
        props.insert("server-ip".to_string(), "127.0.0.1".to_string());
        for (key, value) in &neoforge.server.properties {
            props.insert(key.clone(), value.clone());
        }
        crate::engine::apply_world_preset(&mut props, neoforge.server.world);
        props
            .entry("server-port".to_string())
            .or_insert_with(|| "0".to_string());
        let mut body = String::new();
        for (key, value) in &props {
            body.push_str(key);
            body.push('=');
            body.push_str(value);
            body.push('\n');
        }
        write_replacing(&game_dir.join("server.properties"), body)?;
    }

    Ok(())
}

/// A reused instance dir still holds the port of its previous server; a client must not read that
/// as the port of this one.
fn remove_stale_port_file(port_file: &Path) -> Result<()> {
    match crate::platform::fs::remove_file(port_file) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(error).with_context(|| format!("failed to remove stale {}", port_file.display()))
        }
        _ => Ok(()),
    }
}

/// A client never opens a window, so NeoForge's early loading window is always off.
fn prepare_client_files(game_dir: &Path) -> Result<()> {
    let config_dir = game_dir.join("config");
    fs::create_dir_all(&config_dir)
        .with_context(|| format!("failed to create {}", config_dir.display()))?;
    write_replacing(&config_dir.join("fml.toml"), "earlyWindowControl = false\n")
}

/// The agent renders the client's audio through an OpenAL loopback device, but OpenAL-soft still
/// enumerates its backends (the sound engine polls the default device); the null backend keeps that
/// from reaching the machine's sound server.
fn client_env() -> BTreeMap<String, String> {
    BTreeMap::from([("ALSOFT_DRIVERS".to_string(), "null".to_string())])
}

fn prepare_client_command(
    neoforge: &NeoForgeConfig,
    versions: &ResolvedNeoForgeVersions,
    blockwright_jvm_args: &[String],
    game_dir: &Path,
) -> Result<(String, Vec<String>, PathBuf)> {
    let version_id = format!("neoforge-{}", versions.loader_version);
    let launch = managed_client::build_client_launch_metadata(
        game_dir,
        &version_id,
        None,
        &neoforge.client.account,
    )?;
    let mut jvm_args = blockwright_jvm_args.to_vec();
    jvm_args.extend(launch.jvm_args);
    let mut game_args = vec![launch.main_class];
    game_args.extend(launch.game_args);
    game_args.extend(managed_client::client_extra_game_args(&neoforge.client));
    let args = java_arguments(game_dir, &jvm_args, &game_args)?;
    Ok((neoforge.java.runtime.clone(), args, game_dir.to_path_buf()))
}

/// Keep Windows command lines short. Existing user/NeoForge @files remain at the top
/// level because Java does not recursively expand @files inside another argument file.
fn java_arguments(
    game_dir: &Path,
    jvm_args: &[String],
    game_args: &[String],
) -> Result<Vec<String>> {
    if !cfg!(windows) {
        return Ok(jvm_args.iter().chain(game_args).cloned().collect());
    }
    if jvm_args.iter().any(|arg| arg == "--disable-@files") {
        bail!("--disable-@files cannot be used with the Windows managed launcher, which requires Java argument files");
    }
    let dir = game_dir.join(".blockwright");
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let mut command_args = Vec::new();
    let mut staged = Vec::new();
    let mut index = 0;
    let publish =
        |args: &mut Vec<String>, command_args: &mut Vec<String>, index: &mut usize| -> Result<()> {
            if args.is_empty() {
                return Ok(());
            }
            let relative = Path::new(".blockwright").join(format!("launch-{}.args", *index));
            write_replacing(&game_dir.join(&relative), java_argument_file(args)?)?;
            command_args.push(format!("@{}", relative.display()));
            args.clear();
            *index += 1;
            Ok(())
        };
    for arg in jvm_args {
        if arg.starts_with('@') {
            publish(&mut staged, &mut command_args, &mut index)?;
            command_args.push(arg.clone());
        } else {
            staged.push(arg.clone());
        }
    }
    staged.extend_from_slice(game_args);
    publish(&mut staged, &mut command_args, &mut index)?;
    Ok(command_args)
}

fn java_argument_file(args: &[String]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for arg in args {
        out.push(b'"');
        // Escape after native encoding: a DBCS character can contain byte 0x5c,
        // which Java's byte-oriented argument-file parser would treat as a backslash.
        for byte in java_native_bytes(arg)? {
            match byte {
                0 => bail!("Java launch argument contains a NUL character"),
                b'\\' => out.extend_from_slice(b"\\\\"),
                b'"' => out.extend_from_slice(b"\\\""),
                b'\n' => out.extend_from_slice(b"\\n"),
                b'\r' => out.extend_from_slice(b"\\r"),
                b'\t' => out.extend_from_slice(b"\\t"),
                12 => out.extend_from_slice(b"\\f"),
                byte => out.push(byte),
            }
        }
        out.extend_from_slice(b"\"\n");
    }
    Ok(out)
}

fn java_native_bytes(arg: &str) -> Result<Vec<u8>> {
    #[cfg(unix)]
    return Ok(arg.as_bytes().to_vec());
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::{
            GetACP, WideCharToMultiByte, CP_UTF8, WC_NO_BEST_FIT_CHARS,
        };
        let code_page = unsafe { GetACP() };
        if code_page == CP_UTF8 {
            return Ok(arg.as_bytes().to_vec());
        }
        let wide: Vec<u16> = arg.encode_utf16().collect();
        if wide.is_empty() {
            return Ok(Vec::new());
        }
        let len = i32::try_from(wide.len()).context("Java argument is too large")?;
        let mut substituted = 0;
        let size = unsafe {
            WideCharToMultiByte(
                code_page,
                WC_NO_BEST_FIT_CHARS,
                wide.as_ptr(),
                len,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                &mut substituted,
            )
        };
        if size == 0 {
            return Err(std::io::Error::last_os_error())
                .context("failed to encode Java argument file");
        }
        let mut bytes = vec![0u8; size as usize];
        let converted = unsafe {
            WideCharToMultiByte(
                code_page,
                WC_NO_BEST_FIT_CHARS,
                wide.as_ptr(),
                len,
                bytes.as_mut_ptr(),
                size,
                std::ptr::null(),
                &mut substituted,
            )
        };
        if converted == 0 {
            return Err(std::io::Error::last_os_error())
                .context("failed to encode Java argument file");
        }
        if substituted != 0 {
            bail!("Java 21 on Windows reads argument files using system code page {code_page}; a launch argument contains characters it cannot represent. Use a path/account name supported by that code page, or a Windows UTF-8 system locale");
        }
        Ok(bytes)
    }
}

/// The JVM args Blockwright adds ahead of NeoForge's own. The coverage agent goes first of all,
/// so it is attached before anything else the JVM is told to load.
fn blockwright_jvm_args(
    configured: &[String],
    instance_id: &str,
    role: InstanceRole,
    options: &LaunchOptions,
    coverage_agent: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = coverage_agent.map(str::to_string).into_iter().collect();
    args.extend_from_slice(configured);
    args.push("-Dblockwright.enabled=true".to_string());
    args.push(format!("-Dblockwright.instanceId={instance_id}"));
    args.push(format!("-Dblockwright.role={}", role.as_str()));
    args.push(format!("-Dblockwright.parentPid={}", std::process::id()));
    if let Some(endpoint) = &options.control_endpoint {
        args.push(format!("-Dblockwright.control.endpoint={endpoint}"));
    }
    if options.start_frozen && role == InstanceRole::Server {
        args.push("-Dblockwright.server.startFrozen=true".to_string());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ClientConfig;
    use crate::test_support::TempDir;

    #[test]
    fn java_argument_files_quote_empty_values_paths_quotes_and_control_characters() {
        let args = [
            "",
            "C:\\Program Files\\Java\\",
            "a\"b",
            "#comment",
            "line\nnext\r\t\x0c",
            "@literal",
        ]
        .map(str::to_string);
        let encoded = java_argument_file(&args).unwrap();
        assert_eq!(String::from_utf8(encoded).unwrap(), "\"\"\n\"C:\\\\Program Files\\\\Java\\\\\"\n\"a\\\"b\"\n\"#comment\"\n\"line\\nnext\\r\\t\\f\"\n\"@literal\"\n");
        assert!(java_argument_file(&["nul\0value".to_string()]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn user_argument_files_stay_at_the_top_level() {
        let temp = TempDir::new("java-top-level");
        let args = java_arguments(
            temp.path(),
            &[
                "-Xmx1G".to_string(),
                "@user.args".to_string(),
                "-Dkey=value".to_string(),
            ],
            &["Main".to_string()],
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "@.blockwright\\launch-0.args",
                "@user.args",
                "@.blockwright\\launch-1.args"
            ]
        );
        assert!(
            !fs::read_to_string(temp.path().join(".blockwright/launch-0.args"))
                .unwrap()
                .contains("@user.args")
        );
        assert!(java_arguments(temp.path(), &["--disable-@files".to_string()], &[]).is_err());
    }

    #[test]
    #[ignore = "requires a Java 21 JDK on PATH; run during platform qualification"]
    fn java_argument_files_round_trip_long_classpaths_and_unicode_with_a_real_jdk() {
        let temp = TempDir::new("java-arguments 中文 spaces");
        let classes = temp.path().join("classes 中文");
        fs::create_dir_all(&classes).unwrap();
        temp.write("LaunchProbe.java", r#"class LaunchProbe {
static void emit(String value) {
  System.out.println(value.codePoints().mapToObj(Integer::toHexString).collect(java.util.stream.Collectors.joining(",")));
}
public static void main(String[] args) {
  emit(System.getProperty("probe.value"));
  for (String arg : args) emit(arg);
} }"#);
        let compiled = std::process::Command::new("javac")
            .args(["-encoding", "UTF-8", "-d"])
            .arg(&classes)
            .arg(temp.path().join("LaunchProbe.java"))
            .output()
            .expect("Java 21 javac is required for this test");
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let classpath = env::join_paths(std::iter::repeat_n(&classes, 800))
            .unwrap()
            .into_string()
            .unwrap();
        assert!(classpath.len() > 32767);
        let values = [
            "",
            "a\"b",
            "C:\\trailing path\\",
            "line\nnext\r\t\x0c",
            "#literal",
            "@literal",
            "中文 空格",
            "💻",
        ];
        // Java 21's Windows launcher may use a legacy ANSI code page. Unsupported
        // characters are rejected explicitly instead of silently corrupting paths.
        let values: Vec<&str> = values
            .into_iter()
            .filter(|value| java_native_bytes(value).is_ok())
            .collect();
        let prefix = vec![
            "-Dprobe.value=中文 路径".to_string(),
            "-cp".to_string(),
            classpath,
        ];
        let mut tail = vec!["LaunchProbe".to_string()];
        tail.extend(values.iter().map(|value| value.to_string()));
        let args = java_arguments(temp.path(), &prefix, &tail).unwrap();
        let result = std::process::Command::new("java")
            .args(args)
            .current_dir(temp.path())
            .output()
            .expect("Java 21 java is required for this test");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        // ASCII code-point output avoids console encoding and includes empty/control values.
        let expected: Vec<String> = std::iter::once("中文 路径")
            .chain(values)
            .map(|value| {
                value
                    .chars()
                    .map(|ch| format!("{:x}", ch as u32))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect();
        assert_eq!(
            String::from_utf8(result.stdout)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn server_requires_explicit_eula_even_when_reusing_an_accepted_world() {
        let temp = TempDir::new("eula_opt_in");
        fs::write(temp.path().join("eula.txt"), "eula=true\n").unwrap();
        let config = NeoForgeConfig::default();
        let error =
            prepare_server_files(&config, temp.path(), &temp.path().join("port")).unwrap_err();
        assert!(error.to_string().contains("EULA acceptance"));
        assert!(!temp.path().join("server.properties").exists());
    }

    #[test]
    fn test_server_is_local_by_default_and_allows_explicit_bind_override() {
        let temp = TempDir::new("server_bind");
        let mut config = NeoForgeConfig::default();
        config.server.eula = true;
        prepare_server_files(&config, temp.path(), &temp.path().join("port")).unwrap();
        let properties = fs::read_to_string(temp.path().join("server.properties")).unwrap();
        assert!(properties.contains("server-ip=127.0.0.1\n"));
        config
            .server
            .properties
            .insert("server-ip".into(), "192.0.2.1".into());
        prepare_server_files(&config, temp.path(), &temp.path().join("port")).unwrap();
        let properties = fs::read_to_string(temp.path().join("server.properties")).unwrap();
        assert!(properties.contains("server-ip=192.0.2.1\n"));
        assert!(!properties.contains("server-ip=127.0.0.1"));
    }

    #[test]
    fn passes_client_connect_as_server_port_game_arguments() {
        let mut client = ClientConfig {
            connect: Some("127.0.0.1:25565".to_string()),
            ..ClientConfig::default()
        };
        client.game_args.push("--demo".to_string());

        assert_eq!(
            managed_client::client_extra_game_args(&client),
            vec![
                "--demo".to_string(),
                "--server".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "25565".to_string()
            ]
        );
    }

    #[test]
    fn client_files_turn_the_early_window_off() {
        let temp = TempDir::new("early_window_off");

        prepare_client_files(temp.path()).unwrap();

        let body = fs::read_to_string(temp.path().join("config").join("fml.toml")).unwrap();
        assert!(body.contains("earlyWindowControl = false"), "{body}");
    }

    #[test]
    fn early_window_write_breaks_hardlink_instead_of_writing_through() {
        let temp = TempDir::new("early_window_hardlink");
        let base = temp.path().join("base-fml.toml");
        fs::write(&base, "earlyWindowControl = true\n").unwrap();

        let config_dir = temp.path().join("config");
        fs::create_dir_all(&config_dir).unwrap();
        fs::hard_link(&base, config_dir.join("fml.toml")).unwrap();

        prepare_client_files(temp.path()).unwrap();

        assert!(fs::read_to_string(config_dir.join("fml.toml"))
            .unwrap()
            .contains("earlyWindowControl = false"));
        assert_eq!(
            fs::read_to_string(&base).unwrap(),
            "earlyWindowControl = true\n"
        );
    }

    #[test]
    fn start_frozen_reaches_only_server_jvm_args() {
        let options = LaunchOptions {
            role: InstanceRole::Server,
            instance_name: None,
            trace_path: None,
            control_endpoint: None,
            agent_mod_path: None,
            reuse_instance_dir: false,
            keep_instance_dir: false,
            start_frozen: true,
        };
        let flag = "-Dblockwright.server.startFrozen=true";
        let server = blockwright_jvm_args(&[], "inst", InstanceRole::Server, &options, None);
        assert!(server.iter().any(|a| a == flag));
        let client = blockwright_jvm_args(&[], "inst", InstanceRole::Client, &options, None);
        assert!(!client.iter().any(|a| a == flag));
    }

    #[test]
    fn the_coverage_agent_comes_before_every_other_jvm_arg() {
        let options = LaunchOptions {
            role: InstanceRole::Client,
            instance_name: None,
            trace_path: None,
            control_endpoint: None,
            agent_mod_path: None,
            reuse_instance_dir: false,
            keep_instance_dir: false,
            start_frozen: false,
        };
        let configured = ["-Xmx2G".to_string()];
        let agent = "-javaagent:/store/jacoco.jar=destfile=/cov/jacoco.exec";
        let args = blockwright_jvm_args(
            &configured,
            "inst",
            InstanceRole::Client,
            &options,
            Some(agent),
        );
        assert_eq!(args[..2], [agent.to_string(), "-Xmx2G".to_string()]);
        let args = blockwright_jvm_args(&configured, "inst", InstanceRole::Client, &options, None);
        assert_eq!(args[0], "-Xmx2G");
        assert!(!args.iter().any(|arg| arg.starts_with("-javaagent")));
    }

    #[test]
    fn find_jar_skips_side_artifacts_and_other_names() {
        let temp = TempDir::new("find_jar");
        for name in [
            "blockwright-coverage-0.1.0-sources.jar",
            "blockwright-coverage-0.1.0-dev.jar",
            "other-0.1.0.jar",
        ] {
            temp.write(name, "");
        }
        assert_eq!(find_jar(temp.path(), "blockwright-coverage-"), None);
        temp.write("blockwright-coverage-0.1.0.jar", "");
        assert_eq!(
            find_jar(temp.path(), "blockwright-coverage-"),
            Some(temp.path().join("blockwright-coverage-0.1.0.jar"))
        );
    }
}
