import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, join } from "node:path";

const GIB = 1024 ** 3;

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** Java processes on this machine and their resident memory, read from /proc (Linux only). */
function javaProcesses(): { count: number; rssBytes: number } | undefined {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  let count = 0;
  let rssBytes = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/comm`, "utf8").trim() !== "java") continue;
      count++;
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, "utf8"));
      if (rss) rssBytes += Number(rss[1]) * 1024;
    } catch {
      // The process exited while being read.
    }
  }
  return { count, rssBytes };
}

/**
 * One line on how loaded the machine is: memory left, load against cores, and how many JVMs hold how
 * much memory. A game starved of memory or CPU fails as a timeout, never as an out-of-memory error.
 */
export function hostLoad(): string {
  const parts = [
    `host memory ${gib(freemem())} free of ${gib(totalmem())}`,
    ...(process.platform === "win32" ? [`${cpus().length} cores`] : [`load ${loadavg()[0].toFixed(1)} on ${cpus().length} cores`]),
  ];
  const java = javaProcesses();
  if (java) parts.push(`${java.count} java processes using ${gib(java.rssBytes)}`);
  return parts.join(", ");
}

/**
 * Writes the thread stacks of JVM `pid` next to `tracePath` with the JDK's `jcmd` (beside the `java`
 * that started the game, else on PATH); returns the file, or undefined when no dump could be taken.
 */
export function dumpThreads(pid: number | undefined, javaCommand: string | undefined, tracePath: string): string | undefined {
  if (pid === undefined) return undefined;
  const executable = process.platform === "win32" ? "jcmd.exe" : "jcmd";
  const sibling = javaCommand ? join(dirname(javaCommand), executable) : undefined;
  const jcmd = sibling && existsSync(sibling) ? sibling : executable;
  try {
    const output = execFileSync(jcmd, [String(pid), "Thread.print"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const path = tracePath.replace(/\.ndjson$/, "") + `.threads-${Date.now()}.txt`;
    writeFileSync(path, output);
    return path;
  } catch {
    return undefined;
  }
}
