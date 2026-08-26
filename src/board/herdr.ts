/**
 * Herdr CLI wrapper — the transport layer for host-native ticket execution
 * (see `herdrRun.ts`). Plain TypeScript, no Effect (ADR 0021): every call is
 * a static argv array through `execFile`, never a shell string.
 *
 * Load-bearing quirk, verified live against Herdr 0.8.2 in this session's
 * spike: a successful response goes to stdout (exit 0); a structured
 * `{"error": ...}` response goes to *stderr* (exit 1). Stream authority is
 * decided by exit code, never by "whichever stream is non-empty" — noise on
 * the non-authoritative stream must never substitute for a missing or
 * malformed result on the authoritative one.
 */

import { execFile } from "node:child_process";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspace {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
}

/**
 * One `herdr agent get` result. Field set verified live against a running
 * Herdr 0.8.2 server — `interactive_ready`/`launch_pending` (read by a
 * separate Python Herdr port's `classify_startup`) do not exist in the
 * actual response and are deliberately not read here.
 */
export interface AgentSnapshot {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly agentStatus: AgentStatus;
  /** Detected agent kind, e.g. "claude". Absent until detection fires. */
  readonly agent?: string;
  readonly agentSessionId?: string;
}

export class HerdrCommandError extends Error {
  readonly argv: readonly string[];
  readonly exitCode: number;
  constructor(argv: readonly string[], exitCode: number, detail: string) {
    super(`herdr ${argv.join(" ")} failed (exit ${exitCode}): ${detail}`);
    this.name = "HerdrCommandError";
    this.argv = argv;
    this.exitCode = exitCode;
  }
}

export class HerdrTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "HerdrTimeoutError";
  }
}

export class HerdrUnavailableError extends Error {
  constructor(reason: string) {
    super(`herdr unavailable: ${reason}`);
    this.name = "HerdrUnavailableError";
  }
}

export interface HerdrClient {
  /** Raises `HerdrUnavailableError` if the Herdr client/server can't be reached or aren't protocol-compatible. */
  preflight(): Promise<void>;
  createWorkspace(o: { cwd: string; label: string }): Promise<HerdrWorkspace>;
  /** Fire-and-forget — types `command` into the pane's own shell and presses enter. Does not wait for it to finish. */
  paneRun(o: { paneId: string; command: string }): Promise<void>;
  /** `undefined` for not-found — an expected, common outcome (e.g. before detection fires), never a thrown error. */
  getAgent(paneId: string): Promise<AgentSnapshot | undefined>;
  prompt(o: {
    paneId: string;
    text: string;
    timeoutMs: number;
  }): Promise<AgentSnapshot>;
  sendKeys(o: { paneId: string; keys: string }): Promise<void>;
  readPane(o: {
    paneId: string;
    lines: number;
    source?: "recent" | "detection" | "visible";
  }): Promise<string>;
  /** Close-vs-preserve is always the caller's explicit policy decision — never called automatically by this client. */
  closeWorkspace(workspaceId: string): Promise<void>;
}

interface HerdrEnvelope {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

const MAX_BUFFER = 8 * 1024 * 1024;

const run = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args as string[],
      { maxBuffer: MAX_BUFFER, timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          // execFile's callback error carries `killed`/`signal` beyond what
          // NodeJS.ErrnoException declares — cast once, locally, rather than
          // scattering `as` throughout. Distinguishing a timeout from a
          // genuine command failure matters: getting it backwards turns a
          // `board stop` abort into a spurious HerdrTimeoutError, or a real
          // timeout into a silent failure.
          const err = error as NodeJS.ErrnoException & {
            killed?: boolean;
            code?: number | string;
          };
          if (err.killed && typeof err.code !== "number") {
            reject(new HerdrTimeoutError(args.join(" "), timeoutMs));
            return;
          }
          const exitCode = typeof err.code === "number" ? err.code : 1;
          resolve({ exitCode, stdout, stderr });
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });

