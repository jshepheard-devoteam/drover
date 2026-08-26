import { parseArgs } from "node:util";
import { claudeCode } from "@devoteam/drover";
import { docker } from "@devoteam/drover/sandboxes/docker";
import {
  createHerdrLauncher,
  runOne,
  startBoard,
  type BoardOptions,
} from "@devoteam/drover/board";

// Herdr-watched: a ticket marked `mode: "interactive"` in board.json is
// handed off to a live Herdr pane instead of run headlessly. The daemon
// claims the ticket, opens a new Herdr tab, fires this same script back into
// it with `--ticket <id> --interactive`, and stops touching it — a genuine
// terminal handoff (Sandcastle's `interactive()` passes stdin/stdout/stderr
// to the agent verbatim), not an attach-after-the-fact.
//
// `auto`-mode tickets in the same board.json still run headlessly through
// the daemon's own shared per-chain sandbox, same as sequential-dependencies.
//
// Requires Herdr — run this from inside a Herdr session (`HERDR_ENV=1`).
//
// Usage:
//   npx drover-board load .drover/board.json
//   npx tsx .drover/main.mts
//   npx drover-board status   (from another terminal, at any time)

const boardOptions: BoardOptions = {
  dbPath: "./.drover/board.sqlite",
  sandbox: docker(),
  agentFor: () => claudeCode("claude-sonnet-4-6"),

  // Default launcher: `herdr tab create` + `herdr pane run`. Pass
  // `buildCommand`/`cwd` here to customize the pane's working directory or
  // the command it runs.
  launcher: createHerdrLauncher(),

  copyToWorktree: ["node_modules"],
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },
};

// `--ticket <id> --interactive` is exactly what the Herdr launcher above
// fires into the new pane — this is the pane-resident entry point, not just
// the manual-retry one.
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
