/**
 * A local web view over the board's SQLite state — the same data
 * `drover-board status` prints, laid out for a screen instead of a terminal,
 * plus a DAG view and a form to add new tickets.
 *
 * Deliberately no start/stop/retry/skip: nothing here can disturb a ticket
 * that already exists. The one write path — adding a brand-new ticket — is
 * additive only, so it's still safe to leave this open during a demo.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BoardDb } from "./db.js";
import { loadBoard } from "./load.js";
import type { Attempt, Ticket, TicketStatus } from "./types.js";

/** One board this dashboard instance can show — a name plus its already-open `BoardDb`. */
export interface DashboardRepo {
  readonly name: string;
  readonly dbPath: string;
  readonly db: BoardDb;
}

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

/** Same default `loadBoard` applies to a ticket with no explicit maxAttempts. */
const DEFAULT_MAX_ATTEMPTS = 3;

export interface AddTicketInput {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly deps: readonly string[];
  readonly completionSignal?: string;
  readonly maxIterations?: number;
}

export class AddTicketError extends Error {}

/**
 * Adds one new ticket. Two paths, chosen by `input.deps`:
 *
 * - No deps (or deps only satisfiable within this call — there are none,
 *   since this only ever adds one ticket at a time): becomes its own new
 *   chain via the normal `loadBoard` path.
 * - Deps on existing tickets: the new ticket must join those tickets'
 *   chain — deps never cross a chain boundary by construction (see
 *   chains.ts), so if the deps span more than one existing chain this
 *   throws rather than silently merging two chains' worth of persisted
 *   tickets, which is a bigger and riskier operation than a dashboard
 *   should do on a click.
 */
export const addTicketToBoard = (db: BoardDb, input: AddTicketInput): void => {
  const id = input.id.trim();
  const title = input.title.trim();
  const prompt = input.prompt.trim();

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new AddTicketError(
      "Ticket id must be lowercase letters, numbers, and dashes (not leading/trailing).",
    );
  }
  if (!title) throw new AddTicketError("Title is required.");
  if (!prompt) throw new AddTicketError("Prompt is required.");
  if (db.getTicket(id)) {
    throw new AddTicketError(`Ticket "${id}" already exists.`);
  }

  const maxIterations = input.maxIterations ?? 5;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new AddTicketError("Max iterations must be a positive integer.");
  }

  const completionSignal = input.completionSignal?.trim() || undefined;

  if (input.deps.length === 0) {
    loadBoard(db, [{ id, title, prompt, completionSignal, maxIterations }]);
    return;
  }

  const depTickets = input.deps.map((depId) => {
    const t = db.getTicket(depId);
    if (!t) throw new AddTicketError(`Unknown dependency ticket "${depId}".`);
    return t;
  });
  const chainIds = new Set(depTickets.map((t) => t.chainId));
  if (chainIds.size > 1) {
    throw new AddTicketError(
      `Dependencies span multiple chains (${[...chainIds].join(", ")}) — a new ticket can only extend one existing chain at a time.`,
    );
  }
  const chainId = depTickets[0]!.chainId!;
  const chainTickets = db.listTicketsByChain(chainId);
  const nextSeq = Math.max(...chainTickets.map((t) => t.seq ?? 0)) + 1;

  const { skipped } = db.upsertTickets([
    {
      id,
      title,
      prompt,
      deps: input.deps,
      mode: "auto",
      chainId,
      seq: nextSeq,
      maxIterations,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      completionSignal,
    },
  ]);
  if (skipped.length > 0) {
    throw new AddTicketError(`Ticket "${id}" could not be added.`);
  }
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
  .repo-tabs {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }
  .repo-tab {
    font-family: var(--mono);
    font-size: 0.78rem;
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    border: 1px solid var(--panel-border);
    background: var(--panel);
    color: var(--text-dim);
    cursor: pointer;
  }
  .repo-tab:hover { border-color: var(--accent); }
  .repo-tab.active { border-color: var(--accent); color: var(--accent); }
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
  .panel {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }
  .panel h2 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    margin: 0 0 0.75rem;
  }
  .dag-hint {
    font-size: 0.75rem;
    color: var(--text-dim);
    margin: -0.5rem 0 0.75rem;
  }
  #dag { display: block; overflow-x: auto; }
  .dag-node { cursor: pointer; }
  .dag-node:hover .dag-rect { stroke: var(--accent); }
  .dag-node-selected .dag-rect { stroke: var(--accent); stroke-width: 2.5px; }
  .dag-rect { fill: var(--bg); stroke: var(--panel-border); stroke-width: 1.5px; }
  .dag-rect.dag-status-done, .dag-rect.dag-status-done_no_commits { stroke: var(--done); }
  .dag-rect.dag-status-running { stroke: var(--running); }
  .dag-rect.dag-status-pending { stroke: var(--pending); }
  .dag-rect.dag-status-needs_attempt { stroke: var(--gate); }
  .dag-rect.dag-status-failed, .dag-rect.dag-status-interrupted { stroke: var(--failed); }
  .dag-label { fill: var(--text); font-size: 11px; font-family: -apple-system, sans-serif; }
  .dag-id { fill: var(--text-dim); font-size: 9px; font-family: var(--mono); }
  .dag-edge { fill: none; stroke: var(--panel-border); stroke-width: 1.5px; }
  .dag-arrowhead { fill: var(--panel-border); }
  .field { margin-bottom: 0.75rem; }
  .field label {
    display: block;
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-bottom: 0.25rem;
  }
  .field input, .field textarea {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.85rem;
    padding: 0.45rem 0.6rem;
  }
  .field textarea { font-family: var(--mono); font-size: 0.8rem; resize: vertical; }
  .deps-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--text-dim);
    min-height: 1.5rem;
  }
  .deps-chip {
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
  }
  button {
    background: var(--accent);
    color: #12100e;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    font-size: 0.85rem;
    padding: 0.5rem 1rem;
    cursor: pointer;
  }
  button:hover { opacity: 0.9; }
  #ntMessage { margin-top: 0.6rem; font-size: 0.8rem; font-family: var(--mono); }
  #ntMessage.error { color: var(--failed); }
  #ntMessage.success { color: var(--done); }
