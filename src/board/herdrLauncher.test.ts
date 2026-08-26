import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from "node:child_process";
import { createHerdrLauncher } from "./herdrLauncher.js";
import type { Ticket } from "./types.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

const ticket: Ticket = {
  id: "t1",
  title: "T1",
  prompt: "hello",
  deps: [],
  mode: "interactive",
  chainId: "t1",
  seq: 0,
  maxIterations: 1,
  maxAttempts: 1,
  status: "pending",
  ownerPid: null,
  gateState: null,
  gateNote: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const tabCreateResponse = (paneId: string): string =>
  JSON.stringify({ result: { root_pane: { pane_id: paneId } } });

describe("createHerdrLauncher", () => {
  it("creates a tab labeled with the ticket id, then runs the default command in the returned pane", async () => {
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
      ) => void;
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === "tab" && cmdArgs[1] === "create") {
        callback(null, tabCreateResponse("w1:p9"));
      } else {
        callback(null, "");
      }
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const launcher = createHerdrLauncher();
    await launcher(ticket);

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const [tabCall, paneCall] = mockExecFile.mock.calls;
    if (!tabCall || !paneCall) throw new Error("expected two execFile calls");
    expect(tabCall[0]).toBe("herdr");
    expect(tabCall[1]).toEqual(
      expect.arrayContaining([
        "tab",
        "create",
        "--label",
        "ticket-t1",
        "--no-focus",
      ]),
    );
    expect(paneCall[0]).toBe("herdr");
    expect(paneCall[1]).toEqual([
      "pane",
      "run",
      "w1:p9",
      "npx tsx .drover/main.mts --ticket t1 --interactive",
    ]);
  });

  it("honors a custom buildCommand", async () => {
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
      ) => void;
      const cmdArgs = args[1] as string[];
      callback(null, cmdArgs[0] === "tab" ? tabCreateResponse("w2:p1") : "");
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const launcher = createHerdrLauncher({
      buildCommand: (t) => `echo ${t.id}`,
    });
    await launcher(ticket);

    const paneCall = mockExecFile.mock.calls[1]!;
    expect(paneCall[1]).toEqual(["pane", "run", "w2:p1", "echo t1"]);
  });

  it("throws when herdr tab create doesn't return a pane id", async () => {
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
      ) => void;
      callback(null, JSON.stringify({ result: {} }));
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const launcher = createHerdrLauncher();
    await expect(launcher(ticket)).rejects.toThrow(/did not return a pane id/);
  });

  it("rejects when herdr itself errors", async () => {
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
      ) => void;
      callback(new Error("herdr: not running"), "");
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const launcher = createHerdrLauncher();
    await expect(launcher(ticket)).rejects.toThrow(/not running/);
  });
});
