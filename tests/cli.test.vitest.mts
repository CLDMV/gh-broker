import { describe, it, expect } from "vitest";
import { runCli, USAGE } from "../deploy/lib/cli.mjs";
import { makeDeps } from "./helpers/cli-deps.mjs";

describe("runCli dispatch", () => {
	it("prints usage for no command, -h, --help and help", async () => {
		for (const argv of [[], ["-h"], ["--help"], ["help"]]) {
			const { d, out } = makeDeps();
			expect(await runCli(argv, d)).toBe(0);
			expect(out).toEqual([USAGE]);
		}
		expect(USAGE).toContain("agent add <user>");
		expect(USAGE).toContain("otp unlock <user>|--all");
	});

	it("refuses an unknown command", async () => {
		for (const argv of [["otp"], ["otp", "frob"], ["frob", "unlock"], ["agent", "unlock"], ["install"]]) {
			const { d, err } = makeDeps();
			expect(await runCli(argv, d)).toBe(2);
			expect(err[0]).toContain("unknown command");
		}
	});

	it("refuses to run unless root", async () => {
		const { d, err } = makeDeps({ isRoot: () => false });
		expect(await runCli(["otp", "status"], d)).toBe(1);
		expect(err[0]).toContain("must run as root: sudo gh-broker otp status");
	});

	it("reports an unreadable config", async () => {
		const { d, err } = makeDeps({ readConfig: () => { throw new Error("ENOENT"); } });
		expect(await runCli(["agent", "list"], d)).toBe(1);
		expect(err[0]).toContain("cannot read the broker config: ENOENT");
	});

	it("turns a command failure into an error and exit 1", async () => {
		const { d, err } = makeDeps({ readState: () => { throw new Error("EACCES"); } });
		expect(await runCli(["otp", "status"], d)).toBe(1);
		expect(err[0]).toBe("gh-broker otp status: EACCES");
	});

	it("routes agent commands", async () => {
		const { d, out } = makeDeps();
		expect(await runCli(["agent", "list"], d)).toBe(0);
		expect(out.join("\n")).toContain("repo  /run/gh-broker/agents/repo.sock");
	});
});
