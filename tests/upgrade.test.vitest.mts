import { describe, it, expect } from "vitest";
import { finishLines, parseUpgradeArgs, semverHead, semverLess, shellQuote, upgradeCommand, upgradeSteps, UPGRADE_HELP, type UpgradeStep } from "../src/cli/upgrade.ts";
import { makeDeps, config } from "./helpers/cli-deps.mjs";

describe("parseUpgradeArgs", () => {
	it("takes its own flags out and passes the rest through verbatim", () => {
		expect(parseUpgradeArgs(["--force", "--no-reconnect", "--claude-config", "repo:/srv/x", "--no-mcp-config"])).toEqual({
			force: true,
			noReconnect: true,
			installFlags: ["--claude-config", "repo:/srv/x", "--no-mcp-config"]
		});
	});

	it("reads --version with or without a leading v, prereleases included, and takes nothing else", () => {
		expect(parseUpgradeArgs(["--version", "0.12.1"]).version).toBe("0.12.1");
		expect(parseUpgradeArgs(["--version", "v0.12.1"]).version).toBe("0.12.1");
		expect(parseUpgradeArgs(["--version", "0.13.0-rc.1+build.2"]).version).toBe("0.13.0-rc.1+build.2");
		// npm would treat any of these as a spec that can run code: dist-tags, URLs, git and file paths.
		for (const v of ["latest", "next", "https://evil/x", "git+ssh://x", "file:../x", "", "0.12"]) {
			expect(() => parseUpgradeArgs(["--version", v])).toThrow(/--version takes a semantic version/);
		}
		expect(() => parseUpgradeArgs(["--version"])).toThrow(/--version takes a semantic version/);
		expect(() => parseUpgradeArgs(["--version", "--force"])).toThrow(/--version takes a semantic version/);
	});

	it("knows -h and --help", () => {
		expect(parseUpgradeArgs(["-h"]).help).toBe(true);
		expect(parseUpgradeArgs(["--help"]).help).toBe(true);
	});
});

describe("semverHead / semverLess", () => {
	it("compares numerically, so 0.9 < 0.10", () => {
		expect(semverLess("0.9.0", "0.10.0")).toBe(true);
		expect(semverLess("0.10.0", "0.9.0")).toBe(false);
		expect(semverLess("1.2.3", "1.2.3")).toBe(false);
		expect(semverLess("1.2.3", "1.2.4-rc.1")).toBe(true);
		expect(semverLess("nonsense", "0.9.0")).toBe(false);
		expect(semverHead("0.12.1-rc.1")).toEqual([0, 12, 1]);
		expect(semverHead("latest")).toBeUndefined();
	});
});

