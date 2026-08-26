/**
 * Host-native ticket execution via Herdr — the execution engine that
 * replaces `sandbox.run()` for `execVia: "herdr"` boards. No container:
 * the agent runs directly on the host, in a Herdr pane, against the exact
 * git worktree Sandcastle already checked out (`sandbox.worktreePath`).
 *
 * This trade — no container isolation for these tickets — was confirmed
 * live in this session: `herdr pane run <id> "docker exec -it <container>
 * claude ..."` never triggers Herdr's agent detection (`agent get` returns
 * `agent_not_found` even though the pane visibly renders Claude's TUI), and
 * the PATH-shim fallback resolves and launches the real *host* `claude`
 * binary regardless, bypassing the container entirely. There is currently
 * no way to get Herdr to observe an agent actually running inside a
 * container — see docs/adr/0022-herdr-execution-is-host-native.md.
 */

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { AgentProvider } from "../AgentProvider.js";
import type { Sandbox } from "../createSandbox.js";
import { classify, type RunOutcome } from "./classify.js";
import { classifyStartup, type HerdrClient } from "./herdr.js";
import type { Ticket } from "./types.js";

const MAX_TAIL_CHARS = 4 * 1024;
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 1_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** "claude-code" -> "claude" (Herdr's detected kind, confirmed live); other providers pass through as-is. */
export const herdrKindFor = (providerName: string): string =>
  providerName === "claude-code" ? "claude" : providerName;

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

const sentinelPath = (worktreePath: string, ticketId: string): string =>
  join(worktreePath, `.drover-signal-${ticketId}`);

const readSentinel = async (
  worktreePath: string,
  ticketId: string,
  signals: string | readonly string[] | undefined,
): Promise<string | undefined> => {
  if (signals === undefined) return undefined;
  const wanted = Array.isArray(signals) ? signals : [signals];
  let content: string;
  try {
    content = (
      await readFile(sentinelPath(worktreePath, ticketId), "utf8")
    ).trim();
  } catch {
    return undefined;
  }
  return wanted.find((s) => s === content);
};

const clearSentinel = (worktreePath: string, ticketId: string): Promise<void> =>
  rm(sentinelPath(worktreePath, ticketId), { force: true });

/**
 * Adds `.drover-signal-*` to the worktree's local git exclude, once. Never
 * touches the tracked `.gitignore` — this is host-machine bookkeeping for a
 * file that must never be committed, not something a collaborator's clone
 * needs to know about.
 *
 * Resolved via `git rev-parse --git-path`, not `join(worktreePath, ".git",
 * ...)` — a Sandcastle worktree's `.git` is a *file* pointing at the real
 * git dir elsewhere (`git worktree add`'s usual shape), not a directory, so
 * the naive join throws ENOTDIR.
 */
const excludeSentinelFiles = async (worktreePath: string): Promise<void> => {
  const gitPath = (
    await execHost(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      worktreePath,
    )
  ).trim();
  const excludePath = gitPath.startsWith("/")
    ? gitPath
    : join(worktreePath, gitPath);
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // No .git/info/exclude yet (unusual, but harmless) — the write below creates it.
  }
  if (existing.includes(".drover-signal-*")) return;
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(
    excludePath,
    `${existing.endsWith("\n") || existing === "" ? "" : "\n"}.drover-signal-*\n`,
  );
};

