import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { indexTar, normName, readMember, MAX_TAR_MEMBERS } from "../src/verbs/ghcr/tar.ts";
import { openArchive, planImage, MEDIA, MAX_LAYERS } from "../src/verbs/ghcr/archive.ts";
import { tar, paxRecord, ociArchive, dockerArchive, scratchDir, removeDir, join, sha, layerTar } from "./helpers/ghcr-fixtures.mts";

let root: string;
let drop: string;

beforeAll(() => {
	root = scratchDir("ghcr-archive");
	drop = join(root, "drop");
	mkdirSync(drop);
});
afterAll(() => removeDir(root));

let n = 0;
function file(buf: Buffer, dir = drop): string {
	const p = join(dir, `a${++n}.tar`);
	writeFileSync(p, buf);
	return p;
}

function withFd<T>(buf: Buffer, fn: (fd: number, size: number) => T): T {
	const fd = openSync(file(buf), "r");
	try {
		return fn(fd, buf.length);
	} finally {
		closeSync(fd);
	}
}

describe("indexTar", () => {
	it("indexes regular members and resolves symlinks and hard links inside the archive", () => {
		const buf = tar([
			{ name: "./dir/", type: "5" },
			{ name: "./dir/a.txt", data: "alpha" },
			{ name: "dir/link", type: "2", linkname: "a.txt" },
			{ name: "dir/hard", type: "1", linkname: "dir/a.txt" },
			{ name: "dir/chain", type: "2", linkname: "link" },
			{ name: "dir/dangling", type: "2", linkname: "nope" }
		]);
		withFd(buf, (fd, size) => {
			const { files } = indexTar(fd, size);
			for (const k of ["dir/a.txt", "dir/link", "dir/hard", "dir/chain"]) expect(readMember(fd, files.get(k)!, 100, k).toString()).toBe("alpha");
			expect(files.has("dir/dangling")).toBe(false);
			expect(files.has("dir")).toBe(false);
		});
	});

	it("reads PAX path/size, GNU long names, ustar prefixes and base-256 sizes", () => {
		const long = `${"x".repeat(120)}/file`;
		const buf = tar([
			{ name: "g", type: "g", data: paxRecord("comment", "global") },
			{ name: "pax", type: "x", data: paxRecord("path", "pax/name.txt") + paxRecord("size", "3") },
			{ name: "ignored", data: "abc" },
			{ name: "././@LongLink", type: "L", data: `${long}\0` },
			{ name: "short", data: "long" },
			{ name: "file.txt", prefix: "pre/fix", data: "pfx" },
			{ name: "b256", base256: true, data: "big" }
		]);
		withFd(buf, (fd, size) => {
			const { files } = indexTar(fd, size);
			expect(readMember(fd, files.get("pax/name.txt")!, 10, "x").toString()).toBe("abc");
			expect(readMember(fd, files.get(long)!, 10, "x").toString()).toBe("long");
			expect(readMember(fd, files.get("pre/fix/file.txt")!, 10, "x").toString()).toBe("pfx");
			expect(readMember(fd, files.get("b256")!, 10, "x").toString()).toBe("big");
		});
	});

	it("lets a later member replace an earlier link of the same name", () => {
		const buf = tar([
			{ name: "t", data: "target" },
			{ name: "x", type: "2", linkname: "t" },
			{ name: "x", data: "real" }
		]);
		withFd(buf, (fd, size) => expect(readMember(fd, indexTar(fd, size).files.get("x")!, 10, "x").toString()).toBe("real"));
	});

	it.each([
		["a bad checksum", tar([{ name: "a", data: "x", badChecksum: true }]), /bad tar header checksum/],
		["a non-octal size", tar([{ name: "a", data: "x", sizeField: "99999999999" }]), /bad size field/],
		["a member past the end", tar([{ name: "a", data: "x", sizeField: "00000077777" }], { end: false }), /runs past the end/],
		["a bad PAX record", tar([{ name: "p", type: "x", data: "zz path=x\n" }, { name: "a", data: "x" }]), /bad PAX header record/],
		["a bad PAX size", tar([{ name: "p", type: "x", data: paxRecord("size", "-1") }, { name: "a", data: "x" }]), /bad PAX size/],
		["a link loop", tar([{ name: "a", type: "2", linkname: "b" }, { name: "b", type: "2", linkname: "a" }]), /link loop/]
	])("refuses %s", (_label, buf, re) => {
		withFd(buf, (fd, size) => expect(() => indexTar(fd, size)).toThrow(re));
	});

	it("refuses a truncated header and an oversized extended header", () => {
		const big = tar([{ name: "p", type: "x", data: Buffer.alloc(1024 * 1024 + 1, 0x41) }]);
		withFd(big, (fd, size) => expect(() => indexTar(fd, size)).toThrow(/extended header too large/));
		// The file shrank after it was stat-ed: the second header is cut short.
		const two = tar([{ name: "a", data: "x" }, { name: "b", data: "y" }], { end: false });
		withFd(two.subarray(0, 1100), (fd) => expect(() => indexTar(fd, two.length)).toThrow(/truncated at byte 1100/));
	});

	it("caps the number of members", () => {
		const one = tar([{ name: "a", type: "5" }], { end: false });
		const buf = Buffer.concat([...Array.from({ length: MAX_TAR_MEMBERS + 1 }, () => one), Buffer.alloc(1024)]);
		withFd(buf, (fd, size) => expect(() => indexTar(fd, size)).toThrow(/more than/));
	});

	it("refuses to read a member over the caller's limit", () => {
		const buf = tar([{ name: "a", data: "0123456789" }]);
		withFd(buf, (fd, size) => expect(() => readMember(fd, indexTar(fd, size).files.get("a")!, 5, "thing")).toThrow(/thing is 10 bytes/));
	});

	it("normalizes names", () => {
		expect(normName("./a/../b/")).toBe("b");
		expect(normName("/abs/x")).toBe("abs/x");
		expect(normName("../../x")).toBe("x");
	});
});

