import * as drover from "@devoteam/drover";
import { noSandbox } from "@devoteam/drover/sandboxes/no-sandbox";

// /matt-pococks-projects/drover
const { commits, branch } = await drover.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: drover.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorktree: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
