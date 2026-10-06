import { describe, expect, it } from "vite-plus/test";
import {
	ConversationCapabilityReplayNameSchema,
	ConversationCapabilitySchema,
	ConversationArtifactPinSchema,
} from "../schemas/kernel-runtime";

describe("named conversation capability contract", () => {
	it("accepts stable replay names and exposes context-only authority", () => {
		expect(ConversationCapabilityReplayNameSchema.parse("deploy_release")).toBe(
			"deploy_release",
		);
		const value = ConversationCapabilitySchema.parse({
			id: "019d0000-0000-7000-8000-000000000001",
			conversationId: "chat-1",
			capabilityId: "019d0000-0000-7000-8000-000000000002",
			replayName: "deploy_release",
			name: "Deploy & Release",
			slug: "deploy-release",
			whyPresent: {
				type: "user",
				actorId: "user-1",
				attachedAt: "2026-09-03T00:00:00.000Z",
			},
			authority: "context_only",
		});
		expect(value.authority).toBe("context_only");
	});

	it.each(["Deploy Release", "deploy-release", "1deploy", "deploy/release"])(
		"rejects non-replay-safe name %s",
		(name) => {
			expect(
				ConversationCapabilityReplayNameSchema.safeParse(name).success,
			).toBe(false);
		},
	);

	it("requires an exact SHA-256 revision and context-only authority for artifact pins", () => {
		const pin = ConversationArtifactPinSchema.parse({
			id: "019d0000-0000-7000-8000-000000000003",
			conversationId: "chat-1",
			artifactId: "artifact-1",
			replayName: "approved_report",
			revision: { algorithm: "sha256", digest: "a".repeat(64) },
			artifact: {
				name: "Report",
				kind: "file",
				mimeType: "text/plain",
				uri: "r2://bucket/report",
			},
			state: "active",
			whyPresent: {
				type: "user",
				actorId: "user-1",
				attachedAt: "2026-09-03T00:00:00.000Z",
			},
			authority: "context_only",
		});
		expect(pin.revision.digest).toHaveLength(64);
		expect(pin.authority).toBe("context_only");
	});
});
