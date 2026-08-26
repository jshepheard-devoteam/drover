/**
 * Public surface of the `@devoteam/drover/board` subpath export — a durable,
 * dependency-aware ticket board layered on top of `createSandbox()`. See
 * docs/adr/0021-board-layer-is-plain-typescript.md.
 */

export {
  classify,
  classifyInteractive,
  extractErrorMessage,
  extractErrorTag,
} from "./classify.js";
export type {
  RunOutcome,
  InteractiveOutcome,
  ClassifyRunInput,
  ClassifyInteractiveInput,
} from "./classify.js";

export { computeChains } from "./chains.js";
export type { ChainInput, ChainAssignment } from "./chains.js";

export { openBoard } from "./db.js";
export type { BoardDb, TicketSeed } from "./db.js";

export { loadBoard } from "./load.js";
export type { LoadResult } from "./load.js";

export {
  startBoard,
  runOne,
  buildContinuationPrompt,
  buildRunOptions,
} from "./run.js";

export { createHerdrLauncher } from "./herdrLauncher.js";
export type { HerdrLauncherOptions } from "./herdrLauncher.js";

export type {
  Attempt,
  BeforeRun,
  BoardOptions,
  GateContext,
  GateDecision,
  Launcher,
  Ticket,
  TicketInput,
  TicketMode,
  TicketStatus,
} from "./types.js";
