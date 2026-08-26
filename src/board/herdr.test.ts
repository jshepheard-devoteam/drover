import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from "node:child_process";
import {
  classifyStartup,
  createHerdrClient,
  HerdrCommandError,
  HerdrTimeoutError,
  HerdrUnavailableError,
} from "./herdr.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

type Callback = (
  error: (Error & { killed?: boolean; code?: number }) | null,
  stdout: string,
  stderr: string,
) => void;

const respond = (stdout: string, stderr = "", exitCode = 0) => {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as Callback;
    if (exitCode === 0) {
      callback(null, stdout, stderr);
    } else {
      const error = Object.assign(new Error("command failed"), {
        code: exitCode,
      });
      callback(error, stdout, stderr);
    }
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
};

const respondTimeout = () => {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as Callback;
    const error = Object.assign(new Error("timeout"), { killed: true });
    callback(error, "", "");
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
};

const lastArgv = (): string[] => {
  const call = mockExecFile.mock.calls.at(-1);
  if (!call) throw new Error("execFile was never called");
  return call[1] as string[];
};

describe("createHerdrClient", () => {
  it("preflight resolves when the server is running and compatible", async () => {
    respond(JSON.stringify({ server: { running: true, compatible: true } }));
    const client = createHerdrClient();
    await expect(client.preflight()).resolves.toBeUndefined();
    expect(lastArgv()).toEqual(["status", "--json"]);
  });

  it("preflight throws HerdrUnavailableError when the server isn't running", async () => {
    respond(JSON.stringify({ server: { running: false, compatible: true } }));
    const client = createHerdrClient();
    await expect(client.preflight()).rejects.toThrow(HerdrUnavailableError);
  });

  it("selects stdout as authoritative on exit 0, even with stderr noise", async () => {
    respond(
      JSON.stringify({
        result: {
          root_pane: {
            workspace_id: "w1",
            tab_id: "t1",
            pane_id: "p1",
            terminal_id: "term1",
          },
        },
      }),
      "unrelated warning noise",
      0,
    );
    const client = createHerdrClient();
    const workspace = await client.createWorkspace({
      cwd: "/tmp/x",
      label: "test",
    });
    expect(workspace).toEqual({
      workspaceId: "w1",
      tabId: "t1",
      paneId: "p1",
      terminalId: "term1",
    });
  });

  it("selects stderr as authoritative on nonzero exit, and never falls back to stdout", async () => {
    respond(
      JSON.stringify({ result: { root_pane: { workspace_id: "stale" } } }), // stale stdout from a prior call
      JSON.stringify({ error: { code: "not_found", message: "no such pane" } }),
      1,
    );
    const client = createHerdrClient();
    await expect(client.getAgent("p1")).resolves.toBeUndefined();
  });

  it("throws HerdrCommandError when the authoritative stream is empty", async () => {
    respond("", "", 0);
    const client = createHerdrClient();
    await expect(
      client.createWorkspace({ cwd: "/tmp", label: "x" }),
    ).rejects.toThrow(HerdrCommandError);
  });

  it("throws HerdrCommandError when the authoritative stream is non-JSON", async () => {
    respond("not json", "", 0);
    const client = createHerdrClient();
    await expect(
      client.createWorkspace({ cwd: "/tmp", label: "x" }),
    ).rejects.toThrow(HerdrCommandError);
  });

  it("getAgent returns undefined for a not-found agent, never throws", async () => {
    respond("", JSON.stringify({ error: { code: "agent_not_found" } }), 1);
    const client = createHerdrClient();
    await expect(client.getAgent("p1")).resolves.toBeUndefined();
  });

  it("getAgent parses a found agent snapshot", async () => {
    respond(
      JSON.stringify({
        result: {
          agent: {
            agent: "claude",
            agent_status: "idle",
            pane_id: "p1",
            workspace_id: "w1",
            agent_session: { value: "sess-1" },
          },
        },
      }),
    );
    const client = createHerdrClient();
    const snapshot = await client.getAgent("p1");
    expect(snapshot).toEqual({
      paneId: "p1",
      workspaceId: "w1",
      agentStatus: "idle",
      agent: "claude",
      agentSessionId: "sess-1",
    });
  });

  it("prompt throws HerdrTimeoutError when the response is a structured timeout error", async () => {
    respond("", JSON.stringify({ error: { code: "timeout" } }), 1);
    const client = createHerdrClient();
    await expect(
      client.prompt({ paneId: "p1", text: "hi", timeoutMs: 1000 }),
    ).rejects.toThrow(HerdrTimeoutError);
  });

  it("distinguishes an aborted/killed call from a genuine command failure", async () => {
    respondTimeout();
    const client = createHerdrClient();
    await expect(client.preflight()).rejects.toThrow(HerdrTimeoutError);
  });

  it("paneRun never throws even on a nonzero exit — fire-and-forget", async () => {
    respond("", "some error", 1);
    const client = createHerdrClient();
    await expect(
      client.paneRun({ paneId: "p1", command: "echo hi" }),
    ).resolves.toBeUndefined();
    expect(lastArgv()).toEqual(["pane", "run", "p1", "echo hi"]);
  });

  it("readPane returns raw text without attempting JSON parsing", async () => {
    respond("not json, just terminal output\nmore text");
    const client = createHerdrClient();
    const text = await client.readPane({ paneId: "p1", lines: 10 });
    expect(text).toBe("not json, just terminal output\nmore text");
    expect(lastArgv()).toEqual([
      "pane",
      "read",
      "p1",
      "--source",
      "recent",
      "--lines",
      "10",
    ]);
  });

  it("closeWorkspace is never called automatically by any other method", async () => {
    respond(JSON.stringify({ result: {} }));
    const client = createHerdrClient();
    await client.getAgent("p1");
    expect(mockExecFile).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["workspace", "close"]),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("classifyStartup", () => {
  it("no snapshot -> failed", () => {
    expect(
      classifyStartup({ snapshot: undefined, expectedKind: "claude" }),
    ).toBe("failed");
  });

  it("agentStatus blocked -> blocked", () => {
    expect(
      classifyStartup({
        snapshot: {
          paneId: "p",
          workspaceId: "w",
          agentStatus: "blocked",
          agent: "claude",
        },
        expectedKind: "claude",
      }),
    ).toBe("blocked");
  });

  it("wrong detected kind -> starting", () => {
    expect(
      classifyStartup({
        snapshot: {
          paneId: "p",
          workspaceId: "w",
          agentStatus: "idle",
          agent: "codex",
        },
        expectedKind: "claude",
      }),
    ).toBe("starting");
  });

  it("idle + matching kind -> ready", () => {
    expect(
      classifyStartup({
        snapshot: {
          paneId: "p",
          workspaceId: "w",
          agentStatus: "idle",
          agent: "claude",
        },
        expectedKind: "claude",
      }),
    ).toBe("ready");
  });

  it("done + matching kind -> ready", () => {
    expect(
      classifyStartup({
        snapshot: {
          paneId: "p",
          workspaceId: "w",
          agentStatus: "done",
          agent: "claude",
        },
        expectedKind: "claude",
      }),
    ).toBe("ready");
  });

  it("working + matching kind -> starting", () => {
    expect(
      classifyStartup({
        snapshot: {
          paneId: "p",
          workspaceId: "w",
          agentStatus: "working",
          agent: "claude",
        },
        expectedKind: "claude",
      }),
    ).toBe("starting");
  });
});
