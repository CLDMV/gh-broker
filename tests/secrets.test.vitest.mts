import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// secrets.ts reads the JSON secrets file via node:fs.readFileSync.
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";
import { loadSecretStore } from "../src/secrets.ts";

const mockRead = vi.mocked(readFileSync);
const SECRETS = "/x/secrets.json";

function config(owners: Record<string, unknown> = { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } }, extra: Record<string, unknown> = {}): any {
	return { listen: "unix:/x", upstream: "https://x", tools: [], owners, secrets: { provider: "file", path: SECRETS }, ...extra };
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

	it("strips a single trailing newline (matches the systemd-creds provider)", () => {
		secretsFile({ "cldmv-read": "readtok\n", "cldmv-write": "writetok\r\n" });
		const store = loadSecretStore(config());
		expect(store.resolve("cred:cldmv-read")).toBe("readtok");
		expect(store.resolve("cred:cldmv-write")).toBe("writetok");
	});

	it("rejects a credential that is only a newline (empty after normalization)", () => {
		secretsFile({ "cldmv-read": "\n", "cldmv-write": "w" });
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

	it("rejects an owner cred name with a path separator (traversal guard)", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		expect(() => loadSecretStore(config({ cldmv: { read: "cred:../../etc/shadow", write: "cred:cldmv-write" } }))).toThrow(/unsafe credential name/);
	});

	it("rejects an unsafe cred name at resolve time", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		const store = loadSecretStore(config());
		expect(() => store.resolve("cred:..")).toThrow(/unsafe credential name/);
		expect(() => store.resolve("cred:a/b")).toThrow(/unsafe credential name/);
	});

	it("rejects an unknown provider", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		expect(() => loadSecretStore(config(undefined, { secrets: { provider: "vault", path: SECRETS } }))).toThrow(/unknown provider/);
	});

	it("rejects a non-cred config.app.privateKey (would inline a secret in the config)", () => {
		secretsFile({ "cldmv-read": "r", "cldmv-write": "w" });
		expect(() => loadSecretStore(config(undefined, { app: { appId: 1, privateKey: "-----BEGIN PRIVATE KEY-----" } }))).toThrow(
			/config.app.privateKey must be a "cred:<name>" ref/
		);
	});
});

describe("loadSecretStore (systemd-creds provider, the default)", () => {
	const CREDS = "/run/creds";
	const original = process.env.CREDENTIALS_DIRECTORY;
	function scConfig(): any {
		return {
			listen: "unix:/x",
			upstream: "https://x",
			tools: [],
			owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } },
			secrets: { provider: "systemd-creds" }
		};
	}

	beforeEach(() => {
		mockRead.mockReset();
		process.env.CREDENTIALS_DIRECTORY = CREDS;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.CREDENTIALS_DIRECTORY;
		else process.env.CREDENTIALS_DIRECTORY = original;
	});

	it("throws when $CREDENTIALS_DIRECTORY is unset", () => {
		delete process.env.CREDENTIALS_DIRECTORY;
		expect(() => loadSecretStore(scConfig())).toThrow(/\$CREDENTIALS_DIRECTORY unset/);
	});

	it("resolves creds from $CREDENTIALS_DIRECTORY, stripping a trailing newline", () => {
		mockRead.mockImplementation((p: any) => {
			if (String(p).endsWith("cldmv-read")) return "rtok\n" as any;
			if (String(p).endsWith("cldmv-write")) return "wtok" as any;
			throw new Error(`ENOENT: ${p}`);
		});
		const store = loadSecretStore(scConfig());
		expect(store.resolve("cred:cldmv-read")).toBe("rtok");
		expect(store.resolve("cred:cldmv-write")).toBe("wtok");
	});
});
