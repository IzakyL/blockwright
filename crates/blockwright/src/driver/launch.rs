use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::Arc,
};

use anyhow::{Context, Result};
use blockwright::{
    config::{load_config, InstanceRole},
    engine::{prepare_launch, LaunchOptions, LaunchPlan},
    registry,
    trace::TraceSink,
};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    net::TcpListener,
    process::{Child, Command},
    sync::Mutex,
    task::JoinHandle,
    time::{sleep, timeout, Duration},
};

use super::control::AgentControlHandle;
use super::types::{
    InstanceCloseParams, InstanceCloseResult, InstanceLaunchParams, InstanceLaunchResult,
};
use super::SharedInstances;
use crate::common::validate_java_runtime;

pub(crate) struct RunningInstance {
    pub(crate) plan: Arc<LaunchPlan>,
    pub(crate) sink: TraceSink,

    pub(crate) child: Option<Arc<Mutex<Child>>>,
    pub(crate) process_group_id: Option<u32>,
    pub(crate) exit_watch_task: Option<JoinHandle<()>>,
    pub(crate) control: AgentControlHandle,
    pub(crate) control_task: Option<JoinHandle<()>>,
    pub(crate) stdout_task: Option<JoinHandle<Result<()>>>,
    pub(crate) stderr_task: Option<JoinHandle<Result<()>>>,
    pub(crate) config_path: PathBuf,
    /// Leave the instance dir in place on close; a failed instance always keeps it.
    pub(crate) keep_instance_dir: bool,
    /// When the game was spawned; crash evidence older than this belongs to an earlier run.
    pub(crate) started: std::time::SystemTime,
}

pub(crate) async fn launch_neoforge(
    params: InstanceLaunchParams,
    instances: SharedInstances,
) -> Result<InstanceLaunchResult> {
    let config_path = params
        .config
        .clone()
        .unwrap_or_else(|| PathBuf::from("blockwright.toml"));
    let mut loaded = load_config(&config_path)?;

    apply_auto_connect(params.role, &mut loaded.config.neoforge.client, &instances).await;

    let trace_path = params.trace.as_ref().map(|path| loaded.resolve_path(path));
    let control_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind local control endpoint")?;
    let control_endpoint = control_listener
        .local_addr()
        .context("failed to read control endpoint address")?
        .to_string();

    let (plan, launch_lock) = prepare_launch(
        &loaded,
        LaunchOptions {
            role: params.role,
            instance_name: params.instance,
            trace_path,
            control_endpoint: Some(control_endpoint),
            agent_mod_path: params.agent_mod,
            reuse_instance_dir: params.reuse_instance_dir,
            keep_instance_dir: params.keep_instance_dir,
            start_frozen: params.start_frozen,
        },
    )
    .await?;

    validate_java_runtime(&plan.command, plan.requirements.minimum_java).await?;

    let plan = Arc::new(plan);
    let mut running = spawn_neoforge_plan(plan.clone(), control_listener, config_path).await?;
    running.keep_instance_dir = params.keep_instance_dir;
    register_instance(&running);
    drop(launch_lock);
    let result = InstanceLaunchResult::from_neoforge_plan(&plan);
    instances
        .lock()
        .await
        .insert(plan.instance_id.clone(), running);

    Ok(result)
}

async fn spawn_neoforge_plan(
    plan: Arc<LaunchPlan>,
    control_listener: TcpListener,
    config_path: PathBuf,
) -> Result<RunningInstance> {
    let sink = TraceSink::create(&plan.trace_path, &plan.instance_id)?;
    sink.write(
        "driver",
        "lifecycle.launch.plan",
        serde_json::to_value(&*plan).context("failed to serialize launch plan")?,
    )?;
    for warning in &plan.warnings {
        sink.write("driver", "lifecycle.warning", json!({ "message": warning }))?;
    }

    let (control, control_task) = AgentControlHandle::spawn(control_listener, sink.clone());

    sink.write(
        "process",
        "process.spawn",
        json!({
            "command": plan.command,
            "args": plan.args,
            "cwd": plan.cwd,
            "env": plan.env,
        }),
    )?;

    let spawned = spawn_plan_child(&plan, &plan.env, &sink).await?;
    let SpawnedChild {
        child,
        process_group_id,
        started,
        exit_watch_task,
        stdout_task,
        stderr_task,
    } = spawned;

    Ok(RunningInstance {
        plan,
        sink,
        child: Some(child),
        process_group_id,
        exit_watch_task: Some(exit_watch_task),
        control,
        control_task: Some(control_task),
        stdout_task: Some(stdout_task),
        stderr_task: Some(stderr_task),
        config_path,
        keep_instance_dir: false,
        started,
    })
}

