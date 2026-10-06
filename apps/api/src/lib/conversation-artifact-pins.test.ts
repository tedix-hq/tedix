import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import {
	artifactRevisionDigest,
	conversationArtifactPinView,
	pinConversationArtifactRevision,
	readConversationArtifactPins,
} from "./conversation-artifact-pins";

const queries = vi.hoisted(() => ({
	getTediArtifact: vi.fn(),
	attachConversationArtifactPin: vi.fn(),
	listConversationArtifactPins: vi.fn(),
}));
vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	getTediArtifact: queries.getTediArtifact,
}));
vi.mock("@tedix/db/queries/conversation-artifact-pins", () => ({
	attachConversationArtifactPin: queries.attachConversationArtifactPin,
	listConversationArtifactPins: queries.listConversationArtifactPins,
}));

const artifact = {
	id: "artifact-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	conversationId: "chat-1",
	runId: null,
	messageId: null,
	kind: "file" as const,
	name: "Report",
	mimeType: "text/plain",
	uri: "r2://bucket/report",
	sizeBytes: 10,
	metadata: { contentSha256: "a".repeat(64) },
	createdAt: "2026-09-03T00:00:00.000Z",
};
const pin = {
	id: "019d0000-0000-7000-8000-000000000003",
	organizationId: "org-1",
	conversationId: "chat-1",
	artifactId: "artifact-1",
	replayName: "approved_report",
	revisionDigest: "a".repeat(64),
	artifactUri: "r2://bucket/report",
	artifactName: "Report",
	artifactKind: "file",
	mimeType: "text/plain",
	attachedByType: "user" as const,
	attachedById: "user-1",
	createdAt: "2026-09-03T00:00:00.000Z",
};

describe("conversation artifact pin revisions", () => {
	beforeEach(() => vi.resetAllMocks());
	it("accepts only platform-owned single-file SHA-256 artifacts", () => {
		expect(artifactRevisionDigest(artifact)).toBe("a".repeat(64));
		expect(
			artifactRevisionDigest({ ...artifact, uri: "https://example.com" }),
		).toBeNull();
		expect(
			artifactRevisionDigest({
				...artifact,
				metadata: { bundle: true, contentSha256: "a".repeat(64) },
			}),
		).toBeNull();
	});

	it("marks a pin stale instead of silently following changed content", () => {
		expect(conversationArtifactPinView(pin, artifact)?.state).toBe("active");
		expect(
			conversationArtifactPinView(pin, {
				...artifact,
				metadata: { contentSha256: "b".repeat(64) },
			})?.state,
		).toBe("stale");
	});

	it("does not accept caller metadata as permission to pin a private artifact", async () => {
		const privateArtifact = {
			...artifact,
			accessClassification: "runtime_private" as const,
			contentDigest: "a".repeat(64),
			publicationState: "ready" as const,
		};
		expect(artifactRevisionDigest(privateArtifact)).toBeNull();
		queries.getTediArtifact.mockResolvedValue(privateArtifact);
		const result = await pinConversationArtifactRevision({} as DbClient, {
			id: pin.id,
			organizationId: pin.organizationId,
			conversationId: pin.conversationId,
			artifactId: pin.artifactId,
			replayName: pin.replayName,
			attachedByType: pin.attachedByType,
			attachedById: pin.attachedById,
			createdAt: pin.createdAt,
		});
		expect(result).toBeNull();
		expect(queries.attachConversationArtifactPin).not.toHaveBeenCalled();
	});

	it("omits a previously stored private pin instead of exposing its retained URI", async () => {
		const privateArtifact = {
			...artifact,
			accessClassification: "runtime_private" as const,
		};
		expect(conversationArtifactPinView(pin, privateArtifact)).toBeNull();
		queries.listConversationArtifactPins.mockResolvedValue([pin]);
		queries.getTediArtifact.mockResolvedValue(privateArtifact);
		expect(
			await readConversationArtifactPins({} as DbClient, {
				organizationId: pin.organizationId,
				conversationId: pin.conversationId,
			}),
		).toEqual([]);
	});

	it("preserves the existing public and legacy pin projection", () => {
		expect(
			conversationArtifactPinView(pin, {
				...artifact,
				accessClassification: "explicit_shareable",
			}),
		).toMatchObject({ state: "active", artifact: { uri: pin.artifactUri } });
		expect(conversationArtifactPinView(pin, null)).toMatchObject({
			state: "stale",
			artifact: { uri: pin.artifactUri },
		});
	});
});
