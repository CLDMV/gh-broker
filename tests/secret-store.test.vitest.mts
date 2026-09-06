import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	statSync: vi.fn(() => ({ size: 8 })),
	rmSync: vi.fn()
}));

import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { readSecretsFile, removeSecretsFile, referencedCredNames } from "../deploy/lib/secret-store.mjs";

const mockRead = vi.mocked(readFileSync);
const mockExists = vi.mocked(existsSync);
const mockWrite = vi.mocked(writeFileSync);
const mockRm = vi.mocked(rmSync);

describe("readSecretsFile", () => {
	beforeEach(() => mockRead.mockReset());

	it("keeps only non-empty string values (drops numbers/objects/empties)", () => {
		mockRead.mockReturnValue(JSON.stringify({ a: "tok", b: 123, c: "", d: { x: 1 }, e: "ok" }) as any);
		expect(readSecretsFile("/x")).toEqual({ a: "tok", e: "ok" });
	});

	it("returns {} for a non-object or unparseable file", () => {
		mockRead.mockReturnValue("[1,2,3]" as any);
		expect(readSecretsFile("/x")).toEqual({});
		mockRead.mockReturnValue("not json" as any);
		expect(readSecretsFile("/x")).toEqual({});
	});
});

describe("removeSecretsFile", () => {
	beforeEach(() => {
		mockExists.mockReset().mockReturnValue(true);
		mockWrite.mockReset();
		mockRm.mockReset();
	});

	it("zero-overwrites then unlinks an existing file", () => {
		removeSecretsFile("/x/secrets.json");
		expect(mockWrite).toHaveBeenCalledTimes(1);
		const buf = mockWrite.mock.calls[0][1] as Buffer;
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect(buf.every((b) => b === 0)).toBe(true);
		expect(mockRm).toHaveBeenCalledWith("/x/secrets.json", { force: true });
	});

	it("is a no-op when the file is absent", () => {
		mockExists.mockReturnValue(false);
		removeSecretsFile("/x/secrets.json");
		expect(mockWrite).not.toHaveBeenCalled();
		expect(mockRm).not.toHaveBeenCalled();
	});
});

describe("referencedCredNames", () => {
	it("collects distinct cred names from owners + app, ignoring non-cred refs", () => {
		const cfg = {
			owners: { o1: { read: "cred:a", write: "cred:b" }, o2: { read: "cred:a", write: "cred:c" } },
			app: { privateKey: "cred:k" }
		};
		expect(referencedCredNames(cfg).sort()).toEqual(["a", "b", "c", "k"]);
	});

	it("returns [] with no owners", () => {
		expect(referencedCredNames({})).toEqual([]);
	});

	it("rejects an unsafe cred name (path separator / traversal)", () => {
		expect(() => referencedCredNames({ owners: { o: { read: "cred:../x", write: "cred:ok" } } })).toThrow(/unsafe credential name/);
		expect(() => referencedCredNames({ owners: { o: { read: "cred:a/b", write: "cred:ok" } } })).toThrow(/unsafe credential name/);
	});
});
