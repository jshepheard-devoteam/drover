import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { claudeCode } from "@devoteam/drover";
import { docker } from "@devoteam/drover/sandboxes/docker";
import {
  loadBoard,
  openBoard,
  runOne,
  startBoard,
  type BoardOptions,
  type TicketInput,
} from "@devoteam/drover/board";

const execFileP = promisify(execFile);

// Planner → N independent implement/review chains, run in parallel → a
// printed report of branches ready for a human to look at. Deliberately no
// merge step: unlike the classic planner→parallel→review→merge shape, this
// template stops one step earlier — a human decides what actually lands on
// main, this just gets each branch to "reviewed and ready to look at."
//
// Usage:
//   npx drover-board load .drover/board.json   (seeds just the planner ticket)
//   npx tsx .drover/main.ts                    (plans, fans out, reports)
//   npx tsx .drover/main.ts --ticket <id>       (re-run one ticket ad hoc)

const IMPLEMENT_SIGNAL = "IMPLEMENT_COMPLETE";
const REVIEW_SIGNAL = "REVIEW_COMPLETE";

// ponytail: hard cap on parallel chains regardless of how many items the
// planner selects — raise if your machine/Docker setup can take more.
const MAX_PARALLEL_CHAINS = 4;

const boardOptions: BoardOptions = {
  dbPath: "./.drover/board.sqlite",
  sandbox: docker(),
  agentFor: () => claudeCode("claude-sonnet-4-6"),
  copyToWorktree: ["node_modules"],
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },
};

const { values } = parseArgs({
  options: {
    ticket: { type: "string" },
    interactive: { type: "boolean", default: false },
  },
} as const);

if (values.ticket) {
  await runOne(values.ticket, boardOptions);
  process.exit(0);
}

// --- Phase 1: run the planner --------------------------------------------
// Skipped if a prior run already got the planner to a terminal success —
// runOne() throws on a non-runnable ticket, so re-running this script after
// the planner already finished (e.g. to pick up a retried implement/review
// ticket) would otherwise crash before it got anywhere near Phase 4.

const plannerStatusBefore = openBoard(boardOptions.dbPath);
const plannerAlreadyDone = ["done", "done_no_commits"].includes(
  plannerStatusBefore.getTicket("planner")?.status ?? "",
);
plannerStatusBefore.close();

if (!plannerAlreadyDone) {
  await runOne("planner", boardOptions);
}

const afterPlanner = openBoard(boardOptions.dbPath);
const plannerTicket = afterPlanner.getTicket("planner");
const plannerAttempt = afterPlanner.lastAttempt("planner");
afterPlanner.close();

if (
  !plannerTicket ||
  (plannerTicket.status !== "done" && plannerTicket.status !== "done_no_commits")
) {
  console.error(
    `Planner did not finish successfully (status: ${plannerTicket?.status ?? "missing"}). Nothing to fan out. Check .drover/board.sqlite attempts for the planner ticket.`,
  );
  process.exit(1);
}
if (!plannerAttempt) {
  console.error("Planner ticket has no recorded attempt — nothing to read a branch from.");
  process.exit(1);
}

// --- Phase 2: read the plan off the planner's own branch -----------------
// Not read from the worktree — a successful ticket's worktree is torn down,
// only the commit survives. The plan only exists if the planner committed it.

interface PlanItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

const readPlan = async (branch: string): Promise<PlanItem[]> => {
  let raw: string;
  try {
    ({ stdout: raw } = await execFileP(
      "git",
      ["show", `${branch}:.drover/plan.json`],
      { cwd: boardOptions.cwd ?? process.cwd(), encoding: "utf8" },
    ));
  } catch {
    throw new Error(
      `Could not read .drover/plan.json from branch "${branch}" — did the planner actually commit it?`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("plan.json is not a JSON array");
  for (const item of parsed) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).id !== "string" ||
      typeof (item as Record<string, unknown>).title !== "string" ||
      typeof (item as Record<string, unknown>).description !== "string"
    ) {
      throw new Error(
        `plan.json entry is malformed (expected {id, title, description} strings): ${JSON.stringify(item)}`,
      );
    }
  }
  return parsed as PlanItem[];
};

const plan = await readPlan(plannerAttempt.branch);

if (plan.length === 0) {
  console.log("Planner selected nothing to do. Exiting.");
  process.exit(0);
}

console.log(`Planner selected ${plan.length} item(s):`);
for (const item of plan) console.log(`  ${item.id}: ${item.title}`);

// --- Phase 3: fan out into implement→review chains, no merge -------------

const newTickets: TicketInput[] = plan.flatMap((item) => {
  const implementId = `implement-${item.id}`;
  const reviewId = `review-${item.id}`;
  return [
    {
      id: implementId,
      title: `Implement: ${item.title}`,
      prompt: [
        item.description,
        "",
        `When finished, output exactly this string on its own line: ${IMPLEMENT_SIGNAL}`,
      ].join("\n"),
      completionSignal: IMPLEMENT_SIGNAL,
      maxIterations: 20,
    },
    {
      id: reviewId,
      title: `Review: ${item.title}`,
      deps: [implementId],
      prompt: [
        `Review the changes committed on this branch for "${item.title}".`,
        "Run `git log` and `git diff` against the base branch to see what changed. Check correctness, test coverage, and adherence to this repo's existing conventions.",
        "Write your findings to REVIEW.md at the repository root (create it if missing) and commit it.",
        "Do not merge this branch and do not touch the base branch — a human decides what lands on it.",
        `When finished, output exactly this string on its own line: ${REVIEW_SIGNAL}`,
      ].join("\n"),
      completionSignal: REVIEW_SIGNAL,
      maxIterations: 5,
    },
  ];
});

const loadingDb = openBoard(boardOptions.dbPath);
const { upserted, skipped } = loadBoard(loadingDb, newTickets);
loadingDb.close();
if (skipped.length > 0) {
  console.log(
    `Skipped ${skipped.length} ticket(s) already running/done from a prior run: ${skipped.join(", ")}`,
  );
}
console.log(`Loaded ${upserted.length} new ticket(s).`);

// --- Phase 4: run everything, in parallel -------------------------------

await startBoard({
  ...boardOptions,
  maxConcurrentChains: Math.min(plan.length, MAX_PARALLEL_CHAINS),
});

// --- Phase 5: report what's ready for a human ---------------------------

const finalDb = openBoard(boardOptions.dbPath);
console.log("\nReady for human review (nothing was merged):\n");
for (const item of plan) {
  const reviewId = `review-${item.id}`;
  const ticket = finalDb.getTicket(reviewId);
  const attempt = finalDb.lastAttempt(reviewId);
  const branch = attempt?.branch ?? `(no attempt recorded)`;
  console.log(`  ${item.title}`);
  console.log(`    branch: ${branch}`);
  console.log(`    status: ${ticket?.status ?? "missing"}`);
}
finalDb.close();