</style>
</head>
<body>
  <header>
    <h1>drover<span>::</span>board</h1>
    <div class="dbpath" id="dbpath"></div>
  </header>
  <div class="repo-tabs" id="repoTabs"></div>
  <div class="summary" id="summary"></div>

  <div class="panel">
    <h2>Dependency graph</h2>
    <div class="dag-hint">Click a ticket to toggle it as a dependency for the new ticket below.</div>
    <div id="dag"></div>
  </div>

  <div class="panel" id="newTicketPanel">
    <h2>New ticket</h2>
    <div class="field">
      <label for="ntTitle">Title</label>
      <input id="ntTitle" type="text" placeholder="e.g. Add rate limiting to the API" />
    </div>
    <div class="field">
      <label for="ntId">Id</label>
      <input id="ntId" type="text" placeholder="auto-generated from title" />
    </div>
    <div class="field">
      <label for="ntPrompt">Prompt</label>
      <textarea id="ntPrompt" rows="4" placeholder="Full instructions for the agent…"></textarea>
    </div>
    <div class="field">
      <label for="ntSignal">Completion signal (optional)</label>
      <input id="ntSignal" type="text" placeholder="TICKET_COMPLETE" />
    </div>
    <div class="field">
      <label for="ntMaxIter">Max iterations</label>
      <input id="ntMaxIter" type="number" min="1" value="5" />
    </div>
    <div class="field">
      <label>Depends on</label>
      <div class="deps-chips" id="ntDeps">(none selected)</div>
    </div>
    <button id="ntSubmit">Add ticket</button>
    <div id="ntMessage"></div>
  </div>

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

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const selectedDeps = new Set();

  const NODE_W = 168, NODE_H = 46, COL_GAP = 56, ROW_GAP = 14, CHAIN_GAP = 30, PAD = 12;

  const buildDagSvg = (chains) => {
    const nodePos = new Map();
    const nodesToDraw = [];
    let yCursor = PAD;
    let maxX = 0;

    for (const chain of chains) {
      const layers = new Map();
      for (const t of chain.tickets) {
        const seq = t.seq ?? 0;
        const arr = layers.get(seq) ?? [];
        arr.push(t);
        layers.set(seq, arr);
      }
      const seqs = [...layers.keys()].sort((a, b) => a - b);
      let chainRows = 0;
      for (const seq of seqs) {
        const rowTickets = layers.get(seq);
        chainRows = Math.max(chainRows, rowTickets.length);
        rowTickets.forEach((t, i) => {
          const x = PAD + seq * (NODE_W + COL_GAP);
          const y = yCursor + i * (NODE_H + ROW_GAP);
          nodePos.set(t.id, { x: x, y: y });
          nodesToDraw.push(t);
          maxX = Math.max(maxX, x + NODE_W);
        });
      }
      yCursor += chainRows * (NODE_H + ROW_GAP) + CHAIN_GAP;
    }

    const height = Math.max(yCursor, NODE_H + PAD * 2);
    const width = Math.max(maxX + PAD, 200);

    let edges = "";
    for (const t of nodesToDraw) {
      const to = nodePos.get(t.id);
      for (const depId of t.deps) {
        const from = nodePos.get(depId);
        if (!from || !to) continue;
        const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
        const x2 = to.x, y2 = to.y + NODE_H / 2;
        const midX = (x1 + x2) / 2;
        edges +=
          '<path d="M ' + x1 + " " + y1 + " C " + midX + " " + y1 + ", " + midX + " " + y2 + ", " + x2 + " " + y2 + '" class="dag-edge" marker-end="url(#dagArrow)"></path>';
      }
    }

    let nodes = "";
    for (const t of nodesToDraw) {
      const p = nodePos.get(t.id);
      const selected = selectedDeps.has(t.id) ? " dag-node-selected" : "";
      nodes +=
        '<g class="dag-node' + selected + '" data-id="' + esc(t.id) + '" transform="translate(' + p.x + "," + p.y + ')">' +
        '<rect class="dag-rect dag-status-' + t.status + '" width="' + NODE_W + '" height="' + NODE_H + '" rx="8"></rect>' +
        '<text class="dag-label" x="10" y="19">' + esc(truncate(t.title, 22)) + "</text>" +
        '<text class="dag-id" x="10" y="34">' + esc(t.id) + "</text>" +
        "</g>";
    }

    return (
      '<svg viewBox="0 0 ' + width + " " + height + '" width="100%" height="' + height + '" role="img" aria-label="Ticket dependency graph">' +
      '<defs><marker id="dagArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="dag-arrowhead"></path></marker></defs>' +
      edges +
      nodes +
      "</svg>"
    );
  };

  const renderDepsChips = () => {
    const el = document.getElementById("ntDeps");
    el.innerHTML = selectedDeps.size
      ? [...selectedDeps].map((id) => '<span class="deps-chip">' + esc(id) + "</span>").join("")
      : "(none selected)";
  };

  const renderDag = (chains) => {
    document.getElementById("dag").innerHTML = chains.length
      ? buildDagSvg(chains)
      : '<p style="color:var(--text-dim)">No tickets loaded.</p>';
    document.querySelectorAll(".dag-node").forEach((node) => {
      node.addEventListener("click", () => {
        const id = node.getAttribute("data-id");
        if (selectedDeps.has(id)) selectedDeps.delete(id);
        else selectedDeps.add(id);
        renderDag(chains);
        renderDepsChips();
      });
    });
  };

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

  let currentRepo = null;
  let repos = [];

  const render = (state) => {
    document.getElementById("dbpath").textContent = state.dbPath;
    document.getElementById("summary").innerHTML = Object.entries(state.summary)
      .map(([status, n]) => '<span class="chip">' + (STATUS_LABEL[status] ?? status) + ": <b>" + n + "</b></span>")
      .join("");
    document.getElementById("chains").innerHTML = state.chains.length
      ? state.chains.map(renderChain).join("")
      : '<p style="color:var(--text-dim)">No tickets loaded.</p>';
    document.getElementById("footer").textContent = "updated " + timeAgo(state.generatedAt);
    renderDag(state.chains);
  };

  const renderRepoTabs = () => {
    const el = document.getElementById("repoTabs");
    if (repos.length <= 1) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = repos
      .map(
        (r) =>
          '<span class="repo-tab' + (r.name === currentRepo ? " active" : "") + '" data-repo="' + esc(r.name) + '">' + esc(r.name) + "</span>",
      )
      .join("");
    el.querySelectorAll(".repo-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        currentRepo = tab.getAttribute("data-repo");
        selectedDeps.clear();
        renderRepoTabs();
        poll();
      });
    });
  };

  const poll = () =>
    fetch("/api/state?repo=" + encodeURIComponent(currentRepo ?? ""))
      .then((r) => r.json())
      .then(render)
      .catch(() => {
        document.getElementById("footer").textContent = "connection lost — retrying…";
      });

  const slugify = (s) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  let idManuallyEdited = false;
  document.getElementById("ntId").addEventListener("input", () => {
    idManuallyEdited = true;
  });
  document.getElementById("ntTitle").addEventListener("input", (e) => {
    if (!idManuallyEdited) document.getElementById("ntId").value = slugify(e.target.value);
  });

  const setNtMessage = (text, kind) => {
    const el = document.getElementById("ntMessage");
    el.textContent = text;
    el.className = kind || "";
  };

  document.getElementById("ntSubmit").addEventListener("click", () => {
    const body = {
      id: document.getElementById("ntId").value.trim(),
      title: document.getElementById("ntTitle").value.trim(),
      prompt: document.getElementById("ntPrompt").value.trim(),
      deps: [...selectedDeps],
      completionSignal: document.getElementById("ntSignal").value.trim() || undefined,
      maxIterations: Number(document.getElementById("ntMaxIter").value) || undefined,
    };
    fetch("/api/tickets?repo=" + encodeURIComponent(currentRepo ?? ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((json) => ({ ok: r.ok, json: json })))
      .then(({ ok, json }) => {
        if (!ok) {
          setNtMessage(json.error || "Could not add ticket.", "error");
          return;
        }
        setNtMessage('Added "' + body.id + '".', "success");
        document.getElementById("ntTitle").value = "";
        document.getElementById("ntId").value = "";
        document.getElementById("ntPrompt").value = "";
        document.getElementById("ntSignal").value = "";
        document.getElementById("ntMaxIter").value = "5";
        idManuallyEdited = false;
        selectedDeps.clear();
        renderDepsChips();
        poll();
      })
      .catch(() => setNtMessage("Request failed — is the dashboard server still running?", "error"));
  });

  renderDepsChips();
  fetch("/api/repos")
    .then((r) => r.json())
    .then((list) => {
      repos = list;
      currentRepo = list.length ? list[0].name : null;
      renderRepoTabs();
      poll();
      setInterval(poll, 1500);
    });
</script>
</body>
</html>
`;

export interface DashboardServerOptions {
  readonly repos: readonly DashboardRepo[];
}

const MAX_BODY_BYTES = 64 * 1024;

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const isAddTicketInput = (body: unknown): body is AddTicketInput => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.title === "string" &&
    typeof b.prompt === "string" &&
    (b.deps === undefined ||
      (Array.isArray(b.deps) && b.deps.every((d) => typeof d === "string")))
  );
};

/** Binds nothing itself — call `.listen(port, host)` on the returned server. */
export const createDashboardServer = (
  options: DashboardServerOptions,
): Server => {
  const reposByName = new Map(options.repos.map((r) => [r.name, r]));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && path === "/api/repos") {
      const list = options.repos.map((r) => ({
        name: r.name,
        dbPath: r.dbPath,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === "GET" && path === "/api/state") {
      const repoName = url.searchParams.get("repo") ?? options.repos[0]?.name;
      const repo = repoName ? reposByName.get(repoName) : undefined;
      if (!repo) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown repo "${repoName ?? ""}".` }));
        return;
      }
      const state = buildDashboardState(repo.db, repo.dbPath);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === "POST" && path === "/api/tickets") {
      const repoName = url.searchParams.get("repo") ?? options.repos[0]?.name;
      const repo = repoName ? reposByName.get(repoName) : undefined;
      if (!repo) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown repo "${repoName ?? ""}".` }));
        return;
      }
      readJsonBody(req)
        .then((body) => {
          if (!isAddTicketInput(body)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Malformed ticket payload." }));
            return;
          }
          addTicketToBoard(repo.db, { ...body, deps: body.deps ?? [] });
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: body.id }));
        })
        .catch((error: unknown) => {
          const message =
            error instanceof AddTicketError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Could not add ticket.";
          res.writeHead(error instanceof AddTicketError ? 400 : 500, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: message }));
        });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
};
