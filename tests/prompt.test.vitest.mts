import { describe, it, expect, vi, beforeEach } from "vitest";

// Stand-ins for process.stdin / process.stdout so the raw-mode reader can be driven by hand.
const h = vi.hoisted(() => ({ stdin: null as any, stdout: null as any }));
vi.mock("node:process", async () => {
	const { EventEmitter } = await import("node:events");
	class FakeStdin extends EventEmitter {
		isTTY = true;
		raw: boolean[] = [];
		paused = false;
		setRawMode(v: boolean) {
			this.raw.push(v);
		}
		resume() {
			this.paused = false;
		}
		pause() {
			this.paused = true;
		}
	}
	h.stdin = new FakeStdin();
	h.stdout = { out: "", write(s: string) { this.out += s; return true; } };
	return { stdin: h.stdin, stdout: h.stdout };
});

import { promptLine, promptHidden, confirm, choose } from "../deploy/lib/prompt.mjs";

const type = (s: string) => h.stdin.emit("data", Buffer.from(s, "utf8"));

beforeEach(() => {
	h.stdout.out = "";
	h.stdin.removeAllListeners("data");
	h.stdin.raw = [];
	h.stdin.isTTY = true;
});

describe("promptLine / promptHidden", () => {
	it("echoes typed characters and returns the trimmed line on Enter", async () => {
		const p = promptLine("name? ");
		type("  ab");
		type("c \r");
		expect(await p).toBe("abc");
		expect(h.stdout.out).toBe("name?   abc \n");
		expect(h.stdin.raw).toEqual([true, false]);
		expect(h.stdin.paused).toBe(true);
		expect(h.stdin.listenerCount("data")).toBe(0);
	});

	it("does not echo hidden input", async () => {
		const p = promptHidden("secret: ");
		type("hunter2\n");
		expect(await p).toBe("hunter2");
		expect(h.stdout.out).toBe("secret: \n");
	});

	it("handles Backspace (DEL and BS), including on empty input", async () => {
		const p = promptLine("? ");
		type("\x7f"); // nothing to delete
		type("abc\x7f\x08d\n");
		expect(await p).toBe("ad");
		expect(h.stdout.out).toContain("\b \b");

		const q = promptHidden("? ");
		h.stdout.out = "";
		type("ab\x7f\n");
		expect(await q).toBe("a");
		expect(h.stdout.out).not.toContain("\b \b");
	});

	it("returns what was typed on Ctrl-D, and rejects on Ctrl-C", async () => {
		const p = promptLine("? ");
		type("xy\x04");
		expect(await p).toBe("xy");

		const q = promptLine("? ");
		type("xy\x03");
		await expect(q).rejects.toThrow("aborted");
	});

	it("skips raw mode when stdin is not a TTY", async () => {
		h.stdin.isTTY = false;
		const p = promptLine("? ");
		type("ok\n");
		expect(await p).toBe("ok");
		expect(h.stdin.raw).toEqual([]);
	});
});

describe("confirm", () => {
	it.each([
		["y\n", true],
		["YES\n", true],
		["n\n", false],
		["\n", false],
		["yeah\n", false]
	])("%j -> %s", async (input, expected) => {
		const p = confirm("sure?");
		type(input);
		expect(await p).toBe(expected);
		expect(h.stdout.out).toContain("sure? [y/N] ");
	});
});

describe("choose", () => {
	const opts = [
		{ key: "a", label: "Alpha" },
		{ key: "b", label: "Beta" }
	];

	it("lists the options and returns the chosen key", async () => {
		const p = choose("pick", opts);
		type("2\n");
		expect(await p).toBe("b");
		expect(h.stdout.out).toContain("pick\n  1) Alpha\n  2) Beta\n");
	});

	it("uses the default on empty input, and falls back to it on invalid input", async () => {
		let p = choose("pick", opts, 2);
		type("\n");
		expect(await p).toBe("b");
		p = choose("pick", opts);
		type("9\n");
		expect(await p).toBe("a");
		p = choose("pick", opts);
		type("zz\n");
		expect(await p).toBe("a");
	});
});
