// Claude plans, GPT executes — a two-model split
//
// This template drives the same plan→execute→merge loop as
// parallel-planner, but deliberately puts a different model on each node:
//   Phase 1 (Plan):    Claude Code (opus) analyzes open issues, builds a
//                      dependency graph, and outputs a <plan> JSON listing
//                      unblocked issues with their target branch names.
//   Phase 2 (Execute): Codex (GPT) agents run in parallel via
//                      Promise.allSettled, each working a single issue on
//                      its own branch.
//   Phase 3 (Merge):   Claude Code (sonnet) merges all branches that
//                      produced commits.
//
// The point of the split, not an incidental choice: a second, differently-
// trained model reviewing/implementing the plan's issues gives you a
// different failure mode than "the same model plans and executes its own
// plan" — useful when you want an independent check on how faithfully the
// plan gets carried out.
//
// Both models hardcode their own model string below (rather than the usual
// single claudeCode(...) placeholder every other template uses). This is
// deliberate: `drover init`'s `--agent`/`--model` flags rewrite the
// `claudeCode(...)` placeholder only — running init with `--agent codex`
// here would turn the *planner* into Codex too, defeating the split. If you
// want to change either model, edit the `agent:` lines directly.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// SETUP: `drover init`'s Dockerfile is single-agent-per-image — the
// scaffolded .drover/Dockerfile only installs whichever CLI you pass to
// `--agent` at init time. This template needs both. Add the Codex CLI
// install line to .drover/Dockerfile yourself, before the `USER
// ${AGENT_UID}:${AGENT_GID}` line:
//   RUN npm install -g @openai/codex
// And set OPENAI_KEY (Codex) alongside CLAUDE_CODE_OAUTH_TOKEN/
// ANTHROPIC_API_KEY (Claude Code) in .drover/.env.
//
// Usage:
//   npx tsx .drover/main.mts
// Or add to package.json:
//   "scripts": { "drover": "npx tsx .drover/main.mts" }

import * as drover from "@devoteam/drover";
import { docker } from "@devoteam/drover/sandboxes/docker";
import { z } from "zod";

// Confirmed against the installed Codex CLI's own config
// (`~/.codex/config.toml`, `model = "..."`) rather than guessed — model
// names move fast, so re-check yours with `codex --help` / your config
// before relying on this.
const EXECUTOR_MODEL = "gpt-5.6-terra";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan (Claude Code, opus)
  //
  // The planning agent reads the open issue list, builds a dependency graph,
  // and selects the issues that can be worked in parallel right now (i.e.,
  // no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // Structured output (Output.object) requires maxIterations: 1 and isn't
  // available on sandbox.run() at all, so this uses the top-level run().
  // -------------------------------------------------------------------------
  const plan = await drover.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    maxIterations: 1,
    agent: drover.claudeCode("claude-opus-4-8"),
    promptFile: "./.drover/plan-prompt.md",
    output: drover.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute (Codex / GPT)
  //
  // One Codex agent per issue, all running concurrently, each on its own
  // branch — no conflicts during execution, merging happens in Phase 3.
  //
  // Promise.allSettled means one failing agent doesn't cancel the others.
  // -------------------------------------------------------------------------
  const settled = await Promise.allSettled(
    issues.map((issue) =>
      drover.run({
        hooks,
        copyToWorktree,
        sandbox: docker(),
        branchStrategy: { type: "branch", branch: issue.branch },
        name: "implementer",
        maxIterations: 100,
        agent: drover.codex(EXECUTOR_MODEL),
        promptFile: "./.drover/implement-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
    ),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (
        entry,
      ): entry is {
        outcome: PromiseFulfilledResult<Awaited<ReturnType<typeof drover.run>>>;
        issue: (typeof issues)[number];
      } =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge (Claude Code, sonnet)
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything still
  // works — independent of whichever model implemented each branch.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await drover.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    agent: drover.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.drover/merge-prompt.md",
    promptArgs: {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
