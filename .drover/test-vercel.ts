import * as drover from "@devoteam/drover";
import { vercel } from "@devoteam/drover/sandboxes/vercel";

const claudeInstallHook = {
  command: "curl -fsSL https://claude.ai/install.sh | bash",
};

const ghCliInstallHook = {
  command:
    "curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o /etc/yum.repos.d/gh-cli.repo && dnf install -y gh",
  sudo: true,
};

// /matt-pococks-projects/drover
const { commits, branch } = await drover.run({
  sandbox: vercel({
    token: process.env.VERCEL_OIDC_TOKEN,
    teamId: "matt-pococks-projects",
    projectId: "drover",
  }),
  name: "Test",
  agent: drover.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        claudeInstallHook,
        ghCliInstallHook,
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
