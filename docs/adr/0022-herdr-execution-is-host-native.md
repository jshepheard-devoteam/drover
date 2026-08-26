# Herdr-executed tickets run on the host, not inside a container

## Context

`execVia: "herdr"` (`src/board/herdrRun.ts`) exists to give every ticket the
board runs — not just ones marked `mode: "interactive"` — a real, observable
Herdr pane instead of Sandcastle's headless `sandbox.run()`. The original
design assumed the pane's shell would `docker exec` into the ticket's
container, keeping Docker's isolation. Verified live against Herdr 0.8.2 and
a real Drover sandbox container, that assumption doesn't hold:

- `herdr pane run <paneId> "docker exec -it <container> claude ..."`,
  addressed by pane ID: the pane correctly renders Claude's TUI (the pty
  pipeline works end to end), but `herdr agent get`/`agent explain` both
  return `agent_not_found` — Herdr's agent detection never fires through a
  `docker exec` boundary.
- The fallback tried next — a PATH shim redirecting `claude` to
  `exec docker exec -it <container> claude "$@"`, launched via
  `herdr agent start --kind claude`: detection _did_ fire
  (`agent: "claude", agent_status: "blocked"`), but the trust dialog it
  displayed named the **host** worktree path, not the container's
  `/home/agent/workspace`. `agent start` resolved and launched the real host
  `claude` binary directly, completely bypassing both the shim and the
  container.

Both failure modes point at the same root cause: Herdr's agent detection
and `--kind` executable resolution operate on the host's own process/PATH
context. Nothing in Herdr 0.8.2 gives a caller a way to tell it "the process
I actually want you to observe/detect is inside this container" — the two
mechanisms available (passive content detection via `pane run`, and
declarative launch via `agent start --kind`) both resolve against the host.

## Decision

Herdr-executed tickets run directly on the host, in the Herdr pane, against
the exact git worktree Sandcastle already checked out
(`sandbox.worktreePath`) — using `noSandbox()` (`src/sandboxes/no-sandbox.ts`)
as the board's sandbox provider. `runTicketInPane` requires this; boards that
need container isolation use `execVia: "sandbox"` (the original headless
Docker/Podman path) instead. The two are mutually exclusive per board, not
combinable per ticket.

This is a real trade, not a workaround: **no container-level isolation for
Herdr-executed tickets.** In exchange:

- Herdr's detection and lifecycle API (`agent get`, `agent prompt --wait`,
  `agent send-keys`) all work exactly as designed, verified live.
- Container auth — a real, unsolved blocker under the `docker exec` design
  (`docker exec` inherits the container's env; the host's macOS Keychain
  session has no portable file to mount, and `claude setup-token` needs a
  one-time interactive browser step) — disappears entirely. The host is
  already authenticated; there is nothing special to configure.
- Git identity propagation, which the container-exec design would have
  needed to replicate by hand (Sandcastle's `withSandboxLifecycle` sets
  `git config --global user.name/email` per `sandbox.run()` call, bypassed
  entirely once that's not the exec path), is simply the host's own ambient
  git config. Nothing to propagate.

The cost is accepted deliberately: `runTicketInPane` also runs with
`dangerouslySkipPermissions: true` even though it's on the bare host —
Sandcastle's own `interactive.ts` deliberately sets
`dangerouslySkipPermissions: sandboxProvider.tag !== "none"`, i.e. it never
skips permissions on `noSandbox()`, precisely because there's no container to
contain a mistake. An unattended auto ticket that _doesn't_ skip permissions
hangs on its first file-write/command-run prompt with nobody there to answer
it, which defeats unattended execution outright. Skipping anyway was a
conscious call, not an oversight: boards using `execVia: "herdr"` are
accepting host-level blast radius for these tickets in exchange for them
running unattended at all. Boards that need the safety net use
`execVia: "sandbox"`.

## Considered Options

1. **`docker exec` from the pane, container isolation preserved** (the
   original design) — rejected. Empirically dead: Herdr cannot detect an
   agent running inside a container by either mechanism available in 0.8.2.
2. **Container reaches out to the host's Herdr socket** (a `socat` TCP
   bridge + a Linux `herdr` client binary baked into the image) — considered
   and rejected earlier in this design process, before the `docker exec`
   approach was even tried: solves a different problem (code _inside_ the
   container driving Herdr's API directly) than the one this feature needs
   (a human-observable pane around whatever the ticket runs), and adds a
   socket-bridge lifecycle to manage for no capability this design needs.
3. **Host-native execution via `noSandbox()`** (chosen) — the only mechanism
   that's actually been verified to work against real Herdr 0.8.2, at the
   cost of container isolation for these tickets specifically.

## Consequences

- `execVia: "herdr"` requires `sandbox: noSandbox()`; `runTicketInPane`'s
  caller (`run.ts`) validates this once at `startBoard`/`runOne` entry and
  throws a clear, actionable error otherwise — `Sandbox` itself doesn't carry
  a provider tag, so this can't be checked inside `herdrRun.ts`.
- The completion signal is written to a sentinel file inside the worktree
  (`.drover-signal-<ticketId>`, excluded via `.git/info/exclude`, cleared
  before and after every attempt) rather than scanned from pane text —
  unrelated to the container-vs-host question, but discovered at the same
  time: Claude's TUI renders on the terminal's alternate screen, which
  Herdr's own docs say its scrollback capture can't see once content leaves
  it, so a substring match against `pane read` output isn't reliable either
  way.
- `Attempt.sessionFilePath` (Sandcastle's own session-capture-to-host
  mechanism) never fires under `execVia: "herdr"` — the board's own
  continuation mechanism (`buildContinuationPrompt`) never depended on
  session resume, so this costs nothing today.
- If Herdr ever adds a way to tell it "detect/launch inside this specific
  container" (an `--exec-target`-style flag, or container-namespace-aware
  detection), this ADR's rejection of option 1 should be revisited — the
  container-exec design's other findings (git identity propagation, base-ref
  commit counting) remain valid reference material even though the exec
  mechanism itself didn't pan out.
