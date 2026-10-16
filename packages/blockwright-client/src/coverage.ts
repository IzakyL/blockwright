import { execFile } from "node:child_process";
import { resolveBinaryPath } from "./binary.js";

export interface CoverageOptions {
  /** The config (`path` or `path#profile`) whose `[coverage]` is used; default `blockwright.toml`. */
  config?: string;
  /** The working directory the config path resolves against; default `process.cwd()`. */
  cwd?: string;
  /** The `blockwright` binary; default as for {@link BlockwrightDriver}. */
  driverPath?: string;
}

export interface CoverageReportOptions extends CoverageOptions {
  /** Where `html/`, `jacoco.xml` and `lcov.info` go; default `<coverage.dir>/report`. */
  out?: string;
}

/**
 * Merges the coverage every instance recorded (launched with `[coverage]` on) into HTML, XML and LCOV
 * reports, and returns the tool's summary. Call it once the games are closed, e.g. from a globalTeardown.
 */
export function coverageReport(options: CoverageReportOptions = {}): Promise<string> {
  return runCoverage(["report", ...configArgs(options), ...(options.out ? ["--out", options.out] : [])], options);
}

/** Deletes the recorded coverage and the default report, e.g. from a globalSetup, so a run starts from nothing. */
export function coverageReset(options: CoverageOptions = {}): Promise<string> {
  return runCoverage(["reset", ...configArgs(options)], options);
}

function configArgs(options: CoverageOptions): string[] {
  return options.config ? ["--config", options.config] : [];
}

function runCoverage(args: string[], options: CoverageOptions): Promise<string> {
  const binary = resolveBinaryPath(options.driverPath);
  return new Promise((resolve, reject) => {
    execFile(binary, ["coverage", ...args], { cwd: options.cwd ?? process.cwd(), maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`blockwright coverage ${args[0]} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
