import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTicketToBoard,
  AddTicketError,
  buildDashboardState,
  createDashboardServer,
} from "./dashboard.js";
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

describe("addTicketToBoard", () => {
  let dir: string;
  let dbPath: string;
  let db: BoardDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drover-dashboard-add-test-"));
    dbPath = join(dir, "board.sqlite");
    db = openBoard(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no deps, becomes its own new chain", () => {
    addTicketToBoard(db, {
      id: "standalone",
      title: "Standalone",
      prompt: "do it",
      deps: [],
    });
    const ticket = db.getTicket("standalone")!;
    expect(ticket.chainId).toBe("standalone");
    expect(ticket.seq).toBe(0);
    expect(ticket.status).toBe("pending");
  });

  it("depending on an existing ticket joins that ticket's chain, appended at the end", () => {
    loadBoard(db, [
      { id: "a", title: "A", prompt: "do a", completionSignal: "DONE" },
      {
        id: "b",
        title: "B",
        prompt: "do b",
        deps: ["a"],
        completionSignal: "DONE",
      },
    ]);
    addTicketToBoard(db, {
      id: "c",
      title: "C",
      prompt: "do c",
      deps: ["b"],
    });
    const c = db.getTicket("c")!;
    expect(c.chainId).toBe("a");
    expect(c.seq).toBe(2);
  });

  it("rejects deps spanning two different existing chains", () => {
    loadBoard(db, [
      { id: "a", title: "A", prompt: "x", completionSignal: "DONE" },
      { id: "z", title: "Z", prompt: "x", completionSignal: "DONE" },
    ]);
    expect(() =>
      addTicketToBoard(db, {
        id: "merger",
        title: "Merger",
        prompt: "x",
        deps: ["a", "z"],
      }),
    ).toThrow(/multiple chains/);
    expect(db.getTicket("merger")).toBeUndefined();
  });

  it("rejects an unknown dependency", () => {
    expect(() =>
      addTicketToBoard(db, {
        id: "orphan",
        title: "Orphan",
        prompt: "x",
        deps: ["does-not-exist"],
      }),
    ).toThrow(AddTicketError);
  });

  it("rejects a duplicate id", () => {
    loadBoard(db, [
      { id: "dup", title: "Dup", prompt: "x", completionSignal: "DONE" },
    ]);
    expect(() =>
      addTicketToBoard(db, {
        id: "dup",
        title: "Dup 2",
        prompt: "y",
        deps: [],
      }),
    ).toThrow(/already exists/);
  });

  it("rejects an invalid id shape", () => {
    expect(() =>
      addTicketToBoard(db, {
        id: "Not Valid!",
        title: "T",
        prompt: "x",
        deps: [],
      }),
    ).toThrow(/lowercase/);
  });

  it("rejects a blank title or prompt", () => {
    expect(() =>
      addTicketToBoard(db, {
        id: "no-title",
        title: "  ",
        prompt: "x",
        deps: [],
      }),
    ).toThrow(/Title is required/);
    expect(() =>
      addTicketToBoard(db, {
        id: "no-prompt",
        title: "T",
        prompt: "  ",
        deps: [],
      }),
    ).toThrow(/Prompt is required/);
  });
});

describe("createDashboardServer — multi-repo routing", () => {
  let dirA: string;
  let dirB: string;
  let dbA: BoardDb;
  let dbB: BoardDb;
  let baseUrl: string;
  let server: ReturnType<typeof createDashboardServer>;

  beforeEach(async () => {
    dirA = mkdtempSync(join(tmpdir(), "drover-dashboard-repoA-"));
    dirB = mkdtempSync(join(tmpdir(), "drover-dashboard-repoB-"));
    dbA = openBoard(join(dirA, "board.sqlite"));
    dbB = openBoard(join(dirB, "board.sqlite"));
    loadBoard(dbA, [
      {
        id: "a-ticket",
        title: "A ticket",
        prompt: "x",
        completionSignal: "DONE",
      },
    ]);
    loadBoard(dbB, [
      {
        id: "b-ticket",
        title: "B ticket",
        prompt: "x",
        completionSignal: "DONE",
      },
    ]);

    server = createDashboardServer({
      repos: [
        { name: "repo-a", dbPath: join(dirA, "board.sqlite"), db: dbA },
        { name: "repo-b", dbPath: join(dirB, "board.sqlite"), db: dbB },
      ],
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    dbA.close();
    dbB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("lists both repos", async () => {
    const res = await fetch(`${baseUrl}/api/repos`);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((r) => r.name).sort()).toEqual(["repo-a", "repo-b"]);
  });

  it("defaults to the first repo when none is specified", async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    const state = (await res.json()) as { chains: { chainId: string }[] };
    expect(state.chains.map((c) => c.chainId)).toEqual(["a-ticket"]);
  });

  it("scopes /api/state by ?repo=", async () => {
    const res = await fetch(`${baseUrl}/api/state?repo=repo-b`);
    const state = (await res.json()) as { chains: { chainId: string }[] };
    expect(state.chains.map((c) => c.chainId)).toEqual(["b-ticket"]);
  });

  it("404s on an unknown repo", async () => {
    const res = await fetch(`${baseUrl}/api/state?repo=nope`);
    expect(res.status).toBe(404);
  });

  it("adding a ticket via POST only touches the targeted repo's db", async () => {
    const res = await fetch(`${baseUrl}/api/tickets?repo=repo-b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "new-in-b",
        title: "New in B",
        prompt: "x",
        deps: [],
      }),
    });
    expect(res.status).toBe(201);
    expect(dbB.getTicket("new-in-b")).toBeDefined();
    expect(dbA.getTicket("new-in-b")).toBeUndefined();
  });
});
