/**
 * A local, read-only web view over the board's SQLite state — the same data
 * `drover-board status` prints, laid out for a screen instead of a terminal.
 * Never mutates anything: no start/stop/retry actions, on purpose — that
 * keeps this safe to leave open during a demo without it becoming a second
 * way to drive the board.
 */

import { createServer, type Server } from "node:http";
import type { BoardDb } from "./db.js";
import type { Attempt, Ticket, TicketStatus } from "./types.js";

export interface DashboardAttemptSummary {
  readonly n: number;
  readonly outcome: Attempt["outcome"];
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly branch: string;
  readonly commitCount: number;
  readonly errorTag?: string;
  readonly errorMessage?: string;
}

export interface DashboardTicket {
  readonly id: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly seq: number | null;
  readonly deps: readonly string[];
  readonly mode: Ticket["mode"];
  readonly gateState: string | null;
  readonly gateNote: string | null;
  readonly updatedAt: string;
  readonly lastAttempt?: DashboardAttemptSummary;
}

export interface DashboardChain {
  readonly chainId: string;
  readonly tickets: readonly DashboardTicket[];
}

export interface DashboardState {
  readonly generatedAt: string;
  readonly dbPath: string;
  readonly summary: Partial<Record<TicketStatus, number>>;
  readonly chains: readonly DashboardChain[];
}

const toAttemptSummary = (a: Attempt): DashboardAttemptSummary => ({
  n: a.n,
  outcome: a.outcome,
  startedAt: a.startedAt,
  endedAt: a.endedAt,
  branch: a.branch,
  commitCount: a.commitShas.length,
  errorTag: a.errorTag,
  errorMessage: a.errorMessage,
});

/** Pure — no I/O beyond what `db` already did. Safe to unit test directly. */
export const buildDashboardState = (
  db: BoardDb,
  dbPath: string,
): DashboardState => {
  const tickets = db.listTickets();

  const summary: Partial<Record<TicketStatus, number>> = {};
  for (const t of tickets) summary[t.status] = (summary[t.status] ?? 0) + 1;

  const byChain = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const key = t.chainId ?? "(unassigned)";
    const list = byChain.get(key) ?? [];
    list.push(t);
    byChain.set(key, list);
  }

  const chains: DashboardChain[] = [...byChain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([chainId, chainTickets]) => ({
      chainId,
      tickets: chainTickets
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map((t) => {
          const last = db.lastAttempt(t.id);
          return {
            id: t.id,
            title: t.title,
            status: t.status,
            seq: t.seq,
            deps: t.deps,
            mode: t.mode,
            gateState: t.gateState,
            gateNote: t.gateNote,
            updatedAt: t.updatedAt,
            lastAttempt: last ? toAttemptSummary(last) : undefined,
          };
        }),
    }));

  return { generatedAt: new Date().toISOString(), dbPath, summary, chains };
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Drover board</title>
<style>
  :root {
    --bg: #12100e;
    --panel: #1c1916;
    --panel-border: #2f2a24;
    --text: #e8e2d8;
    --text-dim: #a89e8f;
    --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    --accent: #d98e3f;
    --done: #4f9d6e;
    --running: #4f8ed9;
    --failed: #cc5f5f;
    --pending: #6b6459;
    --gate: #b98fd9;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    padding: 2rem;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  h1 {
    font-size: 1.15rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    margin: 0;
  }
  h1 span { color: var(--accent); }
  .dbpath {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .summary {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.75rem;
  }
  .chip {
    font-family: var(--mono);
    font-size: 0.75rem;
    padding: 0.3rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--panel-border);
    background: var(--panel);
    color: var(--text-dim);
  }
  .chip b { color: var(--text); font-variant-numeric: tabular-nums; }
  .chain {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    margin-bottom: 1rem;
    overflow: hidden;
  }
  .chain-head {
    padding: 0.6rem 1rem;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-dim);
    border-bottom: 1px solid var(--panel-border);
  }
  .chain-head b { color: var(--text); }
  .ticket {
    display: grid;
    grid-template-columns: 1.4rem 1fr auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 1rem;
    border-bottom: 1px solid var(--panel-border);
  }
  .ticket:last-child { border-bottom: none; }
  .seq {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--text-dim);
    text-align: right;
  }
  .ticket-main { min-width: 0; }
  .ticket-title { font-size: 0.9rem; }
  .ticket-id { color: var(--text-dim); font-family: var(--mono); font-size: 0.72rem; }
  .ticket-meta {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-top: 0.15rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ticket-error {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--failed);
    margin-top: 0.15rem;
  }
  .pill {
    font-family: var(--mono);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  .pill-done { color: var(--done); border-color: var(--done); }
  .pill-done_no_commits { color: var(--done); border-color: var(--done); opacity: 0.7; }
  .pill-running { color: var(--running); border-color: var(--running); }
  .pill-pending { color: var(--pending); border-color: var(--pending); }
  .pill-needs_attempt { color: var(--gate); border-color: var(--gate); }
  .pill-failed { color: var(--failed); border-color: var(--failed); }
  .pill-interrupted { color: var(--failed); border-color: var(--failed); opacity: 0.7; }
  footer {
    margin-top: 1.5rem;
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--text-dim);
  }
