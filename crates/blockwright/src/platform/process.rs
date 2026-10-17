use anyhow::{Context, Result};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};

/// Runs an installer with cancellation-safe ownership of all descendants.
pub async fn output(command: &mut Command) -> Result<std::process::Output> {
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let (mut child, tree) = ProcessTree::spawn(command)?;
    let mut stdout = child
        .stdout
        .take()
        .context("child stdout was not captured")?;
    let mut stderr = child
        .stderr
        .take()
        .context("child stderr was not captured")?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let wait = async move {
        let status = child.wait().await.context("failed to wait for process");
        // Descendants can inherit these pipes. Reap them once the installer
        // exits, before waiting for EOF, while draining both pipes concurrently.
        drop(tree);
        status
    };
    let (status, _, _) = tokio::try_join!(
        wait,
        async {
            stdout
                .read_to_end(&mut out)
                .await
                .context("failed to read process stdout")
        },
        async {
            stderr
                .read_to_end(&mut err)
                .await
                .context("failed to read process stderr")
        },
    )?;
    Ok(std::process::Output {
        status,
        stdout: out,
        stderr: err,
    })
}

/// Owns a process tree, including while a launch is cancelled before registration.
pub struct ProcessTree {
    #[cfg(unix)]
    pid: u32,
    #[cfg(unix)]
    leader_identity: Option<String>,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}

impl ProcessTree {
    pub fn spawn(command: &mut Command) -> Result<(Child, Self)> {
        #[cfg(unix)]
        {
            command.process_group(0).kill_on_drop(true);
            let child = command.spawn().context("failed to spawn process tree")?;
            let pid = child.id().context("spawned child has no PID")?;
            let leader_identity = crate::process::identity(pid);
            Ok((
                child,
                Self {
                    pid,
                    leader_identity,
                },
            ))
        }
        #[cfg(windows)]
        windows::spawn(command)
    }

