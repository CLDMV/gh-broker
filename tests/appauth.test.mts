import { describe, it, expect, vi, beforeEach } from "vitest";

const { createAppAuthMock, octokitCtor } = vi.hoisted(() => ({
	createAppAuthMock: vi.fn(),
	// Constructable mock (arrow fns can't be `new`-ed).
	octokitCtor: vi.fn(function (this: any, opts: unknown) {
		this.__opts = opts;
	})
}));

vi.mock("@octokit/core", () => ({ Octokit: octokitCtor }));
vi.mock("@octokit/auth-app", () => ({ createAppAuth: createAppAuthMock }));

import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import { AppAuth } from "../src/appauth.ts";

function config(overrides: Record<string, unknown> = {}): any {
	return {
		listen: "unix:/x",
		upstream: "https://x",
		tools: [],
		app: { appId: 555, privateKey: "cred:app-key" },
		owners: {
			cldmv: { read: "cred:r", write: "cred:w", installationId: 42 },
			noapp: { read: "cred:r2", write: "cred:w2" }
		},
		...overrides
	};
}

describe("AppAuth", () => {
	let secrets: { resolve: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		secrets = { resolve: vi.fn((ref: string) => (ref === "cred:app-key" ? "PEM-PRIVATE-KEY" : "other")) };
	});

	it("throws when the config has no app section", () => {
		expect(() => new AppAuth(config({ app: undefined }), secrets as any)).toThrow(/no app config/);
	});

	it("resolves the App private key at construction", () => {
		new AppAuth(config(), secrets as any);
		expect(secrets.resolve).toHaveBeenCalledWith("cred:app-key");
	});

	it("returns null for an owner without an installationId", () => {
		const auth = new AppAuth(config(), secrets as any);
		expect(auth.octokitFor("noapp")).toBeNull();
	});

	it("returns null for an unknown owner", () => {
		const auth = new AppAuth(config(), secrets as any);
		expect(auth.octokitFor("nobody")).toBeNull();
	});

	it("builds an App-authed Octokit for an owner with an installationId", () => {
		const auth = new AppAuth(config(), secrets as any);
		const ok = auth.octokitFor("cldmv");
		expect(ok).not.toBeNull();
		expect(Octokit).toHaveBeenCalledWith({
			authStrategy: createAppAuth,
			auth: { appId: 555, privateKey: "PEM-PRIVATE-KEY", installationId: 42 }
		});
	});

	it("caches the Octokit per installation id", () => {
		const auth = new AppAuth(config(), secrets as any);
		const first = auth.octokitFor("cldmv");
		const second = auth.octokitFor("cldmv");
		expect(first).toBe(second);
		expect(Octokit).toHaveBeenCalledTimes(1);
	});
});
