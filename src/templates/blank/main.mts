import { run, claudeCode } from "@devoteam/drover";
import { docker } from "@devoteam/drover/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .drover/main.mts
// Or add to package.json scripts: "drover": "npx tsx .drover/main.mts"

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: "./.drover/prompt.md",
});
