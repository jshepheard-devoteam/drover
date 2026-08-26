/**
 * Public types for the durable ticket board — a dependency-aware scheduler
 * layered on top of `createSandbox()`/`sandbox.run()`. See
 * `docs/adr/0021-board-layer-is-plain-typescript.md` for why this layer is
 * plain TypeScript rather than Effect.
 */

import type { AgentProvider } from "../AgentProvider.js";
import type { SandboxHooks } from "../SandboxLifecycle.js";
import type { SandboxProvider } from "../SandboxProvider.js";

/** How a ticket's agent session is launched. Fixed before the ticket starts — not switchable mid-flight. */
export type TicketMode = "auto" | "interactive";

/**
 * Terminal status of a ticket. `blocked` is deliberately not a status —
 * runnability is derived from unmet deps every tick so it can't go stale.
 */
export type TicketStatus =
  | "pending"
  | "running"
  | "done"
  | "done_no_commits"
  | "needs_attempt"
  | "failed"
  | "interrupted";

/** A unit of work seeded from `board.json` and tracked in the board's SQLite state. */
export interface Ticket {
  readonly id: string;
  readonly title: string;
  /** Inline prompt (mutually exclusive with `promptFile`, mirrors `SandboxRunOptions`). */
  readonly prompt?: string;
  readonly promptFile?: string;
  /** Ticket ids this ticket depends on. Satisfied only by dependency status `done` — see ADR-level note in board/run.ts. */
  readonly deps: readonly string[];
  readonly mode: TicketMode;
  /** Weakly-connected component id, assigned by `chains.ts` at `board load` time. */
  readonly chainId: string | null;
  /** Topological position within the chain, assigned at load time. */
  readonly seq: number | null;
  readonly maxIterations: number;
  readonly maxAttempts: number;
  readonly completionSignal?: string | readonly string[];
  /** Advisory hint for the operator's `agentFor()` callback — the board does not interpret this itself. */
  readonly agent?: string;
  readonly model?: string;
  readonly status: TicketStatus;
  readonly ownerPid: number | null;
  readonly gateState: string | null;
  readonly gateNote: string | null;
  readonly updatedAt: string;
}

/** Shape of one entry in the git-tracked `board.json` (intent, not state). */
export interface TicketInput {
  readonly id: string;
  readonly title: string;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly deps?: readonly string[];
  readonly mode?: TicketMode;
  readonly maxIterations?: number;
  readonly maxAttempts?: number;
  readonly completionSignal?: string | readonly string[];
  readonly agent?: string;
  readonly model?: string;
}

/** Append-only audit trail row — one per attempt at running a ticket. */
export interface Attempt {
  readonly ticketId: string;
  readonly n: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: "done" | "done_no_commits" | "needs_attempt" | "failed";
  readonly completionSignal?: string;
  readonly commitShas: readonly string[];
  readonly branch: string;
  /** Foreign key into whichever agent's own native session store — never normalized across providers. */
  readonly sessionId?: string;
  readonly sessionFilePath?: string;
  readonly preservedWorktreePath?: string;
  readonly errorTag?: string;
  readonly errorMessage?: string;
  readonly stdoutTail?: string;
}

export type GateDecision =
  | {
      readonly action: "proceed";
      readonly promptOverride?: string;
      readonly note?: string;
    }
  | {
      readonly action: "defer";
      readonly note: string;
      readonly retryAfterMs?: number;
    }
  | { readonly action: "reject"; readonly note: string };

export interface GateContext {
  readonly ticket: Ticket;
  readonly attempt: number;
  readonly previousAttempt?: Attempt;
  readonly chain: readonly Ticket[];
  readonly baseBranch?: string;
}

/** Pre-execution interrogation gate, run before every `sandbox.run()` call. Purely additive over Sandcastle's own API. */
export type BeforeRun = (ctx: GateContext) => Promise<GateDecision>;

/**
 * Launches an interactive ticket (e.g. inside a Herdr pane) and returns once
 * launched, not once finished. The board claims the ticket and hands off —
 * it never executes an interactive ticket itself.
 */
export type Launcher = (ticket: Ticket) => Promise<void>;

/** Options shared by `startBoard()` and `runOne()`. */
export interface BoardOptions {
  readonly dbPath: string;
  /** Host repo directory forwarded to `createSandbox()`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly sandbox: SandboxProvider;
  /** Resolves the agent provider for a ticket — providers are factory calls, not JSON, so the board never constructs them itself. */
  readonly agentFor: (ticket: Ticket) => AgentProvider;
  readonly hooks?: SandboxHooks;
  readonly copyToWorktree?: readonly string[];
  readonly baseBranch?: string;
  readonly beforeRun?: BeforeRun;
  /** Required when any loaded ticket has `mode: "interactive"`. */
  readonly launcher?: Launcher;
  /** Poll interval for `startBoard()`'s daemon loop, in ms. Default: 2000. */
  readonly pollIntervalMs?: number;
  /** Upper bound on a chain's total wall-clock time, checked between tickets. Unset = no ceiling. */
  readonly maxChainWallClockMs?: number;
  /** Max chains processed concurrently. Default: 1. */
  readonly maxConcurrentChains?: number;
  readonly signal?: AbortSignal;
  /**
   * How a ticket's agent is actually invoked. `"sandbox"` (default) calls
   * `sandbox.run()`/`sandbox.interactive()` headlessly, as today. `"herdr"`
   * runs the agent directly on the host in a Herdr pane instead — requires
   * `sandbox: noSandbox()` (checked at `startBoard`/`runOne` entry) and
   * trades away container isolation for real observability; see
   * docs/adr/0022-herdr-execution-is-host-native.md.
   */
  readonly execVia?: "herdr" | "sandbox";
}