pub(crate) struct SpawnedChild {
    pub(crate) child: Arc<Mutex<Child>>,
    pub(crate) process_group_id: Option<u32>,
    pub(crate) started: std::time::SystemTime,
    pub(crate) exit_watch_task: JoinHandle<()>,
    pub(crate) stdout_task: JoinHandle<Result<()>>,
    pub(crate) stderr_task: JoinHandle<Result<()>>,
}

pub(crate) async fn spawn_plan_child(
    plan: &LaunchPlan,
    env: &BTreeMap<String, String>,
    sink: &TraceSink,
) -> Result<SpawnedChild> {
    let mut command = Command::new(&plan.command);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    command.process_group(0);

    let started = std::time::SystemTime::now();
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn {}", plan.command))?;
    let process_group_id = child.id();
    sink.write(
        "process",
        "process.started",
        json!({ "pid": process_group_id }),
    )?;

    let stdout = child
        .stdout
        .take()
        .context("child stdout was not captured")?;
    let stderr = child
        .stderr
        .take()
        .context("child stderr was not captured")?;
    let stdout_task = tokio::spawn(pipe_output(stdout, false, sink.clone()));
    let stderr_task = tokio::spawn(pipe_output(stderr, true, sink.clone()));

    let child = Arc::new(Mutex::new(child));
    let exit_watch_task = tokio::spawn(watch_for_unexpected_exit(
        child.clone(),
        sink.clone(),
        plan.instance_dir.clone(),
        plan.cwd.clone(),
        started,
    ));

    Ok(SpawnedChild {
        child,
        process_group_id,
        started,
        exit_watch_task,
        stdout_task,
        stderr_task,
    })
}

pub(crate) async fn stop_instance_process(
    instance: &mut RunningInstance,
    grace: Duration,
) -> Result<Option<Termination>> {
    instance.control.reset().await;
    if let Some(task) = instance.exit_watch_task.take() {
        task.abort();
        let _ = task.await;
    }
    let ended = match instance.child.take() {
        Some(child) => {
            let mut child = child.lock().await;
            Some(
                terminate_instance_process(&mut child, instance.process_group_id.take(), grace)
                    .await?,
            )
        }
        None => None,
    };
    if let Some(task) = instance.stdout_task.take() {
        drain_output_task(task).await;
    }
    if let Some(task) = instance.stderr_task.take() {
        drain_output_task(task).await;
    }
    Ok(ended)
}

async fn apply_auto_connect(
    role: InstanceRole,
    client: &mut blockwright::config::ClientConfig,
    instances: &SharedInstances,
) {
    if role != InstanceRole::Client {
        return;
    }
    if let Some(port_file) = running_server_port_file(instances).await {
        client.connect_port_file = Some(port_file);
    }
}

async fn running_server_port_file(instances: &SharedInstances) -> Option<PathBuf> {
    let state = instances.lock().await;
    state
        .values()
        .filter(|instance| instance.plan.role == InstanceRole::Server)
        .find_map(|instance| instance.plan.server_port_file.clone())
}

