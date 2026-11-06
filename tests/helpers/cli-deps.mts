import { vi } from "vitest";
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
		now: () => NOW,
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
		smoke: vi.fn(async () => ({ tools: [1, 2, 3] })),
		versions: () => ({ pkg: "1.0.0", deployed: "1.0.0" }),
		readState: vi.fn(() => ({ status: "ok", state: emptyState() })),
		writeState: vi.fn(),
		newSeed: () => "NEWSEED",
		storeSeed: vi.fn(),
		restart: vi.fn(),
		qr: async () => "QR",
		sudoUser: () => "admin",
		audit: vi.fn(),
		...over
	};
	return { d, out, err, files, writes };
}
