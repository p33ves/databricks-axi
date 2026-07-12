#!/usr/bin/env node
// Demo Arena: node:http server, 127.0.0.1-only, that runs one task three ways
// (raw databricks CLI / MCP / databricks-axi) via headless `claude -p` and
// streams condensed transcripts + a token/turn/duration comparison over SSE.
// See tools/arena/README.md for the full API/SSE contract.
//
// No new dependencies: node stdlib only. Never imports the gitignored bench
// harness (docs/superpowers/bench/) — the condition wiring and metric parse
// below are a trimmed reimplementation (spec §5.1).
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const SKILL_MD_PATH = join(REPO_ROOT, "skills", "databricks-axi", "SKILL.md");
const RESULTS_DIR = join(HERE, "results");
const RESULTS_FILE = join(RESULTS_DIR, "runs.jsonl");

const ARENA_MAX_TURNS = Number(process.env.ARENA_MAX_TURNS || 20);
const ARENA_MODEL = process.env.ARENA_MODEL || null;
const ARENA_TIMEOUT_MS = Number(process.env.ARENA_TIMEOUT_MS || 5 * 60_000);
const ARENA_MCP_CONFIG = process.env.ARENA_MCP_CONFIG || null;
// ponytail: not spec-named/env-configurable — preflight checks are quick
// status probes, not the task run, so a short hardcoded cap is enough.
const PREFLIGHT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for the hermetic self-check, parse.test.mjs). None
// of these spawn a process or touch the network.
// ---------------------------------------------------------------------------

// Condense a single stream-json event into zero or more human-readable
// lines. Same shape as the bench harness's condense() (reworded, spec §5.1),
// but operates per-event so the server can push each line to the browser as
// it arrives instead of waiting for the whole transcript.
export function condenseEvent(ev) {
  const out = [];
  const content = ev?.message?.content;
  if (!Array.isArray(content)) return out;
  for (const item of content) {
    if (ev.type === "assistant" && item.type === "text" && item.text?.trim()) {
      out.push(`ASSISTANT: ${item.text.trim()}`);
    } else if (ev.type === "assistant" && item.type === "tool_use") {
      const input = item.input?.command ?? JSON.stringify(item.input);
      out.push(`TOOL ${item.name}: ${input}`);
    } else if (ev.type === "user" && item.type === "tool_result") {
      let text;
      if (Array.isArray(item.content)) {
        // ToolSearch returns `tool_reference` items (no `.text`) — surfacing
        // only `.text` left the first MCP result rendering blank. Fall back
        // to the tool name so the reference list is visible.
        const parts = item.content
          .map((c) =>
            typeof c.text === "string"
              ? c.text
              : c.type === "tool_reference"
                ? c.tool_name
                : "",
          )
          .filter(Boolean);
        text = item.content.every((c) => c.type === "tool_reference")
          ? `matched tools: ${parts.join(", ")}`
          : parts.join("\n");
      } else {
        text = String(item.content ?? "");
      }
      if (text.length > 1500) text = text.slice(0, 1500) + "\n[...truncated]";
      out.push(`RESULT: ${text}`);
    }
  }
  return out;
}

// Condense a whole array of raw stream-json lines (used by the self-check
// and available for any offline/whole-transcript need); the live server path
// calls condenseEvent() per line instead.
export function condense(streamLines) {
  const out = [];
  for (const line of streamLines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    out.push(...condenseEvent(ev));
  }
  return out;
}

// Extract the metric fields (spec §6) from an array of raw stream-json
// lines by locating the final `result` event. Returns nulls for any field
// the event didn't carry (e.g. a killed/errored child with no result event).
export function parseResultEvent(streamLines) {
  let resultEv = null;
  for (const line of streamLines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === "result") resultEv = ev;
  }
  const usage = resultEv?.usage ?? {};
  return {
    num_turns: resultEv?.num_turns ?? null,
    tokens_in: usage.input_tokens ?? null,
    tokens_cache_create: usage.cache_creation_input_tokens ?? null,
    tokens_cache_read: usage.cache_read_input_tokens ?? null,
    tokens_out: usage.output_tokens ?? null,
    cost_usd: resultEv?.total_cost_usd ?? null,
    is_error: resultEv?.is_error ?? null,
  };
}

