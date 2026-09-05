import { describe, it, expect, vi, beforeEach } from "vitest";

// secrets.ts reads the JSON secrets file via node:fs.readFileSync.
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";
import { loadSecretStore } from "../src/secrets.ts";

const mockRead = vi.mocked(readFileSync);
const SECRETS = "/x/secrets.json";

function config(owners: Record<string, unknown> = { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } }, extra: Record<string, unknown> = {}): any {
	return { listen: "unix:/x", upstream: "https://x", tools: [], owners, secrets: { path: SECRETS }, ...extra };
}

/**
 * Serve the secrets file body (object → JSON, or a raw string). fileStore reads
 * exactly one file, so this returns the body unconditionally.
 */
function secretsFile(obj: Record<string, unknown> | string) {
	const body = typeof obj === "string" ? obj : JSON.stringify(obj);
	mockRead.mockReset();
	mockRead.mockReturnValue(body as any);
}

describe("loadSecretStore (file provider)", () => {
	beforeEach(() => mockRead.mockReset());

	it("resolves cred refs from the secrets file", () => {
		secretsFile({ "cldmv-read": "readtok", "cldmv-write": "writetok" });
		const store = loadSecretStore(config());
		expect(store.resolve("cred:cldmv-read")).toBe("readtok");
		expect(store.resolve("cred:cldmv-write")).toBe("writetok");
	});

	it("reads the secrets file once, not per credential", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		const store = loadSecretStore(config());
		expect(mockRead).toHaveBeenCalledTimes(1);
		store.resolve("cred:cldmv-read");
		store.resolve("cred:cldmv-read");
		expect(mockRead).toHaveBeenCalledTimes(1);
	});

	it("throws when the secrets file is unreadable", () => {
		mockRead.mockReset();
		// Only the fileStore read throws; later reads (e.g. vitest error formatting)
		// must not, or they'd mask the wrapped message under test.
		mockRead.mockImplementationOnce(() => {
			throw new Error("ENOENT");
		});
		expect(() => loadSecretStore(config())).toThrow(/cannot read\/parse secrets file/);
	});

	it("throws when the file is not a JSON object", () => {
		secretsFile("[1,2,3]");
		expect(() => loadSecretStore(config())).toThrow(/must be a JSON object/);
	});

	it("throws (eager) when a referenced credential is missing in the file", () => {
		secretsFile({ "cldmv-write": "w" });
		expect(() => loadSecretStore(config())).toThrow(/credential "cldmv-read" missing or empty/);
	});

	it("throws when a referenced credential is empty", () => {
		secretsFile({ "cldmv-read": "", "cldmv-write": "w" });
		expect(() => loadSecretStore(config())).toThrow(/credential "cldmv-read" missing or empty/);
	});

	it("rejects an owner ref that is not cred:<name>", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		expect(() => loadSecretStore(config({ cldmv: { read: "plain-ref", write: "cred:cldmv-write" } }))).toThrow(/must be "cred:<name>"/);
	});

	it("rejects a malformed ref at resolve time", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		const store = loadSecretStore(config());
		expect(() => store.resolve("not-a-cred-ref")).toThrow(/bad credential ref/);
	});

	it("rejects an unknown provider", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		expect(() => loadSecretStore(config(undefined, { secrets: { provider: "vault", path: SECRETS } }))).toThrow(/unknown provider/);
	});
});
