import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

/** An edit to one of a shader pack's sources: `find` must be there, and is replaced once. */
export interface ShaderPatch {
  file: string;
  find: string;
  replace: string;
}

export interface SeedShaderPackOptions {
  /** The pack's zip. */
  zip: string;
  /** The folder the pack is unpacked as under `shaderpacks/`, and the name Iris is told; default the zip's name without `.zip`. */
  name?: string;
  /** The pack's own settings, as its Shader Options screen would save them (`shaderpacks/<name>.txt`). */
  options?: Record<string, string | number | boolean>;
  /** Edits to its sources, applied in order after unpacking. */
  patches?: readonly ShaderPatch[];
  /** Whether Iris starts with shaders on (default true); false still installs the pack. */
  enabled?: boolean;
}

/**
 * Puts an Iris shader pack into a client's instance dir before it launches: the pack unpacked (so its sources
 * can be patched), its settings written, and Iris told to use it. The client needs Iris among its mods, and
 * must be launched into the dir as it is (`reuseInstanceDir`; a `seedInstance` does that). Needs `unzip` on
 * PATH. Answers the pack's name. A patch whose `find` is gone throws: the pack changed under it.
 */
export function seedShaderPack(instanceDir: string, options: SeedShaderPackOptions): string {
  if (!existsSync(options.zip)) throw new Error(`shader pack not found at ${options.zip}`);
  const name = options.name ?? path.basename(options.zip).replace(/\.zip$/i, "");
  const pack = path.join(instanceDir, "shaderpacks", name);
  mkdirSync(pack, { recursive: true });
  execFileSync("unzip", ["-oq", options.zip, "-d", pack]);
  for (const patch of options.patches ?? []) {
    const file = path.join(pack, patch.file);
    const source = readFileSync(file, "utf8");
    if (!source.includes(patch.find)) throw new Error(`${name} changed: ${patch.file} no longer has ${patch.find}`);
    writeFileSync(file, source.replace(patch.find, () => patch.replace));
  }
  const settings = Object.entries(options.options ?? {});
  if (settings.length > 0) {
    writeFileSync(path.join(instanceDir, "shaderpacks", `${name}.txt`), settings.map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  }
  mkdirSync(path.join(instanceDir, "config"), { recursive: true });
  writeFileSync(path.join(instanceDir, "config", "iris.properties"),
    [`enableShaders=${options.enabled ?? true}`, `shaderPack=${name}`, "disableUpdateMessage=true", ""].join("\n"));
  return name;
}

/** A client did not render through the shader pack it was given. */
export class ShadersNotUsedError extends Error {
  /** What Iris logged. */
  readonly iris: string[];

  constructor(message: string, iris: string[]) {
    super(message);
    this.name = "ShadersNotUsedError";
    this.iris = iris;
  }
}

const SAID = "[Iris/]:";
const PIPELINE = /^Creating pipeline for dimension/;
const BROKE = /^Failed to load|falling back to (?:internal|vanilla)|^Disabling shaders/i;

/** What Iris logged in `text`, one entry per line, without the log prefix. */
export function irisLines(text: string): string[] {
  return text.split("\n")
    .filter((line) => line.includes(SAID))
    .map((line) => line.slice(line.indexOf(SAID) + SAID.length).trim());
}

/**
 * Judges what Iris logged ({@link irisLines}): throws {@link ShadersNotUsedError} unless it loaded the pack
 * `name`, built a render pipeline with it and never fell back to vanilla.
 */
export function judgeIris(iris: string[], name: string): void {
  const broke = iris.filter((line) => BROKE.test(line));
  if (broke.length > 0) throw new ShadersNotUsedError(`Iris fell back to vanilla; ${name} did not compile:\n${broke.join("\n")}`, iris);
  const using = iris.includes(`Using shaderpack: ${name}`);
  const piped = iris.some((line) => PIPELINE.test(line));
  if (!using || !piped) {
    throw new ShadersNotUsedError(
      `rendered without shaders: Iris ${using ? "loaded" : "did not load"} ${name} and ${piped ? "built" : "did not build"} its render pipeline.\n`
        + (iris.length > 0 ? `Iris said:\n${iris.join("\n")}` : "Iris logged nothing. Is it among the client's mods?"),
      iris);
  }
}

/**
 * Confirms from a client's log that it rendered through the shader pack `name`: a pack that fails to compile
 * falls back to vanilla without stopping the game, and the film looks plausible either way. Reads the logs in
 * the client's instance dir (those rolled over at midnight too); answers what Iris logged, or throws
 * {@link ShadersNotUsedError}.
 */
export function shaderEvidence(instanceDir: string, name: string): { pack: string; iris: string[] } {
  const logs = path.join(instanceDir, "logs");
  const latest = path.join(logs, "latest.log");
  if (!existsSync(latest)) throw new Error(`no client log at ${latest}, so nothing says whether the shaders compiled`);
  const rolled = readdirSync(logs)
    .filter((file) => /^\d{4}-\d{2}-\d{2}-\d+\.log\.gz$/.test(file))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => gunzipSync(readFileSync(path.join(logs, file))).toString("utf8"));
  const iris = irisLines([...rolled, readFileSync(latest, "utf8")].join("\n"));
  judgeIris(iris, name);
  return { pack: name, iris };
}
