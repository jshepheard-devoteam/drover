/**
 * The board's execution layer: `startBoard()` is the daemon loop that drives
 * auto tickets through shared per-chain sandboxes; `runOne()` executes a
 * single ticket in its own sandbox — the manual-retry entry point (§Phase 2)
 * and the pane-resident entry point for an interactive handoff (§Phase 5).
 *
 * Deliberately plain TypeScript, no Effect — see
 * docs/adr/0021-board-layer-is-plain-typescript.md.
 */

import {
  createSandbox,
  type Sandbox,
  type SandboxRunOptions,
} from "../createSandbox.js";
import type { AgentProvider } from "../AgentProvider.js";
import {
  classify,
  classifyInteractive,
  extractErrorMessage,
  extractErrorTag,
} from "./classify.js";
import { openBoard, type BoardDb } from "./db.js";
import type {
  Attempt,
  BoardOptions,
  GateContext,
  Ticket,
  TicketStatus,
} from "./types.js";

const MAX_TAIL_CHARS = 4 * 1024;

const isTerminal = (status: TicketStatus): boolean =>
  status === "done" || status === "done_no_commits" || status === "failed";

const chainBranch = (chainId: string): string => `drover/board/${chainId}`;

const nowISO = (): string => new Date().toISOString();

/** Inlines the literal completion signal and the prior attempt's evidence — never a prose description of the handoff contract. */
export const buildContinuationPrompt = (
  ticket: Ticket,
  last: Attempt,
): string => {
  const signal = Array.isArray(ticket.completionSignal)
    ? ticket.completionSignal[0]
    : ticket.completionSignal;
  const lines = [
    `Continuing ticket "${ticket.title}" (id: ${ticket.id}). A previous attempt ran out of iterations before finishing.`,
    ticket.prompt
      ? `Original task:\n${ticket.prompt}`
      : `Original task is defined in ${ticket.promptFile}.`,
  ];
  if (signal !== undefined) {
    lines.push(
      `When the task is complete, you MUST emit exactly this string: ${JSON.stringify(signal)}`,
    );
  }
  lines.push(
    `Commits made in the previous attempt: ${JSON.stringify(last.commitShas)}`,
  );
  lines.push(
    `Tail of the previous attempt's output:\n${last.stdoutTail ?? "(none)"}`,
  );
  return lines.join("\n\n");
};

/**
 * Builds the options for one `sandbox.run()` attempt. A gate's
 * `promptOverride` — or a retry's continuation prompt — is always delivered
 * as an inline `prompt`, never combined with `promptArgs`: per ADR 0008,
 * inline prompts pass through to the agent literally, and Sandcastle treats
 * `prompt` + `promptArgs` together as an error. The gate/retry machinery
 * therefore does its own interpolation in JS rather than relying on
 * Sandcastle's `{{KEY}}` substitution.
 */
export const buildRunOptions = (
  ticket: Ticket,
  agent: AgentProvider,
  promptOverride?: string,
): SandboxRunOptions => {
  const base = {
    agent,
    maxIterations: ticket.maxIterations,
    completionSignal: ticket.completionSignal as string | string[] | undefined,
    name: ticket.id,
  };
  if (promptOverride !== undefined) return { ...base, prompt: promptOverride };
  if (ticket.prompt !== undefined) return { ...base, prompt: ticket.prompt };
  return { ...base, promptFile: ticket.promptFile };
};

const unmetDeps = (ticket: Ticket, db: BoardDb): string[] =>
  ticket.deps.filter((depId) => db.getTicket(depId)?.status !== "done");

/**
 * Runs the pre-execution gate, if configured. Returns the prompt override to
 * use (if any) when the gate says to proceed, or `undefined` when the ticket
 * should not run this pass — the gate has already updated the ticket's
 * status/gate_state/gate_note in that case.
 */