describe("shellQuote", () => {
	it("leaves plain arguments alone and quotes the rest", () => {
		expect(shellQuote("--claude-config")).toBe("--claude-config");
		expect(shellQuote("repo:/srv/x")).toBe("repo:/srv/x");
		expect(shellQuote("/srv/my dir")).toBe("'/srv/my dir'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe("upgradeSteps / finishLines", () => {
	it("lists the three steps with the commands to run them by hand, install flags quoted", () => {
		const steps = upgradeSteps("latest", ["--claude-config", "repo:/srv/x", "--agent-user", "my repo"], true);
		expect(steps).toEqual([
			{ name: "npm install", command: "sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@latest" },
			{ name: "install", command: "sudo gh-broker install --claude-config repo:/srv/x --agent-user 'my repo'" },
			{ name: "agent reconnect", command: "sudo gh-broker agent reconnect" }
		]);
		expect(upgradeSteps("0.12.1", [], true)[0]!.command).toContain("@cldmv/gh-broker@0.12.1");
		expect(upgradeSteps("latest", [], false)).toHaveLength(2);
	});

	it("pins the failure report: which step failed, then the failed and remaining commands", () => {
		const steps: UpgradeStep[] = [
			{ name: "npm install", command: "sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@latest" },
			{ name: "install", command: "sudo gh-broker install" },
			{ name: "agent reconnect", command: "sudo gh-broker agent reconnect" }
		];
		expect(finishLines(steps, 0, "npm ERR! E404")).toEqual([
			"step 1/3 (npm install) failed: npm ERR! E404",
			"finish by running:",
			"  sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@latest",
			"  sudo gh-broker install",
			"  sudo gh-broker agent reconnect"
		]);
		expect(finishLines(steps, 2, "some panes were skipped (see above)")).toEqual([
			"step 3/3 (agent reconnect) failed: some panes were skipped (see above)",
			"finish by running:",
			"  sudo gh-broker agent reconnect"
		]);
	});
});

describe("upgradeCommand", () => {
	it("validates the install flags before anything runs, and refuses positionals", () => {
		const badFlag = makeDeps();
		expect(() => upgradeCommand(["--claude-config", "no-colon-path"], config, badFlag.d)).toThrow(/install flags: --claude-config takes/);
		expect(badFlag.d.npmInstall).not.toHaveBeenCalled();
		expect(badFlag.d.runNewBinary).not.toHaveBeenCalled();
		const positional = makeDeps();
		expect(() => upgradeCommand(["bob"], config, positional.d)).toThrow(/upgrade takes only flags/);
		expect(positional.d.npmInstall).not.toHaveBeenCalled();
	});

	it("runs the three steps in order: npm install, the new binary's install with the flags, its reconnect", () => {
		const order: string[] = [];
		const { d, out } = makeDeps({
			npmInstall: (spec: string) => { order.push(`npm ${spec}`); },
			runNewBinary: (args: string[]) => { order.push(`new ${args.join(" ")}`); }
		});
		expect(upgradeCommand(["--claude-config", "repo:/srv/x"], config, d)).toBe(0);
		// the reconnect runs the NEW binary; the in-process reconnect deps are never touched
		expect(order).toEqual(["npm latest", "new install --claude-config repo:/srv/x", "new agent reconnect"]);
		expect(d.tmuxSockets).not.toHaveBeenCalled();
		expect(out.at(-1)).toContain("✅ gh-broker is at latest");
	});

	it("--version sets the npm spec, and a registry version becomes the target", () => {
		const v = makeDeps({ npmInstall: (spec: string) => expect(spec).toBe("0.12.1") });
		expect(upgradeCommand(["--version", "v0.12.1"], config, v.d)).toBe(0);
		const reg = makeDeps({ latestVersion: () => "0.13.0", installedVersion: () => "0.12.0" });
		expect(upgradeCommand([], config, reg.d)).toBe(0);
		expect(reg.d.npmInstall).toHaveBeenCalledWith("0.13.0");
	});

	it("does nothing when the package is installed AND deployed at the target, unless --force", () => {
		const same = makeDeps({ installedVersion: () => "0.12.0", deployedVersion: () => "0.12.0", latestVersion: () => "0.12.0" });
		expect(upgradeCommand([], config, same.d)).toBe(0);
		expect(same.d.npmInstall).not.toHaveBeenCalled();
		expect(same.d.runNewBinary).not.toHaveBeenCalled();
		expect(same.out[0]).toContain("gh-broker 0.12.0 is installed and deployed; nothing to do (use --force to reinstall it)");
		const forced = makeDeps({ installedVersion: () => "0.12.0", deployedVersion: () => "0.12.0", latestVersion: () => "0.12.0" });
		expect(upgradeCommand(["--force"], config, forced.d)).toBe(0);
		expect(forced.d.npmInstall).toHaveBeenCalledWith("0.12.0");
		expect(forced.d.runNewBinary).toHaveBeenCalledWith(["install"]);
		expect(forced.out.at(-1)).toContain("(reinstalled)");
	});

	it("still installs when npm already has the target but the deployed service does not (#223's own case)", () => {
		const half = makeDeps({ installedVersion: () => "0.13.0", deployedVersion: () => "0.12.0", latestVersion: () => "0.13.0" });
		expect(upgradeCommand([], config, half.d)).toBe(0);
		expect(half.d.npmInstall).toHaveBeenCalledWith("0.13.0");
		expect(half.d.runNewBinary).toHaveBeenCalledWith(["install"]);
		expect(half.d.runNewBinary).toHaveBeenCalledWith(["agent", "reconnect"]);
		const noDeploy = makeDeps({ installedVersion: () => "0.13.0", deployedVersion: () => undefined, latestVersion: () => "0.13.0" });
		expect(upgradeCommand([], config, noDeploy.d)).toBe(0);
		expect(noDeploy.d.runNewBinary).toHaveBeenCalledWith(["install"]);
	});

	it("refuses to downgrade without --force, comparing semver not strings", () => {
		const down = makeDeps({ installedVersion: () => "0.10.0", deployedVersion: () => "0.10.0" });
		expect(upgradeCommand(["--version", "0.9.0"], config, down.d)).toBe(1);
		expect(down.err[0]).toBe("0.9.0 is older than the installed 0.10.0; not downgrading (pass --force to downgrade)");
		expect(down.d.npmInstall).not.toHaveBeenCalled();
		const forced = makeDeps({ installedVersion: () => "0.10.0", deployedVersion: () => "0.10.0" });
		expect(upgradeCommand(["--version", "0.9.0", "--force"], config, forced.d)).toBe(0);
		expect(forced.d.npmInstall).toHaveBeenCalledWith("0.9.0");
		expect(forced.out).toContain("==> step 1/3: npm install (downgrade)");
	});

	it("stops at a failed npm install and prints what to run to finish", () => {
		const { d, err } = makeDeps({ npmInstall: () => { throw new Error("npm ERR! network"); } });
		expect(upgradeCommand([], config, d)).toBe(1);
		expect(err).toEqual([
			"step 1/3 (npm install) failed: npm ERR! network",
			"finish by running:",
			"  sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@latest",
			"  sudo gh-broker install",
			"  sudo gh-broker agent reconnect"
		]);
	});

	it("stops at a failed new-binary install; the reconnect step is not run", () => {
		const { d, err } = makeDeps({ runNewBinary: (args: string[]) => { if (args[0] === "install") throw new Error("/usr/local/bin/gh-broker install exited 1"); } });
		expect(upgradeCommand([], config, d)).toBe(1);
		expect(d.npmInstall).toHaveBeenCalled();
		expect(err[0]).toBe("step 2/3 (install) failed: /usr/local/bin/gh-broker install exited 1");
		expect(err[2]).toBe("  sudo gh-broker install");
		expect(err[3]).toBe("  sudo gh-broker agent reconnect");
	});

	it("stops at a failed reconnect run by the new binary, with just that step to rerun", () => {
		const { d, err } = makeDeps({ runNewBinary: (args: string[]) => { if (args[0] === "agent") throw new Error("/usr/local/bin/gh-broker agent reconnect exited 1"); } });
		expect(upgradeCommand([], config, d)).toBe(1);
		expect(err[0]).toBe("step 3/3 (agent reconnect) failed: /usr/local/bin/gh-broker agent reconnect exited 1");
		expect(err[2]).toBe("  sudo gh-broker agent reconnect");
	});

	it("--no-reconnect leaves two steps and never runs the new binary's reconnect", () => {
		const { d, out } = makeDeps();
		expect(upgradeCommand(["--no-reconnect"], config, d)).toBe(0);
		expect(d.runNewBinary).toHaveBeenCalledTimes(1);
		expect(d.runNewBinary).toHaveBeenCalledWith(["install"]);
		expect(out.filter((l: string) => l.startsWith("==> step"))).toEqual(["==> step 1/2: npm install", "==> step 2/2: install"]);
		expect(out.at(-1)).toContain("; reconnect skipped");
	});

	it("prints its help and runs nothing", () => {
		const { d, out } = makeDeps();
		expect(upgradeCommand(["--help"], config, d)).toBe(0);
		expect(out).toEqual([UPGRADE_HELP]);
		expect(d.npmInstall).not.toHaveBeenCalled();
	});
});
