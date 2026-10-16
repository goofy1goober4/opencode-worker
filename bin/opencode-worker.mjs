#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from "node:fs";
import { runWorker, WorkerError, DEFAULTS } from "../lib/worker.mjs";
import { serveMcp } from "../lib/mcp.mjs";

const USAGE = `Usage:
  opencode-worker run --dir <dir> [options] <prompt | -f file>
  opencode-worker mcp [--opencode-bin <path>]

Options (run):
  --dir <dir>            Working directory; the worker is confined to it (required)
  --model <id>           default ${DEFAULTS.model} (provider must be one of ${DEFAULTS.providers.join(",")})
  --variant <v>          default ${DEFAULTS.variant}
  --agent <name>         default ${DEFAULTS.agent}
  --timeout <sec>        default ${DEFAULTS.timeoutSec}
  --opencode-bin <path>  default $OPENCODE_WORKER_BIN, then PATH
  -f, --prompt-file <f>  Read prompt from file

Prints one JSON result object. Exit: 0 ok, 1 worker failed, 2 usage/setup error.`;

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "run") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        dir: { type: "string" }, model: { type: "string" }, variant: { type: "string" },
        agent: { type: "string" }, timeout: { type: "string" }, "opencode-bin": { type: "string" },
        "prompt-file": { type: "string", short: "f" },
      },
    });
    const prompt = values["prompt-file"] ? fs.readFileSync(values["prompt-file"], "utf8") : positionals.join(" ");
    if (!values.dir || !prompt.trim()) throw new WorkerError("BAD_ARGS", "--dir and a prompt are required\n\n" + USAGE);
    const timeoutSec = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeoutSec !== undefined && !(timeoutSec > 0)) throw new WorkerError("BAD_ARGS", "--timeout must be a positive number");
    const result = await runWorker({
      dir: values.dir, prompt, model: values.model, variant: values.variant, agent: values.agent,
      timeoutSec, opencodeBin: values["opencode-bin"],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.ok ? 0 : 1);
  } else if (cmd === "mcp") {
    const { values } = parseArgs({ args: rest, options: { "opencode-bin": { type: "string" } } });
    serveMcp({ opencodeBin: values["opencode-bin"] });
  } else {
    process.stderr.write(USAGE + "\n");
    process.exit(cmd === "-h" || cmd === "--help" ? 0 : 2);
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, errors: [{ type: e.code ?? "SETUP_ERROR", detail: e.message }] }, null, 2) + "\n");
  process.exit(2);
}
