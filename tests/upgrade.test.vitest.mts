import { describe, it, expect } from "vitest";
import { finishLines, parseUpgradeArgs, upgradeCommand, upgradeSteps, UPGRADE_HELP, type UpgradeStep } from "../src/cli/upgrade.ts";
import { makeDeps, config } from "./helpers/cli-deps.mjs";

describe("parseUpgradeArgs", () => {
	it("takes its own flags out and passes the rest through verbatim", () => {
		expect(parseUpgradeArgs(["--force", "--no-reconnect", "--claude-config", "repo:/srv/x", "--no-mcp-config", "repo"])).toEqual({
			force: true,
			noReconnect: true,
			installFlags: ["--claude-config", "repo:/srv/x", "--no-mcp-config", "repo"]
		});
	});

	it("reads --version with or without a leading v, and needs a value", () => {
		expect(parseUpgradeArgs(["--version", "0.12.1"]).version).toBe("0.12.1");
		expect(parseUpgradeArgs(["--version", "v0.12.1"]).version).toBe("0.12.1");
		expect(() => parseUpgradeArgs(["--version"])).toThrow(/--version takes the version/);
		expect(() => parseUpgradeArgs(["--version", "--force"])).toThrow(/--version takes the version/);
	});

	it("knows -h and --help", () => {
		expect(parseUpgradeArgs(["-h"]).help).toBe(true);
		expect(parseUpgradeArgs(["--help"]).help).toBe(true);
	});
});

describe("upgradeSteps / finishLines", () => {
	it("lists the three steps with the commands to run them by hand", () => {
		const steps = upgradeSteps("latest", ["--claude-config", "repo:/srv/x"], true);
		expect(steps).toEqual([
			{ name: "npm install", command: "sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@latest" },
			{ name: "install", command: "sudo gh-broker install --claude-config repo:/srv/x" },
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
	it("runs the three steps in order, the new install with the passed flags", () => {
		const order: string[] = [];
		const { d, out } = makeDeps({
			npmInstall: (spec: string) => { order.push(`npm ${spec}`); },
			runNewInstall: (flags: string[]) => { order.push(`install ${flags.join(" ")}`); },
			tmuxSockets: () => { order.push("reconnect"); return []; }
		});
		expect(upgradeCommand(["--claude-config", "repo:/srv/x"], config, d)).toBe(0);
		// the reconnect runs for every registered agent (repo and glmtest here)
		expect(order).toEqual(["npm latest", "install --claude-config repo:/srv/x", "reconnect", "reconnect"]);
		expect(out.at(-1)).toContain("✅ gh-broker is at latest");
	});

	it("--version sets the npm spec, and a registry version becomes the target", () => {
		const v = makeDeps({ npmInstall: (spec: string) => expect(spec).toBe("0.12.1") });
		expect(upgradeCommand(["--version", "v0.12.1"], config, v.d)).toBe(0);
		const reg = makeDeps({ latestVersion: () => "0.13.0", installedVersion: () => "0.12.0" });
		expect(upgradeCommand([], config, reg.d)).toBe(0);
		expect(reg.d.npmInstall).toHaveBeenCalledWith("0.13.0");
	});

	it("does nothing when the target is already installed, unless --force", () => {
		const same = makeDeps({ installedVersion: () => "0.12.0", latestVersion: () => "0.12.0" });
		expect(upgradeCommand([], config, same.d)).toBe(0);
		expect(same.d.npmInstall).not.toHaveBeenCalled();
		expect(same.d.runNewInstall).not.toHaveBeenCalled();
		expect(same.d.tmuxSockets).not.toHaveBeenCalled();
		expect(same.out[0]).toContain("gh-broker 0.12.0 is already installed; nothing to do (use --force to reinstall it)");
		const forced = makeDeps({ installedVersion: () => "0.12.0", latestVersion: () => "0.12.0" });
		expect(upgradeCommand(["--force"], config, forced.d)).toBe(0);
		expect(forced.d.npmInstall).toHaveBeenCalledWith("0.12.0");
		expect(forced.d.runNewInstall).toHaveBeenCalledWith([]);
		expect(forced.out.at(-1)).toContain("(reinstalled)");
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
		const { d, err } = makeDeps({ runNewInstall: () => { throw new Error("/usr/local/bin/gh-broker install exited 1"); } });
		expect(upgradeCommand([], config, d)).toBe(1);
		expect(d.npmInstall).toHaveBeenCalled();
		expect(d.tmuxSockets).not.toHaveBeenCalled();
		expect(err[0]).toBe("step 2/3 (install) failed: /usr/local/bin/gh-broker install exited 1");
		expect(err[2]).toBe("  sudo gh-broker install");
		expect(err[3]).toBe("  sudo gh-broker agent reconnect");
	});

	it("stops at a failed reconnect (skipped panes) with just that step to rerun", () => {
		const { d, err } = makeDeps({ tmuxSockets: () => { throw new Error("boom"); } });
		expect(upgradeCommand([], config, d)).toBe(1);
		expect(err[0]).toBe("step 3/3 (agent reconnect) failed: boom");
		expect(err[2]).toBe("  sudo gh-broker agent reconnect");
	});

	it("--no-reconnect leaves two steps and skips the reconnect effects", () => {
		const { d, out } = makeDeps();
		expect(upgradeCommand(["--no-reconnect"], config, d)).toBe(0);
		expect(d.tmuxSockets).not.toHaveBeenCalled();
		expect(d.tmuxSend).not.toHaveBeenCalled();
		expect(out.filter((l: string) => l.startsWith("==> step"))).toEqual(["==> step 1/2: npm install", "==> step 2/2: install"]);
		expect(out.at(-1)).toContain("; reconnect skipped");
	});

	it("reports skipped panes from the reconnect it runs", () => {
		const { d, out, err } = makeDeps(
			{ tmuxSockets: () => ["/tmp/tmux-1000/default"], tmuxPanes: () => [{ id: "%1", pid: 200, text: "> hi" }] },
			{ "/home/repo/.claude.json": JSON.stringify({ mcpServers: { github: { type: "stdio", command: "sg", args: ["gh-broker-agent-repo", "-c", "exec socat STDIO UNIX-CONNECT:/run/gh-broker/agents/repo.sock"] } } }) }
		);
		expect(upgradeCommand([], config, d)).toBe(1);
		expect(out).toContain("repo /tmp/tmux-1000/default %1 github skipped (composer not empty)");
		expect(err[0]).toContain("step 3/3 (agent reconnect) failed: some panes were skipped (see above)");
	});

	it("prints its help and runs nothing", () => {
		const { d, out } = makeDeps();
		expect(upgradeCommand(["--help"], config, d)).toBe(0);
		expect(out).toEqual([UPGRADE_HELP]);
		expect(d.npmInstall).not.toHaveBeenCalled();
	});
});
