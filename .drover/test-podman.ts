import * as drover from "@devoteam/drover";
import { podman } from "@devoteam/drover/sandboxes/podman";

const { commits, branch } = await drover.run({
  sandbox: podman(),
  name: "Test",
  agent: drover.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
