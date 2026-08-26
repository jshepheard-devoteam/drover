/**
 * Pure classification of a completed `sandbox.run()`/`sandbox.interactive()`
 * call into a ticket outcome. No I/O, no board state — the unit-test core of
 * the board.
 */

export type RunOutcome =
  | "done"
  | "done_no_commits"
  | "needs_attempt"
  | "failed";
export type InteractiveOutcome = "done" | "done_no_commits" | "failed";

export interface ClassifyRunInput {
  readonly threw: boolean;
  readonly completionSignal?: string;
  readonly commits: readonly { sha: string }[];
}

/**
 * Maps the four terminal outcomes `sandbox.run()` can actually produce:
 * threw -> `failed`; signal + commits -> `done`; signal, no commits ->
 * `done_no_commits` (dependency satisfaction is `done` only — see
 * board/run.ts); no signal (iterations exhausted) -> `needs_attempt`.
 */
export const classify = (input: ClassifyRunInput): RunOutcome => {
  if (input.threw) return "failed";
  if (input.completionSignal !== undefined) {
    return input.commits.length > 0 ? "done" : "done_no_commits";
  }
  return "needs_attempt";
};

export interface ClassifyInteractiveInput {
  readonly threw: boolean;
  readonly exitCode?: number;
  readonly commits: readonly { sha: string }[];
}

/**
 * `SandboxInteractiveResult` carries only `commits` and `exitCode` — no
 * `completionSignal` — so there is no `needs_attempt` outcome for an
 * interactive run.
 */
export const classifyInteractive = (
  input: ClassifyInteractiveInput,
): InteractiveOutcome => {
  if (input.threw || (input.exitCode !== undefined && input.exitCode !== 0))
    return "failed";
  return input.commits.length > 0 ? "done" : "done_no_commits";
};

/** Extracts a stable error tag from a thrown value: an Effect tagged error's `_tag`, falling back to `error.name`. */
export const extractErrorTag = (error: unknown): string => {
  if (error && typeof error === "object") {
    const tagged = error as { _tag?: unknown; name?: unknown };
    if (typeof tagged._tag === "string") return tagged._tag;
    if (typeof tagged.name === "string") return tagged.name;
  }
  return "UnknownError";
};

/** Best-effort message extraction from a thrown value, for `Attempt.errorMessage`. */
export const extractErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
