import { parseArgs } from "node:util";
import { claudeCode } from "@devoteam/drover";
import { docker } from "@devoteam/drover/sandboxes/docker";
import { runOne, startBoard, type BoardOptions } from "@devoteam/drover/board";

// Sequential dependencies: a durable ticket board that runs a set of tickets
// in dependency order, one shared sandbox per chain of related tickets.
//
// A ticket that runs out of iterations before finishing is automatically
// retried with a fresh run — never a silent resume — that inlines the exact
// completion signal and the previous attempt's evidence, so the agent isn't
// left guessing what "done" means.
//
// Usage:
//   1. Seed the tickets in ./board.json into durable state:
//        npx drover-board load .drover/board.json
//   2. Start the daemon — it exits once every ticket has settled:
//        npx tsx .drover/main.mts
//   3. From another terminal, at any time:
//        npx drover-board status
//   4. Retry a single failed/stuck ticket by hand:
//        npx drover-board retry <id> && npx tsx .drover/main.mts --ticket <id>

const boardOptions: BoardOptions = {
  // Where the board's SQLite state lives. Gitignored — board.json (checked
  // in) is the intent; this file is the runtime state derived from it.
  dbPath: "./.drover/board.sqlite",

  // Sandbox provider — runs each chain's agents inside an isolated container.
  sandbox: docker(),

  // Resolves the agent provider for a ticket. The board never constructs a
  // provider itself — it's a factory call, not JSON, so this callback is
  // where a ticket's advisory `agent`/`model` hints (from board.json) would
  // be turned into an actual provider if you want per-ticket model choice.
  agentFor: () => claudeCode("claude-sonnet-4-6"),

  // Copy node_modules from the host into each chain's worktree before the
  // sandbox starts. The onSandboxReady hook below is still a safety net for
  // platform-specific binaries and any packages added since the last copy.
  copyToWorktree: ["node_modules"],

  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },
};

// `--ticket <id>` runs exactly that ticket once via `runOne()` instead of
// the daemon loop — the manual-retry entry point, and (with `--interactive`)
// what a Herdr-launched pane actually executes for an interactive ticket.
const { values } = parseArgs({
  options: {
    ticket: { type: "string" },
    interactive: { type: "boolean", default: false },
  },
} as const);

if (values.ticket) {
  await runOne(values.ticket, boardOptions);
} else {
  await startBoard(boardOptions);
}
