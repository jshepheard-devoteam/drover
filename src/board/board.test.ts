import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, classifyInteractive, extractErrorTag } from "./classify.js";
import { computeChains } from "./chains.js";
import { openBoard, type BoardDb } from "./db.js";
import { loadBoard } from "./load.js";
import type { TicketInput } from "./types.js";

describe("classify", () => {
  it("threw -> failed", () => {
    expect(classify({ threw: true, commits: [] })).toBe("failed");
  });

  it("signal + commits -> done", () => {
    expect(
      classify({
        threw: false,
        completionSignal: "DONE",
        commits: [{ sha: "a" }],
      }),
    ).toBe("done");
  });

  it("signal, zero commits -> done_no_commits", () => {
    expect(
      classify({ threw: false, completionSignal: "DONE", commits: [] }),
    ).toBe("done_no_commits");
  });

  it("no signal (iterations exhausted) -> needs_attempt", () => {
    expect(classify({ threw: false, commits: [{ sha: "a" }] })).toBe(
      "needs_attempt",
    );
  });
});

describe("classifyInteractive", () => {
  it("threw -> failed", () => {
    expect(classifyInteractive({ threw: true, commits: [] })).toBe("failed");
  });

  it("non-zero exit -> failed", () => {
    expect(
      classifyInteractive({
        threw: false,
        exitCode: 1,
        commits: [{ sha: "a" }],
      }),
    ).toBe("failed");
  });

  it("clean exit + commits -> done", () => {
    expect(
      classifyInteractive({
        threw: false,
        exitCode: 0,
        commits: [{ sha: "a" }],
      }),
    ).toBe("done");
  });

  it("clean exit, zero commits -> done_no_commits", () => {
    expect(
      classifyInteractive({ threw: false, exitCode: 0, commits: [] }),
    ).toBe("done_no_commits");
  });
});

describe("extractErrorTag", () => {
  it("prefers _tag over name", () => {
    expect(
      extractErrorTag({ _tag: "AgentIdleTimeoutError", name: "Error" }),
    ).toBe("AgentIdleTimeoutError");
  });

  it("falls back to name when _tag is absent", () => {
    expect(extractErrorTag(new TypeError("boom"))).toBe("TypeError");
  });

  it("falls back to UnknownError for a non-object throw", () => {
    expect(extractErrorTag("boom")).toBe("UnknownError");
  });
});

describe("computeChains", () => {
  it("groups a linear dependency chain into one component, topologically ordered", () => {
    const result = computeChains([
      { id: "c", deps: ["b"] },
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
    ]);
    const chainId = result.get("a")!.chainId;
    expect(result.get("b")!.chainId).toBe(chainId);
    expect(result.get("c")!.chainId).toBe(chainId);
    expect(result.get("a")!.seq).toBeLessThan(result.get("b")!.seq);
    expect(result.get("b")!.seq).toBeLessThan(result.get("c")!.seq);
  });

  it("assigns unrelated tickets to different chains", () => {
    const result = computeChains([
      { id: "x", deps: [] },
      { id: "y", deps: [] },
    ]);
    expect(result.get("x")!.chainId).not.toBe(result.get("y")!.chainId);
  });

  it("throws on an unknown dependency id", () => {
    expect(() => computeChains([{ id: "a", deps: ["ghost"] }])).toThrow(
      /unknown ticket/,
    );
  });

  it("throws on a dependency cycle", () => {
    expect(() =>
      computeChains([
        { id: "a", deps: ["b"] },
        { id: "b", deps: ["a"] },
      ]),
    ).toThrow(/cycle/i);
  });
});

