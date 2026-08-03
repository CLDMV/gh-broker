import { describe, it, expect, vi, afterEach } from "vitest";
import { audit } from "../src/audit.ts";

describe("audit", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits a single JSON line with a timestamp and the entry fields", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		audit({ tool: "get_me", owner: "cldmv", mode: "read", repo: "cldmv/gh-broker", decision: "forward", ok: true });
		expect(spy).toHaveBeenCalledTimes(1);
		const line = spy.mock.calls[0]![0] as string;
		const parsed = JSON.parse(line);
		expect(parsed).toMatchObject({
			tool: "get_me",
			owner: "cldmv",
			mode: "read",
			repo: "cldmv/gh-broker",
			decision: "forward",
			ok: true
		});
		expect(typeof parsed.ts).toBe("string");
		expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts); // valid ISO timestamp
	});

	it("never emits a token — no cred value or Authorization content in the line", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		// The audit API has no token field; even if a caller mistakenly passed extra
		// fields, only the AuditEntry keys are what the router hands it. Assert the
		// emitted line carries no token-shaped content for the fields it does take.
		audit({ tool: "create_pull_request", owner: "cldmv", mode: "write", repo: "cldmv/x", decision: "custom", ok: true, detail: "done" });
		const line = spy.mock.calls[0]![0] as string;
		expect(line).not.toMatch(/token/i);
		expect(line).not.toMatch(/bearer/i);
		expect(line).not.toMatch(/cred:/);
		const parsed = JSON.parse(line);
		expect(Object.keys(parsed).sort()).toEqual(["decision", "detail", "mode", "ok", "owner", "repo", "tool", "ts"].sort());
	});

	it("emits a minimal deny entry", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		audit({ tool: "rm_rf", decision: "deny", detail: "not in allowlist" });
		const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
		expect(parsed).toMatchObject({ tool: "rm_rf", decision: "deny", detail: "not in allowlist" });
		expect(parsed.owner).toBeUndefined();
	});
});
