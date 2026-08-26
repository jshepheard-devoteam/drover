/**
 * Seeds tickets from a git-tracked `board.json` (intent) into the gitignored
 * SQLite state. Computes chain assignment once, here, at load time — the
 * scheduler in run.ts just reads `chain_id`/`seq` back off each ticket.
 */

import { computeChains } from "./chains.js";
import type { BoardDb, TicketSeed } from "./db.js";
import type { TicketInput } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 1;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface LoadResult {
  readonly upserted: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Validates and upserts tickets. Throws on a duplicate id in the input, an
 * unknown dep id, or a dependency cycle (see `computeChains`) — all
 * load-time boundary errors. Refuses to touch tickets already `running` or
 * `done` (see `BoardDb.upsertTickets`); their ids come back in `skipped`.
 */
export const loadBoard = (
  db: BoardDb,
  inputs: readonly TicketInput[],
): LoadResult => {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.id))
      throw new Error(`Duplicate ticket id "${input.id}" in board.json`);
    seen.add(input.id);
    if (input.prompt !== undefined && input.promptFile !== undefined) {
      throw new Error(
        `Ticket "${input.id}" sets both "prompt" and "promptFile"`,
      );
    }
    if (input.prompt === undefined && input.promptFile === undefined) {
      throw new Error(
        `Ticket "${input.id}" sets neither "prompt" nor "promptFile"`,
      );
    }
  }

  const assignments = computeChains(
    inputs.map((t) => ({ id: t.id, deps: t.deps ?? [] })),
  );

  const seeds: TicketSeed[] = inputs.map((input) => {
    const assignment = assignments.get(input.id)!;
    return {
      id: input.id,
      title: input.title,
      prompt: input.prompt,
      promptFile: input.promptFile,
      deps: input.deps ?? [],
      mode: input.mode ?? "auto",
      chainId: assignment.chainId,
      seq: assignment.seq,
      maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      completionSignal: input.completionSignal,
      agent: input.agent,
      model: input.model,
    };
  });

  return db.upsertTickets(seeds);
};
