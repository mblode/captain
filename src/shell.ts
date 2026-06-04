import { spawnSync } from "node:child_process";

import type { RunOptions, RunResult } from "./types.js";

export const run = (
  command: string,
  args: string[],
  options: RunOptions = {}
): RunResult => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: options.env,
    input: options.input,
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
  });

  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
};

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const runRequired = (
  command: string,
  args: string[],
  options: RunOptions = {}
): string => {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    const details = result.stderr.trim() || result.stdout.trim();
    throw new Error(details ? `${rendered}: ${details}` : `${rendered} failed`);
  }
  return result.stdout.trim();
};

export const commandExists = (
  command: string,
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  run("sh", ["-c", `command -v ${shellQuote(command)}`], { env }).status === 0;
