import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	clearConversationSessionPolicies,
	conversationSessionPolicyId,
	grantConversationSessionPolicy,
	listConversationSessionPolicies,
} from "./conversation-session-policies";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE kernel_conversation_session_policies (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			scope_key TEXT NOT NULL,
			effect TEXT NOT NULL,
			granted_by_type TEXT NOT NULL,
			granted_by_id TEXT NOT NULL,
			reason TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT
		);
		CREATE UNIQUE INDEX uniq_kernel_conversation_session_policy_scope
			ON kernel_conversation_session_policies (organization_id, conversation_id, scope_key);
	`);
	return createDbClient(createD1Facade(sqlite));
}

const scope = { organizationId: "org-1", conversationId: "chat-1" };

describe("conversation session policies", () => {
	it("grants once per scope and refreshes a repeat grant", async () => {
		const db = fixture();
		const first = await grantConversationSessionPolicy(db, {
			...scope,
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-1",
			reason: "target not active",
			now: "2026-11-04T10:00:00.000Z",
		});
		expect(first.id).toBe(
			conversationSessionPolicyId({ ...scope, scopeKey: "delegate:tedi-a" }),
		);
		const second = await grantConversationSessionPolicy(db, {
			...scope,
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-2",
			now: "2026-11-04T11:00:00.000Z",
		});
		expect(second.grantedById).toBe("user-2");
		const rows = await listConversationSessionPolicies(db, scope);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			scopeKey: "delegate:tedi-a",
			effect: "allow",
			grantedById: "user-2",
			createdAt: "2026-11-04T11:00:00.000Z",
		});
	});

	it("lists only the exact conversation and drops expired rows", async () => {
		const db = fixture();
		await grantConversationSessionPolicy(db, {
			...scope,
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-1",
			now: "2026-11-04T10:00:00.000Z",
		});
		await grantConversationSessionPolicy(db, {
			...scope,
			scopeKey: "delegate:tedi-b",
			grantedByType: "user",
			grantedById: "user-1",
			now: "2026-11-04T10:01:00.000Z",
			expiresAt: "2026-11-04T10:30:00.000Z",
		});
		await grantConversationSessionPolicy(db, {
			organizationId: "org-1",
			conversationId: "chat-2",
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-1",
		});
		await grantConversationSessionPolicy(db, {
			organizationId: "org-2",
			conversationId: "chat-1",
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-1",
		});
		const live = await listConversationSessionPolicies(db, scope, {
			now: "2026-11-04T11:00:00.000Z",
		});
		expect(live.map((row) => row.scopeKey)).toEqual(["delegate:tedi-a"]);
		const earlier = await listConversationSessionPolicies(db, scope, {
			now: "2026-11-04T10:10:00.000Z",
		});
		expect(earlier.map((row) => row.scopeKey)).toEqual([
			"delegate:tedi-a",
			"delegate:tedi-b",
		]);
	});

	it("clears one conversation without touching another", async () => {
		const db = fixture();
		await grantConversationSessionPolicy(db, {
			...scope,
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-1",
		});
		await grantConversationSessionPolicy(db, {
			organizationId: "org-1",
			conversationId: "chat-2",
			scopeKey: "delegate:tedi-a",
			grantedByType: "user",
			grantedById: "user-1",
		});
		await clearConversationSessionPolicies(db, scope);
		expect(await listConversationSessionPolicies(db, scope)).toEqual([]);
		expect(
			await listConversationSessionPolicies(db, {
				organizationId: "org-1",
				conversationId: "chat-2",
			}),
		).toHaveLength(1);
	});
});
