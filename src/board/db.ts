/**
 * SQLite-backed storage for the board. `node:sqlite` — built into Node 22+,
 * zero dependency, matches this repo's existing npm/tsx/vitest toolchain
 * (there is no bun anywhere in Sandcastle/Drover).
 *
 * WAL mode + a busy timeout because this is multi-process by construction:
 * a daemon loop, a Herdr-pane-resident interactive runner, and a `board
 * status` read from a third terminal can all open this file at once.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Attempt, Ticket, TicketStatus } from "./types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT,
  prompt_file TEXT,
  deps TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'auto',
  chain_id TEXT,
  seq INTEGER,
  max_iterations INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  completion_signal TEXT,
  agent TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_pid INTEGER,
  gate_state TEXT,
  gate_note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  ticket_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT NOT NULL,
  completion_signal TEXT,
  commit_shas TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  session_id TEXT,
  session_file_path TEXT,
  preserved_worktree_path TEXT,
  error_tag TEXT,
  error_message TEXT,
  stdout_tail TEXT,
  PRIMARY KEY (ticket_id, n)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface TicketRow {
  id: string;
  title: string;
  prompt: string | null;
  prompt_file: string | null;
  deps: string;
  mode: string;
  chain_id: string | null;
  seq: number | null;
  max_iterations: number;
  max_attempts: number;
  completion_signal: string | null;
  agent: string | null;
  model: string | null;
  status: string;
  owner_pid: number | null;
  gate_state: string | null;
  gate_note: string | null;
  updated_at: string;
}

interface AttemptRow {
  ticket_id: string;
  n: number;
  started_at: string;
  ended_at: string | null;
  outcome: string;
  completion_signal: string | null;
  commit_shas: string;
  branch: string | null;
  session_id: string | null;
  session_file_path: string | null;
  preserved_worktree_path: string | null;
  error_tag: string | null;
  error_message: string | null;
  stdout_tail: string | null;
}

const rowToTicket = (row: TicketRow): Ticket => ({
  id: row.id,
  title: row.title,
  prompt: row.prompt ?? undefined,
  promptFile: row.prompt_file ?? undefined,
  deps: JSON.parse(row.deps) as string[],
  mode: row.mode as Ticket["mode"],
  chainId: row.chain_id,
  seq: row.seq,
  maxIterations: row.max_iterations,
  maxAttempts: row.max_attempts,
  completionSignal: row.completion_signal
    ? (JSON.parse(row.completion_signal) as string | string[])
    : undefined,
  agent: row.agent ?? undefined,
  model: row.model ?? undefined,
  status: row.status as TicketStatus,
  ownerPid: row.owner_pid,
  gateState: row.gate_state,
  gateNote: row.gate_note,
  updatedAt: row.updated_at,
});

const rowToAttempt = (row: AttemptRow): Attempt => ({
  ticketId: row.ticket_id,
  n: row.n,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  outcome: row.outcome as Attempt["outcome"],
  completionSignal: row.completion_signal ?? undefined,
  commitShas: JSON.parse(row.commit_shas) as string[],
  branch: row.branch ?? "",
  sessionId: row.session_id ?? undefined,
  sessionFilePath: row.session_file_path ?? undefined,
  preservedWorktreePath: row.preserved_worktree_path ?? undefined,
  errorTag: row.error_tag ?? undefined,
  errorMessage: row.error_message ?? undefined,
  stdoutTail: row.stdout_tail ?? undefined,
});

/** A ticket seeded via `upsertTickets`, with chain assignment already computed. */
export interface TicketSeed {
  readonly id: string;
  readonly title: string;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly deps: readonly string[];
  readonly mode: Ticket["mode"];
  readonly chainId: string;
  readonly seq: number;
  readonly maxIterations: number;
  readonly maxAttempts: number;
  readonly completionSignal?: string | readonly string[];
  readonly agent?: string;
  readonly model?: string;
}

export interface BoardDb {
  readonly raw: DatabaseSync;
  /** Insert new tickets or refresh a still-`pending` ticket's definition. Refuses to touch `running`/`done` tickets — returns their ids as skipped. */
  upsertTickets(tickets: readonly TicketSeed[]): {
    upserted: string[];
    skipped: string[];
  };
  getTicket(id: string): Ticket | undefined;
  listTickets(): Ticket[];
  listTicketsByChain(chainId: string): Ticket[];
  listChainIds(): string[];
  /** Atomically claims a runnable ticket. Returns `true` iff this call won the claim. */
  claim(id: string, ownerPid: number): boolean;
  /** Releases a claimed ticket back to a given status, optionally recording a gate decision. */
  release(
    id: string,
    status: TicketStatus,
    patch?: { gateState?: string; gateNote?: string },
  ): void;
  setStatus(id: string, status: TicketStatus): void;
  recordAttempt(attempt: Attempt): void;
  listAttempts(ticketId: string): Attempt[];
  lastAttempt(ticketId: string): Attempt | undefined;
  /** Global control flag read by `startBoard()`'s poll loop; set by `board stop`. */
  requestStop(): void;
  isStopRequested(): boolean;
  close(): void;
}

