import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const DEFAULTS = {
  model: "opencode/deepseek-v4.1-flash-free",
  variant: "low",
  agent: "build",
  timeoutSec: null, // no job time limit by default; stop via cancel or session close
  providers: ["opencode"],
};
const STATE_DIR = ".opencode-worker";
const HARD_DEADLINE_WRAPPER = ["/usr/bin/perl", "/bin/perl"].find((p) => fs.existsSync(p)) ?? null;
const TOOL_OUTPUT_MAX = 4000;

export class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function resolveOpencodeBin(explicit) {
  const sources = [
    ["--opencode-bin", explicit],
    ["OPENCODE_WORKER_BIN", process.env.OPENCODE_WORKER_BIN],
  ];
  for (const [name, value] of sources) {
    if (value === undefined || value === null) continue;
    // A set-but-empty value is almost always an unexpanded shell variable; never fall back to PATH silently.
    if (value.trim() === "") throw new WorkerError("BIN_EMPTY", `${name} is set but empty; give the absolute path to the opencode binary`);
    if (!fs.existsSync(value)) throw new WorkerError("BIN_NOT_FOUND", `opencode binary not found at ${name}=${value}`);
    return path.resolve(value);
  }
  const which = spawnSync("/usr/bin/env", ["which", "opencode"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new WorkerError("BIN_NOT_FOUND", "opencode not found on PATH (set OPENCODE_WORKER_BIN or --opencode-bin)");
}

function opencodeVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH } });
  if (r.status !== 0) throw new WorkerError("BIN_BROKEN", `opencode --version failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

/** Isolated environment: nothing from the parent except PATH and locale. No credentials or API keys. */
function isolatedEnv(stateRoot, configPath) {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: path.join(stateRoot, "home"),
    XDG_CONFIG_HOME: path.join(stateRoot, "xdg/config"),
    XDG_DATA_HOME: path.join(stateRoot, "xdg/data"),
    XDG_CACHE_HOME: path.join(stateRoot, "xdg/cache"),
    XDG_STATE_HOME: path.join(stateRoot, "xdg/state"),
    OPENCODE_CONFIG: configPath,
    // Without these, an opencode.json / .opencode/ in the task dir is merged in
    // (agents, providers, MCP, plugins) and can override our free-only config.
    OPENCODE_CONFIG_DIR: path.join(stateRoot, "xdg/config/opencode"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    TERM: "dumb",
  };
  for (const k of ["LANG", "LC_ALL", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k];
  for (const k of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"])
    fs.mkdirSync(env[k], { recursive: true });
  return env;
}

// Default-deny: tools added later by OpenCode, plugins or MCP never become available implicitly.
export const ALLOWED_TOOLS = ["read", "list", "glob", "grep", "edit", "bash", "todowrite", "todoread"];
const NO_REASONING_VARIANT = "none";
const variantCache = new Map();

/** Variants OpenCode defines for the model, plus our "none" (reasoning off). */
function modelVariants(bin, env, model) {
  if (variantCache.has(model)) return variantCache.get(model);
  const [provider] = model.split("/");
  const r = spawnSync(bin, ["models", provider, "--verbose"], { encoding: "utf8", env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  const at = r.stdout?.indexOf(`${model}\n{`) ?? -1;
  if (r.status !== 0 || at < 0) throw new WorkerError("MODEL_NOT_FOUND", `model ${model} is not listed by 'opencode models ${provider}'`);
  // The JSON object for this model ends at the first line that is exactly "}".
  const body = r.stdout.slice(at + model.length + 1);
  const meta = JSON.parse(body.slice(0, body.indexOf("\n}") + 2));
  const variants = [...Object.keys(meta.variants ?? {}), NO_REASONING_VARIANT];
  variantCache.set(model, variants);
  return variants;
}

function snapshot(dir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === STATE_DIR) continue;
    fs.cpSync(path.join(dir, name), path.join(dest, name), { recursive: true, verbatimSymlinks: true });
  }
}

function unifiedDiff(before, dir) {
  const r = spawnSync("diff", ["-ruN", `--exclude=${STATE_DIR}`, "before", dir], {
    cwd: path.dirname(before),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // diff exit: 0 same, 1 different, 2 trouble
  if (r.status === 2) return { diff: null, error: r.stderr.trim() };
  return { diff: r.stdout.replaceAll(dir + "/", "after/"), error: null };
}

function parseEvents(stdout) {
  const out = { text: "", tools: [], cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, errors: [], sessionID: null };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { out.errors.push({ type: "unparsed_line", detail: line.slice(0, 300) }); continue; }
    out.sessionID ??= ev.sessionID ?? null;
    const p = ev.part ?? {};
    if (ev.type === "text") out.text += p.text ?? "";
    else if (ev.type === "tool_use") {
      const s = p.state ?? {};
      const output = typeof s.output === "string" ? s.output : s.output == null ? null : JSON.stringify(s.output);
      out.tools.push({
        tool: p.tool,
        status: s.status,
        input: s.input,
        exit: s.metadata?.exit ?? null,
        output: output && output.length > TOOL_OUTPUT_MAX ? output.slice(0, TOOL_OUTPUT_MAX) + `…[truncated ${output.length - TOOL_OUTPUT_MAX} chars]` : output,
        error: s.error ?? null,
      });
    }
    else if (ev.type === "step_finish") {
      out.cost += p.cost ?? 0;
      const t = p.tokens ?? {};
      out.tokens.input += t.input ?? 0;
      out.tokens.output += t.output ?? 0;
      out.tokens.reasoning += t.reasoning ?? 0;
      out.tokens.cacheRead += t.cache?.read ?? 0;
      out.tokens.cacheWrite += t.cache?.write ?? 0;
    } else if (ev.type === "error") out.errors.push({ type: "event_error", detail: ev.error ?? p });
  }
  return out;
}

/** Actual model/variant recorded by OpenCode, read from the isolated session DB. */
function actualModels(stateRoot, sessionID) {
  const db = path.join(stateRoot, "xdg/data/opencode/opencode.db");
  if (!fs.existsSync(db) || !sessionID || !/^[\w-]+$/.test(sessionID)) return null;
  const q = `select distinct json_extract(data,'$.providerID'), json_extract(data,'$.modelID'), json_extract(data,'$.variant') from message where session_id='${sessionID}' and json_extract(data,'$.role')='assistant';`;
  const r = spawnSync("sqlite3", ["-separator", "\t", db, q], { encoding: "utf8" });
  if (r.status !== 0) {
    const r2 = spawnSync("sqlite3", ["-separator", "\t", db, q.replace(` session_id='${sessionID}' and`, "")], { encoding: "utf8" });
    if (r2.status !== 0) return null;
    r.stdout = r2.stdout;
  }
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [provider, model, variant] = l.split("\t");
    return { provider, model, variant: variant || null };
  });
}

/** Job time limit: OPENCODE_WORKER_TIMEOUT_SEC if set, else none (run until done or cancelled). */
export function defaultTimeoutSec() {
  const raw = process.env.OPENCODE_WORKER_TIMEOUT_SEC;
  if (raw === undefined) return DEFAULTS.timeoutSec;
  const n = Number(raw);
  if (raw.trim() === "" || !(Number.isFinite(n) && n > 0))
    throw new WorkerError("BAD_CONFIG", `OPENCODE_WORKER_TIMEOUT_SEC must be a positive number of seconds, got '${raw}'`);
  return n;
}

/** pid plus all descendants. opencode runs tool commands in their own process groups, so a group kill misses them. */
export function treePids(root) {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map();
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]) ?? []));
  return out;
}

/**
 * Stop a worker and every command it spawned: SIGTERM, then SIGKILL after graceMs.
 * The tree is captured before signalling because children reparent to init once opencode exits.
 */
export function killTree(root, graceMs = 5000) {
  const pids = new Set(treePids(root));
  const signalAll = (sig) => {
    for (const pid of pids) {
      try { process.kill(-pid, sig); } catch {} // tool shells lead their own groups
      try { process.kill(pid, sig); } catch {}
    }
  };
  signalAll("SIGTERM");
  return new Promise((resolve) => setTimeout(() => {
    for (const pid of treePids(root)) pids.add(pid);
    signalAll("SIGKILL");
    resolve([...pids]);
  }, graceMs).unref());
}

/**
 * Run one OpenCode worker task.
 * @param {{dir:string,prompt:string,model?:string,variant?:string,agent?:string,timeoutSec?:number|null,opencodeBin?:string,signal?:AbortSignal,onSpawn?:(info:{pid:number,bin:string,runDir:string})=>void}} o
 */
export async function runWorker(o) {
  if (!o.dir || !o.prompt) throw new WorkerError("BAD_ARGS", "dir and prompt are required");
  const dir = fs.realpathSync(path.resolve(o.dir));
  if (!fs.statSync(dir).isDirectory()) throw new WorkerError("BAD_ARGS", `not a directory: ${dir}`);
  const model = o.model ?? DEFAULTS.model;
  const variant = o.variant ?? DEFAULTS.variant;
  const agent = o.agent ?? DEFAULTS.agent;
  const timeoutSec = o.timeoutSec ?? defaultTimeoutSec();
  if (timeoutSec !== null && !(Number.isFinite(timeoutSec) && timeoutSec > 0))
    throw new WorkerError("BAD_ARGS", `timeoutSec must be a positive number, got ${o.timeoutSec}`);
  const provider = model.split("/")[0];
  if (!DEFAULTS.providers.includes(provider))
    throw new WorkerError("PROVIDER_NOT_ALLOWED", `provider '${provider}' not in ${JSON.stringify(DEFAULTS.providers)}`);

  const bin = resolveOpencodeBin(o.opencodeBin);
  const version = opencodeVersion(bin);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const stateRoot = path.join(dir, STATE_DIR);
  const runDir = path.join(stateRoot, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const configPath = path.join(stateRoot, "opencode.json");
  const modelId = model.split("/").slice(1).join("/");
  const permission = Object.fromEntries([["*", "deny"], ...ALLOWED_TOOLS.map((t) => [t, "allow"]), ["external_directory", "deny"]]);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    enabled_providers: DEFAULTS.providers,
    permission,
  };
  if (variant === NO_REASONING_VARIANT)
    config.provider = { [provider]: { models: { [modelId]: { variants: { [NO_REASONING_VARIANT]: { reasoningEffort: "none" } } } } } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const env = isolatedEnv(stateRoot, configPath);
  const variants = modelVariants(bin, env, model);
  if (!variants.includes(variant))
    throw new WorkerError("BAD_VARIANT", `variant '${variant}' is not defined for ${model}; available: ${variants.join(", ")}`);
  const before = path.join(runDir, "before");
  snapshot(dir, before);

  const args = ["run", "--pure", "--auto", "--format", "json", "--agent", agent, "--model", model, "--variant", variant, o.prompt];
  const started = Date.now();
  const eventsPath = path.join(runDir, "events.jsonl");
  const stderrPath = path.join(runDir, "stderr.txt");
  const { exit, signal, timedOut, cancelled, stdout, stderr } = await new Promise((resolve) => {
    // Not detached: terminal Ctrl+C on the CLI still reaches opencode.
    const spawnOpts = { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] };
    // Optional hard deadline that survives our own death: alarm() is inherited across exec.
    const child = timeoutSec !== null && HARD_DEADLINE_WRAPPER
      ? spawn(HARD_DEADLINE_WRAPPER, ["-e", "alarm shift; exec { $ARGV[0] } @ARGV or die $!", String(Math.ceil(timeoutSec) + 10), bin, ...args], spawnOpts)
      : spawn(bin, args, spawnOpts);
    let stdout = "", stderr = "", timedOut = false, cancelled = false;
    // Streamed to disk so a run stays inspectable even if this process dies mid-run.
    child.stdout.on("data", (d) => { stdout += d; fs.appendFileSync(eventsPath, d); });
    child.stderr.on("data", (d) => { stderr += d; fs.appendFileSync(stderrPath, d); });
    if (child.pid) o.onSpawn?.({ pid: child.pid, bin, runDir });
    const kill = () => killTree(child.pid);
    const timer = timeoutSec === null ? null : setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    o.signal?.addEventListener("abort", () => { cancelled = true; kill(); }, { once: true });
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (exit, signal) => { clearTimeout(timer); resolve({ exit, signal, timedOut, cancelled, stdout, stderr }); });
  });
  const durationSec = (Date.now() - started) / 1000;
  fs.writeFileSync(eventsPath, stdout);
  fs.writeFileSync(stderrPath, stderr);

  const ev = parseEvents(stdout);
  const { diff, error: diffError } = unifiedDiff(before, dir);
  const actual = actualModels(stateRoot, ev.sessionID);
  const errors = [...ev.errors];
  if (timedOut) errors.push({ type: "timeout", detail: `exceeded ${timeoutSec}s` });
  if (cancelled) errors.push({ type: "cancelled" });
  if (exit !== 0 && !timedOut && !cancelled) errors.push({ type: "nonzero_exit", detail: stderr.trim().slice(-2000) || `exit ${exit} signal ${signal}` });
  if (diffError) errors.push({ type: "diff_failed", detail: diffError });
  if (actual && actual.some((a) => a.provider !== provider || a.model !== modelId))
    errors.push({ type: "model_mismatch", detail: actual });

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: exit === 0 && errors.length === 0,
    exit, signal, durationSec,
    opencode: { bin, version },
    requested: { model, variant, agent, timeoutSec },
    actual,
    sessionID: ev.sessionID,
    text: ev.text,
    tools: ev.tools,
    cost: ev.cost,
    tokens: ev.tokens,
    diff,
    errors,
    artifacts: { runDir, events: path.join(runDir, "events.jsonl"), stderr: path.join(runDir, "stderr.txt") },
  };
}