const runGate = async (
  ctx: GateContext,
  options: BoardOptions,
  db: BoardDb,
): Promise<{ proceed: true; promptOverride?: string } | { proceed: false }> => {
  if (!options.beforeRun) return { proceed: true };
  const decision = await options.beforeRun(ctx);
  if (decision.action === "proceed")
    return { proceed: true, promptOverride: decision.promptOverride };
  if (decision.action === "defer") {
    db.release(ctx.ticket.id, "pending", {
      gateState: "deferred",
      gateNote: decision.note,
    });
    return { proceed: false };
  }
  db.setStatus(ctx.ticket.id, "failed");
  db.release(ctx.ticket.id, "failed", {
    gateState: "rejected",
    gateNote: decision.note,
  });
  return { proceed: false };
};

/** Runs one `sandbox.run()` attempt and records it. Returns the classified outcome. */
const attemptOnce = async (
  sandbox: Sandbox,
  ticket: Ticket,
  agent: AgentProvider,
  attemptN: number,
  promptOverride: string | undefined,
  signal: AbortSignal | undefined,
  db: BoardDb,
): Promise<ReturnType<typeof classify>> => {
  const startedAt = nowISO();
  const runOptions = {
    ...buildRunOptions(ticket, agent, promptOverride),
    signal,
  };
  try {
    const result = await sandbox.run(runOptions);
    const outcome = classify({
      threw: false,
      completionSignal: result.completionSignal,
      commits: result.commits,
    });
    const lastIteration = result.iterations.at(-1);
    db.recordAttempt({
      ticketId: ticket.id,
      n: attemptN,
      startedAt,
      endedAt: nowISO(),
      outcome,
      completionSignal: result.completionSignal,
      commitShas: result.commits.map((c) => c.sha),
      branch: sandbox.branch,
      sessionId: lastIteration?.sessionId,
      sessionFilePath: lastIteration?.sessionFilePath,
      stdoutTail: result.stdout.slice(-MAX_TAIL_CHARS),
    });
    return outcome;
  } catch (error) {
    const preservedWorktreePath = (error as { preservedWorktreePath?: string })
      .preservedWorktreePath;
    db.recordAttempt({
      ticketId: ticket.id,
      n: attemptN,
      startedAt,
      endedAt: nowISO(),
      outcome: "failed",
      commitShas: [],
      branch: sandbox.branch,
      preservedWorktreePath,
      errorTag: extractErrorTag(error),
      errorMessage: extractErrorMessage(error),
    });
    return "failed";
  }
};

/** Gate + attempt-retry loop for one auto-mode ticket against an already-open sandbox. */
const runAutoTicket = async (
  sandbox: Sandbox,
  ticket: Ticket,
  chain: readonly Ticket[],
  options: BoardOptions,
  controller: AbortController,
  db: BoardDb,
): Promise<void> => {
  let attemptN = (db.lastAttempt(ticket.id)?.n ?? 0) + 1;
  let promptOverride: string | undefined;

  const gateResult = await runGate(
    {
      ticket,
      attempt: attemptN,
      previousAttempt: db.lastAttempt(ticket.id),
      chain,
      baseBranch: options.baseBranch,
    },
    options,
    db,
  );
  if (!gateResult.proceed) return;
  promptOverride = gateResult.promptOverride;

  const agent = options.agentFor(ticket);
  let outcome: ReturnType<typeof classify>;
  for (;;) {
    outcome = await attemptOnce(
      sandbox,
      ticket,
      agent,
      attemptN,
      promptOverride,
      controller.signal,
      db,
    );
    if (outcome !== "needs_attempt" || attemptN >= ticket.maxAttempts) break;
    attemptN++;
    promptOverride = buildContinuationPrompt(
      ticket,
      db.lastAttempt(ticket.id)!,
    );
  }
  db.setStatus(ticket.id, outcome);
};

/**
 * Runs one weakly-connected component of the dependency graph: one shared
 * sandbox, tickets attempted in topological order. Skips (leaves `pending`)
 * any ticket whose deps aren't all `done` yet — dependency satisfaction is
 * `done` only (see classify.ts) — and skips the whole chain if an external
 * process already owns a `running` ticket in it (an in-flight interactive
 * handoff).
 */