export const openBoard = (path: string): BoardDb => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(DDL);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO tickets (id, title, prompt, prompt_file, deps, mode, chain_id, seq, max_iterations, max_attempts, completion_signal, agent, model, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, prompt = excluded.prompt, prompt_file = excluded.prompt_file,
        deps = excluded.deps, mode = excluded.mode, chain_id = excluded.chain_id, seq = excluded.seq,
        max_iterations = excluded.max_iterations, max_attempts = excluded.max_attempts,
        completion_signal = excluded.completion_signal, agent = excluded.agent, model = excluded.model,
        updated_at = excluded.updated_at
      WHERE tickets.status = 'pending'
    `),
    statusOf: db.prepare(`SELECT status FROM tickets WHERE id = ?`),
    getTicket: db.prepare(`SELECT * FROM tickets WHERE id = ?`),
    listTickets: db.prepare(`SELECT * FROM tickets ORDER BY chain_id, seq`),
    listByChain: db.prepare(
      `SELECT * FROM tickets WHERE chain_id = ? ORDER BY seq`,
    ),
    listChainIds: db.prepare(
      `SELECT DISTINCT chain_id FROM tickets WHERE chain_id IS NOT NULL ORDER BY chain_id`,
    ),
    claim: db.prepare(`
      UPDATE tickets SET status = 'running', owner_pid = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'needs_attempt')
    `),
    release: db.prepare(`
      UPDATE tickets SET status = ?, owner_pid = NULL, gate_state = ?, gate_note = ?, updated_at = ?
      WHERE id = ?
    `),
    setStatus: db.prepare(`
      UPDATE tickets SET status = ?, owner_pid = NULL, updated_at = ? WHERE id = ?
    `),
    recordAttempt: db.prepare(`
      INSERT INTO attempts (ticket_id, n, started_at, ended_at, outcome, completion_signal, commit_shas, branch, session_id, session_file_path, preserved_worktree_path, error_tag, error_message, stdout_tail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listAttempts: db.prepare(
      `SELECT * FROM attempts WHERE ticket_id = ? ORDER BY n`,
    ),
    lastAttempt: db.prepare(
      `SELECT * FROM attempts WHERE ticket_id = ? ORDER BY n DESC LIMIT 1`,
    ),
    setMeta: db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
  } satisfies Record<string, StatementSync>;

  return {
    raw: db,

    upsertTickets(tickets) {
      const upserted: string[] = [];
      const skipped: string[] = [];
      for (const t of tickets) {
        const existing = stmts.statusOf.get(t.id) as unknown as
          | { status: string }
          | undefined;
        if (existing && existing.status !== "pending") {
          skipped.push(t.id);
          continue;
        }
        stmts.upsert.run(
          t.id,
          t.title,
          t.prompt ?? null,
          t.promptFile ?? null,
          JSON.stringify(t.deps),
          t.mode,
          t.chainId,
          t.seq,
          t.maxIterations,
          t.maxAttempts,
          t.completionSignal ? JSON.stringify(t.completionSignal) : null,
          t.agent ?? null,
          t.model ?? null,
          new Date().toISOString(),
        );
        upserted.push(t.id);
      }
      return { upserted, skipped };
    },

    getTicket(id) {
      const row = stmts.getTicket.get(id) as unknown as TicketRow | undefined;
      return row ? rowToTicket(row) : undefined;
    },

    listTickets() {
      return (stmts.listTickets.all() as unknown as TicketRow[]).map(
        rowToTicket,
      );
    },

    listTicketsByChain(chainId) {
      return (stmts.listByChain.all(chainId) as unknown as TicketRow[]).map(
        rowToTicket,
      );
    },

    listChainIds() {
      return (
        stmts.listChainIds.all() as unknown as { chain_id: string }[]
      ).map((r) => r.chain_id);
    },

    claim(id, ownerPid) {
      const result = stmts.claim.run(ownerPid, new Date().toISOString(), id);
      return result.changes === 1;
    },

    release(id, status, patch) {
      stmts.release.run(
        status,
        patch?.gateState ?? null,
        patch?.gateNote ?? null,
        new Date().toISOString(),
        id,
      );
    },

    setStatus(id, status) {
      stmts.setStatus.run(status, new Date().toISOString(), id);
    },

    recordAttempt(attempt) {
      stmts.recordAttempt.run(
        attempt.ticketId,
        attempt.n,
        attempt.startedAt,
        attempt.endedAt,
        attempt.outcome,
        attempt.completionSignal ?? null,
        JSON.stringify(attempt.commitShas),
        attempt.branch,
        attempt.sessionId ?? null,
        attempt.sessionFilePath ?? null,
        attempt.preservedWorktreePath ?? null,
        attempt.errorTag ?? null,
        attempt.errorMessage ?? null,
        attempt.stdoutTail ?? null,
      );
    },

    listAttempts(ticketId) {
      return (stmts.listAttempts.all(ticketId) as unknown as AttemptRow[]).map(
        rowToAttempt,
      );
    },

    lastAttempt(ticketId) {
      const row = stmts.lastAttempt.get(ticketId) as unknown as
        | AttemptRow
        | undefined;
      return row ? rowToAttempt(row) : undefined;
    },

    requestStop() {
      stmts.setMeta.run("stop_requested_at", new Date().toISOString());
    },

    isStopRequested() {
      return stmts.getMeta.get("stop_requested_at") !== undefined;
    },

    close() {
      db.close();
    },
  };
};
