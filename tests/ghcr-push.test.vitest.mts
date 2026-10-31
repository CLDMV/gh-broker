import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { GhcrService, GHCR_CATALOG } from "../src/verbs/ghcr_push.ts";
import { JobQueue, QueueFull } from "../src/verbs/ghcr/jobs.ts";
import { Registry, RegistryError } from "../src/verbs/ghcr/registry.ts";
import { pushImage } from "../src/verbs/ghcr/push.ts";
import { planImage, MEDIA } from "../src/verbs/ghcr/archive.ts";
import { DEFAULT_MAX_ARCHIVE_BYTES, type GhcrConfig } from "../src/verbs/ghcr/config.ts";
import { FakeRegistry, ociArchive, dockerArchive, scratchDir, removeDir, join, sha, type FakeRegistryOptions } from "./helpers/ghcr-fixtures.mts";

const PAT = "ghp_testPatValue0123456789abcdefABCDEF";

let root: string;
let drop: string;
let reg: FakeRegistry;
let logs: string[];

beforeAll(() => {
	root = scratchDir("ghcr-push");
	drop = join(root, "drop");
	mkdirSync(drop);
});
afterAll(() => removeDir(root));

beforeEach(() => {
	logs = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await reg?.stop();
});

let n = 0;
function put(buf: Buffer): string {
	const name = `img${++n}.tar`;
	writeFileSync(join(drop, name), buf);
	return name;
}

async function service(opts: FakeRegistryOptions = {}, cfg: Record<string, unknown> = {}, queue?: JobQueue) {
	reg = new FakeRegistry(opts);
	const base = await reg.start();
	// Built directly, not via parseGhcrConfig: the scratch dir lives in the checkout, which in CI is
	// under /home — a path the parser rightly refuses for a real drop dir (see ghcr-config tests).
	const ghcr: GhcrConfig = {
		dropDir: drop,
		protectReleaseTags: true,
		maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
		owners: { cldmv: { username: "Shinrai", credential: "cred:cldmv-packages", images: ["hoot", "hoot-worker-*"] }, other: { username: "o", credential: "cred:other", images: ["x"] } },
		...cfg
	};
	const secrets = { resolve: vi.fn((ref: string) => (ref === "cred:cldmv-packages" ? PAT : "ghp_otherPat000000000000000000000000")), has: vi.fn(() => true) };
	return { svc: new GhcrService(ghcr, secrets, { base, ...(queue ? { queue } : {}) }), secrets };
}

/** No secret value may appear in anything the agent or the journal can see. */
function expectNoSecrets(...texts: string[]) {
	for (const t of [...texts, ...logs]) {
		expect(t).not.toContain(PAT);
		if (reg?.currentToken) expect(t).not.toContain(reg.currentToken);
		expect(t).not.toMatch(/regtok-\d+-secretvalue/);
	}
}