const execHost = (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args as string[],
      { cwd, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

const gitRevParseHead = (worktreePath: string): Promise<string> =>
  execHost("git", ["rev-parse", "HEAD"], worktreePath).then((s) => s.trim());

const gitCommitsSince = async (
  worktreePath: string,
  baseHead: string,
): Promise<{ sha: string }[]> => {
  const out = await execHost(
    "git",
    ["rev-list", `${baseHead}..HEAD`, "--reverse"],
    worktreePath,
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sha) => ({ sha }));
};

const buildIterationNudge = (ticket: Ticket, worktreePath: string): string => {
  const signal = Array.isArray(ticket.completionSignal)
    ? ticket.completionSignal[0]
    : ticket.completionSignal;
  const lines = ["Continue with the task."];
  if (signal !== undefined) {
    lines.push(
      `When complete, write exactly this string (no extra whitespace) to ${sentinelPath(worktreePath, ticket.id)}: ${JSON.stringify(signal)}`,
    );
  }
  return lines.join(" ");
};

const withSignalInstruction = (
  promptText: string,
  ticket: Ticket,
  worktreePath: string,
): string => {
  const signal = Array.isArray(ticket.completionSignal)
    ? ticket.completionSignal[0]
    : ticket.completionSignal;
  if (signal === undefined) return promptText;
  return [
    promptText,
    `When the task is complete, write exactly this string (no extra whitespace) to ${sentinelPath(worktreePath, ticket.id)}: ${JSON.stringify(signal)}`,
  ].join("\n\n");
};

const resolveTicketPrompt = async (ticket: Ticket): Promise<string> => {
  if (ticket.prompt !== undefined) return ticket.prompt;
  if (ticket.promptFile !== undefined)
    return readFile(ticket.promptFile, "utf8");
  throw new Error(`Ticket "${ticket.id}" has neither prompt nor promptFile`);
};

export interface HerdrRunResult {
  readonly completionSignal?: string;
  readonly commits: readonly { sha: string }[];
  readonly stdoutTail: string;
  readonly sessionId?: string;
}

/**
 * One attempt = one pane = one agent session, up to `ticket.maxIterations`
 * turns. Host-native only — throws unless `sandbox` came from `noSandbox()`
 * (checked by the caller in `run.ts`, since `Sandbox` itself doesn't carry
 * the provider tag).
 *
 * Runs with `dangerouslySkipPermissions: true` even on the bare host — a
 * deliberate, explicitly-accepted trade for unattended execution. Without
 * it, an auto ticket would hang on Claude's first permission prompt with
 * nobody watching. There is no container here to contain a mistake; boards
 * that need that safety net use `execVia: "sandbox"` instead.
 */
export const runTicketInPane = async (o: {
  herdr: HerdrClient;
  sandbox: Sandbox;
  ticket: Ticket;
  agent: AgentProvider;
  promptOverride: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<HerdrRunResult> => {
  const { herdr, sandbox, ticket, agent, promptOverride, signal } = o;
  const worktreePath = sandbox.worktreePath;

  if (!agent.buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${agent.name}" does not support buildInteractiveArgs, required for Herdr execution.`,
    );
  }

  const baseHead = await gitRevParseHead(worktreePath);
  await excludeSentinelFiles(worktreePath);
  await clearSentinel(worktreePath, ticket.id);

  const argv = agent.buildInteractiveArgs({
    prompt: "",
    dangerouslySkipPermissions: true,
  });
  const command = argv.map(shellQuote).join(" ");

  const workspace = await herdr.createWorkspace({
    cwd: worktreePath,
    label: `ticket-${ticket.id}`,
  });
  const paneId = workspace.paneId;
  let closeWorkspace = true;

  try {
    await herdr.paneRun({ paneId, command });

    const expectedKind = herdrKindFor(agent.name);
    const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
    let ready = false;
    let blocked = false;
    for (;;) {
      const snapshot = await herdr.getAgent(paneId);
      const state = classifyStartup({ snapshot, expectedKind });
      if (state === "ready") {
        ready = true;
        break;
      }
      if (state === "blocked") {
        blocked = true;
        break;
      }
      if (Date.now() >= startupDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
    }

    if (blocked) {
      closeWorkspace = false; // Nothing automated can clear a startup dialog — leave the pane for a human.
      const error = new Error(
        `Agent for ticket "${ticket.id}" is blocked on startup`,
      );
      error.name = "HerdrAgentBlocked";
      throw error;
    }
    if (!ready) {
      closeWorkspace = false;
      const error = new Error(
        `Agent for ticket "${ticket.id}" did not become ready within ${STARTUP_TIMEOUT_MS}ms`,
      );
      error.name = "HerdrStartupTimeout";
      throw error;
    }

    let completionSignal: string | undefined;
    const initialPrompt = withSignalInstruction(
      promptOverride ?? (await resolveTicketPrompt(ticket)),
      ticket,
      worktreePath,
    );

    for (let turn = 1; turn <= ticket.maxIterations; turn++) {
      if (signal?.aborted) {
        closeWorkspace = false;
        await herdr.sendKeys({ paneId, keys: "C-c" });
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      }
      const text =
        turn === 1 ? initialPrompt : buildIterationNudge(ticket, worktreePath);
      await herdr.prompt({ paneId, text, timeoutMs: DEFAULT_TURN_TIMEOUT_MS });
      completionSignal = await readSentinel(
        worktreePath,
        ticket.id,
        ticket.completionSignal,
      );
      if (completionSignal !== undefined) break;
    }

    const commits = await gitCommitsSince(worktreePath, baseHead);
    const stdoutTail = await herdr
      .readPane({ paneId, lines: 200, source: "recent" })
      .then((s) => s.slice(-MAX_TAIL_CHARS))
      .catch(() => "");
    const snapshot = await herdr.getAgent(paneId).catch(() => undefined);

    closeWorkspace = completionSignal !== undefined;
    return {
      completionSignal,
      commits,
      stdoutTail,
      sessionId: snapshot?.agentSessionId,
    };
  } finally {
    await clearSentinel(worktreePath, ticket.id);
    if (closeWorkspace) {
      await herdr.closeWorkspace(workspace.workspaceId).catch(() => undefined);
    }
  }
};

/** Re-exported for callers that need to classify a HerdrRunResult the same way `classify()` handles a SandboxRunResult. */
export const classifyHerdrRun = (result: HerdrRunResult): RunOutcome =>
  classify({
    threw: false,
    completionSignal: result.completionSignal,
    commits: result.commits,
  });