const runChain = async (
  chainId: string,
  options: BoardOptions,
  controller: AbortController,
  db: BoardDb,
): Promise<void> => {
  const chain = db.listTicketsByChain(chainId);
  if (chain.some((t) => t.status === "running" && t.ownerPid !== process.pid))
    return;

  const chainStart = Date.now();
  const sandbox = await createSandbox({
    branch: chainBranch(chainId),
    baseBranch: options.baseBranch,
    sandbox: options.sandbox,
    cwd: options.cwd,
    hooks: options.hooks,
    copyToWorktree: options.copyToWorktree
      ? [...options.copyToWorktree]
      : undefined,
  });
  let sandboxClosed = false;

  try {
    for (const seed of chain) {
      if (controller.signal.aborted) break;
      if (
        options.maxChainWallClockMs !== undefined &&
        Date.now() - chainStart > options.maxChainWallClockMs
      ) {
        break;
      }

      const ticket = db.getTicket(seed.id)!;
      if (isTerminal(ticket.status)) continue;
      if (unmetDeps(ticket, db).length > 0) continue;

      if (ticket.mode === "interactive") {
        if (!options.launcher) {
          db.setStatus(ticket.id, "failed");
          continue;
        }
        const gateResult = await runGate(
          {
            ticket,
            attempt: 1,
            previousAttempt: db.lastAttempt(ticket.id),
            chain,
            baseBranch: options.baseBranch,
          },
          options,
          db,
        );
        if (!gateResult.proceed) continue;
        if (!db.claim(ticket.id, process.pid)) continue;
        // Hand off entirely — a separate process now owns this worktree/branch.
        // Close our sandbox first so it isn't holding the worktree lock (ADR 0007).
        sandboxClosed = true;
        await sandbox.close();
        await options.launcher(db.getTicket(ticket.id)!);
        return; // Stop touching this chain; a later poll resumes it once the ticket leaves `running`.
      }

      if (!db.claim(ticket.id, process.pid)) continue;
      await runAutoTicket(sandbox, ticket, chain, options, controller, db);
      const after = db.getTicket(ticket.id)!;
      if (after.status === "failed") break; // Chain halts on a hard failure.
    }
  } finally {
    if (!sandboxClosed) await sandbox.close();
  }
};

/**
 * The daemon loop: repeatedly scans for chains with a claimable next ticket,
 * runs up to `maxConcurrentChains` of them concurrently, and polls every
 * `pollIntervalMs` until stopped (`board stop`, an aborted `signal`, or every
 * ticket has reached a terminal status).
 *
 * Known limit: a ticket permanently blocked on a dep that will never reach
 * `done` (e.g. the dep is `failed`) is not detected as stuck — the loop
 * keeps polling until a human runs `board stop`, `board retry`, or `board
 * skip`. Fine for six tickets on a laptop; not a fleet scheduler.
 */
export const startBoard = async (options: BoardOptions): Promise<void> => {
  const db = openBoard(options.dbPath);
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const maxConcurrentChains = options.maxConcurrentChains ?? 1;
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  try {
    const inFlight = new Map<string, Promise<void>>();
    for (;;) {
      if (controller.signal.aborted) break;
      if (db.isStopRequested()) {
        controller.abort();
        break;
      }

      const tickets = db.listTickets();
      if (
        tickets.length > 0 &&
        inFlight.size === 0 &&
        tickets.every(
          (t) => t.status !== "pending" && t.status !== "needs_attempt",
        )
      ) {
        break; // Every ticket has settled into a terminal-ish state.
      }

      for (const chainId of db.listChainIds()) {
        if (inFlight.size >= maxConcurrentChains) break;
        if (inFlight.has(chainId)) continue;
        const chainTickets = db.listTicketsByChain(chainId);
        const claimable = chainTickets.some(
          (t) =>
            (t.status === "pending" || t.status === "needs_attempt") &&
            unmetDeps(t, db).length === 0,
        );
        if (!claimable) continue;
        const run = runChain(chainId, options, controller, db).finally(() => {
          inFlight.delete(chainId);
        });
        inFlight.set(chainId, run);
      }

      await Promise.race([
        Promise.allSettled(inFlight.values()),
        new Promise((resolve) => setTimeout(resolve, pollIntervalMs)),
      ]);
    }
    await Promise.allSettled(inFlight.values());
  } finally {
    db.close();
  }
};

