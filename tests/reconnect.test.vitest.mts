import { describe, it, expect, vi } from "vitest";
import { busyPane, composerState, reconnect } from "../src/cli/reconnect.ts";
import { brokerKeyOf, mcpEntry, SkippedFolder } from "../src/cli/mcp-config.ts";
import type { Pane } from "../src/cli/tmux.ts";
import { makeDeps, config, GROUPS } from "./helpers/cli-deps.mjs";

const DIR = "/run/gh-broker/agents";
const SOCK = "/tmp/tmux-1000/default";
const claude = (u: string) => `/home/${u}/.claude.json`;
const entry = JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } });

// Captured pane text (tmux capture-pane -p), shaped like real Claude Code screens.
const IDLE = `● Used 1 reference
  ⎿  Read src/cli/agents.ts (140 lines)

>
  ? for shortcuts`;
const TYPING = `● Used 1 reference

> fix the reconnect test
  ? for shortcuts`;
const BUSY = `● Bash(npm test)
  ⎿  142 tests passed

✻ Wrangling… (esc to interrupt · 18s · ↑ 2.1k tokens)`;
const DIALOG = `Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for Bash commands in /srv/repos/gh-broker
  3. No, and tell Claude what to do differently (esc)`;
const BASH_MODE = `!
  ! for bash mode`;
const TRANSCRIPT_AND_IDLE = `> what changed in v0.12.0

● Read docs/changelog/v0/v0.12.0.md
  ⎿  62 lines

>
  ? for shortcuts`;

describe("brokerKeyOf (what mcp-config wrote, read back)", () => {
	it("reads the broker entry's key out of a .claude.json text, or none", () => {
		expect(brokerKeyOf(JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR), x: { command: "npx" } } }), DIR)).toBe("github");
		expect(brokerKeyOf(JSON.stringify({ mcpServers: { x: { command: "npx" } } }), DIR)).toBeUndefined();
		expect(brokerKeyOf("{nope", DIR)).toBeUndefined();
		expect(brokerKeyOf("[]", DIR)).toBeUndefined();
		expect(brokerKeyOf(undefined, DIR)).toBeUndefined();
	});
});

describe("busyPane (heuristic over Claude Code's screen)", () => {
	it("sees the working indicator in its shapes", () => {
		expect(busyPane(BUSY)).toBe(true);
		expect(busyPane("✻ Thinking…")).toBe(true);
		expect(busyPane("· Scanning the repo… (esc to interrupt)")).toBe(true);
		expect(busyPane("  Working (esc to interrupt · 4s)")).toBe(true);
	});

	it("leaves an idle, dialog or typing pane alone", () => {
		expect(busyPane(IDLE)).toBe(false);
		expect(busyPane(TYPING)).toBe(false);
		expect(busyPane(DIALOG)).toBe(false);
		expect(busyPane(BASH_MODE)).toBe(false);
	});

	it("is not fooled by transcript lines", () => {
		expect(busyPane("  ⎿  Running tests…")).toBe(false);
		expect(busyPane("● Bash(npm test…)")).toBe(false);
		expect(busyPane("  - fix the thing that hangs…")).toBe(false);
	});
});

describe("composerState (heuristic over Claude Code's screen)", () => {
	it("reads the input line", () => {
		expect(composerState(IDLE)).toBe("empty");
		expect(composerState(TYPING)).toBe("typing");
		expect(composerState("> /mcp")).toBe("typing");
	});

	it("sees no input line in a dialog or another input mode", () => {
		expect(composerState(DIALOG)).toBe("none");
		expect(composerState(BASH_MODE)).toBe("none");
		expect(composerState("")).toBe("none");
	});

	it("takes the bottom-most > line, so a user message in the transcript doesn't count", () => {
		expect(composerState(TRANSCRIPT_AND_IDLE)).toBe("empty");
		expect(composerState(`${TRANSCRIPT_AND_IDLE}\n> and one more thing`)).toBe("typing");
	});
});

