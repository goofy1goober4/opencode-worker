# opencode-worker

Run the official OpenCode CLI as an isolated, time-boxed worker. One package, two entry points:

- `opencode-worker run` — CLI, prints one JSON result
- `opencode-worker mcp` — MCP stdio server (async jobs)

No dependencies. Node ≥ 20. OpenCode is **not** bundled: pass `--opencode-bin`, set `OPENCODE_WORKER_BIN`, or have `opencode` on `PATH` (checked in that order).
A set-but-empty `--opencode-bin`/`OPENCODE_WORKER_BIN` fails with `BIN_EMPTY` instead of falling back to `PATH`; this usually means a shell variable was not expanded in your MCP config.

## Safety defaults

- Child env is rebuilt from scratch: only `PATH`, `LANG`, `LC_ALL`, `TMPDIR` pass through. No API keys or credentials.
- `HOME` and `XDG_{CONFIG,DATA,CACHE,STATE}_HOME` point into `<dir>/.opencode-worker/`.
- Generated config: `model` = `small_model` = requested model, `enabled_providers: ["opencode"]`, `permission.external_directory: "deny"`.
- Models outside the `opencode` provider are rejected (`PROVIDER_NOT_ALLOWED`); there is no fallback.
- No job time limit by default: a job runs until it finishes, `worker_cancel`, or the MCP session closes — like a subagent. Opt in to a limit with `OPENCODE_WORKER_TIMEOUT_SEC` (per install) or `--timeout` / `worker_start.timeoutSec` (per job); on expiry: SIGTERM, then SIGKILL after 5 s, plus an `alarm()` 10 s later that fires even if this process died.
- Cancel and timeout stop the whole process tree: opencode plus every command it spawned (tool shells run in their own process groups, so the tree is walked by parent pid).
- Fixed flags: `run --pure --auto --format json --agent <agent> --model <model> --variant <variant>`.

Defaults: model `opencode/deepseek-v4.1-flash-free`, variant `low`, agent `build`.

## CLI

```sh
opencode-worker run --dir ./task "Fix add() in calculator.py and run the tests"
opencode-worker run --dir ./task --timeout 1800 -f prompt.md --variant high
OPENCODE_WORKER_TIMEOUT_SEC=1800 opencode-worker run --dir ./task "…"
```

Exit codes: `0` ok, `1` worker failed (timeout, nonzero exit, error event, model mismatch), `2` usage/setup error.

## Result (schemaVersion 1)

| field | meaning |
|---|---|
| `ok` | exit 0 and no errors |
| `exit`, `signal`, `durationSec` | process outcome |
| `opencode` | `{bin, version}` |
| `requested` | `{model, variant, agent, timeoutSec}` |
| `actual` | provider/model/variant recorded in the isolated session DB (needs `sqlite3`; `null` if unavailable) |
| `text` | worker's final text |
| `tools[]` | `{tool, status, input, exit, output, error}` per tool call; `exit` is the bash exit code (else `null`), `output` capped at 4000 chars |
| `cost`, `tokens` | summed from `step_finish` events |
| `diff` | `diff -ruN` of `<dir>` before vs after (excludes `.opencode-worker/`) |
| `errors[]` | `timeout`, `cancelled`, `nonzero_exit`, `event_error`, `model_mismatch`, `diff_failed`, `unparsed_line` |
| `artifacts` | raw `events.jsonl` and `stderr.txt` under `<dir>/.opencode-worker/runs/<id>/` |

The worker's report is not proof: verify `diff` and rerun your own checks.

## MCP

Tools: `worker_start` (returns `jobId` immediately), `worker_wait`, `worker_status`, `worker_result`, `worker_cancel`.

Recommended flow: `worker_start` → `worker_wait` (repeat while it returns `status: "running"`). `worker_wait` blocks up to `timeoutSec` (default 50 s, max 120 s) and returns the full result once the job finishes, so clients don't burn model turns polling `worker_status`. The 50 s default stays under common 60 s client tool timeouts (e.g. Codex `tool_timeout_sec`).

```json
{
  "mcpServers": {
    "opencode-worker": {
      "command": "npx",
      "args": ["-y", "opencode-worker", "mcp"],
      "env": { "OPENCODE_WORKER_BIN": "/path/to/opencode" }
    }
  }
}
```

Optional: `"OPENCODE_WORKER_TIMEOUT_SEC": "1800"` in `env` caps every job; omit it for no limit. It is independent of the per-call `worker_wait` limit.

### Client setup

Claude Code (tools must be allowed in `-p` mode; put the prompt right after `-p`, because `--allowedTools` and `--mcp-config` are variadic and swallow trailing arguments):

```sh
claude mcp add opencode-worker -e OPENCODE_WORKER_BIN=/path/to/opencode -- npx -y opencode-worker mcp
claude -p "…" --allowedTools "mcp__opencode-worker__worker_start,mcp__opencode-worker__worker_wait,mcp__opencode-worker__worker_status,mcp__opencode-worker__worker_result"
```

Codex (`~/.codex/config.toml`); without the approval mode, `codex exec` rejects MCP calls under `approval: never`:

```toml
[mcp_servers.opencode-worker]
command = "npx"
args = ["-y", "opencode-worker", "mcp"]
env = { OPENCODE_WORKER_BIN = "/path/to/opencode" }
default_tools_approval_mode = "approve"
```

OMP (`.omp/mcp.json` or `~/.omp/agent/mcp.json`): the JSON above with `"type": "stdio"`. Non-interactive: `omp -p --auto-approve "…"`.

Job records are written to `$OPENCODE_WORKER_STATE_DIR` (default `$XDG_STATE_HOME/opencode-worker/jobs`, else `~/.local/state/opencode-worker/jobs`), so `worker_status`/`worker_result` work after a server or client restart.
Closing stdin or SIGINT/SIGTERM/SIGHUP cancels running jobs and records them as `cancelled`. If the server is killed outright (crash, SIGKILL), a restarted server reports its unfinished jobs as `orphaned` when the recorded worker pid is still that opencode binary (stop it with `worker_cancel`), else `lost`. Events and stderr are streamed to `<dir>/.opencode-worker/runs/<id>/` while the job runs, so partial logs survive either way.

## Notes

- `<dir>/.opencode-worker/` holds state, snapshots and logs per run; delete it when done.
- The before-snapshot copies the whole directory: use small, task-scoped directories.

## Releasing

Publishing runs in GitHub Actions via npm Trusted Publishing (OIDC): no npm token or OTP.

```sh
npm version patch        # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # the tag triggers .github/workflows/publish.yml
```

The workflow fails if the tag does not match `package.json` `version`.