describe("openArchive", () => {
	const MAX = 10 * 1024 * 1024;

	it("opens a file in the drop dir (absolute or relative) and reports its real path", () => {
		const p = file(tar([{ name: "a", data: "x" }]));
		const a = openArchive(p, drop, MAX);
		expect(a.path).toBe(p);
		expect(a.size).toBeGreaterThan(0);
		a.close();
		a.close(); // idempotent
		const rel = openArchive(p.slice(drop.length + 1), drop, MAX);
		expect(rel.path).toBe(p);
		rel.close();
	});

	it("allows subdirectories of the drop dir", () => {
		mkdirSync(join(drop, "sub"), { recursive: true });
		const p = file(tar([{ name: "a", data: "x" }]), join(drop, "sub"));
		const a = openArchive("sub/" + p.split("/").pop(), drop, MAX);
		a.close();
	});

	it.each([[""], [7], [undefined], ["x\0y"], ["a".repeat(5000)]])("refuses a bad archive argument %j", (arg) => {
		expect(() => openArchive(arg, drop, MAX)).toThrow(/"archive" must be a file path/);
	});

	it("refuses paths outside the drop dir lexically, before opening anything", () => {
		expect(() => openArchive("/etc/gh-broker/secrets.json", drop, MAX)).toThrow(/must be inside the drop directory/);
		expect(() => openArchive("../outside.tar", drop, MAX)).toThrow(/must be inside the drop directory/);
		expect(() => openArchive(drop, drop, MAX)).toThrow(/must be inside the drop directory/);
	});

	it("refuses a missing drop dir", () => {
		expect(() => openArchive(join(root, "nodrop", "a.tar"), join(root, "nodrop"), MAX)).toThrow(/does not exist/);
	});

	it("refuses a symlink, even one pointing inside the drop dir", () => {
		const target = file(tar([{ name: "a", data: "x" }]));
		const link = join(drop, "link.tar");
		symlinkSync(target, link);
		expect(() => openArchive(link, drop, MAX)).toThrow(/is a symlink/);
	});

	it("refuses a file reached through a symlinked directory that leads outside", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.tar"), "secret");
		symlinkSync(outside, join(drop, "escape"));
		expect(() => openArchive("escape/secret.tar", drop, MAX)).toThrow(/resolves outside the drop directory/);
	});

	it("refuses a hard-linked file", () => {
		const outside = join(root, "hl-src.tar");
		writeFileSync(outside, "secret");
		const p = join(drop, "hl.tar");
		linkSync(outside, p);
		expect(() => openArchive(p, drop, MAX)).toThrow(/2 hard links/);
	});

	it("refuses a directory, a FIFO (without hanging), an empty file and an oversized file", () => {
		mkdirSync(join(drop, "isdir.tar"));
		expect(() => openArchive(join(drop, "isdir.tar"), drop, MAX)).toThrow(/not a regular file/);
		const fifo = join(drop, "fifo.tar");
		execFileSync("mkfifo", [fifo]);
		expect(() => openArchive(fifo, drop, MAX)).toThrow(/not a regular file/);
		const empty = join(drop, "empty.tar");
		writeFileSync(empty, "");
		expect(() => openArchive(empty, drop, MAX)).toThrow(/is empty/);
		const big = file(Buffer.alloc(2048));
		expect(() => openArchive(big, drop, 1024)).toThrow(/over the 1024-byte limit/);
	});

	it("refuses a missing file and names an unreadable one", () => {
		expect(() => openArchive(join(drop, "nope.tar"), drop, MAX)).toThrow(/not found/);
		expect(() => openArchive(join(drop, "nodir", "x.tar"), drop, MAX)).toThrow(/not found/);
		const p = file(Buffer.from("x"));
		chmodSync(p, 0o000);
		try {
			if (process.getuid?.() !== 0) expect(() => openArchive(p, drop, MAX)).toThrow(/chmod g\+r/);
		} finally {
			chmodSync(p, 0o600);
		}
	});

	it("reports any other open error generically", () => {
		const name = join(drop, `${"n".repeat(300)}.tar`); // ENAMETOOLONG
		expect(() => openArchive(name, drop, MAX)).toThrow(/cannot open .* \(ENAMETOOLONG\)/);
	});
});