</style>
</head>
<body>
  <header>
    <h1>drover<span>::</span>board</h1>
    <div class="dbpath" id="dbpath"></div>
  </header>
  <div class="summary" id="summary"></div>
  <div id="chains"></div>
  <footer id="footer">loading…</footer>
<script>
  const STATUS_LABEL = {
    done: "done",
    done_no_commits: "done (no commits)",
    running: "running",
    pending: "pending",
    needs_attempt: "needs attempt",
    failed: "failed",
    interrupted: "interrupted",
  };

  const timeAgo = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const renderTicket = (t) => {
    const attempt = t.lastAttempt;
    const metaBits = [];
    if (t.deps.length) metaBits.push("deps=" + t.deps.join(","));
    if (attempt) metaBits.push("attempt #" + attempt.n + " · " + attempt.commitCount + " commit(s) · " + esc(attempt.branch));
    if (t.mode === "interactive") metaBits.push("interactive");
    if (t.gateNote) metaBits.push("gate(" + t.gateState + "): " + esc(t.gateNote));

    const errorLine =
      attempt && attempt.errorTag
        ? '<div class="ticket-error">' + esc(attempt.errorTag) + (attempt.errorMessage ? ": " + esc(attempt.errorMessage) : "") + "</div>"
        : "";

    return (
      '<div class="ticket">' +
      '<div class="seq">' + (t.seq ?? "-") + "</div>" +
      '<div class="ticket-main">' +
      '<div class="ticket-title">' + esc(t.title) + ' <span class="ticket-id">' + esc(t.id) + "</span></div>" +
      (metaBits.length ? '<div class="ticket-meta">' + esc(metaBits.join("  ·  ")) + "</div>" : "") +
      errorLine +
      "</div>" +
      '<span class="pill pill-' + t.status + '">' + (STATUS_LABEL[t.status] ?? t.status) + "</span>" +
      "</div>"
    );
  };

  const renderChain = (c) =>
    '<div class="chain"><div class="chain-head">chain <b>' + esc(c.chainId) + "</b></div>" +
    c.tickets.map(renderTicket).join("") +
    "</div>";

  const render = (state) => {
    document.getElementById("dbpath").textContent = state.dbPath;
    document.getElementById("summary").innerHTML = Object.entries(state.summary)
      .map(([status, n]) => '<span class="chip">' + (STATUS_LABEL[status] ?? status) + ": <b>" + n + "</b></span>")
      .join("");
    document.getElementById("chains").innerHTML = state.chains.length
      ? state.chains.map(renderChain).join("")
      : '<p style="color:var(--text-dim)">No tickets loaded.</p>';
    document.getElementById("footer").textContent = "updated " + timeAgo(state.generatedAt);
  };

  const poll = () =>
    fetch("/api/state")
      .then((r) => r.json())
      .then(render)
      .catch(() => {
        document.getElementById("footer").textContent = "connection lost — retrying…";
      });

  poll();
  setInterval(poll, 1500);
</script>
</body>
</html>
`;

export interface DashboardServerOptions {
  readonly dbPath: string;
  readonly db: BoardDb;
}

/** Binds nothing itself — call `.listen(port, host)` on the returned server. */
export const createDashboardServer = (
  options: DashboardServerOptions,
): Server => {
  const { dbPath, db } = options;
  return createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (url === "/api/state") {
      const state = buildDashboardState(db, dbPath);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
};
