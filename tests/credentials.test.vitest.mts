import { describe, it, expect, vi } from "vitest";
import { credentialPlan } from "../deploy/lib/credentials.mjs";

type Opts = Parameters<typeof credentialPlan>[0];

function plan(over: Partial<Opts> = {}, answers: string[] = []) {
	const logs: string[] = [];
	const promptHidden = vi.fn(async () => answers.shift() ?? "");
	const mint = vi.fn(async () => "npm_MINTED");
	const p = credentialPlan({
		needed: ["cldmv-read", "cldmv-write", "npm-token"],
		optional: new Set(["npm-token"]),
		cliSecrets: {},
		imported: {},
		env: {},
		existingFile: {},
		decrypt: () => undefined,
		mints: () => false,
		mint,
		appKeyName: undefined,
		nonInteractive: false,
		promptHidden,
		log: (m: string) => logs.push(m),
		...over
	});
	return { p, logs, promptHidden, mint };
}

/** A fake systemd-creds store: which .cred files exist, and what was encrypted. */
function creds(existing: string[] = []) {
	const files = new Set(existing);
	const written: Record<string, string> = {};
	return {
		written,
		io: {
			exists: (n: string) => files.has(n),
			encrypt: (n: string, v: string) => {
				files.add(n);
				written[n] = v;
			}
		}
	};
}

