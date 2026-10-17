import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { InstanceRole } from "./types-launch.js";

const REGISTRY_DIR = ".blockwright/instances.d";

export interface InstanceRecord {
  instanceId: string;
  role: InstanceRole;
  pid: number;
  instanceDir: string;
  tracePath?: string | null;
  config?: string | null;
  startedAt: string;
  /** Native process creation identity, when the driver could inspect it. */
  processIdentity?: string | null;
  /** Driver target, e.g. linux-x64 or win32-x64; foreign records cannot be inspected locally. */
  platform?: string | null;
}

export function registryDir(root: string = process.cwd()): string {
  return resolve(root, REGISTRY_DIR);
}

export function instanceAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  if (process.platform !== "linux") return processExists(pid);
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return processExists(pid);
  }
  const tail = stat.slice(stat.lastIndexOf(")") + 1).trim();
  return tail.split(/\s+/)[0] !== "Z";
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access denied or an unknown result is not evidence that a process has died.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function listInstances(root: string = process.cwd()): InstanceRecord[] {
  const dir = registryDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: InstanceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as InstanceRecord;
      if (typeof record.pid === "number" && (record.platform && record.platform !== `${process.platform}-${process.arch}` || instanceAlive(record.pid))) {
        records.push(record);
      }
    } catch {
    }
  }
  return records.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

export function findInstance(
  needle: string | undefined,
  options: { root?: string; role?: InstanceRole } = {},
): InstanceRecord | undefined {
  const scoped = listInstances(options.root).filter(
    (record) => options.role === undefined || record.role === options.role,
  );
  if (needle === undefined) {
    if (scoped.length > 1) {
      throw new Error(
        `${scoped.length} instances are running; name one of: ${scoped.map((r) => r.instanceId).join(", ")}`,
      );
    }
    return scoped[0];
  }
  const exact = scoped.find((record) => record.instanceId === needle);
  if (exact) {
    return exact;
  }
  const named = scoped.filter((record) => instanceName(record) === needle);
  if (named.length > 1) {
    throw new Error(
      `${needle} is the instance directory name of more than one running instance: ${named
        .map((r) => r.instanceId)
        .join(", ")}`,
    );
  }
  if (named.length === 1) {
    return named[0];
  }
  const partial = scoped.filter((record) => record.instanceId.includes(needle));
  if (partial.length > 1) {
    throw new Error(
      `${needle} matches ${partial.length} instances: ${partial.map((r) => r.instanceId).join(", ")}`,
    );
  }
  return partial[0];
}

function instanceName(record: InstanceRecord): string | undefined {
  if (typeof record.instanceDir !== "string" || record.instanceDir === "") {
    return undefined;
  }
  const name = basename(record.instanceDir);
  return name === "" || name === "." || name === ".." ? undefined : name;
}
