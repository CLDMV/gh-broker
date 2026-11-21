import { describe, it, expect } from "vitest";
import { runCli, USAGE } from "../src/cli/cli.ts";
import { makeDeps } from "./helpers/cli-deps.mjs";

describe("runCli dispatch", () => {
	it("prints usage for no command, -h, --help and help", async () => {
		for (const argv of [[], ["-h"], ["--help"], ["help"]]) {
			const { d, out } = makeDeps();
			expect(await runCli(argv, d)).toBe(0);
			expect(out).toEqual([USAGE]);
		}
		expect(USAGE).toContain("agent add <user>");
		expect(USAGE).toContain("agent reconnect [<user>]");
		expect(USAGE).toContain("upgrade [flags]");
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
		expect(await runCli(["agent", "reconnect"], d)).toBe(1);
		expect(err[1]).toContain("must run as root: sudo gh-broker agent reconnect");
		expect(await runCli(["upgrade"], d)).toBe(1);
		expect(err[2]).toContain("must run as root: sudo gh-broker upgrade");
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

	it("routes agent reconnect and upgrade", async () => {
		const { d, out } = makeDeps();
		expect(await runCli(["agent", "reconnect", "--dry-run"], d)).toBe(0);
		expect(out).toContain("repo: no Claude Code sessions running (no tmux server)");
		expect(await runCli(["upgrade", "--no-reconnect"], d)).toBe(0);
		expect(d.npmInstall).toHaveBeenCalledWith("latest");
		expect(d.runNewInstall).toHaveBeenCalledWith([]);
		expect(out.join("\n")).toContain("==> step 2/2: install");
		// bare "upgrade": no subcommand, just flags after it
		const bare = makeDeps();
		expect(await runCli(["upgrade"], bare.d)).toBe(0);
		expect(bare.d.npmInstall).toHaveBeenCalledWith("latest");
	});

	it("reports a reconnect or upgrade failure as gh-broker agent reconnect / upgrade", async () => {
		const reconnect = makeDeps({ groups: () => [] });
		expect(await runCli(["agent", "reconnect", "nobody"], reconnect.d)).toBe(1);
		expect(reconnect.err[0]).toBe("gh-broker agent reconnect: \"nobody\" is not a registered agent");
		const upgrade = makeDeps({ npmInstall: () => { throw new Error("npm ERR! network"); } });
		expect(await runCli(["upgrade"], upgrade.d)).toBe(1);
		expect(upgrade.err[0]).toBe("step 1/3 (npm install) failed: npm ERR! network");
	});
});
