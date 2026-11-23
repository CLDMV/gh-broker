import { vi } from "vitest";
import { PassThrough } from "node:stream";
import { emptyState } from "../../src/cli/otp.ts";

export const NOW = Date.parse("2026-11-01T12:05:00.000Z");
export const GROUPS = [
	{ name: "gh-broker-agent-repo", gid: 990, members: ["gh-broker", "repo"] },
	{ name: "gh-broker-agent-glmtest", gid: 991, members: ["gh-broker"] }
];
export const config = { listen: "agents:/run/gh-broker/agents", otp: { seed: "cred:otp-seed" } };

/** Fake effects for the CLI (src/cli/cli.ts). `files` is the agent users' ~/.claude.json contents by path. */
export function makeDeps(over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const writes: Array<[string, string]> = [];
	const d: any = {
		log: (m: string) => out.push(m),
		error: (m: string) => err.push(m),
		isRoot: () => true,
		host: () => "box",
		readConfig: () => config,
		groups: () => GROUPS,
		userInfo: vi.fn((u: string) => (u === "ghost" ? undefined : { uid: 1000, gid: 1000, home: `/home/${u}` })),
		ensureGroup: vi.fn(),
		removeGroup: vi.fn(),
		mcpIO: {
			read: (p: string) => (files[p] === undefined ? undefined : { text: files[p], stat: { uid: 1000, gid: 1000, mode: 0o100600 } }),
			write: (p: string, text: string) => {
				files[p] = text;
				writes.push([p, text]);
			}
		},
		socketExists: vi.fn(() => true),
		binaryExists: vi.fn(() => true),
		smoke: vi.fn(async () => ({ tools: [1, 2, 3] })),
		versions: () => ({ pkg: "1.0.0", deployed: "1.0.0" }),
		readState: vi.fn(() => ({ status: "ok", state: emptyState() })),
		writeState: vi.fn(),
		newSeed: () => "NEWSEED",
		storeSeed: vi.fn(),
		restart: vi.fn(),
		tmuxSockets: vi.fn(() => ({ servers: [], skipped: [] })),
		tmuxPanes: vi.fn(() => []),
		tmuxPaneText: vi.fn(() => "❯ \n"),
		tmuxSend: vi.fn(),
		// A fake clock that starts at NOW; sleep (reconnect --wait) advances it, nothing really waits.
		clock: { t: NOW },
		now: vi.fn(() => d.clock.t),
		sleep: vi.fn((ms: number) => {
			d.clock.t += ms;
		}),
		startBackground: vi.fn(),
		installedVersion: () => undefined,
		deployedVersion: () => undefined,
		latestVersion: () => undefined,
		npmInstall: vi.fn(),
		runNewBinary: vi.fn(),
		qr: async () => "QR",
		sudoUser: () => "admin",
		audit: vi.fn(),
		// The connect bridge's effects: a stdin that is already at EOF (so a dispatched `connect`
		// runs and returns at once), dials that fail, and logs that go to the same `out`.
		connectDeps: {
			stdin: (() => {
				const s = new PassThrough();
				s.end();
				return s;
			})(),
			stdout: new PassThrough(),
			log: (m: string) => out.push(m),
			connect: vi.fn(() => Promise.reject(new Error("ENOENT"))),
			// a real (tiny) timer: a sleep that resolves on the microtask queue alone would let the
			// bridge's retry loop starve the event loop, and the already-ended stdin's 'end' never fires
			sleep: vi.fn((ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))))
		},
		...over
	};
	return { d, out, err, files, writes };
}
