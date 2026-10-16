// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0), no dependencies.
// Async job model so long worker runs never hit client request timeouts.
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runWorker, DEFAULTS } from "./worker.mjs";

const PROTOCOL = "2025-06-18";
const jobs = new Map(); // live jobs of this server: id -> { record, controller, done }
const JOBS_DIR = process.env.OPENCODE_WORKER_STATE_DIR
  ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "opencode-worker", "jobs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Job records are persisted so results survive server/client restarts.
function save(record) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const file = path.join(JOBS_DIR, `${record.jobId}.json`);
  fs.writeFileSync(file + ".tmp", JSON.stringify(record, null, 2));
  fs.renameSync(file + ".tmp", file);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function load(jobId) {
  if (!UUID.test(jobId ?? "")) return null;
  const live = jobs.get(jobId);
  if (live) return live.record;
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, `${jobId}.json`), "utf8")); } catch { return null; }
  // Owned by a server that died mid-run: the outcome is unknown.
  if (record.status === "running" && !alive(record.serverPid)) record.status = "lost";
  return record;
}

const runSchema = {
  type: "object",
  properties: {
    dir: { type: "string", description: "Absolute working directory; the worker is confined to it" },
    prompt: { type: "string", description: "Task for the OpenCode worker" },
    model: { type: "string", description: `default ${DEFAULTS.model}` },
    variant: { type: "string", description: `default ${DEFAULTS.variant}` },
    agent: { type: "string", description: `default ${DEFAULTS.agent}` },
    timeoutSec: { type: "number", description: `default ${DEFAULTS.timeoutSec}` },
  },
  required: ["dir", "prompt"],
};
const idSchema = { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] };
const WAIT_DEFAULT_SEC = 50; // under common 60 s client tool timeouts (e.g. Codex)
const WAIT_MAX_SEC = 120;
const waitSchema = {
  type: "object",
  properties: {
    jobId: { type: "string" },
    timeoutSec: { type: "number", description: `Max seconds to block (default ${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC})` },
  },
  required: ["jobId"],
};

const TOOLS = [
  { name: "worker_start", description: "Start an isolated OpenCode worker job (free model by default). Returns jobId immediately. Then call worker_wait.", inputSchema: runSchema },
  { name: "worker_wait", description: "Block until the job finishes or timeoutSec elapses. Finished: returns the full result (same as worker_result). Still running: returns {status: \"running\"}; call worker_wait again. Prefer this over polling worker_status.", inputSchema: waitSchema },
  { name: "worker_status", description: "Get job status without waiting: running | done | failed | cancelled | lost (server died mid-run). Works across server restarts.", inputSchema: idSchema },
  { name: "worker_result", description: "Get the JSON result (diff, tool outputs, cost, tokens, actual model) of a finished job. Works across server restarts.", inputSchema: idSchema },
  { name: "worker_cancel", description: "Cancel a running job owned by this server (SIGTERM, then SIGKILL).", inputSchema: idSchema },
];

function resultOf(job) {
  if (job.status === "running") return textResult({ jobId: job.jobId, status: "running" }, true);
  if (job.status === "lost") return textResult({ ok: false, errors: [{ type: "lost", detail: "server exited before the job finished; inspect <dir>/.opencode-worker/runs" }] }, true);
  return textResult({ jobId: job.jobId, status: job.status, ...(job.result ?? { ok: false, errors: [job.error] }) }, !job.result?.ok);
}

async function waitFor(jobId, timeoutSec) {
  const sec = Math.min(Math.max(Number(timeoutSec) || WAIT_DEFAULT_SEC, 1), WAIT_MAX_SEC);
  const deadline = Date.now() + sec * 1000;
  const live = jobs.get(jobId);
  if (live) await Promise.race([live.done, new Promise((r) => setTimeout(r, sec * 1000).unref())]);
  // Jobs owned by another server process: watch the persisted record.
  let job = load(jobId);
  while (job?.status === "running" && !live && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    job = load(jobId);
  }
  if (!job) return textResult({ error: "unknown jobId" }, true);
  if (job.status === "running") return textResult({ jobId, status: "running", waitedSec: sec, hint: "call worker_wait again" });
  return resultOf(job);
}

function textResult(obj, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError };
}

async function callTool(name, args, opts) {
  if (name === "worker_start") {
    const record = {
      jobId: randomUUID(), status: "running", serverPid: process.pid,
      dir: args.dir, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
    };
    const controller = new AbortController();
    save(record);
    const done = runWorker({ ...args, opencodeBin: opts.opencodeBin, signal: controller.signal }).then(
      (r) => { record.result = r; record.status = r.errors.some((e) => e.type === "cancelled") ? "cancelled" : r.ok ? "done" : "failed"; },
      (e) => { record.error = { type: e.code ?? "SETUP_ERROR", detail: e.message }; record.status = "failed"; },
    ).then(() => {
      record.finishedAt = new Date().toISOString();
      save(record);
      jobs.delete(record.jobId);
    });
    jobs.set(record.jobId, { record, controller, done });
    return textResult({ jobId: record.jobId, status: "running" });
  }
  if (name === "worker_wait") return waitFor(args?.jobId, args?.timeoutSec);
  const job = load(args?.jobId);
  if (!job) return textResult({ error: "unknown jobId" }, true);
  const { jobId, status, startedAt, finishedAt, dir } = job;
  if (name === "worker_status") return textResult({ jobId, status, startedAt, finishedAt, dir });
  if (name === "worker_result") return resultOf(job);
  if (name === "worker_cancel") {
    const live = jobs.get(jobId);
    live?.controller.abort();
    return textResult({ jobId, cancelRequested: Boolean(live), status });
  }
  return null;
}

async function shutdown(code) {
  const live = [...jobs.values()];
  for (const j of live) j.controller.abort();
  await Promise.allSettled(live.map((j) => j.done));
  process.exit(code);
}

export function serveMcp(opts = {}) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    const reply = (result) => send({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize")
      return reply({ protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "opencode-worker", version: VERSION } });
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS });
    if (method === "tools/call") {
      return callTool(params?.name, params?.arguments ?? {}, opts).then(
        (r) => (r ? reply(r) : fail(-32602, `unknown tool: ${params?.name}`)),
        (e) => fail(-32603, e.message),
      );
    }
    fail(-32601, `method not found: ${method}`);
  });
  rl.on("close", () => shutdown(0));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));
}
