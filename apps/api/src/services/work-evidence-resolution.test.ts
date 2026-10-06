import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	normalizeSubmittedEvidence,
	decodeUtf8Preview,
	resolveWorkEvidenceReference,
	stripReservedEvidenceMetadata,
	previewWorkEvidence,
} from "./work-evidence-resolution";
import type { WorkEvidence } from "@tedix/db/schema/work-items";

const mocks = vi.hoisted(() => ({
	artifact: vi.fn(),
	candidate: vi.fn(),
	head: vi.fn(),
	active: vi.fn(),
	body: vi.fn(),
}));
vi.mock("@tedix/db/queries/artifact-policy/releases", () => ({
	getArtifactRedactionCandidate: mocks.candidate,
	getArtifactReleaseReviewHead: mocks.head,
	getActiveArtifactReleaseApproval: mocks.active,
}));
vi.mock("./artifact-immutable-publication", () => ({
	readVerifiedPrivateTextArtifact: mocks.body,
}));
vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	getTediArtifact: mocks.artifact,
}));

const context = {
	organizationId: "org-1",
	db: {},
	env: { API_URL: "https://api.tedix.dev", TEDI_R2_BUCKET: {} },
} as unknown as BaseContext;

async function hash(value: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

describe("Work evidence resolution", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks))
			mock.mockReset().mockResolvedValue(null);
	});

	function releasedFixture() {
		const artifact = {
			id: "child",
			organizationId: "org-1",
			tediId: "tedi-1",
			uri: "r2://tedix-tedi-production/tedi-1/artifacts/redacted/digest/child.txt",
			mimeType: "text/plain",
			metadata: {},
			accessClassification: "runtime_private",
			contentDigest: "a".repeat(64),
			publicationState: "ready",
			accessEnvelope: null,
		};
		const candidate = {
			id: "candidate",
			organizationId: "org-1",
			tediId: "tedi-1",
			parentArtifactId: "original",
			childArtifactId: "child",
			childContentDigest: artifact.contentDigest,
		};
		mocks.artifact.mockResolvedValue(artifact);
		mocks.candidate.mockResolvedValue(candidate);
		mocks.head.mockResolvedValue({ id: "approval", eventType: "approved" });
		mocks.active.mockResolvedValue({ candidate, approval: { id: "approval" } });
		mocks.body.mockResolvedValue({
			text: "reviewed text",
			bytes: new TextEncoder().encode("reviewed text"),
		});
		return { artifact, candidate };
	}

	it("serves only the already verified released child text and rechecks the same approval", async () => {
		const { artifact } = releasedFixture();
		const result = await previewWorkEvidence(context, {
			uri: "artifact://child",
		} as WorkEvidence);
		expect(result).toMatchObject({
			status: "available",
			text: "reviewed text",
			digest: artifact.contentDigest,
			truncated: false,
			mediaType: "text/plain; charset=utf-8",
		});
		expect(mocks.body).toHaveBeenCalledExactlyOnceWith(
			context.env.TEDI_R2_BUCKET,
			artifact,
		);
		expect(mocks.active).toHaveBeenCalledTimes(2);
		for (const [, input] of mocks.active.mock.calls)
			expect(input).toEqual({
				organizationId: "org-1",
				childArtifactId: "child",
				approvalId: "approval",
				childContentDigest: artifact.contentDigest,
			});
		expect(artifact.accessClassification).toBe("runtime_private");
		expect(artifact.accessEnvelope).toBeNull();
	});

	it.each([
		"original",
		"wrong-org",
		"wrong-tedi",
		"wrong-child",
		"wrong-digest",
		"revoked",
		"inactive-owner",
	])("denies private evidence: %s", async (failure) => {
		const { candidate } = releasedFixture();
		if (failure === "original") mocks.candidate.mockResolvedValue(null);
		if (failure === "wrong-org") candidate.organizationId = "other";
		if (failure === "wrong-tedi") candidate.tediId = "other";
		if (failure === "wrong-child") candidate.childArtifactId = "other";
		if (failure === "wrong-digest")
			candidate.childContentDigest = "b".repeat(64);
		if (failure === "revoked")
			mocks.head.mockResolvedValue({ id: "revoked", eventType: "revoked" });
		if (failure === "inactive-owner") mocks.active.mockResolvedValue(null);
		expect(
			await previewWorkEvidence(context, {
				uri: "artifact://child",
			} as WorkEvidence),
		).toMatchObject({ status: "unavailable" });
		expect(mocks.body).not.toHaveBeenCalled();
	});

	it("denies revocation or owner demotion during the body read", async () => {
		releasedFixture();
		mocks.active.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
		const result = await previewWorkEvidence(context, {
			uri: "artifact://child",
		} as WorkEvidence);
		expect(result).toMatchObject({ status: "unavailable" });
		expect(result).not.toHaveProperty("text");
	});

	it("resolves artifact identity against the current approval, never cached evidence metadata", async () => {
		releasedFixture();
		const row = {
			uri: "artifact://child",
			metadata: { _tedixEvidence: { status: "available", approvalId: "old" } },
		} as unknown as WorkEvidence;
		mocks.head.mockResolvedValue({ id: "revocation", eventType: "revoked" });
		expect(await previewWorkEvidence(context, row)).toMatchObject({
			status: "unavailable",
		});
		expect(mocks.body).not.toHaveBeenCalled();
		// artifact:// names the immutable child, not a bearer approval token.
		// A later explicit reapproval may intentionally release that child again.
		mocks.head.mockResolvedValue({ id: "new-approval", eventType: "approved" });
		expect(await previewWorkEvidence(context, row)).toMatchObject({
			status: "available",
		});
		expect(mocks.active).toHaveBeenLastCalledWith(
			context.db,
			expect.objectContaining({ approvalId: "new-approval" }),
		);
	});

	it("fails closed for unsupported, corrupt or unavailable bodies and ledger outages", async () => {
		releasedFixture();
		mocks.body.mockRejectedValue(
			new Error("Unsupported, corrupt or missing body"),
		);
		expect(
			await previewWorkEvidence(context, {
				uri: "artifact://child",
			} as WorkEvidence),
		).toMatchObject({ status: "unavailable" });
		mocks.active.mockRejectedValue(new Error("D1 unavailable"));
		expect(
			await previewWorkEvidence(context, {
				uri: "artifact://child",
			} as WorkEvidence),
		).toMatchObject({ status: "unavailable" });
	});

	it("keeps external HTTPS telemetry unverified and strips caller authority claims", async () => {
		const result = await normalizeSubmittedEvidence(context, {
			uri: "https://example.com/proof",
			metadata: {
				note: "keep",
				digest: "fake",
				provenance: "fake",
				preview: "fake",
			},
		});
		expect(result).toMatchObject({
			digest: undefined,
			reference: { kind: "external_https", status: "unverified" },
		});
		expect(result.metadata).toMatchObject({ note: "keep" });
		expect(result.metadata).not.toHaveProperty("digest");
		expect(result.metadata).not.toHaveProperty("provenance");
	});

	it("rejects credential-bearing HTTPS references", async () => {
		expect(
			(
				await resolveWorkEvidenceReference(
					context,
					"https://user:secret@example.com/proof",
				)
			).reference,
		).toMatchObject({ kind: "unsupported", status: "unavailable" });
	});

	it("trims an incomplete UTF-8 boundary only for a truncated preview", () => {
		const incomplete = new Uint8Array([0x61, 0xe2, 0x82]);
		expect(decodeUtf8Preview(incomplete, true)).toBe("a");
		expect(decodeUtf8Preview(incomplete, false)).toBeNull();
		expect(decodeUtf8Preview(new TextEncoder().encode("a€"), false)).toBe("a€");
	});

	it("resolves encoded opaque ids but fails closed when raw and decoded ids are ambiguous", async () => {
		mocks.artifact.mockImplementation(async (...args: unknown[]) => {
			const input = args.at(-1) as { artifactId: string };
			if (!input) return null;
			return {
				id: input.artifactId,
				organizationId: "org-1",
				tediId: "tedi-1",
				uri: `r2://artifacts/${input.artifactId}`,
				mimeType: "text/plain",
				metadata: {},
				accessClassification: "explicit_shareable",
				accessEnvelope: '{"version":1,"sources":[]}',
				contentDigest: "a".repeat(64),
				publicationState: "ready",
			};
		});
		const result = await resolveWorkEvidenceReference(
			context,
			"artifact://a%2Fb",
		);
		expect(result.reference).toMatchObject({
			status: "ambiguous",
			reason: "ambiguous_opaque_id",
		});
	});

	it.each([
		"artifact://bad%2",
		`artifact://${"a".repeat(1025)}`,
		"artifact://bad%00id",
	])(
		"rejects malformed or oversized opaque references before lookup: %s",
		async (uri) => {
			expect(
				(await resolveWorkEvidenceReference(context, uri)).reference,
			).toMatchObject({ status: "unavailable", reason: "malformed_reference" });
			expect(mocks.artifact).not.toHaveBeenCalled();
		},
	);

	it("does not treat legacy mutable artifacts as verified", async () => {
		mocks.artifact.mockResolvedValue({
			id: "legacy",
			organizationId: "org-1",
			tediId: "tedi-1",
			uri: "https://mutable",
			mimeType: "text/plain",
			metadata: {},
			accessClassification: null,
			contentDigest: null,
		});
		expect(
			(await resolveWorkEvidenceReference(context, "artifact://legacy"))
				.reference,
		).toMatchObject({ status: "unverified_legacy", digest: null });
	});

	it("keeps ready registry-only artifacts and forged bundle claims unavailable", async () => {
		for (const metadata of [
			{},
			{
				bundle: true,
				entrypoint: "index.html",
				contentManifest: [{ path: "index.html", sha256: "b".repeat(64) }],
			},
		]) {
			mocks.artifact.mockResolvedValue({
				id: "registry",
				organizationId: "org-1",
				tediId: "tedi-1",
				uri: "https://example.com/body",
				mimeType: "text/plain",
				metadata,
				accessClassification: "explicit_shareable",
				contentDigest: null,
				publicationState: "ready",
			});
			expect(
				(await resolveWorkEvidenceReference(context, "artifact://registry"))
					.reference,
			).toMatchObject({
				status: "unavailable",
				reason: "immutable_body_unavailable",
				digest: null,
			});
		}
	});

	it("accepts only a canonical content-addressed bundle manifest", async () => {
		const files = [
			{
				path: "index.html",
				sha256: "b".repeat(64),
				sizeBytes: 7,
				contentType: "text/html; charset=utf-8",
			},
		];
		const digest = await hash(
			JSON.stringify({ version: 1, entrypoint: "index.html", files }),
		);
		const artifact = {
			id: "bundle",
			organizationId: "org-1",
			tediId: "tedi-1",
			uri: `r2://tedix-tedi-production/tedi-1/artifacts/deliverable/bundle/${digest}/`,
			mimeType: "text/html",
			metadata: {
				bundle: true,
				entrypoint: "index.html",
				contentManifest: files,
			},
			accessClassification: "explicit_shareable",
			contentDigest: digest,
			publicationState: "ready",
		};
		mocks.artifact.mockResolvedValue(artifact);
		expect(
			(await resolveWorkEvidenceReference(context, "artifact://bundle"))
				.reference,
		).toMatchObject({
			status: "available",
			bundleDigestKind: "manifest",
			digest,
		});
		mocks.artifact.mockResolvedValue({
			...artifact,
			metadata: {
				...artifact.metadata,
				contentManifest: [{ ...files[0], sizeBytes: 8 }],
			},
		});
		expect(
			(await resolveWorkEvidenceReference(context, "artifact://bundle"))
				.reference,
		).toMatchObject({
			status: "unavailable",
			reason: "immutable_body_unavailable",
		});
	});

	it("removes reserved claims case-insensitively", () => {
		expect(
			stripReservedEvidenceMetadata({
				Reference: "fake",
				organizationId: "fake",
				safe: "yes",
			}),
		).toEqual({ safe: "yes" });
	});
});
