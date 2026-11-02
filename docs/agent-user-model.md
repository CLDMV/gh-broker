# The agent-as-separate-user model

gh-broker's security rests on one structural decision: **the agent runs as a different, unprivileged OS user than the broker that holds the credentials.** The agent gets to *act* on GitHub through the broker; it never gets to *hold* a token. This document is the worked example of that layout — the users, the group, the permissions that make the boundary real, and how to reproduce it. It is a reference setup, not a one-off.

## Why a separate user at all

The credentials (per-org fine-grained PATs, and optionally a GitHub App key) live in a secret store on a root-owned, agent-unreadable path, read into the broker process's memory at start. The only thing that ever crosses to the agent is MCP frames over a Unix socket — bytes in, bytes out, no token.

That isolation is the entire security property, not a garnish on top of one. If the agent and the broker were the same user, that user could read the secret store, connect to the socket, *and* read the broker process's environment and memory — the design would be theater. Running them as two users, with the OS enforcing the split, is what turns "the agent can't exfiltrate the secret" from a hope into a mechanism.

## The three roles

- **Agent user** — the unprivileged account the agent (Claude, or any autonomous client) runs as. It is a member of the *bridge group* so it can open the socket, and nothing more. It is **not** in the service group and has no path to the credentials.
- **Service user** — the dedicated account the broker daemon runs as. It owns the socket and runtime directory and is the only identity that can read and hold the PATs. It runs nothing else.
- **Agent group** — one per agent, `gh-broker-agent-<user>`, whose *sole* purpose is access to that agent's socket. Its members are exactly `gh-broker` and `<user>`; the socket is `group=gh-broker-agent-<user>, mode 0660`. Membership grants exactly one capability — connect to that one socket — and grants nothing over the credentials. The group is also the registry: an agent exists when its group does.

## Example layout (this deployment)

| Role | User | uid / gid | Relevant group memberships | Runs as agent? |
|---|---|---|---|---|
| Agent | `repo` | 1003 / 1003 | `repo`, `users`, `docker` (986, **rootless**), `repos` (1004), `gh-broker-agent-repo` (990) | yes |
| Service | `gh-broker` | 995 / 985 | `gh-broker` (985), `gh-broker-agent-repo` (990) | no — daemon only |

Agent group: `gh-broker-agent-repo` (gid 990) → members `gh-broker, repo`. A second agent `glmtest` would get its own `gh-broker-agent-glmtest`, and neither agent can open the other's socket.

Filesystem and socket:

| Path | Owner:Group | Mode | Effect |
|---|---|---|---|
| `/etc/gh-broker` | `root:gh-broker` | `0750` | Agent (not in `gh-broker`) can't even traverse into it. |
| the token store — `creds/*.cred` (systemd-creds) or `secrets.json` (file) | `root:root` / `root:gh-broker` | `0400` / `0640` | The tokens, in whichever backend was chosen at install. Readable only by root / the `gh-broker` group; the agent (not in it) can't. Referenced by `cred:` names in the config. |
| the OTP seed — `creds/otp-seed.cred` or the `otp-seed` key in `secrets.json` | same as the tokens | same as the tokens | The TOTP seed behind the OTP gate. Stored with the PATs, so the agent can't read it and can't compute a code. |
| `/var/lib/gh-broker` | `gh-broker:gh-broker` | `0700` | OTP gate state: bad-code counters, lockouts, the hard lock. The agent can't read or edit it. |
| `/run/gh-broker` | `gh-broker:gh-broker` | `0755` | Traversable so the socket can be reached. |
| `/run/gh-broker/agents` | `gh-broker:gh-broker` | `0755` | Holds the per-agent sockets. |
| `/run/gh-broker/agents/<user>.sock` | `gh-broker:gh-broker-agent-<user>` | `0660` | That agent connects (it's in its own group); everyone else, including other agents, can't. The broker knows who is calling from which socket the call arrived on. |

## What makes the boundary real

Read these as the capability matrix — what each user actually can and cannot do:

|  | Read the token store | Read broker env / memory | Open the socket | Ever hold a PAT |
|---|---|---|---|---|
| **Agent** (`repo`) | no — not in `gh-broker`; dir is `0750 root:gh-broker`, tokens root-owned | no — separate user, plus the unit's `ProtectHome`/`NoNewPrivileges`/etc. | **yes** — member of `gh-broker-clients` | **never** |
| **Service** (`gh-broker`) | yes — via systemd-creds (memory-only `$CREDENTIALS_DIRECTORY`) or the file, into memory only | yes (it is the process) | yes — it owns it | yes — in memory only, never on an agent-readable path |

Three independent gates, each verifiable:

1. **Credentials** — `/etc/gh-broker` is `0750 root:gh-broker`. The agent user is deliberately *not* in the `gh-broker` group, so it cannot list or traverse the directory, let alone read the token store. Verify: as the agent user, `cat /etc/gh-broker/secrets.json` (or a `creds/*.cred`) → *Permission denied*.
2. **Socket** — `0660 gh-broker:gh-broker-agent-<user>`, one per agent. The agent is in its own group, so it can `connect()` to its socket and no other; a user outside the group cannot. The socket speaks MCP frames only — no credential material is ever written to it.
3. **Process** — the broker runs under the hardened unit (`ProtectHome`, `ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, restricted syscalls). A separate user can't `ptrace` it or read `/proc/<pid>/environ`, so the in-memory token isn't reachable that way either.

## The OTP gate depends on the same split

The OTP gate for risky tools only means something because of this boundary. The agent passes the code, but it can only get one from you: the seed sits in the token store, out of its reach, and a code is valid for 30 seconds. After repeated bad codes the broker hard-locks, and the only thing that clears the lock is `sudo gh-broker otp unlock` on the host. The agent has no sudo, so it can't clear its own lock; a locked agent can only tell you what happened and which command to run. Giving the agent sudo, or putting it in the `gh-broker` group, would let it read the seed or edit the state file and defeat the gate along with everything else.

## Host hardening that backs the split

The two-user split only holds if the agent user has no *other* route to root or to the service user's files:

- **No passwordless sudo for the agent.** If the agent could `sudo`, every gate above is moot. Verify: as the agent user, `sudo -n true` → fails.
- **Rootless docker (mandatory if the agent has docker access).** The agent here is in the `docker` group — which on a **rootful** daemon is root-equivalent (a container can bind-mount host `/` and read any file, including the creds). It is safe *only because docker runs rootless*: the group grants access to the agent's own userns-mapped daemon, not to a host-root daemon. If you put the agent user in a rootful `docker` group, you have handed it the credentials. Keep docker rootless, or keep the agent out of the docker group.
- **The agent never has the credentials on any readable path** — not in `~/.claude.json`, not in an env var, not in a file it owns. The socket bridge (`socat STDIO UNIX-CONNECT:…`) is the whole of its access.

## Setting up the agent user

The agent account is a prerequisite you provide. Set it up as a plain unprivileged user, then register it:

```sh
# An ordinary login user with NO sudo. (Add to `docker` only if docker is rootless.)
sudo useradd --create-home --shell /bin/bash agent          # or reuse an existing unprivileged user
# Make sure it has no sudo rights:
sudo -l -U agent            # should report it may run nothing, or fail
sudo gh-broker agent add agent   # its group, socket, MCP config, restart and smoke test
```

`agent add` writes the entry into the user's `~/.claude.json` (the stdio bridge through `sg gh-broker-agent-<user>`, so no re-login is needed). Restart the user's running Claude sessions to pick it up. Nothing else about the agent needs the broker's internals.

## Anti-patterns

- **Running the agent as root** (or with sudo) — collapses every gate; root reads the creds directly.
- **Running the broker as the agent user** — the agent then owns the secret store and the process; there is no boundary left.
- **Adding the agent to the *service* group (`gh-broker`)** — it only needs its own agent group (`gh-broker-agent-<user>`). Membership in `gh-broker` grants traversal into `/etc/gh-broker`. Keep these groups distinct and put the agent in its agent group only.
- **Adding one agent to another's group** — that hands it the other agent's socket, and with it that agent's OTP windows and lock state.
- **Granting the agent read on `/etc/gh-broker/creds`** "for convenience" — the whole point is that it can't.
- **A rootful `docker` group for the agent** — see above; it's a silent root-equivalent escape around the socket.

## See also

- `deploy/README.md` — prerequisites, provisioning, the systemd unit, and agent wiring.
- The full design + threat model lives outside this repo (the maintainer's `designs/github-mcp-broker.md`).
