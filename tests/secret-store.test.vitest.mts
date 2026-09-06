import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true), readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";
import { readSecretsFile, referencedCredNames } from "../deploy/lib/secret-store.mjs";

const mockRead = vi.mocked(readFileSync);

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
});
