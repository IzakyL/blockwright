import { parseCaps } from "./tools.js";
import type { CreateServerOptions } from "./server.js";

export interface CliOptions extends CreateServerOptions {
  /** Modules whose default export is a UI adapter (or an array of them), see `loadUiAdapters`. */
  uiAdapters?: string[];
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--config":
        options.config = take();
        break;
      case "--cwd":
        options.cwd = take();
        break;
      case "--cli":
        options.driverPath = take();
        break;
      case "--artifact-dir":
        options.artifactDir = take();
        break;
      case "--instance-prefix":
        options.instancePrefix = take();
        break;
      case "--launch-attempts": {
        const attempts = Number(take());
        if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--launch-attempts needs a positive integer");
        options.launchAttempts = attempts;
        break;
      }
      case "--caps":
        options.caps = parseCaps(take());
        break;
      case "--ui-adapter":
        (options.uiAdapters ??= []).push(take());
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}