fn register_instance(running: &RunningInstance) {
    let Some(pid) = running.process_group_id else {
        return;
    };
    let plan = &running.plan;
    let record = registry::InstanceRecord {
        instance_id: plan.instance_id.clone(),
        role: plan.role,
        pid,
        instance_dir: plan.instance_dir.clone(),
        trace_path: Some(plan.trace_path.clone()),
        config: Some(running.config_path.clone()),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    let root = match std::env::current_dir() {
        Ok(root) => root,
        Err(_) => return,
    };
    if let Err(error) = registry::write(&root, &record) {
        let _ = running.sink.write(
            "driver",
            "registry.write.error",
            json!({ "error": error.to_string() }),
        );
    }
}

pub(crate) async fn close_instance(
    params: InstanceCloseParams,
    instances: SharedInstances,
) -> Result<InstanceCloseResult> {
    let mut instance = {
        let mut instances = instances.lock().await;
        instances
            .remove(&params.instance_id)
            .with_context(|| format!("unknown instance: {}", params.instance_id))?
    };
    if let Ok(root) = std::env::current_dir() {
        registry::remove(&root, &params.instance_id);
    }

    instance
        .sink
        .write("driver", "lifecycle.close", json!({}))?;

    let grace = params
        .grace_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_CLOSE_GRACE);
    let ended = stop_instance_process(&mut instance, grace).await?;
    if let Some(task) = instance.control_task {
        task.abort();
    }

    let plan = &instance.plan;
    // A game can crash and hang instead of exiting; whatever it left behind is reported here too.
    let crash = crash_evidence(&plan.instance_dir, &plan.cwd, instance.started);
    let outcome = close_outcome(ended.as_ref(), crash.is_empty());
    let mut exit = serde_json::to_value(&outcome)?;
    exit.as_object_mut()
        .expect("an object")
        .extend(crash.clone());
    instance.sink.write("process", "process.exit", exit)?;

    let sink = &instance.sink;
    // A crash report or JVM crash log found now keeps the dir too, so the files it names still exist.
    let keep = instance.keep_instance_dir || params.keep_projection || !crash.is_empty();
    if !keep && !failed(&plan.instance_dir) {
        reclaim_dir(sink, &plan.instance_dir)?;
    }

    Ok(InstanceCloseResult {
        code: outcome.code,
        signal: outcome.signal,
        success: outcome.success,
        terminated: outcome.terminated,
        killed: outcome.killed,
        crash,
    })
}

/// How long a close waits after SIGTERM (the JVM runs its shutdown hooks: a server saves the world)
/// before it SIGKILLs the process group.
pub(crate) const DEFAULT_CLOSE_GRACE: Duration = Duration::from_secs(10);
/// How long a close waits for the process after SIGKILL.
const KILL_WAIT: Duration = Duration::from_secs(10);

