import { describe, it, expect } from "vitest";
import { parseGhcrConfig, ghcrCredRefs, imageAllowed, imageGlobToRegExp, DEFAULT_MAX_ARCHIVE_BYTES } from "../src/verbs/ghcr/config.ts";

const good = (over: Record<string, unknown> = {}, owner: Record<string, unknown> = {}) => ({
	dropDir: "/srv/gh-broker/ghcr-drop",
	owners: { CLDMV: { username: "Shinrai", credential: "cred:cldmv-packages", images: ["hoot", "hoot-worker-*"], ...owner } },
	...over
});

describe("parseGhcrConfig", () => {
	it("accepts a valid block, lowercases owners and applies defaults", () => {
		const c = parseGhcrConfig(good());
		expect(c).toEqual({
			dropDir: "/srv/gh-broker/ghcr-drop",
			protectReleaseTags: true,
			maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
			owners: { cldmv: { username: "Shinrai", credential: "cred:cldmv-packages", images: ["hoot", "hoot-worker-*"] } }
		});
	});

	it("honours protectReleaseTags: false and maxArchiveBytes, and strips a trailing slash", () => {
		const c = parseGhcrConfig(good({ dropDir: "/srv/drop/", protectReleaseTags: false, maxArchiveBytes: 1024 }));
		expect(c.dropDir).toBe("/srv/drop");
		expect(c.protectReleaseTags).toBe(false);
		expect(c.maxArchiveBytes).toBe(1024);
	});

	it.each([
		[null, /must be an object/],
		[[], /must be an object/],
		[{ ...good(), image: [] }, /unknown key\(s\) image/],
		[good({ dropDir: "relative/dir" }), /absolute path/],
		[good({ dropDir: 7 }), /absolute path/],
		[good({ dropDir: "/srv/../etc/x" }), /normalized/],
		[good({ dropDir: "/srv//x" }), /normalized/],
		[good({ dropDir: "/srv" }), /two levels deep/],
		[good({ dropDir: "/" }), /two levels deep|normalized/],
		[good({ dropDir: "/etc/gh-broker" }), /may not be under \/etc/],
		[good({ dropDir: "/home/repo/drop" }), /may not be under \/home/],
		[good({ dropDir: "/tmp/drop" }), /may not be under \/tmp/],
		[good({ dropDir: "/run/gh-broker" }), /may not be under \/run/],
		[good({ protectReleaseTags: "yes" }), /protectReleaseTags: must be a boolean/],
		[good({ maxArchiveBytes: 0 }), /maxArchiveBytes/],
		[good({ maxArchiveBytes: 1.5 }), /maxArchiveBytes/],
		[good({ owners: {} }), /at least one owner/],
		[good({ owners: [] }), /at least one owner/],
		[good({ owners: { "bad owner": {} } }), /not a valid GitHub owner name/],
		[good({ owners: { cldmv: "x" } }), /must be an object/]
	])("refuses %j", (raw, re) => {
		expect(() => parseGhcrConfig(raw)).toThrow(re);
	});

	it.each([
		[{ extra: 1 }, /unknown key\(s\) extra/],
		[{ username: "" }, /username/],
		[{ username: "bad name" }, /username/],
		[{ credential: "cldmv-packages" }, /credential: must be a "cred:<name>" ref/],
		[{ credential: "cred:../x" }, /credential/],
		[{ credential: "cred:.." }, /credential/],
		[{ images: [] }, /non-empty list/],
		[{ images: "hoot" }, /non-empty list/],
		[{ images: ["Hoot"] }, /not a valid image name or glob/],
		[{ images: ["hoot/"] }, /not a valid image name or glob/],
		[{ images: [7] }, /not a valid image name or glob/],
		[{ images: ["a".repeat(256)] }, /not a valid image name or glob/]
	])("refuses owner fields %j", (owner, re) => {
		expect(() => parseGhcrConfig(good({}, owner))).toThrow(re);
	});
});

describe("image globs", () => {
	const owner = { username: "u", credential: "cred:x", images: ["hoot", "hoot-worker-*", "tools/*.cli"] };

	it("matches exact names and `*` within one segment only", () => {
		expect(imageAllowed(owner, "hoot")).toBe(true);
		expect(imageAllowed(owner, "hoot-worker-")).toBe(true);
		expect(imageAllowed(owner, "hoot-worker-render")).toBe(true);
		expect(imageAllowed(owner, "tools/x.cli")).toBe(true);
		expect(imageAllowed(owner, "hoot-worker-a/b")).toBe(false);
		expect(imageAllowed(owner, "hootx")).toBe(false);
		expect(imageAllowed(owner, "tools/xcli")).toBe(false); // "." is literal, not a regex wildcard
		expect(imageAllowed(owner, "other")).toBe(false);
	});

	it("escapes regex metacharacters", () => {
		expect(imageGlobToRegExp("a.b-c").test("aXb-c")).toBe(false);
		expect(imageGlobToRegExp("a.b-c").test("a.b-c")).toBe(true);
	});
});

describe("ghcrCredRefs", () => {
	it("lists each owner's credential ref, or nothing without a block", () => {
		expect(ghcrCredRefs(undefined)).toEqual([]);
		expect(ghcrCredRefs(parseGhcrConfig(good()))).toEqual(["cred:cldmv-packages"]);
	});
});
