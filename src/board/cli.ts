#!/usr/bin/env node
/**
 * `drover-board` — DB-only board commands. No providers, no Effect: a
 * `SandboxProvider`/`AgentProvider` is a factory call, not JSON, so actually
 * *running* a ticket is the operator's own `.drover/main.mts` calling
 * `startBoard()`/`runOne()` from `@devoteam/drover/board`. This CLI only
 * reads and mutates the SQLite state those functions act on.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openBoard } from "./db.js";
import { loadBoard } from "./load.js";
import type { TicketInput } from "./types.js";

const DEFAULT_DB_PATH = ".drover/board.sqlite";

const usage = `Usage:
  drover-board load <board.json> [--db <path>]
  drover-board status [--db <path>] [--json]
  drover-board retry <id> [--db <path>]
  drover-board skip <id> [--db <path>] [--note <text>]
  drover-board stop [--db <path>]
`;

class CliUsageError extends Error {}

const fail = (message: string): never => {
  throw new CliUsageError(message);
};

const main = (): void => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) fail(usage);

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      db: { type: "string", default: DEFAULT_DB_PATH },
      json: { type: "boolean", default: false },
      note: { type: "string" },
    },
    allowPositionals: true,
  } as const);

  switch (command) {
    case "load": {
      const [boardJsonPath] = positionals;
      if (!boardJsonPath)
        throw new CliUsageError(`drover-board load <board.json> [--db <path>]`);
      if (!existsSync(boardJsonPath))
        throw new CliUsageError(`No such file: ${boardJsonPath}`);
      const inputs = JSON.parse(
        readFileSync(boardJsonPath, "utf8"),
      ) as TicketInput[];
      const db = openBoard(values.db);
      try {
        const result = loadBoard(db, inputs);
        console.log(
          `Loaded ${result.upserted.length} ticket(s): ${result.upserted.join(", ") || "(none)"}`,
        );
        if (result.skipped.length > 0) {
          console.log(
            `Skipped ${result.skipped.length} ticket(s) already running/done: ${result.skipped.join(", ")}`,
          );
        }
      } finally {
        db.close();
      }
      return;
    }

    case "status": {
      const db = openBoard(values.db);
      try {
        const tickets = db.listTickets();
        if (values.json) {
          console.log(JSON.stringify(tickets, null, 2));
          return;
        }
        if (tickets.length === 0) {
          console.log(
            "No tickets loaded. Run `drover-board load <board.json>` first.",
          );
          return;
        }
        for (const t of tickets) {
          const deps = t.deps.length > 0 ? ` deps=[${t.deps.join(",")}]` : "";
          const gate = t.gateNote ? ` gate(${t.gateState}): ${t.gateNote}` : "";
          console.log(
            `${t.id.padEnd(24)} chain=${(t.chainId ?? "-").padEnd(12)} seq=${String(t.seq ?? "-").padEnd(3)} ${t.status.padEnd(14)}${deps}${gate}`,
          );
        }
      } finally {
        db.close();
      }
      return;
    }

    case "retry": {
      const [id] = positionals;
      if (!id) throw new CliUsageError(`drover-board retry <id> [--db <path>]`);
      const db = openBoard(values.db);
      try {
        const ticket = db.getTicket(id);
        if (!ticket) throw new CliUsageError(`Unknown ticket "${id}"`);
        db.release(id, "needs_attempt");
        console.log(`Ticket "${id}" reset to needs_attempt.`);
      } finally {
        db.close();
      }
      return;
    }

    case "skip": {
      const [id] = positionals;
      if (!id)
        throw new CliUsageError(
          `drover-board skip <id> [--db <path>] [--note <text>]`,
        );
      const db = openBoard(values.db);
      try {
        const ticket = db.getTicket(id);
        if (!ticket) throw new CliUsageError(`Unknown ticket "${id}"`);
        db.release(id, "failed", {
          gateState: "skipped",
          gateNote: values.note ?? "Skipped by operator",
        });
        console.log(`Ticket "${id}" marked failed (skipped).`);
      } finally {
        db.close();
      }
      return;
    }

    case "stop": {
      const db = openBoard(values.db);
      try {
        db.requestStop();
        console.log(
          "Stop requested — the running daemon will halt after its current poll.",
        );
      } finally {
        db.close();
      }
      return;
    }

    default:
      fail(usage);
  }
};

try {
  main();
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