/// How a process ended when the driver closed it.
#[derive(Debug)]
pub(crate) struct Termination {
    pub(crate) status: ExitStatus,
    /// The process was still running, so the driver signalled it; false when it had exited on its own.
    pub(crate) terminated: bool,
    /// It outlived SIGTERM's grace period (or had no process group to signal) and was SIGKILLed.
    pub(crate) killed: bool,
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub(crate) struct CloseOutcome {
    pub(crate) code: Option<i32>,
    pub(crate) signal: Option<i32>,
    pub(crate) success: bool,
    pub(crate) terminated: bool,
    pub(crate) killed: bool,
}

/// A process that exited on its own succeeded when its status did. One the driver stopped succeeded
/// when it went on SIGTERM (exit 0, 128+SIGTERM as the JVM reports it, or the signal itself) and left
/// no crash evidence behind; one that had to be SIGKILLed did not.
pub(crate) fn close_outcome(ended: Option<&Termination>, no_crash: bool) -> CloseOutcome {
    let Some(ended) = ended else {
        return CloseOutcome {
            code: None,
            signal: None,
            success: true,
            terminated: false,
            killed: false,
        };
    };
    let code = ended.status.code();
    let signal = exit_signal(&ended.status);
    let success = if !ended.terminated {
        ended.status.success()
    } else {
        !ended.killed
            && no_crash
            && (ended.status.success()
                || code == Some(128 + libc::SIGTERM)
                || signal == Some(libc::SIGTERM))
    };
    CloseOutcome {
        code,
        signal,
        success,
        terminated: ended.terminated,
        killed: ended.killed,
    }
}

/// Written into an instance dir when its game dies (the TypeScript side writes it for a failed
/// test); such a dir outlives the close so there is something to look at.
const FAILURE_MARKER: &str = ".blockwright-failed";

fn failed(instance_dir: &Path) -> bool {
    instance_dir.join(FAILURE_MARKER).exists()
        || std::fs::read_dir(instance_dir.join("crash-reports"))
            .is_ok_and(|mut entries| entries.next().is_some())
}

fn reclaim_dir(sink: &TraceSink, path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    match std::fs::remove_dir_all(path) {
        Ok(()) => sink.write("driver", "lifecycle.reclaim", json!({ "path": path })),
        Err(error) => sink.write(
            "driver",
            "lifecycle.reclaim.error",
            json!({ "path": path, "error": error.to_string() }),
        ),
    }
}

pub(crate) async fn shutdown_all(instances: SharedInstances) {
    let ids = {
        let instances = instances.lock().await;
        instances.keys().cloned().collect::<Vec<_>>()
    };

    let mut closing = tokio::task::JoinSet::new();
    for instance_id in ids {
        closing.spawn(close_instance(
            InstanceCloseParams {
                instance_id,
                keep_projection: false,
                grace_ms: None,
            },
            instances.clone(),
        ));
    }
    closing.join_all().await;
}

async fn watch_for_unexpected_exit(
    child: Arc<Mutex<Child>>,
    sink: TraceSink,
    instance_dir: PathBuf,
    cwd: PathBuf,
    started: std::time::SystemTime,
) {
    loop {
        sleep(Duration::from_millis(200)).await;
        let status = {
            let mut child = child.lock().await;
            match child.try_wait() {
                Ok(Some(status)) => status,
                Ok(None) => continue,

                Err(_) => return,
            }
        };
        if !status.success() {
            let _ = std::fs::write(instance_dir.join(FAILURE_MARKER), b"failed\n");
        }
        let mut data = json!({
            "code": status.code(),
            "signal": exit_signal(&status),
            "success": status.success(),
        });
        if !status.success() {
            let crash = crash_evidence(&instance_dir, &cwd, started);
            data.as_object_mut().expect("an object").extend(crash);
        }
        let _ = sink.write("process", "process.died", data);
        return;
    }
}

/// The crash report and JVM fatal-error log a game left behind since it started, with the lines
/// that say what went wrong, so a caller learns the cause without opening the files:
/// `crashReport`, `crashSummary`, `jvmCrashLog`, `jvmCrashSummary`, each present only when found.
fn crash_evidence(
    instance_dir: &Path,
    cwd: &Path,
    since: std::time::SystemTime,
) -> serde_json::Map<String, serde_json::Value> {
    let mut data = serde_json::Map::new();
    if let Some(report) = newest_file(&instance_dir.join("crash-reports"), since, |_| true) {
        data.insert("crashReport".into(), json!(report));
        data.insert("crashSummary".into(), json!(crash_report_summary(&report)));
    }
    let hs_err = newest_file(cwd, since, |name| name.starts_with("hs_err_pid"))
        .or_else(|| newest_file(instance_dir, since, |name| name.starts_with("hs_err_pid")));
    if let Some(log) = hs_err {
        data.insert("jvmCrashLog".into(), json!(log));
        data.insert("jvmCrashSummary".into(), json!(jvm_crash_summary(&log)));
    }
    data
}

fn newest_file(
    dir: &Path,
    since: std::time::SystemTime,
    accept: impl Fn(&str) -> bool,
) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(&accept))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .filter(|(modified, _)| *modified >= since)
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// `Description:` and the exception with its first frames from a Minecraft crash report.
fn crash_report_summary(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = text
        .lines()
        .skip_while(|line| !line.starts_with("Description:"));
    let mut summary: Vec<String> = lines.next().map(str::to_string).into_iter().collect();
    summary.extend(
        lines
            .skip_while(|line| line.trim().is_empty())
            .take_while(|line| !line.trim().is_empty())
            .take(5)
            .map(|line| line.trim_end().to_string()),
    );
    summary
}

/// The header lines of a HotSpot `hs_err_pid*.log`: the signal and the problematic frame.
fn jvm_crash_summary(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .take_while(|line| line.starts_with('#') || line.trim().is_empty())
        .map(|line| line.trim_start_matches('#').trim())
        .filter(|line| {
            !line.is_empty() && !line.starts_with("If you would like") && !line.starts_with("http")
        })
        .take(8)
        .map(str::to_string)
        .collect()
}

fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

/// Stops the game: a process that already exited keeps its own status; otherwise its process group
/// gets SIGTERM and `grace` to exit (shutdown hooks run), then SIGKILL. Without a process group the
/// child alone is SIGKILLed at once.
pub(crate) async fn terminate_instance_process(
    child: &mut Child,
    process_group_id: Option<u32>,
    grace: Duration,
) -> Result<Termination> {
    if let Some(status) = child
        .try_wait()
        .context("failed to poll the child process")?
    {
        return Ok(Termination {
            status,
            terminated: false,
            killed: false,
        });
    }
    if process_group_id.is_some() {
        signal_process_group(process_group_id, libc::SIGTERM);
        if let Ok(status) = timeout(grace, child.wait()).await {
            return Ok(Termination {
                status: status.context("failed to wait for child process")?,
                terminated: true,
                killed: false,
            });
        }
        signal_process_group(process_group_id, libc::SIGKILL);
    }
    let _ = child.start_kill();
    let status = timeout(KILL_WAIT, child.wait())
        .await
        .context("timed out waiting for child process after SIGKILL")?
        .context("failed to wait for child process after SIGKILL")?;
    Ok(Termination {
        status,
        terminated: true,
        killed: true,
    })
}

