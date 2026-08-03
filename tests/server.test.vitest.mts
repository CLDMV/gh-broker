import { describe, it, expect } from "vitest";
import { startServer } from "../src/server.ts";

// startServer owns a long-lived net.Server it never hands back, so a successful
// listen can't be cleanly torn down from a unit test. We exercise the safe,
// non-listening paths only: the unsupported-scheme guard (synchronous throw) and
// a listen that fails (bind into a non-existent directory) → promise rejects.
const fakeRouter: any = { call: () => Promise.resolve({ content: [] }) };
const catalog: any[] = [];

describe("startServer", () => {
	it("throws synchronously for a non-unix listen scheme", () => {
		expect(() => startServer({ listen: "tcp:0.0.0.0:9000" } as any, fakeRouter, catalog)).toThrow(/unsupported listen/);
	});

	it("rejects when the socket cannot be bound", async () => {
		const config: any = { listen: "unix:/no/such/dir/gh-broker.sock" };
		await expect(startServer(config, fakeRouter, catalog)).rejects.toBeTruthy();
	});
});
