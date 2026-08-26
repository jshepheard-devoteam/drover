import { parseArgs } from "node:util";
import { claudeCode } from "@devoteam/drover";
import { noSandbox } from "@devoteam/drover/sandboxes/no-sandbox";
import {
  createHerdrLauncher,
  runOne,
  startBoard,
  type BoardOptions,
} from "@devoteam/drover/board";

// Herdr-watched: every ticket gets a real, human-visible Herdr pane — not
// just ones marked `mode: "interactive"`.
//
// This runs host-native, not containerized: verified directly against
// Herdr 0.8.2, there is currently no way to get Herdr to detect an agent
// running inside a containerized process — see
// docs/adr/0022-herdr-execution-is-host-native.md. `execVia: "herdr"`
// therefore requires `sandbox: noSandbox()`, and every auto ticket here runs
// with `dangerouslySkipPermissions: true` on the bare host — deliberate, not
// an oversight: unattended execution needs it (nobody's there to answer a
// permission prompt), and there's no container to contain a mistake if the
// agent does something wrong. If you need that safety net, use
// `execVia: "sandbox"` (the default) with a containerized sandbox provider
// instead — see sequential-dependencies for that shape.
//
// `mode: "interactive"` tickets still hand off via the same launcher as
// before (a genuine terminal handoff, not an attach-after-the-fact) — that
// path is unchanged by the host-native switch.
//
// Requires Herdr — run this from inside a Herdr session (`HERDR_ENV=1`).
//
// Usage:
//   npx drover-board load .drover/board.json
//   npx tsx .drover/main.mts
//   npx drover-board status   (from another terminal, at any time)

const boardOptions: BoardOptions = {
  dbPath: "./.drover/board.sqlite",
  sandbox: noSandbox(),
  execVia: "herdr",
  agentFor: () => claudeCode("claude-sonnet-4-6"),

  // Default launcher for `mode: "interactive"` tickets: `herdr tab create` +
  // `herdr pane run`. Pass `buildCommand`/`cwd` here to customize the pane's
  // working directory or the command it runs.
  launcher: createHerdrLauncher(),
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
