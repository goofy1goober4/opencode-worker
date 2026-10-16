// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0), no dependencies.
// Async job model so long worker runs never hit client request timeouts.
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runWorker, killTree, alive, ROLES, DEFAULTS } from "./worker.mjs";

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

// The recorded pid is ours only if it is still that opencode binary (guards against pid reuse).
function isOurWorker(record) {
  if (!record.workerPid || !record.workerBin || !alive(record.workerPid)) return false;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(record.workerPid)], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes(record.workerBin);
}

function load(jobId) {
  if (!UUID.test(jobId ?? "")) return null;
  const live = jobs.get(jobId);
  if (live) return live.record;
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, `${jobId}.json`), "utf8")); } catch { return null; }
  // Owner server died mid-run: the worker either still runs unattended (orphaned) or is gone (lost).
  if (record.status === "running" && !alive(record.serverPid)) record.status = isOurWorker(record) ? "orphaned" : "lost";
  return record;
}

async function killOrphan(record) {
  await killTree(record.workerPid);
  Object.assign(record, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    error: { type: "orphan_killed", detail: `worker pid ${record.workerPid} outlived its server and was stopped; partial logs in ${record.runDir}` },
  });
  save(record);
}

const runSchema = {
  type: "object",
  properties: {
    dir: { type: "string", description: "Absolute working directory; the worker is confined to it" },
    prompt: { type: "string", description: "Task for the OpenCode worker" },
    model: { type: "string", description: `default ${DEFAULTS.model}` },
    variant: { type: "string", description: "Reasoning effort: none | low | high | max (model-defined set; default low)" },
    role: {
      type: "string",
      enum: Object.keys(ROLES),
      description: "implementer (default): edit + bash. tester: bash, no edits. reviewer: read/search only; several reviewers may share a dir. Only one implementer/tester job per dir at a time.",
    },
    agent: { type: "string", description: `default ${DEFAULTS.agent}` },
    timeoutSec: { type: "number", description: "Optional job time limit in seconds. Default: $OPENCODE_WORKER_TIMEOUT_SEC if set, else no limit (runs until done or worker_cancel)." },
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
  { name: "worker_status", description: "Get job status without waiting: running | done | failed | cancelled | orphaned (its server died but the worker still runs; stop it with worker_cancel) | lost (server and worker both gone). Works across server restarts.", inputSchema: idSchema },
  { name: "worker_result", description: "Get the JSON result (diff, tool outputs, cost, tokens, actual model) of a finished job. Works across server restarts.", inputSchema: idSchema },
  { name: "worker_cancel", description: "Stop a running job (SIGTERM, then SIGKILL, to the worker's whole process group). Also stops orphaned jobs left by a crashed server.", inputSchema: idSchema },
];

function resultOf(job) {
  if (job.status === "running") return textResult({ jobId: job.jobId, status: "running" }, true);
  if (job.status === "lost") return textResult({ jobId: job.jobId, status: "lost", ok: false, errors: [{ type: "lost", detail: `server and worker exited before the job finished; partial logs in ${job.runDir ?? "<dir>/.opencode-worker/runs"}` }] }, true);
  if (job.status === "orphaned") return textResult({ jobId: job.jobId, status: "orphaned", ok: false, workerPid: job.workerPid, errors: [{ type: "orphaned", detail: `server died; worker pid ${job.workerPid} still runs but its result can no longer be collected. Call worker_cancel to stop it. Partial logs in ${job.runDir}` }] }, true);
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
    let spawned;
    const started = new Promise((r) => { spawned = r; });
    const onSpawn = ({ pid, bin, runDir }) => { Object.assign(record, { workerPid: pid, workerBin: bin, runDir }); save(record); spawned(); };
    const done = runWorker({ ...args, opencodeBin: opts.opencodeBin, signal: controller.signal, onSpawn }).then(
      (r) => { record.result = r; record.status = r.errors.some((e) => e.type === "cancelled") ? "cancelled" : r.ok ? "done" : "failed"; },
      (e) => { record.error = { type: e.code ?? "SETUP_ERROR", detail: e.message }; record.status = "failed"; },
    ).then(() => {
      record.finishedAt = new Date().toISOString();
      save(record);
      jobs.delete(record.jobId);
    });
    jobs.set(record.jobId, { record, controller, done });
    // Setup failures (bad variant, DIR_BUSY, missing binary) surface here instead of on the first wait.
    await Promise.race([started, done]);
    if (record.status === "failed" && record.error)
      return textResult({ jobId: record.jobId, status: "failed", ok: false, errors: [record.error] }, true);
    return textResult({ jobId: record.jobId, status: "running" });
  }
  if (name === "worker_wait") return waitFor(args?.jobId, args?.timeoutSec);
  const job = load(args?.jobId);
  if (!job) return textResult({ error: "unknown jobId" }, true);
  const { jobId, status, startedAt, finishedAt, dir, workerPid } = job;
  if (name === "worker_status") return textResult({ jobId, status, startedAt, finishedAt, dir, workerPid });
  if (name === "worker_result") return resultOf(job);
  if (name === "worker_cancel") {
    const live = jobs.get(jobId);
    if (live) {
      live.controller.abort();
      return textResult({ jobId, cancelRequested: true, status });
    }
    if (status === "orphaned") {
      await killOrphan(job);
      return textResult({ jobId, cancelRequested: true, status: job.status, killedPid: workerPid });
    }
    return textResult({ jobId, cancelRequested: false, status });
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
