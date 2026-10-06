/**
 * Route-level proof of the untrusted-content origin switch. The unit tests in ./lib/untrusted-origin.test.ts prove the
 * resolver; these prove the Worker actually behaves differently.
 *
 * The two things worth breaking a build over:
 *  1. UNSET must be a genuine no-op. A half-migration that quietly keeps
 *     serving agent bytes from the shared origin while looking migrated is
 *     the failure mode this item exists to avoid.
 *  2. CONFIGURED must move every byte lane — including the session-authed
 *     ones, which have to trade the session for a signed token because the
 *     cookie cannot cross the boundary by design.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const artifactMock = vi.hoisted(() => ({
	current: {
		id: "art-1",
		sizeBytes: 0,
		organizationId: "org-1",
		tediId: "tedi-1",
		uri: "r2://tedix-tedi-production/tedi-1/artifacts/art-1/",
		mimeType: "text/html; charset=utf-8",
		metadata: { bundle: true, entrypoint: "index.html" },
		accessClassification: null as
			| "source_derived"
			| "runtime_private"
			| "explicit_shareable"
			| null,
		contentDigest: null as string | null,
		producerExecutionId: null as string | null,
		accessEnvelope: null as string | null,
		publicationState: null as "pending" | "ready" | null,
	},
}));
const releaseMock = vi.hoisted(() => ({ active: vi.fn() }));
vi.mock("@tedix/db/queries/artifact-policy/releases", () => ({
	getActiveArtifactReleaseApproval: releaseMock.active,
}));

vi.mock("@tedix/auth/jwt", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	validateToken: async () => ({ sub: "descope-user-1" }),
}));
vi.mock("@tedix/auth/types", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveTenantOverride: () => ({
		tenantId: "descope-tenant-1",
		isCrossTenantOverride: false,
	}),
}));
vi.mock("@tedix/db/client", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createDbClient: () => ({}),
}));
vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getOrganizationByDescopeId: async () => ({ id: "org-1" }),
}));
vi.mock("@tedix/db/queries/skill-runs", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getSkillRun: async () => ({ id: "run-1", organizationId: "org-1" }),
}));
vi.mock("@tedix/db/queries/kernel-runtime-events", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getTediArtifactById: async () => artifactMock.current,
}));

import worker from "./worker-app";
import { signArtifactReleaseUrl } from "./lib/artifact-url";

const UNTRUSTED = "https://artifacts.tedix-usercontent.example";

const baseEnv = {
	API_URL: "https://api.tedix.dev",
	OS_URL: "https://os.tedix.dev",
	SECRETS_MASTER_KEY: "test-master-key",
	DESCOPE_PROJECT_ID: "P-test",
	DESCOPE_BASE_URL: "https://auth.tedix.dev",
	// /artifacts/* is rate limited and fails CLOSED without a binding.
	API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	DB: {
		withSession: () => ({ getBookmark: () => null }),
	},
};

const ctx = {} as ExecutionContext;
const call = async (
	url: string,
	env: Record<string, unknown>,
	init?: RequestInit,
): Promise<Response> =>
	worker.fetch(new Request(url, init), env as unknown as CloudflareEnv, ctx);

const configured = { ...baseEnv, UNTRUSTED_CONTENT_ORIGIN: UNTRUSTED };
const unset = { ...baseEnv, UNTRUSTED_CONTENT_ORIGIN: "" };
const invalid = {
	...baseEnv,
	UNTRUSTED_CONTENT_ORIGIN: "https://artifacts.tedix.dev",
};

describe("unset — the switch is genuinely off", () => {
	it("serves an org-scoped historical render from R2 with range context", async () => {
		let key: string | undefined;
		let range: Headers | undefined;
		const res = await call(
			"https://api.tedix.dev/video-renders/5860e069-c32c-4659-94b3-6169da778d2c/media",
			{
				...unset,
				TEDI_R2_BUCKET: {
					get: async (k: string, options: { range: Headers }) => {
						key = k;
						range = options.range;
						return {
							body: "video",
							size: 10,
							range: { offset: 0, length: 5 },
						};
					},
				},
			},
			{
				headers: {
					Authorization: "Bearer session-jwt",
					Range: "bytes=0-4",
				},
			},
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Type")).toBe("video/mp4");
		expect(res.headers.get("Content-Range")).toBe("bytes 0-4/10");
		expect(key).toBe(
			"video-renders/org-1/5860e069-c32c-4659-94b3-6169da778d2c/output.mp4",
		);
		expect(range?.get("Range")).toBe("bytes=0-4");
	});

	it("rejects private video without a session", async () => {
		const res = await call(
			"https://api.tedix.dev/video-renders/5860e069-c32c-4659-94b3-6169da778d2c/media",
			unset,
		);
		expect(res.status).toBe(401);
	});

	it("refuses unversioned signed artifact links", async () => {
		const res = await call(
			"https://api.tedix.dev/artifacts/s/tedi-1/art-1?exp=99&sig=nope",
			unset,
		);
		expect(res.status).toBe(404);
	});

	it("serves the signed skill-media lane here", async () => {
		const res = await call(
			"https://api.tedix.dev/skill-media/run-1/outputs/a.json?exp=99&sig=nope",
			unset,
		);
		expect(res.status).toBe(403);
	});

	it("gates nothing on an unrelated host", async () => {
		const res = await call(`${UNTRUSTED}/`, unset);
		expect(res.status).toBe(200);
	});
});

describe("configured — trusted-origin byte routes bounce to the boundary", () => {
	it("redirects the signed artifact lane, preserving path and token", async () => {
		const res = await call(
			"https://api.tedix.dev/artifacts/s/tedi-1/art-1/js/app.js?exp=99&sig=abc",
			configured,
		);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("Location") ?? "");
		expect(location.origin).toBe(UNTRUSTED);
		expect(location.pathname).toBe("/artifacts/s/tedi-1/art-1/js/app.js");
		expect(location.searchParams.get("sig")).toBe("abc");
		expect(location.searchParams.get("exp")).toBe("99");
	});

	it("redirects the signed skill-media lane", async () => {
		const res = await call(
			"https://api.tedix.dev/skill-media/run-1/outputs/a.png?exp=99&sig=abc",
			configured,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(
			`${UNTRUSTED}/skill-media/run-1/outputs/a.png?exp=99&sig=abc`,
		);
	});

	it("does not serve or redirect session artifact bytes when the boundary is configured", async () => {
		const res = await call(
			"https://api.tedix.dev/artifacts/tedi-1/art-1/js/app.js",
			configured,
			{ headers: { Authorization: "Bearer session-jwt" } },
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("Location")).toBeNull();
	});

	it("does not redirect a session artifact whose stored R2 key is unowned", async () => {
		const original = artifactMock.current;
		artifactMock.current = {
			...original,
			uri: "r2://tedix-tedi-production/other-tedi/artifacts/secret.html",
		};
		const get = vi.fn(async () => ({ body: "secret", size: 6 }));
		try {
			const res = await call(
				"https://api.tedix.dev/artifacts/tedi-1/art-1",
				{ ...configured, TEDI_R2_BUCKET: { get } },
				{ headers: { Authorization: "Bearer session-jwt" } },
			);
			expect({
				status: res.status,
				location: res.headers.get("Location"),
			}).toEqual({ status: 404, location: null });
			expect(get).not.toHaveBeenCalled();
		} finally {
			artifactMock.current = original;
		}
	});

	it("trades the SESSION skill-media lane for a signed URL too", async () => {
		const res = await call(
			"https://api.tedix.dev/skill-runs/run-1/media/outputs/a.png",
			configured,
			{ headers: { Authorization: "Bearer session-jwt" } },
		);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("Location") ?? "");
		expect(location.origin).toBe(UNTRUSTED);
		expect(location.pathname).toBe("/skill-media/run-1/outputs/a.png");
		expect(location.searchParams.get("sig")).toBeTruthy();
	});

	it("still refuses an unauthenticated session-lane request", async () => {
		const res = await call(
			"https://api.tedix.dev/artifacts/tedi-1/art-1",
			configured,
		);
		expect(res.status).toBe(401);
	});
});

describe("configured — the boundary origin serves the signed lanes and nothing else", () => {
	it("denies legacy signed artifact links at the boundary origin", async () => {
		const res = await call(
			`${UNTRUSTED}/artifacts/s/tedi-1/art-1?exp=99&sig=nope`,
			configured,
		);
		expect(res.status).toBe(404);
	});

	it("404s the authenticated API", async () => {
		for (const path of ["/rpc/tedis/list", "/v1/tedis", "/openapi.json", "/"]) {
			const res = await call(`${UNTRUSTED}${path}`, configured);
			expect(res.status).toBe(404);
		}
	});

	it("404s the SESSION byte lanes — no cookie is ever read there", async () => {
		for (const path of [
			"/artifacts/tedi-1/art-1",
			"/skill-runs/run-1/media/a.png",
		]) {
			const res = await call(`${UNTRUSTED}${path}`, configured, {
				headers: { Authorization: "Bearer session-jwt" },
			});
			expect(res.status).toBe(404);
		}
	});

	it("404s a session artifact whose tediId is literally `s`", async () => {
		// Hono routes /artifacts/s/art-1 to the SESSION handler (tediId="s").
		// It must not reach a cookie-reading handler on this origin.
		const res = await call(`${UNTRUSTED}/artifacts/s/art-1`, configured, {
			headers: { Authorization: "Bearer session-jwt" },
		});
		expect(res.status).toBe(404);
	});

	it("404s non-GET methods", async () => {
		const res = await call(
			`${UNTRUSTED}/artifacts/s/tedi-1/art-1`,
			configured,
			{
				method: "POST",
			},
		);
		expect(res.status).toBe(404);
	});

	it("emits no credentialed CORS on the boundary origin", async () => {
		const res = await call(
			`${UNTRUSTED}/artifacts/s/tedi-1/art-1?exp=99&sig=nope`,
			configured,
			{ headers: { Origin: "https://os.tedix.dev" } },
		);
		expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
		expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe(
			"https://os.tedix.dev",
		);
	});

	it("keeps credentialed CORS on the API origin", async () => {
		const res = await call("https://api.tedix.dev/", configured, {
			headers: { Origin: "https://os.tedix.dev" },
		});
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://os.tedix.dev",
		);
		expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
	});
});

describe("artifact URI ownership at the byte boundary", () => {
	it("denies an unversioned bearer URL", async () => {
		const get = vi.fn(async () => ({ body: "secret", size: 6 }));
		const res = await call(
			`${UNTRUSTED}/artifacts/s/tedi-1/art-1?exp=${Math.floor(Date.now() / 1000) + 60}&sig=x`,
			{ ...configured, TEDI_R2_BUCKET: { get } },
		);
		expect(res.status).toBe(404);
		expect(get).not.toHaveBeenCalled();
	});

	it("denies pending classified bytes on the authenticated lane", async () => {
		const original = artifactMock.current;
		const get = vi.fn(async () => ({ body: "secret", size: 6 }));
		try {
			for (const accessClassification of [
				"explicit_shareable",
				"source_derived",
			] as const) {
				artifactMock.current = {
					...original,
					accessClassification,
					contentDigest: "a".repeat(64),
					producerExecutionId: "execution-1",
					accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
					publicationState: "pending",
				};
				expect(
					(
						await call(
							"https://api.tedix.dev/artifacts/tedi-1/art-1",
							{ ...configured, TEDI_R2_BUCKET: { get } },
							{ headers: { Authorization: "Bearer session-jwt" } },
						)
					).status,
				).toBe(404);
			}
			expect(get).not.toHaveBeenCalled();
		} finally {
			artifactMock.current = original;
		}
	});
});

describe("reviewed private-child v2 byte boundary", () => {
	const original = artifactMock.current;
	const bytes = new TextEncoder().encode(
		"\uFEFF<script>private reviewed child</script> €",
	);
	let digest: string;
	let get: ReturnType<typeof vi.fn>;
	let head: ReturnType<typeof vi.fn>;
	let signed: { url: string; expiresAt: string };
	let duringRead: () => void;
	const active = () => ({
		candidate: {
			organizationId: "org-1",
			tediId: "tedi-1",
			childArtifactId: "art-1",
		},
	});
	const env = () => ({ ...configured, TEDI_R2_BUCKET: { get, head } });
	beforeEach(async () => {
		digest = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		artifactMock.current = {
			...original,
			uri: "r2://tedix-tedi-production/tedi-1/artifacts/redacted/child.txt",
			mimeType: "text/plain",
			metadata: { bundle: false, entrypoint: "" },
			accessClassification: "runtime_private",
			publicationState: "ready",
			contentDigest: digest,
			sizeBytes: bytes.byteLength,
		};
		releaseMock.active.mockReset().mockImplementation(async () => active());
		duringRead = () => {};
		head = vi.fn(async () => ({ size: bytes.byteLength }));
		get = vi.fn(async () => ({
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					duringRead();
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			size: bytes.byteLength,
		}));
		signed = await signArtifactReleaseUrl({
			baseUrl: UNTRUSTED,
			secret: baseEnv.SECRETS_MASTER_KEY,
			tediId: "tedi-1",
			artifactId: "art-1",
			approvalId: "approval-1",
			contentDigest: digest,
			nowMs: Date.now(),
			ttlSeconds: 60,
		});
	});
	afterEach(() => {
		artifactMock.current = original;
		vi.restoreAllMocks();
	});

	it("serves exact verified bytes once, inert and uncached, with both approval checks", async () => {
		const response = await call(signed.url, env());
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		expect(response.headers.get("Content-Type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Security-Policy")).toContain(
			"sandbox",
		);
		expect(get).toHaveBeenCalledExactlyOnceWith(
			"tedi-1/artifacts/redacted/child.txt",
		);
		expect(head).toHaveBeenCalledTimes(1);
		expect(releaseMock.active).toHaveBeenCalledTimes(2);
	});
	it.each([
		"original",
		"unapproved",
		"inactive-owner",
		"wrong-org",
		"wrong-tedi",
		"wrong-child",
		"digest-mismatch",
	])("denies %s before reading bytes", async (failure) => {
		if (["original", "unapproved", "inactive-owner"].includes(failure))
			releaseMock.active.mockResolvedValue(null);
		if (failure === "wrong-org")
			releaseMock.active.mockResolvedValue({
				candidate: { ...active().candidate, organizationId: "other" },
			});
		if (failure === "wrong-tedi")
			releaseMock.active.mockResolvedValue({
				candidate: { ...active().candidate, tediId: "other" },
			});
		if (failure === "wrong-child")
			releaseMock.active.mockResolvedValue({
				candidate: { ...active().candidate, childArtifactId: "other" },
			});
		if (failure === "digest-mismatch")
			artifactMock.current.contentDigest = "a".repeat(64);
		expect((await call(signed.url, env())).status).toBe(404);
		expect(get).not.toHaveBeenCalled();
	});
	it.each(["revocation", "owner-loss"])(
		"denies %s during body read",
		async () => {
			duringRead = () => {
				releaseMock.active.mockResolvedValue(null);
			};
			const response = await call(signed.url, env());
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("private reviewed child");
			expect(get).toHaveBeenCalledTimes(1);
		},
	);
	it("rechecks expiry after reading the body", async () => {
		duringRead = () => {
			vi.spyOn(Date, "now").mockReturnValue(Date.parse(signed.expiresAt));
		};
		expect((await call(signed.url, env())).status).toBe(404);
		expect(get).toHaveBeenCalledTimes(1);
	});
	it.each(["downgrade", "unknown-version", "approval", "digest", "signature"])(
		"rejects token %s",
		async (failure) => {
			const url = new URL(signed.url);
			if (failure === "downgrade") url.searchParams.delete("v");
			if (failure === "unknown-version") url.searchParams.set("v", "3");
			if (failure === "approval") url.searchParams.set("approval", "other");
			if (failure === "digest") url.searchParams.set("digest", "a".repeat(64));
			if (failure === "signature") url.searchParams.set("sig", "wrong");
			expect((await call(url.toString(), env())).status).toBe(
				failure === "downgrade" ? 404 : 403,
			);
			expect(get).not.toHaveBeenCalled();
		},
	);
	it("does not accept an unversioned bearer URL for private bytes", async () => {
		const v1 = new URL(signed.url);
		v1.search = `?exp=${Math.floor(Date.now() / 1000) + 60}&sig=x`;
		expect((await call(v1.toString(), env())).status).toBe(404);
		expect(get).not.toHaveBeenCalled();
	});
	it("denies Range and subpaths rather than reading partial approved content", async () => {
		expect(
			(await call(signed.url, env(), { headers: { Range: "bytes=0-3" } }))
				.status,
		).toBe(404);
		const url = new URL(signed.url);
		url.pathname += "/other.txt";
		expect((await call(url.toString(), env())).status).toBe(404);
		expect(get).not.toHaveBeenCalled();
	});
	it.each(["corrupt", "unsupported", "unowned", "oversized"])(
		"denies a %s body under an otherwise active approval",
		async (failure) => {
			if (failure === "corrupt")
				get.mockResolvedValue({
					body: new Response("different").body,
					size: 9,
				});
			if (failure === "unsupported")
				artifactMock.current.mimeType = "application/pdf";
			if (failure === "unowned")
				artifactMock.current.uri =
					"r2://tedix-tedi-production/other/artifacts/file.txt";
			if (failure === "oversized") head.mockResolvedValue({ size: 51201 });
			expect((await call(signed.url, env())).status).toBe(404);
		},
	);
});

describe("invalid — refuses loudly, never falls back to the shared origin", () => {
	it("503s every agent-authored byte path", async () => {
		for (const path of [
			"/artifacts/s/tedi-1/art-1?exp=1&sig=x",
			"/artifacts/tedi-1/art-1",
			"/skill-media/run-1/a.json?exp=1&sig=x",
			"/skill-runs/run-1/media/a.png",
		]) {
			const res = await call(`https://api.tedix.dev${path}`, invalid);
			expect(res.status).toBe(503);
		}
	});

	it("leaves the rest of the API working", async () => {
		const res = await call("https://api.tedix.dev/", invalid);
		expect(res.status).toBe(200);
	});
});