// Build the one JSONL row persisted per run (spec §6). No host, no token —
// `task` is the only free-text field. Enforced by whitelist: free-text
// diagnostics (`error_line`, `error`) and UI-only flags stay SSE-only —
// upstream CLI stderr can end with a "Host: https://..." trailer, and the
// spec promises this file never carries a hostname or transcript text.
const PERSISTED_KEYS = [
  "exit",
  "wall_s",
  "num_turns",
  "tokens_in",
  "tokens_cache_create",
  "tokens_cache_read",
  "tokens_out",
  "cost_usd",
  "is_error",
];
export function buildResultRow(task, conditionMetrics) {
  const conditions = {};
  for (const [id, m] of Object.entries(conditionMetrics)) {
    conditions[id] = Object.fromEntries(
      PERSISTED_KEYS.map((k) => [k, m?.[k] ?? null]),
    );
  }
  return {
    ts: new Date().toISOString(),
    task,
    conditions,
  };
}

// Pick the comparison highlight (lowest tokens / lowest turns), skipping any
// condition that errored or never produced a result event.
export function buildComparison(conditionMetrics) {
  // Input-token total (in + cache create + cache read) — the same formula
  // the page's "Input tokens" column uses, so the lowest badge always lands
  // on the smallest displayed number.
  const totalTokens = (m) =>
    (m.tokens_in ?? 0) +
    (m.tokens_cache_create ?? 0) +
    (m.tokens_cache_read ?? 0);
  const candidates = Object.entries(conditionMetrics).filter(
    ([, m]) => m && m.is_error !== true && m.exit === 0,
  );
  const lowestTokens = candidates.length
    ? candidates.reduce((a, b) =>
        totalTokens(b[1]) < totalTokens(a[1]) ? b : a,
      )[0]
    : null;
  const lowestTurns = candidates.length
    ? candidates.reduce((a, b) =>
        (b[1].num_turns ?? Infinity) < (a[1].num_turns ?? Infinity) ? b : a,
      )[0]
    : null;
  return {
    conditions: conditionMetrics,
    lowest_tokens: lowestTokens,
    lowest_turns: lowestTurns,
  };
}

// ---------------------------------------------------------------------------
// The three condition definitions (spec §5). CLAUDE.md strings are
// structurally parallel (implementer note d) — identical boilerplate,
// differing only in the named tool/surface.
// ---------------------------------------------------------------------------

const CONDITION_ORDER = ["raw-cli", "mcp", "databricks-axi"];

function claudeMdFor(id, mcpName) {
  const header = "For all Databricks operations use ONLY";
  const footer = "\n\nWhen done, state your final answer plainly.\n";
  switch (id) {
    case "raw-cli":
      return (
        `${header} the official \`databricks\` CLI (already on PATH and ` +
        "authenticated). Do NOT use any other Databricks tool. Prefer " +
        `\`-o json\` output.${footer}`
      );
    case "databricks-axi": {
      const skillMd = readFileSync(SKILL_MD_PATH, "utf8");
      return (
        `${header} the \`databricks-axi\` command (already on PATH and ` +
        "authenticated). Do NOT use the raw `databricks` CLI, the REST API " +
        "directly, or any other Databricks tool. Its skill (usage below) is " +
        `already preloaded into your context — use it directly.\n\n${skillMd}${footer}`
      );
    }
    case "mcp":
      return (
        `${header} the tools of the configured \`${mcpName}\` MCP server ` +
        "(already authenticated). Do NOT use any CLI, the REST API " +
        `directly, or any other Databricks tool.${footer}`
      );
    default:
      throw new Error(`unknown condition ${id}`);
  }
}

function allowedToolsFor(id, mcpName) {
  if (id === "mcp") return `Read,mcp__${mcpName}`;
  return "Bash,Read";
}

// ---------------------------------------------------------------------------
// Process spawning. Every spawn (preflight and child run alike) uses
// stdin:"ignore" and a hard timeout — no interactive prompt ever hangs the
// demo (AGENTS.md sharp edge; spec §7 C3).
// ---------------------------------------------------------------------------

