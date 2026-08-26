import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../AgentProvider.js";
import type { Sandbox } from "../createSandbox.js";
import type { AgentSnapshot, HerdrClient } from "./herdr.js";
import { herdrKindFor, runTicketInPane } from "./herdrRun.js";
import type { Ticket } from "./types.js";

const execFileAsync = promisify(execFile);

const readySnapshot: AgentSnapshot = {
  paneId: "p1",
  workspaceId: "w1",
  agentStatus: "idle",
  agent: "claude",
};

const blockedSnapshot: AgentSnapshot = {
  paneId: "p1",
  workspaceId: "w1",
  agentStatus: "blocked",
  agent: "claude",
};

const baseTicket: Ticket = {
  id: "t1",
  title: "T1",
  prompt: "do the thing",
  deps: [],
  mode: "auto",
  chainId: "t1",
  seq: 0,
  maxIterations: 3,
  maxAttempts: 3,
  completionSignal: "DONE",
  status: "pending",
  ownerPid: null,
  gateState: null,
  gateNote: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const stubAgent: AgentProvider = {
  name: "claude-code",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: "claude" }),
  buildInteractiveArgs: () => ["claude", "--dangerously-skip-permissions"],
  parseStreamLine: () => [],
};

const fakeHerdr = (): HerdrClient & {
  paneRun: ReturnType<typeof vi.fn>;
  closeWorkspace: ReturnType<typeof vi.fn>;
  sendKeys: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
} => ({
  preflight: vi.fn(),
  createWorkspace: vi.fn().mockResolvedValue({
    workspaceId: "w1",
    tabId: "tab1",
    paneId: "p1",
    terminalId: "term1",
  }),
  paneRun: vi.fn().mockResolvedValue(undefined),
  getAgent: vi.fn().mockResolvedValue(readySnapshot),
  prompt: vi.fn().mockResolvedValue(readySnapshot),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  readPane: vi.fn().mockResolvedValue("some pane output"),
  closeWorkspace: vi.fn().mockResolvedValue(undefined),
});

describe("herdrKindFor", () => {
  it("maps claude-code to claude", () => {
    expect(herdrKindFor("claude-code")).toBe("claude");
  });
  it("passes other provider names through", () => {
    expect(herdrKindFor("codex")).toBe("codex");
  });
});

describe("runTicketInPane", () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = mkdtempSync(join(tmpdir(), "herdrRun-test-"));
    await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: worktreePath,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: worktreePath,
    });
    await execFileAsync(
      "git",
      ["commit", "--allow-empty", "-q", "-m", "init"],
      {
        cwd: worktreePath,
      },
    );
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  const fakeSandbox = (): Sandbox => ({ worktreePath }) as unknown as Sandbox;

  it("happy path: createWorkspace -> paneRun -> getAgent -> prompt -> close, signal on turn 1", async () => {
    const herdr = fakeHerdr();
    herdr.prompt.mockImplementation(async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(worktreePath, ".drover-signal-t1"), "DONE");
      return readySnapshot;
    });

    const result = await runTicketInPane({
      herdr,
      sandbox: fakeSandbox(),
      ticket: baseTicket,
      agent: stubAgent,
      promptOverride: undefined,
      signal: undefined,
    });

    expect(herdr.createWorkspace).toHaveBeenCalledWith({
      cwd: worktreePath,
      label: "ticket-t1",
    });
    expect(herdr.paneRun).toHaveBeenCalledTimes(1);
    expect(herdr.prompt).toHaveBeenCalledTimes(1);
    expect(result.completionSignal).toBe("DONE");
    expect(herdr.closeWorkspace).toHaveBeenCalledWith("w1");
    // Sentinel is cleaned up, never left for git to see.
    expect(() =>
      readFileSync(join(worktreePath, ".drover-signal-t1")),
    ).toThrow();
    const exclude = readFileSync(
      join(worktreePath, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain(".drover-signal-*");
  });

  it("signal appears on turn 2 -> exactly two prompt calls", async () => {
    const herdr = fakeHerdr();
    let call = 0;
    herdr.prompt.mockImplementation(async () => {
      call++;
      if (call === 2) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(worktreePath, ".drover-signal-t1"), "DONE");
      }
      return readySnapshot;
    });

    const result = await runTicketInPane({
      herdr,
      sandbox: fakeSandbox(),
      ticket: baseTicket,
      agent: stubAgent,
      promptOverride: undefined,
      signal: undefined,
    });

    expect(herdr.prompt).toHaveBeenCalledTimes(2);
    expect(result.completionSignal).toBe("DONE");
  });

  it("maxIterations exhausted with no signal -> completionSignal undefined, workspace not closed", async () => {
    const herdr = fakeHerdr(); // prompt never writes the sentinel

    const result = await runTicketInPane({
      herdr,
      sandbox: fakeSandbox(),
      ticket: baseTicket,
      agent: stubAgent,
      promptOverride: undefined,
      signal: undefined,
    });

    expect(herdr.prompt).toHaveBeenCalledTimes(baseTicket.maxIterations);
    expect(result.completionSignal).toBeUndefined();
    expect(herdr.closeWorkspace).not.toHaveBeenCalled();
  });

  it("a stale sentinel from a prior attempt is cleared before turn 1", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(worktreePath, ".drover-signal-t1"), "DONE"); // stale, from a hypothetical prior attempt
    const herdr = fakeHerdr(); // this attempt's prompt never rewrites it

    const result = await runTicketInPane({
      herdr,
      sandbox: fakeSandbox(),
      ticket: baseTicket,
      agent: stubAgent,
      promptOverride: undefined,
      signal: undefined,
    });

    // Must NOT report done just because a leftover file from a previous attempt existed.
    expect(result.completionSignal).toBeUndefined();
  });

  it("agent blocked at startup -> throws HerdrAgentBlocked, workspace left open", async () => {
    const herdr = fakeHerdr();
    herdr.getAgent.mockResolvedValue(blockedSnapshot);

    await expect(
      runTicketInPane({
        herdr,
        sandbox: fakeSandbox(),
        ticket: baseTicket,
        agent: stubAgent,
        promptOverride: undefined,
        signal: undefined,
      }),
    ).rejects.toThrow(/blocked on startup/);
    expect(herdr.closeWorkspace).not.toHaveBeenCalled();
  });

  it("abort mid-turn sends Ctrl-C and rejects with AbortError, workspace left open", async () => {
    const herdr = fakeHerdr();
    const controller = new AbortController();
    herdr.prompt.mockImplementation(async () => {
      controller.abort();
      return readySnapshot;
    });

    await expect(
      runTicketInPane({
        herdr,
        sandbox: fakeSandbox(),
        ticket: { ...baseTicket, maxIterations: 5 },
        agent: stubAgent,
        promptOverride: undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(herdr.sendKeys).toHaveBeenCalledWith({ paneId: "p1", keys: "C-c" });
    expect(herdr.closeWorkspace).not.toHaveBeenCalled();
  });

  it("throws immediately when the agent provider has no buildInteractiveArgs", async () => {
    const herdr = fakeHerdr();
    const agentWithoutInteractive: AgentProvider = {
      ...stubAgent,
      buildInteractiveArgs: undefined,
    };

    await expect(
      runTicketInPane({
        herdr,
        sandbox: fakeSandbox(),
        ticket: baseTicket,
        agent: agentWithoutInteractive,
        promptOverride: undefined,
        signal: undefined,
      }),
    ).rejects.toThrow(/buildInteractiveArgs/);
    expect(herdr.createWorkspace).not.toHaveBeenCalled();
  });
});
