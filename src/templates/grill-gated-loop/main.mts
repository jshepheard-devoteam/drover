import { parseArgs } from "node:util";
import { claudeCode } from "@devoteam/drover";
import { docker } from "@devoteam/drover/sandboxes/docker";
import {
  runOne,
  startBoard,
  type BeforeRun,
  type BoardOptions,
} from "@devoteam/drover/board";

// Grill-gated loop: a pre-execution interrogation gate runs before every
// ticket attempt. It can approve a ticket as-is, rewrite its prompt before
// the agent ever sees it (promptOverride — the actual point of a gate like
// this: turning a vague ticket into a sharp one, not just rubber-stamping
// it), reject it outright, or defer it back to a human.
//
// Usage:
//   npx drover-board load .drover/board.json
//   npx tsx .drover/main.mts
//   npx drover-board status   (from another terminal, at any time)
//   npx drover-board retry <id> && npx tsx .drover/main.mts --ticket <id>  (retry one)

// "bot": the gate below runs a synchronous heuristic critique and returns
// proceed/reject on its own.
// "human": every ticket is deferred with instructions for a person to
// review board.json and re-run `drover-board retry <id>`.
const GRILL_MODE = "bot" as "bot" | "human";

const MIN_PROMPT_LENGTH = 40;

// ponytail: this is a heuristic gate, not a round-based interrogation
// agent — no second LLM call, no back-and-forth. It still exercises the
// full proceed/reject/defer/promptOverride contract a real Grill-style gate
// would use. Upgrade path: once ticket volume justifies the cost, replace
// the heuristic below with a small critique agent (its own `run()` call)
// that actually questions the ticket instead of pattern-matching it.
const beforeRun: BeforeRun = async (ctx) => {
  const { ticket } = ctx;

  if (GRILL_MODE === "human") {
    return {
      action: "defer",
      note: `Review the prompt for "${ticket.title}" in board.json, edit if needed, then run: npx drover-board retry ${ticket.id}`,
    };
  }

  const prompt = ticket.prompt ?? "";
  if (prompt.length < MIN_PROMPT_LENGTH) {
    return {
      action: "reject",
      note: `Prompt is only ${prompt.length} characters — too thin to run unattended.`,
    };
  }
  if (ticket.completionSignal === undefined) {
    return {
      action: "reject",
      note: "Ticket has no completionSignal — the agent has no way to signal it's actually done.",
    };
  }

  // Sharpen the prompt rather than approving it verbatim. Delivered as an
  // inline `prompt` (never combined with `promptArgs` — see ADR 0008), so
  // any interpolation happens here in JS, not via Sandcastle's `{{KEY}}`
  // substitution.
  const sharpened = [
    prompt,
    "",
    "Before you start: state your plan in one sentence. If the task as written is ambiguous, make the narrowest reasonable interpretation and note the assumption in your final commit message.",
  ].join("\n");

  return { action: "proceed", promptOverride: sharpened, note: "Grill gate approved." };
};

const boardOptions: BoardOptions = {
  dbPath: "./.drover/board.sqlite",
  sandbox: docker(),
  agentFor: () => claudeCode("claude-sonnet-4-6"),
  beforeRun,
  copyToWorktree: ["node_modules"],
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },
};

// `--ticket <id>` runs exactly that ticket once via `runOne()` — still
// gated by `beforeRun` above — instead of the daemon loop.
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
