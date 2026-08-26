import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDashboardState } from "./dashboard.js";
import { openBoard, type BoardDb } from "./db.js";
import { loadBoard } from "./load.js";
import type { TicketInput } from "./types.js";

describe("buildDashboardState", () => {
  let dir: string;
  let dbPath: string;
  let db: BoardDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drover-dashboard-test-"));
    dbPath = join(dir, "board.sqlite");
    db = openBoard(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const board: TicketInput[] = [
    { id: "a", title: "A", prompt: "do a", completionSignal: "DONE" },
    {
      id: "b",
      title: "B",
      prompt: "do b",
      deps: ["a"],
      completionSignal: "DONE",
    },
    { id: "solo", title: "Solo", prompt: "do solo", completionSignal: "DONE" },
  ];

  it("groups tickets by chain in seq order and tallies status counts", () => {
    loadBoard(db, board);
    const state = buildDashboardState(db, dbPath);

    expect(state.dbPath).toBe(dbPath);
    expect(state.summary).toEqual({ pending: 3 });

    const chainIds = state.chains.map((c) => c.chainId).sort();
    expect(chainIds).toEqual(["a", "solo"]);

    const abChain = state.chains.find((c) => c.chainId === "a")!;
    expect(abChain.tickets.map((t) => t.id)).toEqual(["a", "b"]);
    expect(abChain.tickets[1]!.deps).toEqual(["a"]);
  });

  it("attaches the last attempt, not every attempt", () => {
    loadBoard(db, [
      { id: "solo", title: "Solo", prompt: "x", completionSignal: "DONE" },
    ]);
    db.claim("solo", 1);
    db.recordAttempt({
      ticketId: "solo",
      n: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      outcome: "needs_attempt",
      commitShas: [],
      branch: "drover/board/solo",
    });
    db.release("solo", "needs_attempt");
    db.claim("solo", 2);
    db.recordAttempt({
      ticketId: "solo",
      n: 2,
      startedAt: "2026-01-01T00:02:00.000Z",
      endedAt: "2026-01-01T00:03:00.000Z",
      outcome: "done",
      completionSignal: "DONE",
      commitShas: ["abc123"],
      branch: "drover/board/solo",
    });
    db.setStatus("solo", "done");

    const state = buildDashboardState(db, dbPath);
    const ticket = state.chains[0]!.tickets[0]!;
    expect(ticket.lastAttempt?.n).toBe(2);
    expect(ticket.lastAttempt?.commitCount).toBe(1);
  });

  it("reports an empty board without throwing", () => {
    const state = buildDashboardState(db, dbPath);
    expect(state.chains).toEqual([]);
    expect(state.summary).toEqual({});
  });
});
