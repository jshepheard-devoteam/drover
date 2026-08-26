# The board layer is plain TypeScript, not Effect

## Context

Every internal module in this codebase routes through Effect: `FileSystem`
over raw `fs`, tagged errors from `errors.ts` instead of `new Error()`, `.pipe`
composition, DI via `Layer`. `src/board/` — a durable, dependency-aware ticket
scheduler built on top of the public `createSandbox()`/`sandbox.run()` API —
does none of this. It is plain `async`/`await` TypeScript over `node:sqlite`'s
synchronous `DatabaseSync`.

This isn't an oversight; it's a boundary question. `CODING_STANDARDS.md` says
"use Effect primitives... so that we can make use of DI and type-safe errors,"
which is a rule about the sandbox/agent-provider internals `board/` sits
_on top of_, not a rule about every future consumer of the published package.

## Decision

`src/board/` is plain TypeScript with no Effect dependency, and is expected to
stay that way.

- **`node:sqlite`'s `DatabaseSync` is synchronous.** There's no async I/O to
  wrap in an Effect in the first place — every `db.prepare(...).run(...)` call
  is a blocking C++ binding call, not a Promise. Effect's value here (fiber
  scheduling, structured concurrency) has nothing to attach to.
- **The `./board` subpath export is a public export, like the root package.**
  `scripts/check-public-types-effect-free.mjs` already enforces "Effect must
  never appear in the published type surface" for `dist/index.d.ts` — the same
  check runs over `dist/board.d.ts`. A consumer of `@devoteam/drover/board`
  should never need `effect` in their own dependency tree to read this
  package's types, exactly like a consumer of the root export today.
- **`board/` is a new layer over the public API, not new internals.** It calls
  `createSandbox()` and `sandbox.run()` — functions that already return
  Promises at the public boundary — the same way any external caller would.
  There's no privileged internal access to justify pulling in the internal
  Effect machinery.
- **Tagged errors are still used, structurally.** `board/classify.ts` reads a
  caught error's `_tag` (falling back to `.name`) to extract `Attempt.errorTag`
  — the discriminated-error discipline `errors.ts` established is preserved as
  a _consumer_, without requiring `board/` itself to construct or propagate
  Effect's tagged-error types.

## Considered Options

1. **Effect throughout `board/`, matching the rest of `src/`** — rejected.
   `DatabaseSync` has no async surface to lift into Effect, so every wrapper
   would be `Effect.sync(() => stmt.run(...))` — ceremony with no behavioral
   payoff — and the `./board` export would then need the same
   `Effect.runPromise`-at-the-boundary pattern `createSandbox.ts` uses just to
   hand callers a plain Promise back, doubling the indirection for a
   synchronous DB call.
2. **Plain TypeScript, tagged-error-aware at the boundary** (chosen) — matches
   the actual shape of the work (synchronous DB + calls into an already-Promise
   public API) and keeps the public `./board` surface Effect-free the same way
   the root export already is.

## Consequences

- `board/` has exactly two runtime dependencies: `node:sqlite` and this
  package's own public API (`createSandbox`, `AgentProvider`,
  `SandboxProvider`, `SandboxHooks` types). No `effect` import anywhere under
  `src/board/`.
- `scripts/check-public-types-effect-free.mjs` covers `dist/board.d.ts` for
  free — it already walks every `.d.ts` under `dist/`.
- If a future board feature needs genuine async orchestration Effect would
  help with (e.g. structured concurrency across many chains), that's a reason
  to introduce Effect _internally_ to that feature, still without leaking it
  into `./board`'s exported types — not a reason to retrofit the whole layer.
