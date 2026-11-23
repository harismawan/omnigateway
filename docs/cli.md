# The omni CLI

`omni --help` lists everything; `omni <command> --help` explains one. Every
command takes `--json` for scripting, and `--root <path>` to manage an
installation other than the default. The CLI opens the installation's SQLite
file directly, so it works when the gateway is down.

`--root` names the installation, so an `OMNI_DB_PATH` exported in your shell is
ignored alongside it and said so on stderr; that root's own `.env` still decides.
Use `--db <path>` to point one command somewhere else.

| | |
| --- | --- |
| `omni status` | the gateway, its accounts, and their quota, on one screen |
| `omni health` | probe the gateway's `/health` endpoint |
| `omni start` / `stop` / `restart` | run the gateway; `--foreground` attaches it to your terminal |
| `omni doctor` | which installation it resolved, and whether it can act on it |
| `omni logs` | recent requests as the gateway recorded them; filter and page with `--failed`, `--key`, `--since`, `--cursor` |
| `omni logs export` | matching request metadata as CSV or JSONL on stdout; `--since` and `--until` required |
| `omni bodies <request-id>` | captured bodies for one request; withheld unless you pass `--full` |
| `omni console` | the gateway process's own output: boot, refreshes, quota, errors |
| `omni usage` | spend and tokens, by provider, model, key, or day; `--account <id>` and `--key <id>` narrow to one account or gateway key |
| `omni quota` | provider quota per window: use, burn rate, and when it runs out |
| `omni quota refresh <id> \| --all` | read provider quota now, without waiting for the next poll |
| `omni quota resets <id>` / `omni quota reset <id>` | list / spend a banked Codex or Claude quota reset (irreversible) |
| `omni connect <provider>` | authorize an account from the terminal |
| `omni credentials …` | list, show, enable, disable, `set`, `rm`, refresh, `add-key`, health |
| `omni models …` | list, show, put, `rm`, `dry-run`, `catalog` |
| `omni keys …` | list, create, `limits`, revoke |
| `omni plugin …` | not supported in 1.x; see [Plugins](../ARCHITECTURE.md#plugins) |
| `omni service install` / `uninstall` | write or remove a systemd unit for this installation |
| `omni setup claude` / `opencode` | point a client's config at this gateway |
| `omni settings get` / `set` | routing weights, retention, deadlines, and the runtime switches |
| `omni admin set-password` | change the console password |
| `omni db migrate` | create or upgrade the database |
| `omni db stats` | size on disk, free pages, schema version, and what snapshots are held |
| `omni db backup` / `snapshots` | take a snapshot, and list the ones retention has kept |
| `omni db restore <id>` | put a snapshot back; shows a live-vs-snapshot count table, then asks. `--dry-run` shows the table and stops |
| `omni db vacuum` | rewrite the database, reclaiming the pages deletion left free |
| `omni db clear-bodies` | delete every captured request and response body; the requests stay logged |

Two worth knowing:

`omni models dry-run fast` shows exactly where a request would go and why —
each candidate's score, and every account that was excluded with the reason.

`omni status` is the "is anything wrong" command: process state, per-account
health, and how much provider quota each account has left.

Service supervision and its limits are in
[rust-cli-service.md](rust-cli-service.md).