fn signal_process_group(process_group_id: Option<u32>, signal: i32) {
    if let Some(pid) = process_group_id {
        blockwright::process::signal(pid, signal);
    }
}

pub(crate) async fn drain_output_task(mut task: JoinHandle<Result<()>>) {
    match timeout(Duration::from_secs(5), &mut task).await {
        Ok(result) => {
            let _ = result;
        }
        Err(_) => {
            task.abort();
            let _ = task.await;
        }
    }
}

pub(crate) async fn pipe_output<R>(reader: R, stderr: bool, sink: TraceSink) -> Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        sink.write(
            "process",
            if stderr {
                "process.stderr"
            } else {
                "process.stdout"
            },
            json!({ "line": line }),
        )?;
    }

    Ok(())
}

#[cfg(test)]
pub(crate) fn test_instance(role: InstanceRole) -> RunningInstance {
    let mut plan = test_plan(
        "test",
        PathBuf::from("/nonexistent/blockwright-test-instance"),
        Vec::new(),
    );
    plan.role = role;
    plan.server_port_file = None;
    test_instance_with(plan)
}

#[cfg(test)]
pub(crate) fn test_instance_with(plan: LaunchPlan) -> RunningInstance {
    let sink = TraceSink::create("/dev/null", "test").unwrap();
    let control = AgentControlHandle::over(super::control::ControlMux::closed(
        "this test instance has no agent",
    ));
    RunningInstance {
        plan: Arc::new(plan),
        sink,
        child: None,
        process_group_id: None,
        exit_watch_task: None,
        control,
        control_task: None,
        stdout_task: None,
        stderr_task: None,
        config_path: PathBuf::from("blockwright.toml"),
        keep_instance_dir: false,
        started: std::time::SystemTime::now(),
    }
}