describe("credentialPlan", () => {
	it("refuses a --secret name the config does not use", () => {
		expect(() => plan({ cliSecrets: { "cldmv-raed": "x" } })).toThrow(/--secret names no credential this config uses: cldmv-raed \(it uses: cldmv-read, cldmv-write, npm-token\)/);
	});

	it("takes an explicit value from --secret, then --secrets-file, then env", () => {
		const env = { GH_BROKER_SECRET_CLDMV_READ: "from-env" };
		expect(plan({ env }).p.explicit("cldmv-read")).toBe("from-env");
		expect(plan({ env, imported: { "cldmv-read": "from-file" } }).p.explicit("cldmv-read")).toBe("from-file");
		expect(plan({ env, imported: { "cldmv-read": "from-file" }, cliSecrets: { "cldmv-read": "from-cli" } }).p.explicit("cldmv-read")).toBe("from-cli");
		expect(plan({ imported: { "cldmv-read": "" }, env: { GH_BROKER_SECRET_CLDMV_READ: "" } }).p.explicit("cldmv-read")).toBeUndefined();
	});

	it("resolves explicit → stored file → decrypt → prompt", async () => {
		expect(await plan({ cliSecrets: { "cldmv-read": "cli" }, existingFile: { "cldmv-read": "old" } }).p.resolve("cldmv-read")).toBe("cli");
		expect(await plan({ existingFile: { "cldmv-read": "old" }, decrypt: () => "dec" }).p.resolve("cldmv-read")).toBe("old");
		const d = plan({ decrypt: () => "dec" });
		expect(await d.p.resolve("cldmv-read")).toBe("dec");
		expect(d.logs).toContain("  cldmv-read: migrated from systemd-creds");
		const prompted = plan({}, ["typed"]);
		expect(await prompted.p.resolve("cldmv-read")).toBe("typed");
		expect(prompted.promptHidden).toHaveBeenCalledWith("  cldmv-read (input hidden): ");
	});

	it("fails a required credential that is missing or left empty", async () => {
		await expect(plan({ nonInteractive: true }).p.resolve("cldmv-read")).rejects.toThrow(/missing credential "cldmv-read" — provide via --secret, --secrets-file or env GH_BROKER_SECRET_CLDMV_READ/);
		await expect(plan({}, [""]).p.resolve("cldmv-read")).rejects.toThrow(/empty value for "cldmv-read"/);
		await expect(plan({ appKeyName: "gh-app-key", needed: ["gh-app-key"] }).p.resolve("gh-app-key")).rejects.toThrow(/GitHub App private key/);
	});

	it("lets an optional credential be skipped, never failing", async () => {
		expect(await plan({ nonInteractive: true }).p.resolve("npm-token")).toBeUndefined();
		const i = plan({}, [""]);
		expect(await i.p.resolve("npm-token")).toBeUndefined();
		expect(i.promptHidden).toHaveBeenCalledWith(expect.stringMatching(/Enter to skip/));
		expect(await plan({}, ["npm_typed"]).p.resolve("npm-token")).toBe("npm_typed");
	});

	it("creates the npm token when this run mints it, unless one is supplied", async () => {
		const m = plan({ mints: (n) => n === "npm-token" });
		expect(await m.p.resolve("npm-token")).toBe("npm_MINTED");
		expect(m.p.replaces("npm-token")).toBe(true);
		const given = plan({ mints: (n) => n === "npm-token", cliSecrets: { "npm-token": "npm_given" } });
		expect(await given.p.resolve("npm-token")).toBe("npm_given");
		expect(given.mint).not.toHaveBeenCalled();
		await expect(plan({ mints: () => true, nonInteractive: true }).p.resolve("npm-token")).rejects.toThrow(/needs a browser login/);
	});

	describe("storeSystemd", () => {
		it("keeps existing creds, encrypts new ones, and lists only what is stored", async () => {
			const c = creds(["cldmv-read"]);
			const { p, logs } = plan({}, ["write-typed", ""]);
			const stored = await p.storeSystemd(c.io);
			expect(stored).toEqual(["cldmv-read", "cldmv-write"]);
			expect(c.written).toEqual({ "cldmv-write": "write-typed" });
			expect(logs).toEqual(["  cldmv-read: existing systemd-creds kept", "  cldmv-write: encrypted (systemd-creds)", "  npm-token: not stored — its tools stay hidden until it is (re-run the installer to add it)"]);
		});

		it("rotates on an explicit value or a plaintext entry, and notes a replaced npm token", async () => {
			const c = creds(["cldmv-read", "cldmv-write", "npm-token"]);
			const { p, logs } = plan({ cliSecrets: { "cldmv-read": "new-read" }, existingFile: { "cldmv-write": "file-write" }, mints: (n) => n === "npm-token" });
			expect(await p.storeSystemd(c.io)).toEqual(["cldmv-read", "cldmv-write", "npm-token"]);
			expect(c.written).toEqual({ "cldmv-read": "new-read", "cldmv-write": "file-write", "npm-token": "npm_MINTED" });
			expect(logs).toContain("  cldmv-read: rotated (systemd-creds)");
			expect(logs.some((l) => /previous npm-token is still valid/.test(l))).toBe(true);
			expect(logs.filter((l) => /previous/.test(l))).toHaveLength(1);
		});
	});

	describe("storeFile", () => {
		it("keeps stored values, fills missing ones, rotates on an explicit value, and skips an optional one", async () => {
			const { p, logs } = plan({ needed: ["cldmv-read", "cldmv-write", "cldmv-new", "npm-token"], existingFile: { "cldmv-read": "old-read", "cldmv-write": "old-write" }, cliSecrets: { "cldmv-write": "new-write", "cldmv-new": "fresh" }, nonInteractive: true });
			expect(await p.storeFile()).toEqual({ "cldmv-read": "old-read", "cldmv-write": "new-write", "cldmv-new": "fresh" });
			expect(logs).toEqual(["  npm-token: not stored — its tools stay hidden until it is (re-run the installer to add it)"]);
		});

		it("replaces a stored npm token with a newly created one and says the old one is still live", async () => {
			const { p, logs } = plan({ existingFile: { "cldmv-read": "r", "cldmv-write": "w", "npm-token": "npm_old" }, mints: (n) => n === "npm-token" });
			expect(await p.storeFile()).toEqual({ "cldmv-read": "r", "cldmv-write": "w", "npm-token": "npm_MINTED" });
			expect(logs.some((l) => /previous npm-token is still valid/.test(l))).toBe(true);
		});
	});
});