describe("ghcr_push (end to end against a fake registry)", () => {
	it("pushes an uncompressed docker save archive: gzips layers, writes an OCI manifest, audits the result", async () => {
		const { svc } = await service();
		const img = ociArchive();
		const job = await svc.push({ owner: "CLDMV", image: "hoot", tag: "1.0.0", archive: put(img.archive) });
		expect(job).toMatchObject({ state: "queued", owner: "cldmv", image: `${new URL(reg.base).host}/cldmv/hoot`, tag: "1.0.0", format: "oci-layout" });
		await svc.queue.idle();
		const done = svc.status({ owner: "cldmv", job: job.job }) as any;
		expect(done.state).toBe("succeeded");
		expect(done.progress.phase).toBe("done");
		expect(done.result.blobsUploaded).toBe(3);

		const man = reg.manifests.get("1.0.0")!;
		expect(man.mediaType).toBe(MEDIA.ociManifest);
		expect(sha(man.bytes)).toBe(done.result.digest);
		const parsed = JSON.parse(man.bytes.toString());
		expect(parsed.layers.map((l: any) => l.mediaType)).toEqual([MEDIA.ociLayerGzip, MEDIA.ociLayerGzip]);
		// The pushed blobs really are the gzip of the archive's layers.
		expect(parsed.layers.map((l: any) => gunzipSync(reg.blobs.get(l.digest)!).toString("hex"))).toEqual(img.layers.map((l) => l.toString("hex")));
		expect(reg.blobs.get(sha(img.config))).toEqual(img.config);

		const auditLines = logs.filter((l) => l.includes('"tool":"ghcr_push"'));
		expect(auditLines).toHaveLength(2);
		expect(auditLines[1]).toContain(done.result.digest);
		expect(auditLines[1]).toContain(join(drop, `img${n}.tar`));
		expectNoSecrets(JSON.stringify(job), JSON.stringify(done));
	});

	it("skips blobs the registry already has, so a re-push uploads nothing", async () => {
		const { svc } = await service();
		const archive = put(ociArchive().archive);
		await svc.push({ owner: "cldmv", image: "hoot", tag: "a", archive });
		await svc.queue.idle();
		const uploadsBefore = reg.requests.filter((r) => r.method === "PATCH").length;
		const again = await svc.push({ owner: "cldmv", image: "hoot", tag: "b", archive });
		await svc.queue.idle();
		const res = (svc.status({ owner: "cldmv", job: again.job }) as any).result;
		expect(res).toMatchObject({ blobsUploaded: 0, blobsSkipped: 3 });
		expect(reg.requests.filter((r) => r.method === "PATCH").length).toBe(uploadsBefore);
		expect(reg.manifests.get("a")!.bytes).toEqual(reg.manifests.get("b")!.bytes);
	});

	it("pushes a compressed OCI layout byte-for-byte, manifest included", async () => {
		const { svc } = await service();
		const img = ociArchive({ gzip: true });
		const job = await svc.push({ owner: "cldmv", image: "hoot-worker-render", tag: "latest", archive: put(img.archive) });
		await svc.queue.idle();
		const res = (svc.status({ owner: "cldmv", job: job.job }) as any).result;
		for (const l of img.layers) expect(reg.blobs.get(sha(l))).toEqual(l);
		const idx = reg.manifests.get("latest")!;
		expect(sha(idx.bytes)).toBe(res.digest);
	});

	it("pushes a legacy docker-archive and uploads a duplicated layer once", async () => {
		const { svc } = await service();
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "legacy", archive: put(dockerArchive({ gzipFirst: true }).archive) });
		await svc.queue.idle();
		const res = (svc.status({ owner: "cldmv", job: job.job }) as any).result;
		expect(res).toMatchObject({ blobsUploaded: 3, blobsSkipped: 1 });
		const man = JSON.parse(reg.manifests.get("legacy")!.bytes.toString());
		expect(man.config.mediaType).toBe(MEDIA.ociConfig);
		expect(man.layers).toHaveLength(3);
	});

	it("maps docker media types to OCI ones when the manifest has to be rebuilt", async () => {
		const { svc } = await service();
		const img = ociArchive({ configMediaType: MEDIA.dockerConfig, manifestMediaType: MEDIA.dockerManifest, layerMediaType: MEDIA.dockerLayer, annotations: { k: "v" } });
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "dm", archive: put(img.archive) });
		await svc.queue.idle();
		expect((svc.status({ owner: "cldmv", job: job.job }) as any).state).toBe("succeeded");
		const man = JSON.parse(reg.manifests.get("dm")!.bytes.toString());
		expect(man.config.mediaType).toBe(MEDIA.ociConfig);
		expect(man.annotations).toEqual({ k: "v" });
	});

	it("re-runs the token exchange when the registry token expires mid-push", async () => {
		const { svc } = await service({ expireTokenAfter: 3 });
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "exp", archive: put(ociArchive().archive) });
		await svc.queue.idle();
		expect((svc.status({ owner: "cldmv", job: job.job }) as any).state).toBe("succeeded");
		expect(reg.tokensIssued).toBeGreaterThan(1);
		expectNoSecrets();
	});

	it("refuses to overwrite an existing release tag, at submit time and again before the manifest PUT", async () => {
		const { svc } = await service();
		const archive = put(ociArchive().archive);
		await svc.push({ owner: "cldmv", image: "hoot", tag: "v2.0.0", archive });
		await svc.queue.idle();
		await expect(svc.push({ owner: "cldmv", image: "hoot", tag: "v2.0.0", archive })).rejects.toThrow(/tag v2.0.0 already exists .* release tags are protected/);

		// Race: two queued pushes of the same new release tag — the second must fail at manifest time.
		const one = await svc.push({ owner: "cldmv", image: "hoot", tag: "3.0.0", archive });
		const two = await svc.push({ owner: "cldmv", image: "hoot", tag: "3.0.0", archive });
		await svc.queue.idle();
		expect((svc.status({ owner: "cldmv", job: one.job }) as any).state).toBe("succeeded");
		const failed = svc.status({ owner: "cldmv", job: two.job }) as any;
		expect(failed.state).toBe("failed");
		expect(failed.error).toMatch(/release tags are protected/);
		expect(logs.some((l) => l.includes('"ok":false') && l.includes(two.job))).toBe(true);
	});

	it("lets non-release tags and unprotected configs overwrite", async () => {
		const { svc } = await service({}, { protectReleaseTags: false });
		const archive = put(ociArchive().archive);
		for (let i = 0; i < 2; i++) {
			await svc.push({ owner: "cldmv", image: "hoot", tag: "1.2.3", archive });
			await svc.queue.idle();
		}
		const all = svc.status({ owner: "cldmv" }) as any;
		expect(all.jobs.map((j: any) => j.state)).toEqual(["succeeded", "succeeded"]);
	});

	it("surfaces a bad PAT at submit without echoing it", async () => {
		const { svc } = await service({ tokenStatus: 403 });
		const err = await svc.push({ owner: "cldmv", image: "hoot", tag: "x", archive: put(ociArchive().archive) }).catch((e: Error) => e);
		expect((err as Error).message).toMatch(/token exchange failed: HTTP 403 .*classic PAT with write:packages/);
		expectNoSecrets((err as Error).message);
	});

	it("scrubs a registry error that echoes the Authorization header", async () => {
		const { svc } = await service({ manifestStatus: 403, leakyErrors: true });
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "leak", archive: put(ociArchive().archive) });
		await svc.queue.idle();
		const failed = svc.status({ owner: "cldmv", job: job.job }) as any;
		expect(failed.state).toBe("failed");
		expect(failed.error).toMatch(/pushing manifest for tag leak failed: HTTP 403 .*Bearer \[redacted\]/);
		expectNoSecrets(JSON.stringify(failed));
	});

	it("scrubs a secret before cutting a long registry error, so no fragment survives the cut", async () => {
		// "DENIED: " is 8 characters, so 285 characters of padding puts the cut inside the token.
		const { svc } = await service({ manifestStatus: 403, leakBareTokenAfter: 285 });
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "cut", archive: put(ociArchive().archive) });
		await svc.queue.idle();
		const failed = svc.status({ owner: "cldmv", job: job.job }) as any;
		expect(failed.state).toBe("failed");
		expect(failed.error).not.toMatch(/regtok-/);
		expectNoSecrets(JSON.stringify(failed));
	});

	it("refuses an upload Location on another host (the token never leaves the registry)", async () => {
		const { svc } = await service({ foreignLocation: true });
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "f", archive: put(ociArchive().archive) });
		await svc.queue.idle();
		expect((svc.status({ owner: "cldmv", job: job.job }) as any).error).toMatch(/pointed at another host \(evil.example\)/);
	});

	describe("refusals before any network call", () => {
		it.each([
			[{ owner: "cldmv", image: "hoot", tag: "t" }, /archive: "archive" must be a file path/],
			[{ owner: "cldmv", image: "hoot", tag: "t", archive: "a", extra: 1 }, /unknown argument\(s\): extra/],
			[{ image: "hoot", tag: "t", archive: "a" }, /"owner" must be a non-empty string/],
			[{ owner: "nobody", image: "hoot", tag: "t", archive: "a" }, /owner "nobody" has no GHCR configuration/],
			[{ owner: "cldmv", image: "secret-thing", tag: "t", archive: "a" }, /ghcr.io\/cldmv\/secret-thing is not on the allowlist/],
			[{ owner: "cldmv", image: "hoot-worker-a/b", tag: "t", archive: "a" }, /not on the allowlist/],
			[{ owner: "cldmv", image: "Hoot", tag: "t", archive: "a" }, /not a valid image name/],
			[{ owner: "cldmv", image: "cldmv/hoot", tag: "t", archive: "a" }, /pass e.g. "hoot"/],
			[{ owner: "cldmv", image: "ghcr.io/cldmv/hoot", tag: "t", archive: "a" }, /pass e.g. "hoot"/],
			[{ owner: "cldmv", image: "", tag: "t", archive: "a" }, /"image" must be a non-empty string/],
			[{ owner: "cldmv", image: "hoot", tag: "-bad", archive: "a" }, /"tag" must be a valid tag/],
			[{ owner: "cldmv", image: "hoot", tag: 5, archive: "a" }, /"tag" must be a valid tag/],
			[{ owner: "cldmv", image: "hoot", tag: "t", archive: "/etc/gh-broker/secrets.json" }, /must be an existing file inside the drop directory/],
			[{ owner: "cldmv", image: "hoot", tag: "t", archive: "../../x.tar" }, /must be an existing file inside the drop directory/]
		])("%j", async (args, re) => {
			const { svc } = await service();
			await expect(svc.push(args)).rejects.toThrow(re);
			expect(reg.requests).toHaveLength(0);
		});

		it("refuses a non-object argument list", async () => {
			const { svc } = await service();
			await expect(svc.push([])).rejects.toThrow(/arguments must be an object/);
		});

		it("refuses a non-image archive before touching the registry, and closes it", async () => {
			const { svc } = await service();
			await expect(svc.push({ owner: "cldmv", image: "hoot", tag: "t", archive: put(Buffer.alloc(1024)) })).rejects.toThrow(/not an image archive/);
			expect(reg.requests).toHaveLength(0);
		});

		it("refuses every verb when GHCR is not configured", async () => {
			const svc = new GhcrService(undefined, { resolve: () => "x" });
			await expect(svc.push({ owner: "cldmv", image: "hoot", tag: "t", archive: "a" })).rejects.toThrow(/GHCR is not configured/);
			expect(() => svc.status({ owner: "cldmv" })).toThrow(/GHCR is not configured/);
			await expect(svc.tags({ owner: "cldmv", image: "hoot" })).rejects.toThrow(/GHCR is not configured/);
		});
	});

	it("refuses new pushes once the queue is full", async () => {
		const { svc } = await service({}, {}, new JobQueue({ maxPending: 1 }));
		const archive = put(ociArchive().archive);
		await svc.push({ owner: "cldmv", image: "hoot", tag: "q1", archive });
		await expect(svc.push({ owner: "cldmv", image: "hoot", tag: "q2", archive })).rejects.toThrow(/already queued or running/);
		await svc.queue.idle();
	});
});