describe("agent reconnect", () => {
	/** Deps whose tmux has `panes` on SOCK, with the agent's home config planted. */
	function withPanes(panes: Pane[], over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
		return makeDeps({ tmuxSockets: () => [SOCK], tmuxPanes: (socket: string) => (socket === SOCK ? panes : []), ...over }, { [claude("repo")]: entry, ...files });
	}
	const pane = (id: string, text: string, over: Partial<Pane> = {}): Pane => ({ id, pid: 200, text, ...over });
	const fileIO = (files: Record<string, string>) => ({
		read: (p: string) => (files[p] === undefined ? undefined : { text: files[p], stat: { uid: 1000, gid: 1000, mode: 0o100600 } }),
		write: (_p: string, _t: string) => {}
	});

	it("sends /mcp reconnect with the agent's own key, lists the skipped one, and exits 1 for the skip", () => {
		const { d, out } = withPanes([pane("%3", IDLE), pane("%4", TYPING)]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).toHaveBeenCalledTimes(1);
		expect(d.tmuxSend).toHaveBeenCalledWith(SOCK, "%3", "/mcp reconnect github");
		expect(out).toContain(`repo ${SOCK} %3 github sent`);
		expect(out).toContain(`repo ${SOCK} %4 github skipped (composer not empty)`);
		expect(out[out.length - 1]).toBe("sent 1, skipped 1");
	});

	it("--dry-run lists what it would send where, and sends nothing", () => {
		const { d, out } = withPanes([pane("%3", IDLE)]);
		expect(reconnect(["repo", "--dry-run"], config, d)).toBe(0);
		expect(d.tmuxSend).not.toHaveBeenCalled();
		expect(out).toContain(`repo ${SOCK} %3 github would send`);
		expect(out[out.length - 1]).toBe('dry run: 1 pane(s) would get "/mcp reconnect"');
	});

	it("skips a busy pane, one with text in the composer, and one without a prompt, with the pane id", () => {
		const { d, out } = withPanes([pane("%1", BUSY), pane("%2", TYPING), pane("%3", DIALOG)]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).not.toHaveBeenCalled();
		expect(out).toContain(`repo ${SOCK} %1 github skipped (busy: Claude is working)`);
		expect(out).toContain(`repo ${SOCK} %2 github skipped (composer not empty)`);
		expect(out).toContain(`repo ${SOCK} %3 github skipped (no Claude Code prompt on screen)`);
		expect(out[out.length - 1]).toBe("sent 0, skipped 3");
	});

	it("skips a pane when none of the agent's files has a broker entry", () => {
		const { d, out } = withPanes([pane("%3", IDLE)], {}, { [claude("repo")]: JSON.stringify({ mcpServers: { x: { command: "npx" } } }) });
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} %3 - skipped (no broker MCP entry in its .claude.json files)`);
	});

	it("prefers the key in the session's own config folder, then the home file's", () => {
		const ALT = "/home/repo/.claude-alt";
		const files = { [claude("repo")]: entry, [`${ALT}/.claude.json`]: JSON.stringify({ mcpServers: { "gh-broker-repo": mcpEntry("repo", DIR) } }) };
		const { d, out } = makeDeps(
			{ tmuxSockets: () => [SOCK], tmuxPanes: () => [pane("%1", IDLE, { configDir: ALT }), pane("%2", IDLE)], mcpIO: { ...fileIO(files), scan: (home: string) => (home === "/home/repo" ? [ALT] : []) } },
			files
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 gh-broker-repo sent`);
		expect(out).toContain(`repo ${SOCK} %2 github sent`);
	});

	it("falls back to a broker entry in any of the agent's folders when the home file has none", () => {
		const SAVED = "/data/claude-saved";
		const files = { [claude("repo")]: JSON.stringify({ mcpServers: { x: { command: "npx" } } }), [`${SAVED}/.claude.json`]: JSON.stringify({ mcpServers: { "gh-broker": mcpEntry("repo", DIR) } }) };
		const { d, out } = makeDeps(
			{ tmuxSockets: () => [SOCK], tmuxPanes: () => [pane("%1", IDLE)], mcpIO: { ...fileIO(files), scan: () => [] } },
			files
		);
		expect(reconnect(["repo"], { ...config, claudeConfigDirs: { repo: [SAVED] } }, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 gh-broker sent`);
	});

	it("carries on when a folder root won't be read", () => {
		const BROKEN = "/home/repo/.claude-broken";
		const { d, out } = makeDeps(
			{
				tmuxSockets: () => [SOCK],
				tmuxPanes: () => [pane("%1", IDLE)],
				mcpIO: {
					...fileIO({ [claude("repo")]: entry }),
					scan: () => [BROKEN],
					pin: (folder: string) => {
						throw new SkippedFolder(`${folder} is owned by uid 0, not the agent user (uid 1000)`);
					}
				}
			},
			{ [claude("repo")]: entry }
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 github sent`);
	});

	it("lists panes from every tmux server the agent runs, with the socket in the line", () => {
		const OTHER = "/home/repo/.tmux/claude";
		const { d, out } = makeDeps(
			{ tmuxSockets: () => [SOCK, OTHER], tmuxPanes: (socket: string) => (socket === SOCK ? [pane("%1", IDLE)] : socket === OTHER ? [pane("%7", IDLE)] : []) },
			{ [claude("repo")]: entry }
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 github sent`);
		expect(out).toContain(`repo ${OTHER} %7 github sent`);
	});

	it("covers every registered agent when none is named", () => {
		const { d, out } = makeDeps({ tmuxSockets: () => [] }, { [claude("repo")]: entry });
		expect(reconnect([], config, d)).toBe(0);
		expect(out).toContain("repo: no Claude Code sessions running (no tmux server)");
		expect(out).toContain("glmtest: no Claude Code sessions running (no tmux server)");
	});

	it("says when a tmux server runs but no pane is Claude Code", () => {
		const { d, out } = withPanes([]);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain("repo: no Claude Code sessions running");
		expect(out[out.length - 1]).toBe("sent 0, skipped 0");
	});

	it("keeps going when a send fails, and counts it as skipped", () => {
		const { d, out } = withPanes([pane("%1", IDLE), pane("%2", IDLE)], { tmuxSend: vi.fn((_s: string, p: string) => { if (p === "%1") throw new Error("pane died"); }) });
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).toHaveBeenCalledTimes(2);
		expect(out).toContain(`repo ${SOCK} %1 github skipped (send failed: pane died)`);
		expect(out).toContain(`repo ${SOCK} %2 github sent`);
	});

	it("reports a registered agent with no user account and exits 1", () => {
		const groups = [...GROUPS, { name: "gh-broker-agent-ghost", gid: 992, members: ["gh-broker", "ghost"] }];
		const { d, err } = makeDeps({ groups: () => groups, tmuxSockets: () => [] });
		expect(reconnect([], config, d)).toBe(1);
		expect(err).toEqual(["ghost: no such user"]);
	});

	it("refuses an unregistered or invalid user, two users, and unknown flags", () => {
		const { d } = withPanes([], { tmuxSockets: vi.fn(() => []) });
		expect(() => reconnect(["nobody"], config, d)).toThrow(/"nobody" is not a registered agent/);
		expect(() => reconnect(["Bad Name"], config, d)).toThrow(/not a valid agent user name/);
		expect(() => reconnect(["repo", "glmtest"], config, d)).toThrow(/name at most one agent user/);
		expect(() => reconnect(["repo", "--json"], config, d)).toThrow("unknown flag: --json");
		expect(d.tmuxSockets).not.toHaveBeenCalled();
	});
});
