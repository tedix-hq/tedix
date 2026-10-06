import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	attachConversationArtifactPin,
	detachConversationArtifactPin,
	listConversationArtifactPins,
} from "./conversation-artifact-pins";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE kernel_conversation_artifact_pins (
		id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL,
		conversation_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
		replay_name TEXT NOT NULL, revision_digest TEXT NOT NULL,
		artifact_uri TEXT NOT NULL, artifact_name TEXT NOT NULL,
		artifact_kind TEXT NOT NULL, mime_type TEXT,
		attached_by_type TEXT NOT NULL, attached_by_id TEXT NOT NULL,
		created_at TEXT NOT NULL);
		CREATE UNIQUE INDEX uniq_kernel_conversation_artifact_pin_name ON kernel_conversation_artifact_pins (organization_id, conversation_id, replay_name);
		CREATE UNIQUE INDEX uniq_kernel_conversation_artifact_pin_revision ON kernel_conversation_artifact_pins (organization_id, conversation_id, artifact_id, revision_digest);`);
	return createDbClient(createD1Facade(sqlite));
}

const row = {
	id: "pin-1",
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

describe("conversation artifact pins", () => {
	it("scopes list and detach by tenant plus conversation", async () => {
		const db = fixture();
		await attachConversationArtifactPin(db, row);
		expect(
			await listConversationArtifactPins(db, {
				organizationId: "org-2",
				conversationId: "chat-1",
			}),
		).toEqual([]);
		expect(
			await detachConversationArtifactPin(db, {
				organizationId: "org-1",
				conversationId: "chat-2",
				pinId: row.id,
			}),
		).toBeNull();
		expect(
			(
				await detachConversationArtifactPin(db, {
					organizationId: "org-1",
					conversationId: "chat-1",
					pinId: row.id,
				})
			)?.revisionDigest,
		).toBe(row.revisionDigest);
	});
});