describe("ghcr_push_status", () => {
	it("validates the job id and never shows another owner's job", async () => {
		const { svc } = await service();
		const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "s", archive: put(ociArchive().archive) });
		await svc.queue.idle();
		expect(() => svc.status({ owner: "cldmv", job: "nope" })).toThrow(/must be a job id/);
		expect(() => svc.status({ owner: "cldmv", job: "00000000-0000-0000-0000-000000000000" })).toThrow(/no job .* for owner cldmv/);
		expect(() => svc.status({ owner: "other", job: job.job })).toThrow(/no job/);
		expect((svc.status({ owner: "other" }) as any).jobs).toEqual([]);
		expect(() => svc.status({ owner: "cldmv", job: job.job, x: 1 })).toThrow(/unknown argument/);
	});
});

describe("ghcr_tags", () => {
	it("lists tags across pages", async () => {
		const { svc } = await service({ tagPageSize: 2 });
		reg.tags = ["a", "b", "c", "d", "e"];
		const out = await svc.tags({ owner: "cldmv", image: "hoot" });
		expect(out).toEqual({ image: `${new URL(reg.base).host}/cldmv/hoot`, exists: true, tags: ["a", "b", "c", "d", "e"] });
		expect(reg.requests.find((r) => r.path.startsWith("/token"))!.path).toContain("scope=repository%3Acldmv%2Fhoot%3Apull");
	});

	it("reports a repository that doesn't exist yet", async () => {
		const { svc } = await service({ noRepo: true });
		expect(await svc.tags({ owner: "cldmv", image: "hoot" })).toMatchObject({ exists: false, tags: [] });
	});

	it("refuses a non-allowlisted image and a foreign pagination link, and scrubs errors", async () => {
		const { svc } = await service({ tagPageSize: 1, foreignLink: true });
		reg.tags = ["a", "b"];
		await expect(svc.tags({ owner: "cldmv", image: "private" })).rejects.toThrow(/not on the allowlist/);
		await expect(svc.tags({ owner: "cldmv", image: "hoot" })).rejects.toThrow(/another host/);
		const bad = await service({ tokenStatus: 401 });
		const err = await bad.svc.tags({ owner: "cldmv", image: "hoot" }).catch((e: Error) => e);
		expect((err as Error).message).toMatch(/HTTP 401/);
		expectNoSecrets((err as Error).message);
	});
});

