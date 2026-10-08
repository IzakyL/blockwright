use std::{fs, path::Path};

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

/// Sends `signal` to the process group `pid` leads and to `pid` itself; true if either got it.
pub fn signal(pid: u32, signal: libc::c_int) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    unsafe { (libc::kill(-pid, signal) == 0) | (libc::kill(pid, signal) == 0) }
}

#[cfg(test)]
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
