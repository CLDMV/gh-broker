import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { Registry, RegistryError } from "../src/verbs/ghcr/registry.ts";

// Real node:http, except request() can be swapped for a fake to reach states a real socket won't produce.
const hook = vi.hoisted(() => ({ request: null as null | ((...a: any[]) => any) }));
vi.mock("node:http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:http")>();
	return { ...actual, request: (...a: any[]) => (hook.request ? hook.request(...a) : (actual.request as any)(...a)) };
});

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
const servers: Server[] = [];

/** A scripted registry: /token always works, everything else is up to the test. */
async function scripted(h: Handler): Promise<Registry> {
	const srv = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			if (req.url?.startsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				return void res.end(JSON.stringify({ token: "regtok-0001" }));
			}
			h(req, res, Buffer.concat(chunks));
		});
	});
	servers.push(srv);
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
	return new Registry({ base, username: "u", password: "ghp_testPatValue0123456789abcdefABCDEF", repository: "o/i" });
}

const json = (res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}) => {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(obj));
};

afterEach(async () => {
	hook.request = null;
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

describe("Registry construction and errors", () => {
	it("defaults to ghcr.io", () => {
		expect(new Registry({ username: "u", password: "p", repository: "o/i" }).host).toBe("ghcr.io");
	});

	it("tolerates registry error entries with no code or message", async () => {
		const failing = createServer((_req, res) => json(res, 500, { errors: [{}, { code: "X" }, { message: "m" }] }));
		servers.push(failing);
		await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
		const bad = new Registry({ base: `http://127.0.0.1:${(failing.address() as { port: number }).port}`, username: "u", password: "pppp", repository: "o/i" });
		await expect(bad.login("pull")).rejects.toThrow(/HTTP 500 \(: ; X: ; : m\)/);
	});

	it("reads at most 1 MiB of a response body", async () => {
		const big = createServer((_req, res) => {
			res.writeHead(500);
			const chunk = Buffer.alloc(600 * 1024, "a");
			res.write(chunk);
			res.write(chunk);
			res.end(chunk);
		});
		servers.push(big);
		await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
		const reg = new Registry({ base: `http://127.0.0.1:${(big.address() as { port: number }).port}`, username: "u", password: "pppp", repository: "o/i" });
		const err = await reg.login("pull").catch((e: Error) => e);
		expect(err).toBeInstanceOf(RegistryError);
		expect((err as Error).message).toMatch(/HTTP 500/);
	});

	it("uses https for an https base (and reports a connection failure)", async () => {
		const reg = new Registry({ base: "https://127.0.0.1:1", username: "u", password: "pppp", repository: "o/i" });
		await expect(reg.login("pull")).rejects.toThrow(/ghcr: GET \/token failed/);
	});
});

describe("Registry transport (fake http.request)", () => {
	function fakeRequest(onEnd: (cb: (res: any) => void, req: any) => void, opts: { fireTimeout?: boolean } = {}) {
		return (_url: unknown, _o: unknown, cb: (res: any) => void) => {
			const req: any = new EventEmitter();
			req.setTimeout = (_ms: number, handler: () => void) => {
				if (opts.fireTimeout) queueMicrotask(handler);
			};
			req.destroy = (e: Error) => queueMicrotask(() => req.emit("error", e));
			req.end = () => onEnd(cb, req);
			return req;
		};
	}
	const reg = () => new Registry({ base: "http://registry.invalid", username: "u", password: "pppp", repository: "o/i" });

	it("destroys the request when the idle timeout fires", async () => {
		hook.request = fakeRequest(() => {}, { fireTimeout: true });
		await expect(reg().login("pull")).rejects.toThrow("ghcr: GET /token failed: GET timed out");
	});

	it("treats a response without a status code as status 0", async () => {
		hook.request = fakeRequest((cb) => {
			const res: any = new EventEmitter();
			res.headers = {};
			cb(res);
			res.emit("end");
		});
		await expect(reg().login("pull")).rejects.toThrow("HTTP 0");
	});

	it("rejects when the response stream errors", async () => {
		hook.request = fakeRequest((cb) => {
			const res: any = new EventEmitter();
			res.statusCode = 200;
			res.headers = {};
			cb(res);
			res.emit("error", new Error("reset"));
		});
		await expect(reg().login("pull")).rejects.toThrow("reset");
	});

	it("streams a function body without a byte counter", async () => {
		const sent: Buffer[] = [];
		hook.request = (_u: unknown, _o: unknown, cb: (res: any) => void) => {
			
			const req: any = new Writable({
				write(chunk, _e, done) {
					sent.push(chunk);
					done();
				},
				final(done) {
					const res: any = new EventEmitter();
					res.statusCode = 204;
					res.headers = {};
					cb(res);
					res.emit("end");
					done();
				}
			});
			req.setTimeout = () => {};
			return req;
		};
		const r = reg();
		const res = await (r as any).send("PATCH", new URL("http://registry.invalid/x"), {}, () => Readable.from([Buffer.from("abc")]));
		expect(res.status).toBe(204);
		expect(Buffer.concat(sent).toString()).toBe("abc");
	});
});

describe("Registry upload and listing edge cases", () => {
	it("completes a blob upload whose PATCH answers 204 with no Location", async () => {
		const seen: string[] = [];
		const reg = await scripted((req, res) => {
			seen.push(`${req.method} ${req.url}`);
			if (req.method === "POST") {
				res.writeHead(202, { Location: "/v2/o/i/blobs/uploads/u1" });
				return void res.end();
			}
			if (req.method === "PATCH") {
				res.writeHead(204);
				return void res.end();
			}
			res.writeHead(201);
			res.end();
		});
		await reg.uploadBlob("sha256:abc", 3, () => Readable.from([Buffer.from("abc")]));
		expect(seen).toEqual(["POST /v2/o/i/blobs/uploads/", "PATCH /v2/o/i/blobs/uploads/u1", "PUT /v2/o/i/blobs/uploads/u1?digest=sha256%3Aabc"]);
	});

	it("reports a PATCH the registry refuses", async () => {
		const reg = await scripted((req, res) => {
			if (req.method === "POST") {
				res.writeHead(202, { Location: "/v2/o/i/blobs/uploads/u1" });
				return void res.end();
			}
			json(res, 500, { errors: [{ code: "UNKNOWN", message: "storage down" }] });
		});
		await expect(reg.uploadBlob("sha256:abc", 3, () => Readable.from([Buffer.from("abc")]))).rejects.toThrow(/uploading blob sha256:abc failed: HTTP 500 \(UNKNOWN: storage down\)/);
	});

	it("aborts the upload when the source stream errors", async () => {
		const reg = await scripted((req, res) => {
			res.writeHead(202, { Location: "/v2/o/i/blobs/uploads/u1" });
			res.end();
			void req;
		});
		const body = () =>
			new Readable({
				read() {
					this.destroy(new Error("disk gone"));
				}
			});
		await expect(reg.uploadBlob("sha256:abc", 3, body)).rejects.toThrow(/disk gone/);
	});

	it("reports a tag listing the registry refuses", async () => {
		const reg = await scripted((_req, res) => json(res, 500, { errors: [{ code: "UNAVAILABLE", message: "later" }] }));
		await expect(reg.listTags()).rejects.toThrow(/listing tags failed: HTTP 500/);
	});

	it("ignores a missing tags field and non-string tag entries", async () => {
		let call = 0;
		const reg = await scripted((_req, res) => json(res, 200, ++call === 1 ? { name: "o/i" } : { tags: ["a", 7, null, "b"] }));
		expect(await reg.listTags()).toEqual([]);
		expect(await reg.listTags()).toEqual(["a", "b"]);
	});
});