describe("Registry edge cases", () => {
	beforeEach(async () => {
		reg = new FakeRegistry();
		await reg.start();
	});
	const client = (over: Partial<ConstructorParameters<typeof Registry>[0]> = {}) => new Registry({ base: reg.base, username: "Shinrai", password: PAT, repository: "cldmv/hoot", ...over });

	it("clean() redacts both secrets and token-shaped strings", async () => {
		const r = client();
		await r.login("pull");
		const tok = reg.currentToken!;
		expect(r.clean(`a ${PAT} b ${tok} c Basic abc== d ghs_${"x".repeat(30)} e github_pat_${"y".repeat(30)}`)).toBe(
			"a [redacted] b [redacted] c Basic [redacted] d [redacted] e [redacted]"
		);
		expect(r.host).toBe(new URL(reg.base).host);
	});

	it("fails cleanly when the token response has no token, or the credential is wrong", async () => {
		await expect(client({ password: "wrong-password" }).login("pull")).rejects.toThrow(/HTTP 401 \(UNAUTHORIZED: bad credentials\)/);
		await reg.stop();
		reg = new FakeRegistry({ tokenMissing: true });
		await reg.start();
		await expect(client().login("pull")).rejects.toThrow(/returned no token/);
	});

	it("logs in on demand, and reports unexpected statuses with the registry's error code", async () => {
		const r = client();
		expect(await r.blobExists(sha("nothing"))).toBe(false); // first call triggers a pull login
		await expect(r.putManifest("t", MEDIA.ociManifest, Buffer.from('{"config":{"digest":"sha256:00"},"layers":[]}'))).rejects.toThrow(/MANIFEST_BLOB_UNKNOWN/);
		expect(await r.manifestExists("t")).toBe(false);
	});

	it("surfaces the registry's digest check when the bytes don't match", async () => {
		const r = client();
		await r.login("push,pull");
		const body = Buffer.from("real bytes");
		await expect(r.uploadBlob(sha("other bytes"), body.length, () => Readable.from([body]))).rejects.toThrow(/finishing blob .*HTTP 400 \(DIGEST_INVALID/);
	});

	it("rolls progress back and retries a blob once when the token expires mid-upload", async () => {
		await reg.stop();
		reg = new FakeRegistry({ expireTokenAfter: 1 }); // POST succeeds, PATCH gets 401
		await reg.start();
		const r = client();
		await r.login("push,pull");
		const body = Buffer.from("retry me");
		let progress = 0;
		await r.uploadBlob(sha(body), body.length, () => Readable.from([body]), (d) => (progress += d));
		expect(progress).toBe(body.length);
		expect(reg.blobs.get(sha(body))).toEqual(body);
	});

	it("gives up after the retry when the token keeps expiring", async () => {
		await reg.stop();
		reg = new FakeRegistry({ rejectBearer: true });
		await reg.start();
		const r = client();
		await r.login("push,pull");
		await expect(r.uploadBlob(sha("x"), 1, () => Readable.from([Buffer.from("x")]))).rejects.toThrow(/HTTP 401/);
	});

	it("reports a network failure without secrets", async () => {
		const r = client({ base: "http://127.0.0.1:1" });
		const err = await r.login("pull").catch((e: Error) => e);
		expect(err).toBeInstanceOf(RegistryError);
		expect((err as Error).message).toMatch(/GET \/token failed/);
	});

	it("reports a misbehaving registry (plain-text errors, bad JSON, unexpected statuses)", async () => {
		const server = createServer((req, res) => {
			if (req.url?.startsWith("/token")) return void res.end(JSON.stringify({ token: "t0ken-value" }));
			if (req.url?.includes("/tags/list")) return void res.end("not json");
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("  upstream\n  exploded  ");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		try {
			const r = client({ base });
			await r.login("push,pull");
			await expect(r.manifestExists("t")).rejects.toThrow(/checking tag t failed: HTTP 500$/); // HEAD: no body
			await expect(r.blobExists(sha("x"))).rejects.toThrow(/HTTP 500/);
			await expect(r.uploadBlob(sha("x"), 1, () => Readable.from([Buffer.from("x")]))).rejects.toThrow(/starting a blob upload failed: HTTP 500 \(upstream exploded\)/);
			await expect(r.listTags()).rejects.toThrow(/invalid JSON/);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("refuses an unparseable Location", async () => {
		const r = client();
		expect(() => (r as any).sameOrigin("http://[", "x")).toThrow(/unparseable URL/);
	});
});

describe("pushImage progress", () => {
	it("reports every phase in order and the final byte count", async () => {
		reg = new FakeRegistry();
		await reg.start();
		const r = new Registry({ base: reg.base, username: "Shinrai", password: PAT, repository: "cldmv/hoot" });
		await r.login("push,pull");
		const buf = ociArchive({ gzip: true }).archive;
		const p = join(drop, "progress.tar");
		writeFileSync(p, buf);
		const fd = openSync(p, "r");
		const phases: string[] = [];
		try {
			const res = await pushImage(r, fd, planImage(fd, buf.length), "p", { protectReleaseTags: true, onProgress: (x) => phases.push(x.phase) });
			expect(res.size).toBeGreaterThan(0);
		} finally {
			closeSync(fd);
		}
		expect([...new Set(phases)]).toEqual(["preparing", "uploading", "manifest", "done"]);
	});
});

describe("JobQueue", () => {
	it("runs jobs one at a time, records failures, survives a throwing hook, and prunes old jobs", async () => {
		const q = new JobQueue({ keepFinished: 2 });
		const order: string[] = [];
		const meta = { owner: "o", image: "i", tag: "t", archive: "a", archiveBytes: 1, format: "f" };
		const ok = (id: string) => ({
			run: async () => {
				order.push(`start ${id}`);
				await new Promise((r) => setTimeout(r, 5));
				order.push(`end ${id}`);
				return { digest: "d", mediaType: "m", size: 1, blobsUploaded: 1, blobsSkipped: 0 };
			},
			finally: () => {
				throw new Error("hook bug");
			}
		});
		const a = q.submit(meta, ok("a"));
		q.submit(meta, ok("b"));
		const failing = q.submit(meta, { run: async () => Promise.reject(new Error("boom")) });
		const noDescribe = q.submit(meta, { run: async () => Promise.reject(new Error("hidden")) });
		await q.idle();
		expect(order).toEqual(["start a", "end a", "start b", "end b"]);
		expect(q.get(a.job)).toBeUndefined(); // pruned: only the newest 2 finished jobs are kept
		expect(q.get(failing.job)).toMatchObject({ state: "failed", error: "push failed" });
		expect(q.get(noDescribe.job)?.state).toBe("failed");
		expect(q.list("o")).toHaveLength(2);
	});

	it("throws QueueFull past maxPending", () => {
		const q = new JobQueue({ maxPending: 1 });
		const meta = { owner: "o", image: "i", tag: "t", archive: "a", archiveBytes: 1, format: "f" };
		q.submit(meta, { run: () => new Promise(() => {}) });
		expect(() => q.submit(meta, { run: () => new Promise(() => {}) })).toThrow(QueueFull);
	});
});

describe("GHCR_CATALOG", () => {
	it("describes all three verbs with strict schemas", () => {
		expect(Object.keys(GHCR_CATALOG)).toEqual(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);
		for (const v of Object.values(GHCR_CATALOG)) expect(v.inputSchema.additionalProperties).toBe(false);
	});
});