/** Runs a `herdr` verb and parses its JSON envelope, selecting the authoritative stream by exit code — never falling back to the other stream. */
const runJson = async (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<HerdrEnvelope> => {
  const { exitCode, stdout, stderr } = await run(bin, args, timeoutMs);
  const body = exitCode === 0 ? stdout : stderr;
  if (!body.trim()) {
    throw new HerdrCommandError(
      args,
      exitCode,
      "empty response on authoritative stream",
    );
  }
  try {
    return JSON.parse(body) as HerdrEnvelope;
  } catch {
    throw new HerdrCommandError(
      args,
      exitCode,
      `non-JSON response on authoritative stream: ${body}`,
    );
  }
};

const parseSnapshot = (
  agent: Record<string, unknown> | undefined,
): AgentSnapshot | undefined => {
  if (!agent) return undefined;
  const session = agent["agent_session"] as { value?: string } | undefined;
  return {
    paneId: String(agent["pane_id"]),
    workspaceId: String(agent["workspace_id"]),
    agentStatus: (agent["agent_status"] as AgentStatus) ?? "unknown",
    agent:
      typeof agent["agent"] === "string"
        ? (agent["agent"] as string)
        : undefined,
    agentSessionId: session?.value,
  };
};

export const createHerdrClient = (options?: {
  bin?: string;
  timeoutMs?: number;
}): HerdrClient => {
  const bin = options?.bin ?? "herdr";
  const defaultTimeoutMs = options?.timeoutMs ?? 10_000;

  return {
    async preflight() {
      const envelope = await runJson(
        bin,
        ["status", "--json"],
        defaultTimeoutMs,
      );
      const server = envelope as unknown as {
        server?: { running?: boolean; compatible?: boolean };
      };
      if (!server.server?.running || !server.server.compatible) {
        throw new HerdrUnavailableError(
          `server not running/compatible: ${JSON.stringify(server.server)}`,
        );
      }
    },

    async createWorkspace({ cwd, label }) {
      const envelope = await runJson(
        bin,
        ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
        defaultTimeoutMs,
      );
      const pane = envelope.result?.["root_pane"] as
        | Record<string, unknown>
        | undefined;
      if (!pane) {
        throw new HerdrCommandError(
          ["workspace", "create"],
          0,
          `no root_pane in response: ${JSON.stringify(envelope)}`,
        );
      }
      return {
        workspaceId: String(pane["workspace_id"]),
        tabId: String(pane["tab_id"]),
        paneId: String(pane["pane_id"]),
        terminalId: String(pane["terminal_id"]),
      };
    },

    async paneRun({ paneId, command }) {
      await run(bin, ["pane", "run", paneId, command], defaultTimeoutMs);
    },

    async getAgent(paneId) {
      const envelope = await runJson(
        bin,
        ["agent", "get", paneId],
        defaultTimeoutMs,
      );
      if (envelope.error) return undefined;
      return parseSnapshot(
        envelope.result?.["agent"] as Record<string, unknown>,
      );
    },

    async prompt({ paneId, text, timeoutMs }) {
      const envelope = await runJson(
        bin,
        [
          "agent",
          "prompt",
          paneId,
          text,
          "--wait",
          "--timeout",
          String(timeoutMs),
        ],
        timeoutMs + 5_000,
      );
      if (envelope.error) {
        if (envelope.error.code === "timeout") {
          throw new HerdrTimeoutError(`prompt(${paneId})`, timeoutMs);
        }
        throw new HerdrCommandError(
          ["agent", "prompt", paneId],
          1,
          envelope.error.message ?? JSON.stringify(envelope.error),
        );
      }
      const snapshot = parseSnapshot(
        envelope.result?.["agent"] as Record<string, unknown>,
      );
      if (!snapshot) {
        throw new HerdrCommandError(
          ["agent", "prompt", paneId],
          0,
          `no agent in response: ${JSON.stringify(envelope)}`,
        );
      }
      return snapshot;
    },

    async sendKeys({ paneId, keys }) {
      await runJson(
        bin,
        ["agent", "send-keys", paneId, keys],
        defaultTimeoutMs,
      );
    },

    async readPane({ paneId, lines, source }) {
      const { stdout } = await run(
        bin,
        [
          "pane",
          "read",
          paneId,
          "--source",
          source ?? "recent",
          "--lines",
          String(lines),
        ],
        defaultTimeoutMs,
      );
      return stdout;
    },

    async closeWorkspace(workspaceId) {
      await runJson(bin, ["workspace", "close", workspaceId], defaultTimeoutMs);
    },
  };
};

/**
 * Pure. Classifies a pane's startup state from only the fields Herdr 0.8.2
 * actually returns — never trusts a launch verb's own exit code (a
 * non-zero `paneRun`/`agent start` commonly just means "blocked on a
 * startup dialog", not failure).
 */
export const classifyStartup = (o: {
  snapshot: AgentSnapshot | undefined;
  expectedKind: string;
}): "ready" | "starting" | "blocked" | "failed" => {
  if (!o.snapshot) return "failed";
  if (o.snapshot.agentStatus === "blocked") return "blocked";
  if (o.snapshot.agent !== o.expectedKind) return "starting";
  if (o.snapshot.agentStatus === "idle" || o.snapshot.agentStatus === "done") {
    return "ready";
  }
  return "starting";
};