describe("board db", () => {
  let dir: string;
  let dbPath: string;
  let db: BoardDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drover-board-test-"));
    dbPath = join(dir, "board.sqlite");
    db = openBoard(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const linearBoard: TicketInput[] = [
    { id: "a", title: "A", prompt: "do a", completionSignal: "DONE" },
    {
      id: "b",
      title: "B",
      prompt: "do b",
      deps: ["a"],
      completionSignal: "DONE",
    },
  ];

  it("load assigns chain/seq and dependency satisfaction requires done, not done_no_commits", () => {
    loadBoard(db, linearBoard);
    const a = db.getTicket("a")!;
    const b = db.getTicket("b")!;
    expect(a.chainId).toBe(b.chainId);
    expect(a.status).toBe("pending");

    // "a" finishes with a signal but zero commits — dependency satisfaction
    // is `done` only, so "b" must not be considered runnable.
    db.setStatus("a", "done_no_commits");
    const stillUnmetForB = db
      .getTicket("b")!
      .deps.filter((depId) => db.getTicket(depId)?.status !== "done");
    expect(stillUnmetForB).toEqual(["a"]);

    db.setStatus("a", "done");
    const unmetNow = db
      .getTicket("b")!
      .deps.filter((depId) => db.getTicket(depId)?.status !== "done");
    expect(unmetNow).toEqual([]);
  });

  it("load refuses to touch a ticket that is already running or done", () => {
    loadBoard(db, linearBoard);
    db.claim("a", 111);
    expect(db.getTicket("a")!.status).toBe("running");

    const result = loadBoard(db, [
      {
        id: "a",
        title: "A (changed)",
        prompt: "changed",
        completionSignal: "DONE",
      },
    ]);
    expect(result.skipped).toEqual(["a"]);
    expect(db.getTicket("a")!.title).toBe("A"); // untouched
  });

  it("claim is atomic across two connections to the same file — only one wins", () => {
    loadBoard(db, [
      { id: "solo", title: "Solo", prompt: "x", completionSignal: "DONE" },
    ]);
    const second = openBoard(dbPath);
    try {
      const wonByFirst = db.claim("solo", 1);
      const wonBySecond = second.claim("solo", 2);
      expect([wonByFirst, wonBySecond].filter(Boolean)).toHaveLength(1);
      expect(db.getTicket("solo")!.status).toBe("running");
    } finally {
      second.close();
    }
  });

  it("records an append-only attempt trail and reports the last attempt", () => {
    loadBoard(db, [
      { id: "solo", title: "Solo", prompt: "x", completionSignal: "DONE" },
    ]);
    db.recordAttempt({
      ticketId: "solo",
      n: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      outcome: "needs_attempt",
      commitShas: [],
      branch: "drover/board/solo",
      stdoutTail: "still working...",
    });
    db.recordAttempt({
      ticketId: "solo",
      n: 2,
      startedAt: "2026-01-01T00:00:02.000Z",
      endedAt: "2026-01-01T00:00:03.000Z",
      outcome: "done",
      completionSignal: "DONE",
      commitShas: ["abc123"],
      branch: "drover/board/solo",
    });
    expect(db.listAttempts("solo")).toHaveLength(2);
    const last = db.lastAttempt("solo")!;
    expect(last.n).toBe(2);
    expect(last.outcome).toBe("done");
    expect(last.commitShas).toEqual(["abc123"]);
  });

  it("gate defer releases the ticket back to pending with a gate note", () => {
    loadBoard(db, [
      { id: "solo", title: "Solo", prompt: "x", completionSignal: "DONE" },
    ]);
    db.claim("solo", process.pid);
    db.release("solo", "pending", {
      gateState: "deferred",
      gateNote: "needs human input",
    });
    const ticket = db.getTicket("solo")!;
    expect(ticket.status).toBe("pending");
    expect(ticket.ownerPid).toBeNull();
    expect(ticket.gateState).toBe("deferred");
    expect(ticket.gateNote).toBe("needs human input");
  });

  it("board stop sets a flag startBoard's poll loop can observe", () => {
    expect(db.isStopRequested()).toBe(false);
    db.requestStop();
    expect(db.isStopRequested()).toBe(true);
  });
});

describe("loadBoard validation", () => {
  let dir: string;
  let db: BoardDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drover-board-test-"));
    db = openBoard(join(dir, "board.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a ticket with both prompt and promptFile", () => {
    expect(() =>
      loadBoard(db, [
        {
          id: "a",
          title: "A",
          prompt: "x",
          promptFile: "./x.md",
        } as TicketInput,
      ]),
    ).toThrow(/both/);
  });

  it("rejects a ticket with neither prompt nor promptFile", () => {
    expect(() =>
      loadBoard(db, [{ id: "a", title: "A" } as TicketInput]),
    ).toThrow(/neither/);
  });

  it("rejects a duplicate ticket id", () => {
    expect(() =>
      loadBoard(db, [
        { id: "a", title: "A", prompt: "x" },
        { id: "a", title: "A again", prompt: "y" },
      ]),
    ).toThrow(/duplicate/i);
  });
});
