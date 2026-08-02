import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// secrets.ts reads credential files from $CREDENTIALS_DIRECTORY via node:fs.
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";
import { loadSecretStore } from "../src/secrets.ts";

const mockRead = vi.mocked(readFileSync);

function config(owners: Record<string, unknown> = { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } }): any {
	return { listen: "unix:/x", upstream: "https://x", tools: [], owners };
}

/** Map a credential file path to its contents by trailing name. */
function fileMap(map: Record<string, string>) {
	mockRead.mockImplementation((p: any) => {
		for (const [name, val] of Object.entries(map)) {
			if (String(p).endsWith(name)) return val as any;
		}
		throw new Error(`ENOENT: ${p}`);
	});
}

describe("loadSecretStore", () => {
	const ORIGINAL = process.env.CREDENTIALS_DIRECTORY;

	beforeEach(() => {
		mockRead.mockReset();
		process.env.CREDENTIALS_DIRECTORY = "/run/creds";
	});

	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.CREDENTIALS_DIRECTORY;
		else process.env.CREDENTIALS_DIRECTORY = ORIGINAL;
	});

	it("throws when $CREDENTIALS_DIRECTORY is unset", () => {
		delete process.env.CREDENTIALS_DIRECTORY;
		expect(() => loadSecretStore(config())).toThrow(/\$CREDENTIALS_DIRECTORY unset/);
	});

	it("rejects a credential ref that is not cred:<name>", () => {
		fileMap({ "cldmv-read": "tok" });
		expect(() => loadSecretStore(config({ cldmv: { read: "plain-ref", write: "cred:cldmv-write" } }))).toThrow(
			/owner "cldmv" ref must be "cred:<name>"/
		);
	});

	it("throws when a referenced credential file is unreadable (eager validation)", () => {
		fileMap({ "cldmv-write": "wtok" }); // read is missing → readFileSync throws
		expect(() => loadSecretStore(config())).toThrow(/credential "cldmv-read" not available/);
	});

	it("throws when a credential file is empty", () => {
		fileMap({ "cldmv-read": "", "cldmv-write": "wtok" });
		expect(() => loadSecretStore(config())).toThrow(/credential "cldmv-read" is empty/);
	});

	it("resolves a cred ref, stripping a trailing newline", () => {
		fileMap({ "cldmv-read": "readtok\n", "cldmv-write": "writetok" });
		const store = loadSecretStore(config());
		expect(store.resolve("cred:cldmv-read")).toBe("readtok");
		expect(store.resolve("cred:cldmv-write")).toBe("writetok");
	});

	it("caches reads — the file is read once across eager validation and resolve", () => {
		fileMap({ "cldmv-read": "readtok", "cldmv-write": "writetok" });
		const store = loadSecretStore(config());
		expect(mockRead).toHaveBeenCalledTimes(2); // one per referenced cred at startup
		store.resolve("cred:cldmv-read");
		store.resolve("cred:cldmv-read");
		expect(mockRead).toHaveBeenCalledTimes(2); // served from cache, no new reads
	});

	it("rejects a malformed ref at resolve time", () => {
		fileMap({ "cldmv-read": "readtok", "cldmv-write": "writetok" });
		const store = loadSecretStore(config());
		expect(() => store.resolve("not-a-cred-ref")).toThrow(/bad credential ref "not-a-cred-ref"/);
	});
});