describe("planImage", () => {
	const plan = (buf: Buffer) => withFd(buf, (fd, size) => planImage(fd, size));

	it("pushes an already-compressed OCI layout verbatim, manifest included", () => {
		const img = ociArchive({ gzip: true, annotations: { a: "b" } });
		const p = plan(img.archive);
		expect(p.format).toBe("oci-layout");
		expect(p.layers.map((l) => [l.compress, l.mediaType, l.sourceDigest])).toEqual(img.layers.map((l) => [false, MEDIA.ociLayerGzip, sha(l)]));
		expect(p.verbatimManifest?.mediaType).toBe(MEDIA.ociManifest);
		expect(p.config.digest).toBe(sha(img.config));
		expect(p.annotations).toEqual({ a: "b" });
	});

	it("marks uncompressed OCI layers for gzip and drops the verbatim manifest", () => {
		const p = plan(ociArchive().archive);
		expect(p.layers.every((l) => l.compress && l.mediaType === MEDIA.ociLayerGzip)).toBe(true);
		expect(p.verbatimManifest).toBeUndefined();
	});

	it("retypes a gzip layer declared as plain tar, and keeps docker media types when correct", () => {
		const retyped = plan(ociArchive({ gzip: true, layerMediaType: MEDIA.ociLayer }).archive);
		expect(retyped.layers[0]!.mediaType).toBe(MEDIA.ociLayerGzip);
		expect(retyped.verbatimManifest).toBeUndefined();
		const docker = plan(
			ociArchive({ gzip: true, layerMediaType: MEDIA.dockerLayerGzip, configMediaType: MEDIA.dockerConfig, manifestMediaType: MEDIA.dockerManifest }).archive
		);
		expect(docker.layers[0]!.mediaType).toBe(MEDIA.dockerLayerGzip);
		expect(docker.verbatimManifest?.mediaType).toBe(MEDIA.dockerManifest);
	});

	it("detects zstd layers", () => {
		const zstd = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from("payload")]);
		const p = plan(rebuildWithBlob(zstd));
		expect(p.layers[0]!.mediaType).toBe(MEDIA.ociLayerZstd);
		expect(p.layers[0]!.compress).toBe(false);
	});

	it("unwraps a nested index and skips attestation and unknown-platform entries", () => {
		const attest = { mediaType: MEDIA.ociManifest, digest: sha("x"), size: 1, annotations: { "vnd.docker.reference.type": "attestation-manifest" } };
		const unknown = { mediaType: MEDIA.ociManifest, digest: sha("y"), size: 1, platform: { os: "unknown", architecture: "unknown" } };
		expect(plan(ociArchive({ nested: true, extraIndexEntries: [attest, unknown] }).archive).format).toBe("oci-layout");
	});

	it("picks the one platform whose blobs were saved from a full multi-platform index (containerd store)", () => {
		const notSaved = { mediaType: MEDIA.ociManifest, digest: sha("arm64 manifest"), size: 1, platform: { os: "linux", architecture: "arm64" } };
		expect(plan(ociArchive({ nested: true, extraIndexEntries: [notSaved] }).archive).format).toBe("oci-layout");
		expect(plan(ociArchive({ extraIndexEntries: [notSaved, { ...notSaved, digest: "md5:x" }] }).archive).format).toBe("oci-layout");
	});

	it("refuses multi-image archives and unsupported manifests", () => {
		const img = ociArchive();
		const idx = JSON.parse(extract(img.archive, "index.json"));
		const both = ociArchive({ extraIndexEntries: [{ ...idx.manifests[0], platform: { os: "linux", architecture: "arm64" } }] });
		expect(() => plan(both.archive)).toThrow(/holds 2 images/);
		expect(() => plan(ociArchive({ manifestMediaType: "application/x-weird" }).archive)).toThrow(/manifest media type/);
		expect(() => plan(tar([{ name: "index.json", data: "{}" }]))).toThrow(/no manifests list/);
		expect(() => plan(tar([{ name: "index.json", data: "not json" }]))).toThrow(/index.json is not valid JSON/);
	});

	it("refuses missing, mismatched or non-sha256 blobs", () => {
		const img = ociArchive({ gzip: true });
		const cfgName = `blobs/sha256/${sha(img.config).slice(7)}`;
		expect(() => plan(ociArchive({ gzip: true, omit: [cfgName] }).archive)).toThrow(/image config sha256:.* is missing/);
		expect(() => plan(ociArchive({ gzip: true, mutateManifest: (m) => (m.config.size = 1) }).archive)).toThrow(/config size does not match/);
		expect(() => plan(ociArchive({ gzip: true, mutateManifest: (m) => (m.layers[0].size = 1) }).archive)).toThrow(/layer 1 size does not match/);
		expect(() => plan(ociArchive({ gzip: true, mutateManifest: (m) => (m.layers[0].digest = "sha512:abc") }).archive)).toThrow(/only sha256/);
		expect(() => plan(ociArchive({ gzip: true, mutateManifest: (m) => delete m.layers }).archive)).toThrow(/no config or layers/);
		expect(() => plan(ociArchive({ gzip: true, configMediaType: "application/x-cfg" }).archive)).toThrow(/config media type/);
		expect(() => plan(ociArchive({ gzip: true, layerMediaType: "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip" }).archive)).toThrow(/non-distributable/);
		expect(() => plan(ociArchive({ gzip: true, mutateManifest: (m) => (m.layers = Array.from({ length: MAX_LAYERS + 1 }, () => m.layers[0])) }).archive)).toThrow(/at most 256/);
	});

	it("refuses a manifest blob whose bytes don't match its digest", () => {
		const img = ociArchive({ gzip: true });
		const idx = JSON.parse(extract(img.archive, "index.json"));
		const tampered = tar([
			{ name: "index.json", data: JSON.stringify({ manifests: [{ ...idx.manifests[0] }] }) },
			{ name: `blobs/sha256/${idx.manifests[0].digest.slice(7)}`, data: "{}" }
		]);
		expect(() => plan(tampered)).toThrow(/image manifest does not match its digest/);
	});

	it("reads a legacy docker-archive, following its symlinked duplicate layer", () => {
		const img = dockerArchive({ gzipFirst: true });
		const p = plan(img.archive);
		expect(p.format).toBe("docker-archive");
		expect(p.config.digest).toBe(sha(img.config));
		expect(p.config.mediaType).toBe(MEDIA.ociConfig);
		expect(p.layers.map((l) => l.compress)).toEqual([false, true, true]);
		expect(p.layers[0]!.mediaType).toBe(MEDIA.ociLayerGzip);
		expect(p.layers[1]!.member).toEqual(p.layers[2]!.member);
	});

	it("refuses bad docker-archives and non-image tarballs", () => {
		expect(() => plan(dockerArchive({ images: 2 }).archive)).toThrow(/holds 2 images/);
		expect(() => plan(tar([{ name: "manifest.json", data: "{}" }]))).toThrow(/holds 0 images/);
		expect(() => plan(tar([{ name: "manifest.json", data: "[{}]" }]))).toThrow(/no Config or Layers/);
		expect(() => plan(tar([{ name: "manifest.json", data: '[{"Config":"c.json","Layers":["l.tar"]}]' }]))).toThrow(/image config "c.json" is missing/);
		expect(() => plan(tar([{ name: "manifest.json", data: JSON.stringify([{ Config: "c.json", Layers: Array(257).fill("l") }]) }]))).toThrow(/at most 256/);
		expect(() =>
			plan(
				tar([
					{ name: "c.json", data: "{}" },
					{ name: "manifest.json", data: '[{"Config":"c.json","Layers":["l.tar"]}]' }
				])
			)
		).toThrow(/layer 1 "l.tar" is missing/);
		expect(() => plan(tar([{ name: "readme", data: "hi" }]))).toThrow(/not an image archive/);
	});
});

