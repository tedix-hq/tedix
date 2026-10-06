import { describe, expect, it } from "vite-plus/test";
import { artifactBucketBinding, streamArtifactObject } from "./artifact-serve";
import {
	ARTIFACT_SHARE_DEFAULT_TTL_SECONDS,
	ARTIFACT_SHARE_MAX_TTL_SECONDS,
	clampArtifactTtlSeconds,
	signArtifactReleaseUrl,
	verifyArtifactReleaseToken,
} from "./artifact-url";

const SECRET = "test-master-secret-0123456789";
const TEDI = "5eed0024";
const ART = "run-7:artifact:deliverable:report.md";

describe("clampArtifactTtlSeconds", () => {
	it("defaults when absent/invalid/non-positive", () => {
		expect(clampArtifactTtlSeconds(undefined)).toBe(
			ARTIFACT_SHARE_DEFAULT_TTL_SECONDS,
		);
		expect(clampArtifactTtlSeconds(0)).toBe(ARTIFACT_SHARE_DEFAULT_TTL_SECONDS);
		expect(clampArtifactTtlSeconds(-5)).toBe(
			ARTIFACT_SHARE_DEFAULT_TTL_SECONDS,
		);
	});
	it("caps at the 7-day ceiling", () => {
		expect(clampArtifactTtlSeconds(99 * 24 * 3600)).toBe(
			ARTIFACT_SHARE_MAX_TTL_SECONDS,
		);
		expect(clampArtifactTtlSeconds(120)).toBe(120);
	});
});

describe("reviewed artifact release v2 tokens", () => {
	const nowMs = 1_900_000_000_000;
	const contentDigest = "a".repeat(64);
	const approvalId = "review-7";
	const input = {
		baseUrl: "https://artifacts.tedix.dev",
		secret: SECRET,
		tediId: TEDI,
		artifactId: ART,
		approvalId,
		contentDigest,
		nowMs,
		ttlSeconds: 60,
	};
	async function signedToken() {
		const signed = await signArtifactReleaseUrl(input);
		const url = new URL(signed.url);
		return {
			...input,
			exp: Number(url.searchParams.get("exp")),
			sig: url.searchParams.get("sig") ?? "",
		};
	}

	it("round-trips a versioned exact child/digest/approval URL", async () => {
		const signed = await signArtifactReleaseUrl(input);
		const url = new URL(signed.url);
		expect(url.origin).toBe(input.baseUrl);
		expect(url.pathname).toBe(
			`/artifacts/s/${encodeURIComponent(TEDI)}/${encodeURIComponent(ART)}`,
		);
		expect(url.searchParams.get("v")).toBe("2");
		expect(url.searchParams.get("approval")).toBe(approvalId);
		expect(url.searchParams.get("digest")).toBe(contentDigest);
		expect(url.searchParams.get("exp")).toBe(String(nowMs / 1000 + 60));
		expect(Date.parse(signed.expiresAt)).toBe(nowMs + 60_000);
		expect(await verifyArtifactReleaseToken(await signedToken())).toBe(true);
	});

	it.each([
		["tedi", { tediId: "another-tedi" }],
		["child artifact", { artifactId: "original-artifact" }],
		["approval", { approvalId: "later-reapproval" }],
		["digest", { contentDigest: "b".repeat(64) }],
		["expiry", { exp: nowMs / 1000 + 61 }],
		["secret", { secret: "wrong-secret" }],
		["signature", { sig: "malformed" }],
	] as const)("rejects substitution of %s", async (_label, change) => {
		expect(
			await verifyArtifactReleaseToken({ ...(await signedToken()), ...change }),
		).toBe(false);
	});

	it("expires at its boundary and rejects non-finite or fractional expiry", async () => {
		const token = await signedToken();
		expect(
			await verifyArtifactReleaseToken({ ...token, nowMs: token.exp * 1000 }),
		).toBe(false);
		for (const exp of [NaN, Infinity, -Infinity, token.exp + 0.5]) {
			expect(await verifyArtifactReleaseToken({ ...token, exp })).toBe(false);
		}
	});

	it.each(["", "A".repeat(64), "a".repeat(63), "g".repeat(64)])(
		"refuses malformed release digest %s at signing and verification",
		async (invalidDigest) => {
			await expect(
				signArtifactReleaseUrl({ ...input, contentDigest: invalidDigest }),
			).rejects.toThrow("digest");
			expect(
				await verifyArtifactReleaseToken({
					...(await signedToken()),
					contentDigest: invalidDigest,
				}),
			).toBe(false);
		},
	);

	it("cannot collide adjacent fields by moving a delimiter between them", async () => {
		const signed = new URL(
			(
				await signArtifactReleaseUrl({
					...input,
					tediId: "owner|child",
					artifactId: "revision",
				})
			).url,
		);
		expect(
			await verifyArtifactReleaseToken({
				...(await signedToken()),
				tediId: "owner",
				artifactId: "child|revision",
				exp: Number(signed.searchParams.get("exp")),
				sig: signed.searchParams.get("sig") ?? "",
			}),
		).toBe(false);
	});

	it("caps release token lifetime without changing legacy token behavior", async () => {
		const signed = new URL(
			(
				await signArtifactReleaseUrl({
					...input,
					ttlSeconds: ARTIFACT_SHARE_MAX_TTL_SECONDS * 2,
				})
			).url,
		);
		expect(Number(signed.searchParams.get("exp"))).toBe(
			nowMs / 1000 + ARTIFACT_SHARE_MAX_TTL_SECONDS,
		);
	});
});