#[cfg(test)]
pub(crate) fn test_plan(instance_id: &str, instance_dir: PathBuf, args: Vec<String>) -> LaunchPlan {
    use blockwright::neoforge::{NeoForgeRuntimeRequirements, ResolvedNeoForgeVersions};
    LaunchPlan {
        instance_id: instance_id.to_string(),
        role: InstanceRole::Server,
        trace_path: instance_dir.join("trace.ndjson"),
        command: "/bin/sh".to_string(),
        args,
        cwd: instance_dir.clone(),
        instance_dir,
        env: BTreeMap::new(),
        mods: Vec::new(),
        resolved: ResolvedNeoForgeVersions {
            minecraft_version: "1.21.1".to_string(),
            loader_version: "21.1.0".to_string(),
        },
        requirements: NeoForgeRuntimeRequirements {
            java_runtime: "java".to_string(),
            minimum_java: 21,
            managed_agent_minecraft: "1.21.1".to_string(),
            managed_agent_loader: "21.1.0".to_string(),
            managed_agent_java_release: 21,
        },
        warnings: Vec::new(),
        server_port_file: Some(PathBuf::from("/nonexistent/blockwright-server-port")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_game_names_its_crash_report_and_jvm_log_with_their_key_lines() {
        let root = std::env::temp_dir().join(format!("bw-crash-evidence-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("crash-reports")).unwrap();
        let since = std::time::SystemTime::now() - Duration::from_secs(1);
        std::fs::write(
            root.join("crash-reports").join("crash-client.txt"),
            "---- Minecraft Crash Report ----\n// Oops.\n\nTime: now\nDescription: Rendering screen\n\n\
             java.lang.IllegalStateException: Image is not allocated.\n\tat a.b.C.d(C.java:1)\n\n-- Head --\n",
        )
        .unwrap();
        std::fs::write(
            root.join("hs_err_pid42.log"),
            "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n#  SIGSEGV (0xb) at pc=0x1\n#\n\
             # If you would like to submit a bug report\n#\n\n---------------  S U M M A R Y ------------\n",
        )
        .unwrap();

        let data = serde_json::Value::Object(crash_evidence(&root, &root, since));

        assert_eq!(
            data["crashSummary"],
            json!([
                "Description: Rendering screen",
                "java.lang.IllegalStateException: Image is not allocated.",
                "\tat a.b.C.d(C.java:1)"
            ])
        );
        assert!(data["crashReport"]
            .as_str()
            .unwrap()
            .ends_with("crash-client.txt"));
        assert_eq!(
            data["jvmCrashSummary"],
            json!([
                "A fatal error has been detected by the Java Runtime Environment:",
                "SIGSEGV (0xb) at pc=0x1"
            ])
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn auto_connect_points_client_at_running_server_port_file() {
        let instances: SharedInstances = Default::default();
        {
            let mut guard = instances.lock().await;
            let mut plan = test_plan("server", PathBuf::from("/nonexistent"), Vec::new());
            plan.server_port_file = Some(PathBuf::from("/srv/one/blockwright-server-port"));
            guard.insert("server".to_string(), test_instance_with(plan));
        }

        let mut client = blockwright::config::ClientConfig::default();
        apply_auto_connect(InstanceRole::Client, &mut client, &instances).await;
        assert_eq!(
            client.connect_port_file.as_deref(),
            Some(std::path::Path::new("/srv/one/blockwright-server-port"))
        );

        let mut as_server = blockwright::config::ClientConfig::default();
        apply_auto_connect(InstanceRole::Server, &mut as_server, &instances).await;
        assert_eq!(as_server.connect_port_file, None);
    }

    #[tokio::test]
    async fn shutdown_runs_twice_without_complaining_so_a_signal_can_race_a_stdin_close() {
        let instances: SharedInstances = Default::default();
        {
            let mut guard = instances.lock().await;
            guard.insert("server".to_string(), test_instance(InstanceRole::Server));
            guard.insert("client".to_string(), test_instance(InstanceRole::Client));
        }

        shutdown_all(instances.clone()).await;
        shutdown_all(instances.clone()).await;

        assert!(instances.lock().await.is_empty());
    }

    #[tokio::test]
    async fn closing_keeps_the_instance_dir_only_when_it_failed() {
        let root = std::env::temp_dir().join(format!("bw-close-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (name, crashed) in [("failed-run", true), ("clean-run", false)] {
            let instance_dir = root.join(name);
            std::fs::create_dir_all(&instance_dir).unwrap();
            if crashed {
                std::fs::create_dir_all(instance_dir.join("crash-reports")).unwrap();
                std::fs::write(
                    instance_dir.join("crash-reports").join("crash.txt"),
                    b"boom",
                )
                .unwrap();
            }

            let instances: SharedInstances = Default::default();
            {
                let mut guard = instances.lock().await;
                let mut plan = test_plan(name, instance_dir.clone(), Vec::new());
                plan.server_port_file = None;
                guard.insert(name.to_string(), test_instance_with(plan));
            }

            shutdown_all(instances).await;

            assert_eq!(instance_dir.exists(), crashed, "{name}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn closing_a_game_that_left_a_crash_report_returns_its_summary() {
        let root = std::env::temp_dir().join(format!("bw-close-crash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("crash-reports")).unwrap();
        std::fs::write(
            root.join("crash-reports").join("crash-server.txt"),
            "Description: Ticking entity\n\njava.lang.NullPointerException: boom\n",
        )
        .unwrap();
        let instances: SharedInstances = Default::default();
        let mut instance = test_instance_with(test_plan("hung", root.clone(), Vec::new()));
        instance.started = std::time::SystemTime::now() - Duration::from_secs(5);
        instances.lock().await.insert("hung".to_string(), instance);

        let result = close_instance(
            InstanceCloseParams {
                instance_id: "hung".to_string(),
                keep_projection: false,
                grace_ms: None,
            },
            instances,
        )
        .await
        .unwrap();
        let result = serde_json::to_value(result).unwrap();

        assert_eq!(
            result["crashSummary"],
            json!([
                "Description: Ticking entity",
                "java.lang.NullPointerException: boom"
            ])
        );
        assert!(result["crashReport"]
            .as_str()
            .unwrap()
            .ends_with("crash-server.txt"));
        assert!(result.get("jvmCrashLog").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn spawn_group(script: &str) -> (Child, Option<u32>) {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]).process_group(0);
        let child = command.spawn().unwrap();
        let pid = child.id();
        (child, pid)
    }

    #[tokio::test]
    async fn a_process_that_already_exited_keeps_its_own_status() {
        let (mut child, pgid) = spawn_group("exit 3");
        sleep(Duration::from_millis(300)).await;

        let ended = terminate_instance_process(&mut child, pgid, Duration::from_secs(5))
            .await
            .unwrap();

        assert!(!ended.terminated && !ended.killed);
        assert_eq!(ended.status.code(), Some(3));
        let outcome = close_outcome(Some(&ended), true);
        assert_eq!(
            outcome,
            CloseOutcome {
                code: Some(3),
                signal: None,
                success: false,
                terminated: false,
                killed: false
            }
        );
    }

    #[tokio::test]
    async fn sigterm_comes_first_and_a_process_that_heeds_it_is_a_clean_stop() {
        // Exits the way a JVM does on SIGTERM: shutdown hooks run, then status 128+15.
        let (mut child, pgid) = spawn_group("trap 'sleep 0.2; exit 143' TERM; while :; do sleep 0.05; done");
        sleep(Duration::from_millis(200)).await;
        let started = std::time::Instant::now();

        let ended = terminate_instance_process(&mut child, pgid, Duration::from_secs(5))
            .await
            .unwrap();

        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        assert!(ended.terminated && !ended.killed);
        assert_eq!(
            close_outcome(Some(&ended), true),
            CloseOutcome {
                code: Some(143),
                signal: None,
                success: true,
                terminated: true,
                killed: false
            }
        );
        assert!(
            !close_outcome(Some(&ended), false).success,
            "a stop that left crash evidence is no success"
        );
    }

    #[tokio::test]
    async fn a_process_killed_by_the_sigterm_itself_reports_the_signal() {
        let (mut child, pgid) = spawn_group("exec sleep 30");
        sleep(Duration::from_millis(100)).await;

        let ended = terminate_instance_process(&mut child, pgid, Duration::from_secs(5))
            .await
            .unwrap();

        let outcome = close_outcome(Some(&ended), true);
        assert_eq!(outcome.signal, Some(libc::SIGTERM));
        assert_eq!(outcome.code, None);
        assert!(outcome.success && outcome.terminated && !outcome.killed);
    }

    #[tokio::test]
    async fn a_process_that_ignores_sigterm_is_killed_after_the_grace_period() {
        let (mut child, pgid) = spawn_group("trap '' TERM; while :; do sleep 0.05; done");
        sleep(Duration::from_millis(100)).await;
        let started = std::time::Instant::now();

        let ended = terminate_instance_process(&mut child, pgid, Duration::from_millis(400))
            .await
            .unwrap();

        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(400), "{waited:?}");
        assert!(waited < Duration::from_secs(5), "{waited:?}");
        let outcome = close_outcome(Some(&ended), true);
        assert_eq!(outcome.signal, Some(libc::SIGKILL));
        assert!(outcome.terminated && outcome.killed && !outcome.success);
    }

    #[tokio::test]
    async fn without_a_process_group_the_child_is_killed_at_once() {
        let (mut child, _) = spawn_group("trap '' TERM; while :; do sleep 0.05; done");
        let ended = terminate_instance_process(&mut child, None, Duration::from_secs(30))
            .await
            .unwrap();
        assert!(ended.killed);
        assert_eq!(exit_signal(&ended.status), Some(libc::SIGKILL));
    }

    #[test]
    fn closing_an_instance_without_a_process_is_a_success() {
        assert_eq!(
            close_outcome(None, true),
            CloseOutcome {
                code: None,
                signal: None,
                success: true,
                terminated: false,
                killed: false
            }
        );
    }

    #[tokio::test]
    async fn auto_connect_keeps_configured_endpoint_without_server() {
        let instances: SharedInstances = Default::default();
        let mut client = blockwright::config::ClientConfig {
            connect: Some("10.0.0.5:25565".to_string()),
            ..Default::default()
        };
        apply_auto_connect(InstanceRole::Client, &mut client, &instances).await;
        assert_eq!(client.connect.as_deref(), Some("10.0.0.5:25565"));
        assert_eq!(client.connect_port_file, None);
    }
}