function spawnCapture(cmd, args, { timeoutMs, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out, err, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Preflight (spec §7). Checks only — never touches credentials.
// ---------------------------------------------------------------------------

async function checkDatabricks() {
  const r = await spawnCapture("databricks", [
    "auth",
    "describe",
    "-o",
    "json",
  ]);
  if (r.code !== 0) {
    return { ok: false, reason: "not authed — run `databricks auth login`" };
  }
  try {
    const parsed = JSON.parse(r.out);
    if (parsed?.details?.host) return { ok: true }; // host itself is never surfaced
  } catch {
    // fall through
  }
  return { ok: false, reason: "not authed — run `databricks auth login`" };
}

async function checkClaude() {
  const r = await spawnCapture("claude", ["--version"]);
  if (r.code !== 0) {
    return { ok: false, reason: "claude CLI not found — install Claude Code" };
  }
  return { ok: true, version: r.out.trim() };
}

async function checkAxi() {
  const onPath = await spawnCapture("databricks-axi", ["--version"]);
  if (onPath.code === 0) return { ok: true, mode: "path" };
  const fallback = join(REPO_ROOT, "dist", "bin", "databricks-axi.js");
  if (existsSync(fallback))
    return { ok: true, mode: "fallback", fallbackPath: fallback };
  return {
    ok: false,
    reason:
      "not built — run `pnpm run build`, or install databricks-axi globally",
  };
}

async function checkMcp() {
  if (ARENA_MCP_CONFIG) {
    return { ok: true, name: "databricks", mode: "scoped" };
  }
  const r = await spawnCapture("claude", ["mcp", "list"]);
  const configured = r.out
    .split("\n")
    .some((line) => /^databricks:/.test(line));
  if (configured) return { ok: true, name: "databricks", mode: "inherit" };
  return {
    ok: false,
    reason:
      'no "databricks" MCP server configured — run `claude mcp add databricks ...`, ' +
      "or set ARENA_MCP_CONFIG to a scoped mcp.json",
  };
}

async function runPreflight() {
  const [databricks, claude, axi, mcp] = await Promise.all([
    checkDatabricks(),
    checkClaude(),
    checkAxi(),
    checkMcp(),
  ]);
  return { databricks, claude, axi, mcp };
}

// GET /profiles: name + host only, from the databricks CLI's own profile
// list (~/.databrickscfg) — never a token or any other config value.
async function listProfiles() {
  const r = await spawnCapture("databricks", [
    "auth",
    "profiles",
    "-o",
    "json",
  ]);
  try {
    const parsed = JSON.parse(r.out);
    return (parsed?.profiles ?? []).map((p) => ({
      name: p.name,
      host: p.host,
    }));
  } catch {
    return [];
  }
}

// Resolves the effective host for a run (default profile, or the one the
// viewer picked) so the UI can render an "open workspace" link. Reuses the
// same non-interactive `auth describe` preflight already runs — unlike that
// check, the host IS surfaced here (a URL, not a secret), by explicit design.
async function resolveHost(profile) {
  const args = ["auth", "describe", "-o", "json"];
  if (profile) args.push("-p", profile);
  const r = await spawnCapture("databricks", args);
  try {
    return JSON.parse(r.out)?.details?.host ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Child run per condition.
// ---------------------------------------------------------------------------

// Real `databricks-axi` on PATH needs no PATH change. The dist/bin fallback
// is a bare .js file (no bin shim outside a real install), so the child's
// Bash tool wouldn't find a plain `databricks-axi` command on PATH — shim it
// with a symlink under a throwaway dir instead of requiring a global install.
// ponytail: symlink shim, only exercised when the repo isn't installed/linked.
function axiPathPrefix(axiStatus) {
  if (axiStatus.mode !== "fallback") return null;
  const dir = mkdtempSync(join(tmpdir(), "arena-axi-bin-"));
  symlinkSync(axiStatus.fallbackPath, join(dir, "databricks-axi"));
  return dir;
}

function conditionArgv(id, task, mcpName, model) {
  const argv = [
    "-p",
    task,
    "--output-format",
    "stream-json",
    "--verbose",
    "--disallowedTools",
    "WebSearch,WebFetch,Task,TodoWrite",
    "--allowedTools",
    allowedToolsFor(id, mcpName),
    "--max-turns",
    String(ARENA_MAX_TURNS),
  ];
  // Per-run model (from the page dropdown) wins over the ARENA_MODEL env
  // default; both panes share whichever is chosen so the comparison is fair.
  const chosen = model || ARENA_MODEL;
  if (chosen) argv.push("--model", chosen);
  if (id === "mcp" && ARENA_MCP_CONFIG) {
    argv.push("--strict-mcp-config", "--mcp-config", ARENA_MCP_CONFIG);
  }
  return argv;
}

// Runs one condition's `claude -p` child, forwarding condensed transcript
// lines to onLine as they arrive. Resolves with the metrics for the
// comparison row/results JSONL.
async function runCondition(
  id,
  task,
  { mcpName, axiStatus, profile, model },
  onLine,
) {
  const cwd = mkdtempSync(join(tmpdir(), `arena-${id}-`));
  let pathPrefix = null;
  try {
    const claudeMd = claudeMdFor(id, mcpName);
    writeFileSync(join(cwd, "CLAUDE.md"), claudeMd);

    const env = { ...process.env };
    if (id === "databricks-axi") {
      pathPrefix = axiPathPrefix(axiStatus);
      if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH}`;
    }
    // Selects the profile every condition's tool calls resolve against
    // (official CLI and databricks-axi both honor this env var as their
    // default `-p`); best-effort for the mcp condition, whose server is
    // configured independently of any CLI profile.
    if (profile) env.DATABRICKS_CONFIG_PROFILE = profile;

    const argv = conditionArgv(id, task, mcpName, model);
    const rawLines = [];
    const started = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn("claude", argv, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let lastErrLine = "";
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        rawLines.push(line);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        for (const text of condenseEvent(ev)) onLine(text);
      });
      child.stderr.on("data", (d) => {
        lastErrLine = d.toString().trim().split("\n").pop() || lastErrLine;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), ARENA_TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, lastErrLine });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, lastErrLine: String(e.message ?? e) });
      });
    });
    const wallS = Math.round((Date.now() - started) / 1000);
    const parsed = parseResultEvent(rawLines);
    const metrics = {
      exit: result.code,
      wall_s: wallS,
      ...parsed,
      // A killed/timed-out/crashed child emits no result event: is_error
      // stays null there unless we fall back to the exit code, and a
      // force-killed condition must never render as a fast, cheap success.
      is_error: parsed.is_error ?? result.code !== 0,
      error_line: result.code === 0 ? null : result.lastErrLine || null,
    };
    return metrics;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (pathPrefix) rmSync(pathPrefix, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP server: routes, SSE, safety guards (spec §7).
// ---------------------------------------------------------------------------

const NONCE = randomBytes(16).toString("hex");
const runs = new Map(); // runId -> { subscribers: Set<res>, buffer: [] }

function sseSend(res, event, id) {
  res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
}

function broadcast(run, event) {
  run.buffer.push(event);
  for (const res of run.subscribers) sseSend(res, event, run.buffer.length - 1);
}

// Shared teardown for success and failure: end every stream exactly once,
// then evict the run after a grace window so a reload can still replay it,
// but a long-lived server does not grow without bound.
const RUN_EVICT_MS = 10 * 60 * 1000;
function finishRun(runId, run) {
  for (const res of run.subscribers) res.end();
  run.subscribers.clear();
  run.finished = true;
  setTimeout(() => runs.delete(runId), RUN_EVICT_MS).unref();
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function startRun(task, profile, model) {
  const runId = randomUUID();
  const run = { subscribers: new Set(), buffer: [], task };
  runs.set(runId, run);

  // Per-run random order: a fixed order would let the last condition ride
  // any cross-session warmup or cache advantage on every single run.
  const order = [...CONDITION_ORDER].sort(() => Math.random() - 0.5);

  (async () => {
    const host = await resolveHost(profile);
    broadcast(run, {
      pane: null,
      kind: "started",
      profile: profile ?? "default",
      host, // a URL, not a secret — surfaced so the UI can link "open workspace"
      order,
    });
    const preflight = await runPreflight();
    const mcpName = preflight.mcp.name ?? "databricks";
    const metrics = {};
    for (const id of order) {
      const status = {
        "raw-cli": preflight.databricks,
        mcp: preflight.mcp,
        "databricks-axi": preflight.axi,
      }[id];
      if (!status.ok) {
        broadcast(run, { pane: id, kind: "error", reason: status.reason });
        metrics[id] = { exit: null, wall_s: 0, is_error: true, disabled: true };
        continue;
      }
      try {
        const m = await runCondition(
          id,
          task,
          { mcpName, axiStatus: preflight.axi, profile, model },
          (text) => broadcast(run, { pane: id, kind: "line", text }),
        );
        metrics[id] = m;
        broadcast(run, { pane: id, kind: "done", metrics: m });
      } catch (e) {
        const reason = String(e?.message ?? e);
        broadcast(run, { pane: id, kind: "error", reason });
        metrics[id] = { exit: null, wall_s: 0, is_error: true, error: reason };
      }
    }
    const row = buildResultRow(task, metrics);
    try {
      mkdirSync(RESULTS_DIR, { recursive: true });
      appendFileSync(RESULTS_FILE, JSON.stringify(row) + "\n");
    } catch {
      // best-effort persistence; never fail the run over a disk write
    }
    broadcast(run, {
      pane: null,
      kind: "comparison",
      ...buildComparison(metrics),
    });
    finishRun(runId, run);
  })().catch((e) => {
    broadcast(run, {
      pane: null,
      kind: "error",
      reason: String(e?.message ?? e),
    });
    finishRun(runId, run);
  });

  return runId;
}

function handleEvents(req, res, runId) {
  const run = runs.get(runId);
  if (!run) {
    jsonResponse(res, 404, { error: "unknown runId" });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // On EventSource auto-reconnect, replay only what the client missed.
  const lastSeen = Number.parseInt(req.headers["last-event-id"] ?? "", 10);
  const from = Number.isNaN(lastSeen) ? 0 : lastSeen + 1;
  for (let i = from; i < run.buffer.length; i++) sseSend(res, run.buffer[i], i);
  if (run.finished) {
    res.end();
    return;
  }
  run.subscribers.add(res);
  req.on("close", () => run.subscribers.delete(res));
}

function indexHtml() {
  const html = readFileSync(join(HERE, "index.html"), "utf8");
  return html.replace(/%%ARENA_NONCE%%/g, NONCE);
}

function isSameOrigin(req, port) {
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin") return false;
  if (origin && origin !== `http://127.0.0.1:${port}`) return false;
  return true;
}

export function createArenaServer() {
  let port = 0; // set once listen() resolves the ephemeral port

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: loopback bind alone isn't enough — a page open in
    // the viewer's browser could still POST to a hostname that resolves to
    // 127.0.0.1. Reject any request whose Host header isn't our own loopback
    // address (spec §7).
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}`) {
      jsonResponse(res, 403, { error: "bad host header" });
      return;
    }

    const url = new URL(req.url, `http://${host}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = indexHtml();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/preflight") {
      jsonResponse(res, 200, await runPreflight());
      return;
    }

    if (req.method === "GET" && url.pathname === "/profiles") {
      jsonResponse(res, 200, { profiles: await listProfiles() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (!isSameOrigin(req, port)) {
        jsonResponse(res, 403, { error: "cross-origin request rejected" });
        return;
      }
      if (req.headers["x-arena-nonce"] !== NONCE) {
        jsonResponse(res, 403, { error: "bad nonce" });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
        return;
      }
      // `null`/`"x"` are valid JSON: reading .task off them must be a 400,
      // never an unhandled throw that takes the whole server down.
      if (typeof body !== "object" || body === null) {
        jsonResponse(res, 400, { error: "invalid JSON body" });
        return;
      }
      const task = typeof body.task === "string" ? body.task.trim() : "";
      if (!task) {
        jsonResponse(res, 400, { error: "task is required" });
        return;
      }
      const profile =
        typeof body.profile === "string" && body.profile.trim()
          ? body.profile.trim()
          : null;
      // Model id is agent-facing config, not a shell/path value, but keep it
      // to a conservative charset so nothing odd reaches the child argv.
      const model =
        typeof body.model === "string" && /^[\w.:-]{1,64}$/.test(body.model)
          ? body.model
          : null;
      const runId = await startRun(task, profile, model);
      jsonResponse(res, 200, { runId });
      return;
    }

    const eventsMatch = /^\/events\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && eventsMatch) {
      // runId is only ever used as a Map key below — never joined into a
      // filesystem path (implementer note f).
      handleEvents(req, res, eventsMatch[1]);
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  });

  server.on("listening", () => {
    port = server.address().port;
  });

  return server;
}

// Only start the server when run directly (`node tools/arena/server.mjs`),
// never as a side effect of the hermetic self-check importing this module.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = createArenaServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    console.log(`Demo Arena running at http://127.0.0.1:${port}`);
    console.log(
      "A run costs real claude -p tokens and touches your workspace.",
    );
  });
}
