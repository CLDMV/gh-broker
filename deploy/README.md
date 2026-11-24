# Deploying gh-broker

One interactive installer does first-install and upgrade. Design and rationale: [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md). The broker runs as a dedicated `gh-broker` service user, separate from the unprivileged user the agent runs as — that two-user split is the security boundary; see [`../docs/agent-user-model.md`](../docs/agent-user-model.md).

## 0. Host prerequisites

- **Node ≥ 22** — the only real prerequisite; the installer runs under it (`sudo gh-broker install`). From a checkout, `sudo ./deploy/install.sh` sets up a system-wide nvm + node if node isn't installed yet (leaving anything already at `/usr/local/bin` alone), builds the checkout as its owner, then hands off to the installer (`bin/gh-broker.mjs install`).
- **`rsync`** — used to sync the build (falls back to a plain copy if absent). **`systemd`** with `systemctl`. **`sudo`** — used internally to build as the checkout's own owner (see step 5 below), not just to invoke the installer itself. Install what's missing (`apt install rsync sudo` etc.). The agent's stdio↔socket bridge needs nothing extra: it is the `gh-broker` binary itself (`gh-broker connect`, [installed with the package](#2-install-first-install--and-upgrade-usually-as-gh-broker-upgrade)).

The installer keeps a root-owned **copy** of a qualifying node at `/usr/local/lib/gh-broker/node` — inside a root:root 0755 directory the service user cannot write — and replaces it atomically on every install when a strictly newer qualifying node turns up (a candidate's version is read by running it; only even LTS majors at or above the package's `engines.node` floor count; the fallback is the latest LTS from nodejs.org, verified against its SHASUMS256.txt). The service unit and every agent's bridge run that copy, so CLI node == service node by construction and bumping node needs no unit edit. A copy, not a symlink: a link into nvm is only as safe as whoever owns the target and dangles when that version is removed. Older installs' `/usr/local/bin/{node,npm,npx}` links are left exactly as they are (other things may rely on them): the broker itself never writes under `/usr/local/bin` — the one exception is `deploy/install.sh`'s bootstrap on a box with no node at all, which fills a missing `node`/`npm`/`npx` and never replaces what is there (see step 0 above).

## 1. Mint the two fine-grained PATs

For each GitHub owner (user or org) the broker serves, `<org>`: GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token, **twice**. Resource owner: `<org>`. Repository access: **All repositories**.

**`<org>-read`** — Issues: Read, Pull requests: Read, Contents: Read, Metadata: Read (auto). For `report_custom_properties`, also the repository permission Custom properties: Read, plus the organization permission Custom properties: Read for the org-wide listing.
**`<org>-write`** — Issues: R/W, Pull requests: R/W, Contents: R/W, Metadata: Read (auto). For the tools added in #146, also: Administration: R/W (`create_repository`, `fork_repository`), Actions: R/W (`actions_run_trigger`), Workflows: R/W (`merge_pull_request` and `update_pull_request_branch` on a PR that changes `.github/workflows/`), Code scanning alerts: R/W, Dependabot alerts: R/W and Secret scanning alerts: R/W (`dismiss_alert`). The Copilot coding-agent tools ship disabled and need nothing extra beyond Issues and Pull requests: R/W, plus Copilot coding agent on the account. The installer ships every tool on each run, so a scope left off doesn't hide its tools: the calls are advertised and GitHub refuses them. Administration: R/W is broad: on its own it also lets the token delete repos and change their settings. The broker never offers those, but the token itself can do them, so treat the write PAT accordingly.

The write PAT gets no organization permissions, and the read PAT only the read-only Custom properties one above. If the org requires approval for fine-grained PATs, approve them in Org → Settings → Personal access tokens. The two-PAT split (read vs write) is a deliberate least-privilege control — see the design doc.

### GHCR pushes: one classic PAT (`<org>-packages`)