    pub fn kill(&self) -> Result<()> {
        #[cfg(unix)]
        {
            // A retained instance may outlive its leader. If that PID now
            // belongs to a different lifetime, its group is no longer ours.
            if let Some(actual) = crate::process::identity(self.pid) {
                if self.leader_identity.as_deref() != Some(actual.as_str()) {
                    return Ok(());
                }
            }
            // Only address our group: the leader may already have exited.
            if unsafe { libc::kill(-(self.pid as i32), libc::SIGKILL) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error.into());
                }
            }
            Ok(())
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.job.as_raw_handle(),
                    1,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error())
                    .context("failed to terminate process job");
            }
            Ok(())
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
            },
        },
    };

    fn owned(handle: HANDLE, action: &str) -> Result<OwnedHandle> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(std::io::Error::last_os_error()).with_context(|| action.to_owned())
        } else {
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }

    pub(super) fn spawn(command: &mut Command) -> Result<(Child, ProcessTree)> {
        // CREATE_SUSPENDED closes the spawn/assignment race. The primary thread
        // cannot create descendants before the process belongs to its job.
        let job = owned(
            unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) },
            "failed to create process job",
        )?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error()).context("failed to configure process job");
        }
        let tree = ProcessTree { job };
        command
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .context("failed to spawn suspended process")?;
        let started = (|| -> Result<()> {
            let process = child
                .raw_handle()
                .context("spawned process has no handle")?;
            if unsafe { AssignProcessToJobObject(tree.job.as_raw_handle(), process) } == 0 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to assign suspended process to job");
            }
            let pid = child.id().context("spawned process has no PID")?;
            let snapshot = owned(
                unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) },
                "failed to enumerate suspended process thread",
            )?;
            let mut entry: THREADENTRY32 = unsafe { zeroed() };
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
            let mut thread = None;
            while more {
                if entry.th32OwnerProcessID == pid {
                    anyhow::ensure!(
                        thread.is_none(),
                        "suspended process unexpectedly has multiple threads"
                    );
                    thread = Some(owned(
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) },
                        "failed to open suspended process thread",
                    )?);
                }
                more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
            }
            let thread = thread.context("suspended process primary thread was not found")?;
            let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
            anyhow::ensure!(
                previous == 1,
                "failed to resume process primary thread (suspend count {previous})"
            );
            Ok(())
        })();
        if let Err(error) = started {
            let _ = tree.kill();
            let _ = child.start_kill();
            return Err(error);
        }
        Ok((child, tree))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::{path::Path, process::Stdio, time::Duration};

    fn helper(command: &mut Command, mode: &str, pid_file: &Path) {
        command
            .arg("--exact")
            .arg("platform::process::tests::child_helper")
            .arg("--ignored")
            .arg("--nocapture")
            .env("BLOCKWRIGHT_TEST_CHILD_MODE", mode)
            .env("BLOCKWRIGHT_TEST_PID_FILE", pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    }

    #[test]
    #[ignore = "auxiliary process, invoked by ownership tests"]
    fn child_helper() {
        let mode = std::env::var("BLOCKWRIGHT_TEST_CHILD_MODE").unwrap();
        let file = std::env::var_os("BLOCKWRIGHT_TEST_PID_FILE").unwrap();
        if mode == "exit" {
            println!("owned-output");
            return;
        }
        let pid = if mode == "parent" || mode == "parent-exit-with-pipes" {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "platform::process::tests::child_helper",
                    "--ignored",
                    "--nocapture",
                ])
                .env("BLOCKWRIGHT_TEST_CHILD_MODE", "sleep")
                .stdin(Stdio::null());
            if mode == "parent" {
                command.stdout(Stdio::null()).stderr(Stdio::null());
            }
            let child = command.spawn().unwrap();
            child.id()
        } else {
            std::process::id()
        };
        if mode != "sleep" {
            std::fs::write(file, pid.to_string()).unwrap();
        }
        if mode == "parent-exit-with-pipes" {
            return;
        }
        std::thread::sleep(Duration::from_secs(60));
    }

    async fn read_pid(path: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(path) {
                    if let Ok(pid) = text.parse() {
                        return pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("child did not report its PID")
    }

    async fn assert_gone(pid: u32) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while crate::process::running(pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned process survived cleanup");
    }

    #[tokio::test]
    async fn dropping_owned_tree_reaps_descendants_ten_times() {
        let temp = TempDir::new("process-tree");
        for index in 0..10 {
            let pid_file = temp.path().join(format!("child-{index}.pid"));
            let mut command = Command::new(std::env::current_exe().unwrap());
            helper(&mut command, "parent", &pid_file);
            let (mut child, tree) = ProcessTree::spawn(&mut command).unwrap();
            let pid = child.id().unwrap();
            let descendant = read_pid(&pid_file).await;
            assert!(crate::process::running(descendant));
            drop(tree);
            tokio::time::timeout(Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap();
            assert_gone(pid).await;
            assert_gone(descendant).await;
        }
    }

    #[tokio::test]
    async fn aborting_output_owner_cancels_descendants() {
        let temp = TempDir::new("process-owner-abort");
        let pid_file = temp.path().join("descendant.pid");
        let owned_file = pid_file.clone();
        let task = tokio::spawn(async move {
            let mut command = Command::new(std::env::current_exe().unwrap());
            helper(&mut command, "parent", &owned_file);
            output(&mut command).await
        });
        let pid = read_pid(&pid_file).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_gone(pid).await;
    }

    #[tokio::test]
    async fn output_is_collected_before_the_job_is_released() {
        let temp = TempDir::new("process-output");
        let mut command = Command::new(std::env::current_exe().unwrap());
        helper(&mut command, "exit", &temp.path().join("unused.pid"));
        let result = output(&mut command).await.unwrap();
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains("owned-output"));
    }

    #[tokio::test]
    async fn installer_exit_reaps_descendants_that_inherited_its_output_pipes() {
        let temp = TempDir::new("process-inherited-output");
        let pid_file = temp.path().join("descendant.pid");
        let mut command = Command::new(std::env::current_exe().unwrap());
        helper(&mut command, "parent-exit-with-pipes", &pid_file);
        let result = tokio::time::timeout(Duration::from_secs(10), output(&mut command))
            .await
            .expect("installer output waited on an orphan's pipes")
            .unwrap();
        assert!(result.status.success());
        assert_gone(read_pid(&pid_file).await).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_reused_leader_identity_does_not_receive_a_group_signal() {
        let temp = TempDir::new("process-reused-identity");
        let mut command = Command::new(std::env::current_exe().unwrap());
        helper(&mut command, "sleep", &temp.path().join("unused.pid"));
        let (mut child, mut tree) = ProcessTree::spawn(&mut command).unwrap();
        let pid = child.id().unwrap();
        assert!(tree.leader_identity.is_some());
        tree.leader_identity = Some("different-process-lifetime".to_owned());
        tree.kill().unwrap();
        assert!(crate::process::running(pid));
        tree.leader_identity = None;
        tree.kill().unwrap();
        drop(tree);
        assert!(crate::process::running(pid));
        child.kill().await.unwrap();
    }
}