/**
 * Executes exactly one ticket in its own sandbox — the manual-retry entry
 * point (`board retry` flips status via the DB; this is what an operator's
 * `.drover/main.mts --ticket <id>` actually runs) and the pane-resident
 * entry point for an interactive handoff (`--ticket <id> --interactive`).
 *
 * A single attempt, never the automatic `maxAttempts` retry loop — that loop
 * is `startBoard`'s concern. A human calling this again is the retry.
 */
export const runOne = async (
  ticketId: string,
  options: BoardOptions,
): Promise<void> => {
  const db = openBoard(options.dbPath);
  try {
    const ticket = db.getTicket(ticketId);
    if (!ticket) throw new Error(`Unknown ticket "${ticketId}"`);
    if (!ticket.chainId)
      throw new Error(
        `Ticket "${ticketId}" has no chain assignment — run "board load" first`,
      );

    // The daemon may have already claimed this ticket before handing off to
    // an interactive launcher; re-stamp ownership to this process rather
    // than re-claiming (claim() only matches pending/needs_attempt).
    if (ticket.status !== "running") {
      if (!db.claim(ticketId, process.pid)) {
        throw new Error(
          `Ticket "${ticketId}" is not runnable (status: ${ticket.status})`,
        );
      }
    }

    const sandbox = await createSandbox({
      branch: chainBranch(ticket.chainId),
      baseBranch: options.baseBranch,
      sandbox: options.sandbox,
      cwd: options.cwd,
      hooks: options.hooks,
      copyToWorktree: options.copyToWorktree
        ? [...options.copyToWorktree]
        : undefined,
    });

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else
        options.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }

    try {
      const agent = options.agentFor(ticket);
      const attemptN = (db.lastAttempt(ticketId)?.n ?? 0) + 1;

      if (ticket.mode === "interactive") {
        const startedAt = nowISO();
        try {
          const result = await sandbox.interactive({
            agent,
            prompt: ticket.prompt,
            promptFile: ticket.promptFile,
            name: ticket.id,
            signal: controller.signal,
          });
          const outcome = classifyInteractive({
            threw: false,
            exitCode: result.exitCode,
            commits: result.commits,
          });
          db.recordAttempt({
            ticketId,
            n: attemptN,
            startedAt,
            endedAt: nowISO(),
            outcome,
            commitShas: result.commits.map((c) => c.sha),
            branch: sandbox.branch,
          });
          db.setStatus(ticketId, outcome);
        } catch (error) {
          db.recordAttempt({
            ticketId,
            n: attemptN,
            startedAt,
            endedAt: nowISO(),
            outcome: "failed",
            commitShas: [],
            branch: sandbox.branch,
            errorTag: extractErrorTag(error),
            errorMessage: extractErrorMessage(error),
          });
          db.setStatus(ticketId, "failed");
        }
        return;
      }

      const last = db.lastAttempt(ticketId);
      const promptOverride =
        ticket.status === "running" && last?.outcome === "needs_attempt"
          ? buildContinuationPrompt(ticket, last)
          : undefined;
      const outcome = await attemptOnce(
        sandbox,
        ticket,
        agent,
        attemptN,
        promptOverride,
        controller.signal,
        db,
      );
      db.setStatus(ticketId, outcome);
    } finally {
      await sandbox.close();
    }
  } finally {
    db.close();
  }
};