`ghcr_push` needs a third credential, because the GitHub Container Registry does not accept fine-grained PATs. Create a **classic** token with **`write:packages` only** (it implies `read:packages`; do not add `delete:packages`, and add `repo` only if pushes to a private-repo-linked package are refused without it), and set an expiry: [create the token](https://github.com/settings/tokens/new?scopes=write:packages&description=gh-broker%20ghcr). Enable it with `--ghcr-owner <org> --ghcr-username <login> --ghcr-image <name>` (or a `ghcr` block in a `--config` file, see [Configuring the install](#configuring-the-install)). The installer then prompts for the token as `<org>-packages`; it is an **optional credential**, so you can press Enter to skip it (an unattended run skips it with a note), and the broker then starts normally with the `ghcr_*` tools hidden until the token is stored. Supply it on a later run with `--secret <org>-packages=<token>`, `--secrets-file` or env `GH_BROKER_SECRET_<ORG>_PACKAGES`. `--ghcr-username` (`ghcr.owners.<org>.username`) must be the GitHub login that owns the token.

The installer also creates the drop directory from `ghcr.dropDir` (default `/srv/gh-broker/ghcr-drop`) as `2750 <agent-user>:gh-broker`: the agent writes archives there, the setgid bit gives each file the broker's group, and nobody else can look in. Archives must be group-readable (`chmod g+r`); the broker can only read them, so the agent deletes them after a push. See [`../docs/TOOLS.md`](../docs/TOOLS.md#ghcr_push).

## 2. Install (first install — and upgrade, usually as `gh-broker upgrade`)

```sh
sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker   # first install
sudo gh-broker install [agent-user]
```

**Upgrade** with one sudo:

```sh
sudo gh-broker upgrade
```

which runs, in order and stopping at the first failure (reported, with the commands to finish by hand): the npm install (`@latest`, or `@<version>` with `--version <v>` — a semantic version; the install flags are validated before anything runs, and a downgrade needs `--force`), the **newly installed binary's** `gh-broker install` as a child process with the same flags (`--claude-config <user>:<dir>`, `--no-mcp-config`, …), and the **new binary's** `agent reconnect` — the restart drops every running Claude Code session's connection, so `/mcp reconnect <key>` is typed into each of the agent's tmux panes (see [Agents](#3-agents-one-socket-and-one-mcp-config-each); `--no-reconnect` skips the step, `--force` reinstalls when the target version is already installed **and deployed** — a run where npm succeeded but install never did still installs). The two commands above are still the way to do a first install, and `deploy/install.sh` the way from a checkout.

`--prefix /usr/local` puts the package in `/usr/local/lib/node_modules/@cldmv/gh-broker` and the command at `/usr/local/bin/gh-broker`, independent of the Node version and on `sudo`'s PATH. `--ignore-scripts` because a global install runs as root on the box that holds the tokens. The package ships a prebuilt `dist/`, so there is nothing to build. A copy installed under an nvm version folder breaks when Node is upgraded; `gh-broker install` warns if it finds one. One-offs still work: `sudo npx @cldmv/gh-broker install [agent-user]`, and from a checkout `sudo ./deploy/install.sh [agent-user]`.

`gh-broker install` takes the same flags either way. `agent-user` registers that user as an agent (see [Agents](#3-agents-one-socket-and-one-mcp-config-each)); on an upgrade with agents already registered it is optional and adds nobody. A first install with no agent asks for one (`--non-interactive` needs `--agent-user`); it never takes `$SUDO_USER`, the admin running sudo. The installer walks the whole thing and is idempotent:

1. checks prerequisites,
2. **registers the agents**: members of the old shared `gh-broker-clients` group become registered agents (the group itself is left alone), the user named on the command line is added (and created if missing), and each one gets its own group `gh-broker-agent-<user>`,
3. creates the `gh-broker` service user and, when the config has a `ghcr` block, the GHCR drop directory (owned by the agent named on the command line, else the first registered one),
4. installs a root-owned copy of a qualifying node at `/usr/local/lib/gh-broker/node` (a root:root 0755 directory, the copy replaced atomically; anything already under `/usr/local/bin` is left alone),
5. checks the daemon bundle `dist/index.mjs` is there (the npm package ships it; from a checkout, `deploy/install.sh` builds it first via `sudo -u '#<uid>'` as whoever owns the checkout's `package.json`, not as root, removing any `dist/`, `bin/` or `node_modules/` a root-run build left behind, so nothing root-owned stays in your checkout),
6. regenerates the config (replacing an old `unix:` `listen` with `agents:/run/gh-broker/agents`) by layering `config.example.json`, whatever is deployed, your `--config` file and your flags (your data is preserved; allowlist changes from the repo arrive; see [Configuring the install](#configuring-the-install)); a first install with no owner asks for one,
7. sets up the optional **npm integration** when asked (offered on a first install, or `--npm`): an npm web login it waits on, then the token it creates for `npm_scaffold` (see [npm integration](#npm-integration-npm_scaffold)),
8. **asks how to store the credentials** — `systemd-creds` (encrypted at rest, host-bound; recommended) or a plaintext `file` (`0640 root:gh-broker`; portable) — then stores the tokens in the chosen backend: it keeps existing creds, decrypts a legacy `systemd-creds` token when you switch to `file`, and **prompts only for what it can't find** (input hidden); when no OTP seed is stored it also generates one and shows it once (see [OTP gate](#otp-gate-gh-broker-otp)),
9. validates the config with the real loader (`--check`),
10. installs the unit, deploys `dist/` to `/opt/gh-broker`, restarts, writes every agent's MCP config (`--no-mcp-config` prints the entry instead), and
11. runs a **smoke test** over each agent's own socket (MCP handshake + a real read) → ✅/❌.

### Unattended (single non-interactive command)

Pass flags plus `--non-interactive` (`-y`) to skip every prompt: `--agent-user <name>`, `--secrets-provider systemd-creds|file`, `--create-agent-user`, and supply tokens via `--secrets-file <json>` (`{ "<cred-name>": "<token>" }`), env `GH_BROKER_SECRET_<NAME>` (NAME upper-cased, non-alnum → `_`), or `--secret <cred-name>=<token>` (repeatable; a name the config doesn't use is refused, so a typo can't silently do nothing; it is visible in the process list and shell history, so prefer the file or env). Precedence is `--secret`, then the file, then env, then the interactive prompt; a token from any of the first three replaces a stored one. Example:

```sh
sudo GH_BROKER_SECRET_ACME_READ=… GH_BROKER_SECRET_ACME_WRITE=… \
  gh-broker install --agent-user repo --owner acme \
  --secrets-provider systemd-creds --non-interactive
```

Re-running on an existing install needs no `--owner`: the deployed owners are kept. Migrating an existing `systemd-creds` install needs **no tokens** — `--secrets-provider systemd-creds --non-interactive` keeps the existing `.cred` files (nothing to prompt). `--help` lists every flag.

**Upgrade** is just re-running it: config merged (edits kept), your previously-chosen storage backend pre-selected, existing tokens kept. You can **switch backends** on any run — pick `file` and it decrypts the existing `systemd-creds` tokens into the file (no re-entry); pick `systemd-creds` and it encrypts the tokens into `.cred` files. `launch.sh` is no longer used — remove it after a successful run: `sudo rm -f /opt/gh-broker/launch.sh` (and `sudo rm -rf /etc/gh-broker/creds` only if you've moved fully to the `file` backend).

## OTP gate (`gh-broker otp`)

Tools marked `"otp": true` in `/etc/gh-broker/config.json` (an upgrade keeps each tool's `otp` and `enabled` settings) only run when the call carries a current code from an authenticator app, so a code is something only you can supply. The seed behind those codes is generated by the installer and stored next to the PATs, where the agent can't read it.

**Setup.** On a first install, and on any later run that finds no stored `otp-seed`, the installer generates a seed, prints it, then stores it in the chosen backend (an encrypted `otp-seed.cred` delivered by the unit drop-in under `systemd-creds`, or the `otp-seed` key in `secrets.json` under `file`). It is printed once, before it is stored, so a run that fails later can't leave a stored seed nobody saw: a QR code of the `otpauth://` URI, the base32 key as text, and the URI itself. If a run fails and the next one prints a different key, use the newer one. Scan the QR code with an authenticator app, or enter the key by hand. `--non-interactive` does the same, so capture the output of an unattended run. An existing seed is never overwritten by the installer. To supply your own, pass `--secret otp-seed=<base32>`, `--secrets-file` or env `GH_BROKER_SECRET_OTP_SEED`; it is then used as is and not printed.

**The `gh-broker` command.** The global npm install puts `gh-broker` on root's PATH (`/usr/local/bin/gh-broker`). It needs root, because the state directory is `0700 gh-broker`:

```sh
sudo gh-broker otp status [<user>] [--json]   # per agent: bad codes so far, short lockouts in the last 24 h, hard lock, state file health
sudo gh-broker otp list [--json]              # who is locked out now, and the command that clears each
sudo gh-broker otp unlock <user>              # clear one agent's lockout and hard lock
sudo gh-broker otp unlock --all               # clear everyone
sudo gh-broker otp rotate                     # new seed: stored, shown once, service restarted
```

`unlock <user>` drops that user's entry from the state file and leaves the others alone, rewriting the file atomically as `0600 gh-broker:gh-broker`. Every write from the command also counts each code up to the next 30-second step as spent, so a write that races the daemon can't hand a code back that the daemon just accepted. After an unlock the current code and the one after it are refused (they don't count as bad codes); the command says how many seconds to wait for a fresh one, up to a minute. If the broker writes the state file while the command runs (a lockout, an accepted code), the command changes nothing and asks you to run it again, so it can't undo what the broker just recorded. Each unlock is logged to the journal as `gh-broker`, next to the daemon's audit log, with the sudo user who ran it. If the state file is corrupt the broker treats every user as hard-locked; `status` and `list` report that, `unlock <user>` refuses (clearing one user would not fix the file), and `unlock --all` rewrites it clean. `rotate` replaces the stored seed and restarts the service, which closes every open window; remove the old entry from your authenticator.

**State file.** The lock counters live in `/var/lib/gh-broker/otp-state.json` (`otp.statePath` to change it): `version`, a global `lastAcceptedStep`, and a `users` object with `failures`, `lockedUntil`, `lockouts` and `hardLock` per agent user. A user with no entry is all zero. The unit sets `StateDirectory=gh-broker` with `StateDirectoryMode=0700`, which makes the directory writable under `ProtectSystem=strict` and owned by the service user. It survives restarts, so a hard lock does too. The broker re-reads it whenever it changes, so `unlock` takes effect on the next call with no restart.

**Config.** `config.example.json` ships `"otp": { "seed": "cred:otp-seed" }`. An upgrade adds it to a deployed config that lacks it; an `otp` block you already have (`maxFailures`, `lockoutSeconds`, `maxLockouts`, `windowSeconds`, `statePath`) wins field by field, and a `--config` file may hold one too.

## Credential storage — your choice

The installer asks which backend holds the tokens at rest:

- **`systemd-creds`** (recommended, Linux): tokens are encrypted with a host/TPM-bound key (`.cred` files delivered via a unit drop-in into memory-only `$CREDENTIALS_DIRECTORY`). Encrypted at rest and resistant to backup/disk theft; not portable to another machine.
- **`file`**: tokens in a plaintext JSON file, `0640 root:gh-broker`. Portable and platform-neutral; at-rest protection is filesystem permissions only.

Either way the **agent user cannot read the tokens** (that's filesystem perms, not encryption) and the **config stays token-free**. The choice only affects at-rest protection vs portability. See [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md).

## Configuring the install

`config.example.json` ships only the generic defaults: `listen`, `upstream` and the `tools` allowlist. Everything specific to your deployment (owners, GHCR, App, npm, secrets) is supplied at install time. `config.sample.json` shows a complete config with placeholder values; nothing loads it.

Settings are layered, lowest precedence first:

1. `config.example.json` (shipped defaults),
2. the config already deployed on the host,
3. `--config <file>`,
4. command-line flags.

A scalar is replaced by a higher layer. `owners` and `ghcr.owners` are merged per owner, so adding an owner never drops the deployed ones. `tools` always comes from the example: the allowlist is a security control, so a `--config` file that contains `tools` is refused. The `--config` file is JSON in the deployed config's shape, holds only `cred:` references (a value shaped like a token is refused), and the merged result is validated by the real loader before anything is deployed. An upgrade run with no config flags keeps the deployed owners, `ghcr` and everything else as they are.

| Flag                                                                                | Sets                                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `--config <file>`                                                                   | JSON config file merged on top of the deployed config                 |
| `--owner <org>` (repeatable)                                                        | `owners.<org>` = `cred:<org>-read` / `cred:<org>-write`               |
| `--installation-id <org>=<id>` (repeatable)                                         | `owners.<org>.installationId`                                         |
| `--default-owner <org>`                                                             | `defaultOwner` (a first install with a single owner defaults to it)   |
| `--listen <unix:path>`                                                              | `listen`                                                              |
| `--upstream <url>`                                                                  | `upstream`                                                            |
| `--app-id <n>`, `--app-private-key <cred-name>`                                     | `app.appId`, `app.privateKey` (`cred:gh-app-key` unless named)        |
| `--secrets-provider <p>`, `--secrets-path <path>`                                   | `secrets.provider`, `secrets.path` (path is for the `file` provider)  |
| `--npm`, `--npm-scope`, `--npm-org`, `--npm-registry <url>`, `--npm-token-days`     | the `npm` block, see [npm integration](#npm-integration-npm_scaffold) |
| `--ghcr-owner <org>`, `--ghcr-username <login>`, `--ghcr-image <glob>` (repeatable) | `ghcr.owners.<org>`; the credential is `cred:<org>-packages`          |
| `--ghcr-drop-dir <path>`                                                            | `ghcr.dropDir` (default `/srv/gh-broker/ghcr-drop`)                   |
| `--ghcr-max-archive-bytes <n>`                                                      | `ghcr.maxArchiveBytes`                                                |
| `--protect-release-tags`, `--no-protect-release-tags`                               | `ghcr.protectReleaseTags`                                             |

Flags that build a single GHCR owner do so for one owner per run; use `--config` for several, or for a credential name other than the derived one.

With no owner anywhere (a first install with no flags and no `--config`), an interactive run asks for the GitHub owner name and then for its two tokens; `--non-interactive` fails and names `--owner` / `--config`.

## 3. Agents: one socket and one MCP config each

The broker knows which agent is calling from the socket the call arrives on: there is one Unix socket per agent user, `/run/gh-broker/agents/<user>.sock`, reachable only by that user. An agent is registered when the group `gh-broker-agent-<user>` exists with exactly `gh-broker` and `<user>` as members (user names are lowercase, up to 16 characters: `^[a-z_][a-z0-9_-]{0,15}$`). There is no shared socket, so a locked-out agent can't keep using the broker through another door.

```sh
sudo gh-broker agent add <user>      # group, MCP config, restart, smoke test over the user's socket
sudo gh-broker agent remove <user>   # empty the group, restart (closes the socket), then the MCP entry (backup first) and the user's lock state
sudo gh-broker agent list            # socket path, whether it exists, and whether the MCP config points at it (ok / missing / points elsewhere)
sudo gh-broker agent sync [<user>]   # re-apply the MCP config for one agent or all
sudo gh-broker agent reconnect [<user>] [--wait 5m] [--session <name|%pane>] [--all] # /mcp reconnect <key> in the agent's running Claude Code sessions that need it (--dry-run lists)
```

`agent remove` empties the agent's group rather than deleting it. Processes the user already has running keep that group's id, so deleting it would let a later `agent add` reuse the id and give those processes the new agent's socket. An empty group isn't an agent; `agent add` for the same user fills it again.

**The MCP config.** The broker writes the entry into the top-level `mcpServers` of `<home>/.claude.json`, using `sg` so the new group is effective without a re-login:

```json
"github": {
	"type": "stdio",
	"command": "sg",
	"args": ["gh-broker-agent-<user>", "-c", "exec /usr/local/lib/gh-broker/node /usr/local/bin/gh-broker connect /run/gh-broker/agents/<user>.sock"]
}
```

If an existing entry already mentions `/run/gh-broker/` (the old shared socket or the new one) that entry is updated in place and keeps its name; otherwise the entry is added as `github`, or `gh-broker` when that name is taken. Nothing else in the file changes. The file is parsed, edited, written to a temp file in the same directory and renamed, keeping its owner and mode, and `~/.claude.json.gh-broker.bak` keeps the previous copy (overwritten each time). A missing file is created `0600`; a file that doesn't parse is left alone and the entry is printed to add by hand. The home directory belongs to the agent user and the command runs as root, so it reads the file without following a symlink and only touches a plain file the user owns with a single link; anything else (a symlink, a hard link, someone else's file) is left alone with a warning, and the temp file is created with a random name that can't be pre-planted. Running Claude sessions for that user must be restarted to pick the change up; `agent sync <user>` puts the entry back if a running session overwrote the file.

**`agent reconnect`.** A restart (from `install`, `upgrade`, `agent add` or `remove`) closes every agent's socket. The `connect` bridge the MCP entry runs dials again on its own (backoff, handshake replay, a `list_changed` notification), so a running session usually keeps working across a restart. When a session still shows its `github` (or `gh-broker`, or `gh-broker-<user>`) MCP server as failed — an old entry it hasn't picked up, or a bridge that can't recover — its operator types `/mcp reconnect <key>`, where `<key>` is that file's entry name, read back from the agent's `.claude.json` files. `agent reconnect [<user>]` does it for them: it finds the agent user's tmux servers (the sockets under `/tmp/tmux-<uid>/` plus every `tmux -S <path>` server it runs, found through the server processes' own fds — no server-access ACL needed), lists their panes, and to each pane running Claude Code **that needs it**, it sends `/mcp reconnect <key>` (`tmux send-keys -l`, then a separate `Enter`). Which panes need it is decided from the **running process tree**, not the `.claude.json` file — the file can already say `connect` while the session still runs the socat entry it loaded before the file was rewritten, which is exactly the case this step exists for. A claude whose descendants include the connect bridge the entry runs (`<node> <cli> connect <socket>` under the entry's `sg` — the socket inside the agents directory, matched on argv shape and owned by the agent user, since that child is what the installer's entry exec'd) recovers from a restart on its own, so typing into it would be noise: those panes are listed with `already on the connect bridge` and are **not counted as skipped** (they don't turn the run into exit 3, are never handed to `--wait`, and `upgrade`'s "some sessions were skipped" notice doesn't fire when they're the only ones left); `--all` sends to every Claude Code pane as before. A claude whose child is still the old socat entry (`socat … UNIX-CONNECT:<socket>`) or that has no broker child at all (the entry failed or never started) gets the send as before. Every tmux command runs **as the agent user** — through `/usr/bin/setpriv --reuid --regid --init-groups` (which keeps the agent's supplementary groups; a bare uid/gid spawn drops them, and a `-S` socket reachable only through a group would then be unreachable), with the agent's HOME, a UTF-8 locale (a bare one makes tmux write `_` for the tab in its pane listing), and no inherited `$TMUX` — against a socket verified to be a socket the agent owns, using **that server's own tmux binary** (`/proc/<pid>/exe`; a client of one version can't reach a server of another, and more than one may be installed — a socket no live tmux process holds is skipped with a reason rather than guessed at). Root enumerates, the agent connects, so root is never the one typing into a tmux server. A claude started from a wrapper script reads as `bash` in the pane's process tree and is skipped (safe — it can be retried once the session shows as claude). One output line per pane: user, socket, pane with the tmux session and working directory it sits in (`%77 (main, /home/repo) github skipped (…)` — both fields come from the agent's tmux, so control characters in them are blanked out before printing), key, sent or skipped and why. Claude working in a pane doesn't stop the send: Claude Code queues what's typed while it works. A pane is **never** sent to when its composer isn't empty (the dim prompt suggestion Claude Code shows in an empty box doesn't count; the capture keeps SGR attributes to tell it apart), a dialog such as a permission prompt or question is showing, Claude isn't its foreground job (a stopped or background `claude` never gets text typed into the shell above it), it is in copy mode or has synchronize-panes on, or its key isn't one that is safe to type blind (alphanumerics, `_`, `.`, `-` — a crafted key could carry a newline, and `send-keys -l` delivers that as Enter) — those are listed as skipped with the pane id so they can be retried, and nothing the user typed is ever cleared. The screen is re-captured just before sending, so a pane that changed between the check and the send is skipped too. The detectors are heuristics over Claude Code's screen (pinned against real captured panes), so they err toward skipping. `--dry-run` lists what it would send where. `--session <name|%pane>` (repeatable) keeps only the panes whose tmux session name or pane id is an exact match — a value that matches no pane anywhere is reported and the run exits 1. With `--wait <time>` (e.g. `90s`, `5m`, at most `30m`), the panes skipped for text in the input box or a dialog are re-checked every 5 seconds and sent to as soon as each is clear; the ones still blocked when the time is up are skipped as before. It exits 0 when every pane was sent to (or the only ones it didn't type into were already on the bridge), 3 when some were only skipped, and 1 when a named user doesn't exist or a `--session` matched no pane. `upgrade --wait <time>` passes it on to its reconnect step.

**Other Claude config folders.** A Claude session started with `CLAUDE_CONFIG_DIR` reads `$CLAUDE_CONFIG_DIR/.claude.json` and ignores `~/.claude.json`, so the entry also goes into the `.claude.json` of the agent's other Claude config folders. Only registered agents' folders are looked at:

- each `~/.claude*` directory in the agent's home;
- the `CLAUDE_CONFIG_DIR` of each `claude` process the agent is running, as long as it resolves inside the agent's home;
- folders saved for the agent with `--claude-config` (`sudo gh-broker agent add|sync <user> --claude-config <dir>`, or `sudo gh-broker install --claude-config <user>:<dir>`). They're kept in `claudeConfigDirs` in the broker config, so every later sync updates them. This is how a folder outside the home directory is added.

In these folders the file is only updated when it already exists (Claude Code creates it on first run). The folder must be a real directory the agent owns, not a symlink; anything else is skipped with a warning and doesn't fail the run. The folder is opened once and the file is edited through that open folder, so it can't be swapped mid-way. A session folder outside the home directory is skipped, because owning a folder doesn't mean the agent can reach it; save it with `--claude-config` if it's meant to be used. `agent remove` cleans the entry out of every folder it finds, and forgets the saved ones. A session folder that isn't running at that moment and isn't saved keeps its entry, which then points at a closed socket.

`--no-mcp-config` (on `install`, `agent add` and `agent sync`) skips the write and prints the entry.

**Upgrading from the shared socket.** The first `gh-broker install` after the change registers every member of `gh-broker-clients` (other than `gh-broker`) as an agent, writes the new `listen` (`agents:/run/gh-broker/agents`), rewrites each agent's MCP config to its own socket and smoke-tests every socket. `gh-broker-clients` is left in place; nothing depends on it any more. Agents added later need a service restart, which `agent add` does.

**Versions.** The service runs from `/opt/gh-broker`, which `gh-broker install` deploys. `gh-broker otp status` and `gh-broker agent list` warn when the installed package and the deployed copy differ; run `sudo gh-broker install` again.

## Adding an org later

Re-run `sudo gh-broker install` with `--owner <org>` (repeatable). The deployed owners stay, the new one is added with `cred:<org>-read` / `cred:<org>-write`, and the installer prompts for its two tokens. No code change.

## npm integration (`npm_scaffold`)

Optional. It lets `npm_scaffold` create new npm packages and their trusted publishers. The broker holds an npm granular access token; the installer creates it for you.

**Enable or rotate:** re-run the installer with `--npm` (a first interactive install also offers it). The installer then:

1. asks which scopes to allow (`--npm-scope @your-org`, repeatable; defaults to the existing setting, else `@<first owner>`),
   and, with `--npm-org your-org` (repeatable), also grants the token org read-write on those orgs; the choice is saved as `npm.tokenOrgs` so a later rotation creates the same kind of token,
2. starts an npm web login and shows the login link, then **waits** until you approve it in a browser (the same flow as `npm login --auth-type=web`),
3. asks for your npm password and a one-time password (both hidden; the password is used for this one request and never stored), and creates a granular token: those scopes read-write, `--npm-token-days` lifetime (default 90), **no 2FA bypass**,
4. revokes the login session, stores the token as `npm-token` in the chosen credential backend, and adds `"npm": { "token": "cred:npm-token", "scopes": [...] }` to the config.

Without 2FA bypass the token can't publish or change trust settings on its own: every npm write `npm_scaffold` makes carries its own one-time password from you (one for the publish, one for the trusted publisher). Running `--npm` again creates a fresh token and replaces the stored one. The installer does not revoke the old token; it says so, and the old one stays valid until it expires or you revoke it in your npm account's Access Tokens settings.

**Unattended:** the web login needs a browser, so `--non-interactive --npm` takes an existing token instead, via `--secrets-file` (`{ "npm-token": "npm_…" }`) or env `GH_BROKER_SECRET_NPM_TOKEN`.

Without the `npm` block nothing changes: the installer says "not enabled", and the broker does not expose `npm_scaffold` at all (startup logs why). The token is an **optional credential**: if it is missing (skipped at the prompt, or an unattended run without it), the installer carries on and the broker starts normally with `npm_scaffold` hidden. Only the owners' PATs are required.

## Enabling `link_issue` (GitHub App) — DEFERRED

> **Status: deferred / not wired in.** `link_issue` is implemented in `src/verbs/link_issue.ts` but its catalog (advertise) and router (dispatch) hooks are **commented out**, and it has no entry in `config.example.json`'s allowlist — so it is neither advertised nor callable. To turn it on: uncomment the `link_issue` blocks in `src/catalog.ts` and `src/router.ts` (and their imports), add `{ "name": "link_issue", "mode": "write", "custom": true }` to the tools allowlist, and configure a GitHub App.

`link_issue` creates an explicit PR→issue closing reference via `addClosingIssueReference` — a mutation **not available to fine-grained PATs** (only App/classic tokens). It runs on a **GitHub App** installation token (`@octokit/auth-app`, from `config.app` = `{ appId, privateKey: "cred:gh-app-key" }` plus the owner's `installationId`). Store the App key like any other credential — as `gh-app-key` in the secrets file.

## Verify no secret leaks

- The agent user cannot read `/etc/gh-broker/` — the dir is `0750 root:gh-broker`; the config (`0640`) and, whichever backend is used, the tokens (systemd-creds `.cred` files `0400 root`, or the `file` backend's `secrets.json` `0640 root:gh-broker`) are unreadable to a non-member.
- The config file holds **no tokens** — only `cred:` references; the tokens live in the separate secret store.
- The socket carries MCP frames only.
- `journalctl -t gh-broker` shows the audit log (tool, user, owner, mode, repo, result, OTP outcome, lockouts and unlocks) — never tokens, codes or the seed.