describe("artifactBucketBinding", () => {
	it("maps known bucket names to bindings; unknown → undefined", () => {
		const env = {
			TEDI_R2_BUCKET: "tedi" as unknown as R2Bucket,
			SKILL_ARTIFACTS: "skill" as unknown as R2Bucket,
			R2_BUCKET: "assets" as unknown as R2Bucket,
			CONTENT_CMS_BUCKET: "cms" as unknown as R2Bucket,
		};
		expect(artifactBucketBinding(env, "tedix-tedi-production")).toBe(
			env.TEDI_R2_BUCKET,
		);
		expect(artifactBucketBinding(env, "skill-artifacts-production")).toBe(
			env.SKILL_ARTIFACTS,
		);
		expect(artifactBucketBinding(env, "tedix-assets")).toBe(env.R2_BUCKET);
		expect(artifactBucketBinding(env, "content-cms")).toBe(
			env.CONTENT_CMS_BUCKET,
		);
		expect(artifactBucketBinding(env, "nope")).toBeUndefined();
	});
});

describe("streamArtifactObject", () => {
	const body = "<h1>Weekly Trend Report</h1>";
	function fakeBucket() {
		return {
			get: async (
				_key: string,
				opts?: { range?: { offset: number; length: number } },
			) => {
				if (opts?.range) {
					const slice = body.slice(
						opts.range.offset,
						opts.range.offset + opts.range.length,
					);
					return { body: slice, size: body.length };
				}
				return { body, size: body.length };
			},
			head: async (_key: string) => ({ size: body.length }),
		} as unknown as R2Bucket;
	}

	it("streams 200 with the artifact mimeType", async () => {
		const env = { TEDI_R2_BUCKET: fakeBucket() };
		const res = await streamArtifactObject(
			env,
			{
				uri: "r2://tedix-tedi-production/5eed0024/artifacts/deliverable/report.html",
				mimeType: "text/html; charset=utf-8",
			},
			null,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(res.headers.get("Content-Length")).toBe(String(body.length));
		// HTML is sandboxed + nosniff so tedi-generated markup can't XSS the origin.
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
	});

	// Renamed from "CSP sandbox only for HTML", which stated the defect as the
	// rule: sandboxing ONLY text/html left every other scriptable type — svg,
	// xhtml, xml — executing on the API origin. The csv assertion below is
	// unchanged and still correct; the invariant it belongs to is now
	// "sandbox unless provably inert".
	it("nosniff always; no sandbox for a provably inert type", async () => {
		const env = { TEDI_R2_BUCKET: fakeBucket() };
		const csv = await streamArtifactObject(
			env,
			{ uri: "r2://tedix-tedi-production/x/report.csv", mimeType: "text/csv" },
			null,
		);
		expect(csv.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(csv.headers.get("Content-Security-Policy")).toBeNull();
	});

	it("sandboxes every scriptable type, not just text/html", async () => {
		const env = { TEDI_R2_BUCKET: fakeBucket() };
		for (const mimeType of [
			"image/svg+xml",
			"application/xhtml+xml",
			"text/xml; charset=utf-8",
			"application/xml",
			// An unrecognized type must fail CLOSED: the scriptable set is
			// open-ended, so anything not provably inert is sandboxed.
			"application/x-totally-unknown",
		]) {
			const res = await streamArtifactObject(
				env,
				{ uri: "r2://tedix-tedi-production/x/evil", mimeType },
				null,
			);
			expect(
				res.headers.get("Content-Security-Policy"),
				`${mimeType} must be sandboxed`,
			).toContain("sandbox");
		}
	});

	it("keeps audio and video inert without a sandbox", async () => {
		const env = { TEDI_R2_BUCKET: fakeBucket() };
		for (const mimeType of ["video/mp4", "audio/mpeg", "image/png"]) {
			const res = await streamArtifactObject(
				env,
				{ uri: "r2://tedix-tedi-production/x/media", mimeType },
				null,
			);
			expect(res.headers.get("Content-Security-Policy")).toBeNull();
		}
	});

	it("returns 206 for a Range request", async () => {
		const env = { TEDI_R2_BUCKET: fakeBucket() };
		const res = await streamArtifactObject(
			env,
			{
				uri: "r2://tedix-tedi-production/5eed0024/artifacts/deliverable/clip.mp4",
				mimeType: "video/mp4",
			},
			"bytes=0-9",
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe(`bytes 0-9/${body.length}`);
		expect(res.headers.get("Content-Length")).toBe("10");
	});

	it("415 for a non-r2 uri, 404 for an unknown bucket", async () => {
		const env = { TEDI_R2_BUCKET: fakeBucket() };
		expect(
			(
				await streamArtifactObject(
					env,
					{ uri: null, mimeType: "text/html" },
					null,
				)
			).status,
		).toBe(415);
		expect(
			(
				await streamArtifactObject(
					env,
					{ uri: "r2://unknown-bucket/x", mimeType: "text/html" },
					null,
				)
			).status,
		).toBe(404);
	});
});
