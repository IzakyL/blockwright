#[cfg(unix)]
use std::{fs, path::Path};

#[cfg(unix)]
pub fn running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return Path::new(&format!("/proc/{pid}")).exists();
    };
    stat.rsplit_once(')')
        .is_none_or(|(_, tail)| tail.split_whitespace().next() != Some("Z"))
}

/// Unknown/access-denied processes are conservatively considered alive so GC
/// never deletes an instance just because it could not inspect its owner.
#[cfg(windows)]
pub fn running(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    if pid == 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return std::io::Error::last_os_error().raw_os_error()
            != Some(ERROR_INVALID_PARAMETER as i32);
    }
    let status = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    match status {
        WAIT_OBJECT_0 => false,
        WAIT_TIMEOUT => true,
        _ => true,
    }
}

/// Sends `signal` to the process group `pid` leads and to `pid` itself; true if either got it.
#[cfg(unix)]
pub fn signal(pid: u32, signal: libc::c_int) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    unsafe { (libc::kill(-pid, signal) == 0) | (libc::kill(pid, signal) == 0) }
}

/// A stable creation identity for a PID, used to detect PID reuse in the registry.
pub fn identity(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (_, fields) = stat.rsplit_once(')')?;
        Some(format!("linux:{}", fields.split_whitespace().nth(19)?))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, FILETIME},
            System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        let ok =
            unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
        unsafe { CloseHandle(process) };
        (ok != 0).then(|| {
            format!(
                "windows:{}",
                ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64
            )
        })
    }
}

pub fn matches_identity(pid: u32, expected: Option<&str>) -> bool {
    running(pid)
        && match (expected, identity(pid)) {
            (Some(expected), Some(actual)) => expected == actual,
            _ => true,
        }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_zombie_is_not_running_even_though_its_proc_entry_is_still_there() {
        let child = std::process::Command::new("/bin/true")
            .spawn()
            .expect("spawn /bin/true");
        let pid = child.id();
        std::mem::forget(child);

        let mut zombie = false;
        for _ in 0..200 {
            if fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    let (_, tail) = stat.rsplit_once(')')?;
                    Some(tail.split_whitespace().next()? == "Z")
                })
                .unwrap_or(false)
            {
                zombie = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            zombie,
            "could not get /bin/true to sit as an unreaped zombie"
        );

        assert!(
            Path::new(&format!("/proc/{pid}")).exists(),
            "a zombie still has a /proc entry, which is exactly why existence is the wrong test"
        );
        assert!(
            !running(pid),
            "an exited process nobody has reaped is not something to keep waiting on"
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    #[test]
    fn current_process_is_alive_and_zero_is_not() {
        assert!(super::running(std::process::id()));
        assert!(!super::running(0));
    }
}