/** Pull one member's text out of a built archive. */
function extract(buf: Buffer, name: string): string {
	return withFd(buf, (fd, size) => readMember(fd, indexTar(fd, size).files.get(name)!, 1 << 20, name).toString());
}

/** A one-layer OCI archive whose only layer is `blob` (any bytes), declared as zstd. */
function rebuildWithBlob(blob: Buffer): Buffer {
	const config = Buffer.from(JSON.stringify({ rootfs: { type: "layers", diff_ids: [sha(layerTar("z"))] } }));
	const manifest = Buffer.from(
		JSON.stringify({
			schemaVersion: 2,
			mediaType: MEDIA.ociManifest,
			config: { mediaType: MEDIA.ociConfig, digest: sha(config), size: config.length },
			layers: [{ mediaType: MEDIA.ociLayerZstd, digest: sha(blob), size: blob.length }]
		})
	);
	const index = JSON.stringify({ manifests: [{ mediaType: MEDIA.ociManifest, digest: sha(manifest), size: manifest.length }] });
	return tar([
		{ name: "index.json", data: index },
		{ name: `blobs/sha256/${sha(config).slice(7)}`, data: config },
		{ name: `blobs/sha256/${sha(manifest).slice(7)}`, data: manifest },
		{ name: `blobs/sha256/${sha(blob).slice(7)}`, data: blob }
	]);
}
