/**
 * Default `Launcher` (see types.ts): opens a Herdr pane and fires the
 * ticket's interactive entry point into it. Both `herdr` calls return as
 * soon as the action is issued — `herdr pane run` does not wait for the
 * launched command to finish, which matches the `Launcher` contract
 * ("returns once launched, not once finished"). Verified against `herdr
 * 0.8.2`: `herdr tab create`'s response carries the new pane's id at
 * `result.root_pane.pane_id`, and `herdr pane run <PANE_ID> <TEXT>` types
 * `<TEXT>` into the pane's own shell and presses enter — it does not exec
 * argv directly, so a single already-joined command string behaves exactly
 * like passing its words as separate arguments.
 */

import { execFile } from "node:child_process";
import type { Launcher, Ticket } from "./types.js";

/** `execFile`, promisified by hand rather than via `util.promisify` — matches the mocking pattern the rest of this codebase's exec-based tests use (e.g. `sandboxes/podman.test.ts`), which stubs the callback form directly. */
const execFileAsync = (
  command: string,
  args: string[],
): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });

export interface HerdrLauncherOptions {
  /** Working directory for the new pane. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Builds the command line typed into the pane. Defaults to the
   * conventional entry point: `npx tsx .drover/main.mts --ticket <id>
   * --interactive` — the same `runOne()`-calling script every board
   * template already exports for manual retry.
   */
  readonly buildCommand?: (ticket: Ticket) => string;
}

interface HerdrTabCreateResponse {
  readonly result?: { readonly root_pane?: { readonly pane_id?: string } };
}

const defaultBuildCommand = (ticket: Ticket): string =>
  `npx tsx .drover/main.mts --ticket ${ticket.id} --interactive`;

export const createHerdrLauncher = (
  options?: HerdrLauncherOptions,
): Launcher => {
  const cwd = options?.cwd ?? process.cwd();
  const buildCommand = options?.buildCommand ?? defaultBuildCommand;

  return async (ticket) => {
    const { stdout } = await execFileAsync("herdr", [
      "tab",
      "create",
      "--cwd",
      cwd,
      "--label",
      `ticket-${ticket.id}`,
      "--no-focus",
    ]);
    const response = JSON.parse(stdout) as HerdrTabCreateResponse;
    const paneId = response.result?.root_pane?.pane_id;
    if (!paneId) {
      throw new Error(
        `herdr tab create did not return a pane id for ticket "${ticket.id}": ${stdout}`,
      );
    }
    await execFileAsync("herdr", ["pane", "run", paneId, buildCommand(ticket)]);
  };
};
