import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	attachConversationCapability,
	ConversationCapabilityConflictError,
	detachConversationCapability,
	listConversationCapabilities,
} from "./conversation-capabilities";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE kernel_conversation_capabilities (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			capability_id TEXT NOT NULL,
			replay_name TEXT NOT NULL,
			attached_by_type TEXT NOT NULL,
			attached_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_kernel_conversation_capability_name
			ON kernel_conversation_capabilities (organization_id, conversation_id, replay_name);
		CREATE UNIQUE INDEX uniq_kernel_conversation_capability_target
			ON kernel_conversation_capabilities (organization_id, conversation_id, capability_id);
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("conversation capability references", () => {
	it("lists only the exact tenant and conversation in replay-name order", async () => {
		const db = fixture();
		for (const row of [
			["own-b", "org-1", "chat-1", "cap-b", "beta"],
			["own-a", "org-1", "chat-1", "cap-a", "alpha"],
			["other-chat", "org-1", "chat-2", "cap-c", "gamma"],
			["foreign", "org-2", "chat-1", "cap-d", "delta"],
		] as const) {
			await attachConversationCapability(db, {
				id: row[0],
				organizationId: row[1],
				conversationId: row[2],
				capabilityId: row[3],
				replayName: row[4],
				attachedByType: "user",
				attachedById: "user-1",
				createdAt: "2026-09-03T00:00:00.000Z",
			});
		}

		const rows = await listConversationCapabilities(db, {
			organizationId: "org-1",
			conversationId: "chat-1",
		});
		expect(rows.map((row) => row.id)).toEqual(["own-a", "own-b"]);
	});

	it("cannot detach a reference through another tenant or conversation", async () => {
		const db = fixture();
		await attachConversationCapability(db, {
			id: "ref-1",
			organizationId: "org-1",
			conversationId: "chat-1",
			capabilityId: "cap-1",
			replayName: "deploy_release",
			attachedByType: "tedi",
			attachedById: "tedi-1",
			createdAt: "2026-09-03T00:00:00.000Z",
		});
		expect(
			await detachConversationCapability(db, {
				organizationId: "org-2",
				conversationId: "chat-1",
				referenceId: "ref-1",
			}),
		).toBeNull();
		expect(
			await detachConversationCapability(db, {
				organizationId: "org-1",
				conversationId: "chat-2",
				referenceId: "ref-1",
			}),
		).toBeNull();
		const detached = await detachConversationCapability(db, {
			organizationId: "org-1",
			conversationId: "chat-1",
			referenceId: "ref-1",
		});
		expect(detached?.id).toBe("ref-1");
	});

	it("is idempotent for the same name and target but rejects ambiguous replay names", async () => {
		const db = fixture();
		const input = {
			id: "ref-1",
			organizationId: "org-1",
			conversationId: "chat-1",
			capabilityId: "cap-1",
			replayName: "deploy_release",
			attachedByType: "user" as const,
			attachedById: "user-1",
			createdAt: "2026-09-03T00:00:00.000Z",
		};
		expect((await attachConversationCapability(db, input)).id).toBe("ref-1");
		expect(
			(await attachConversationCapability(db, { ...input, id: "retry" })).id,
		).toBe("ref-1");
		await expect(
			attachConversationCapability(db, {
				...input,
				id: "conflict",
				capabilityId: "cap-2",
			}),
		).rejects.toBeInstanceOf(ConversationCapabilityConflictError);
	});
});
