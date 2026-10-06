import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { signOwnedChannelAuthorizationProof } from "@tedix/db/queries/mcp-governance";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({ item: vi.fn(), member: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/crud", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/crud")>()),
	getWorkItemById: mocks.item,
}));
vi.mock("@tedix/db/queries/organization-members", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMemberByCanonicalUserId: mocks.member,
	getMemberByUserId: mocks.member,
}));
import {
	authorizeOwnedChannelProcedure,
	revokeOwnedChannelProcedure,
} from "./owned-channel";

const id = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
let sqlite: DatabaseSync;
let context: BaseContext;
let input: {
	id: string;
	campaignKey: string;
	contentIds: string[];
	validUntil: string;
};
function authorize() {
	return authorizeOwnedChannelProcedure["~orpc"].handler!({
		input,
		context,
		path: [],
		procedure: authorizeOwnedChannelProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}
function revoke() {
	return revokeOwnedChannelProcedure["~orpc"].handler!({
		input: { id, campaignKey: input.campaignKey, reason: "Stop campaign" },
		context,
		path: [],
		procedure: revokeOwnedChannelProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`CREATE TABLE work_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL);`,
	);
	context = {
		db: createDbClient(createD1Facade(sqlite)),
		authType: "user",
		user: { sub: "verified-user" },
		organizationId: orgId,
		env: { SECRETS_MASTER_KEY: "test-signing-secret" },
	} as BaseContext;
	mocks.item.mockResolvedValue({
		id,
		orgId,
		disposition: "accepted",
		metadata: { marketingCampaign: { key: "campaign" } },
	});
	mocks.member.mockResolvedValue({
		userId: "canonical-user",
		status: "active",
		role: "owner",
	});
	input = {
		id,
		campaignKey: "campaign",
		contentIds: ["draft-1", "draft-1"],
		validUntil: new Date(Date.now() + 60_000).toISOString(),
	};
});
describe("owned-channel authorization", () => {
	it.each(["owner", "admin"])(
		"persists a signed %s receipt in the publish resolver event ledger",
		async (role) => {
			mocks.member.mockResolvedValue({
				userId: "canonical-user",
				status: "active",
				role,
			});
			const event = await authorize();
			expect(event.actorId).toBe("canonical-user");
			expect(event.actorType).toBe("user");
			expect(event.eventType).toBe("owned_channel_authorization");
			const body = event.payload.body as string;
			expect(JSON.parse(body)).toMatchObject({
				contentIds: ["draft-1"],
				channel: "tedix.dev/blog",
				contentRisk: "low",
				allowedAction: "content_publish",
			});
			const signature = await signOwnedChannelAuthorizationProof(
				"test-signing-secret",
				{
					commentId: event.id,
					workItemId: id,
					organizationId: orgId,
					authorId: event.actorId,
					eventType: "owned_channel_authorization",
					body,
					createdAt: event.occurredAt,
				},
			);
			expect(event.payload.ownedChannelAuthorizationProof).toEqual({
				version: 1,
				signature,
			});
			expect(
				sqlite.prepare("SELECT count(*) AS count FROM work_events").get(),
			).toEqual({ count: 1 });
		},
	);
	it.each(["tedi", "apikey", "m2m", "service-binding"])(
		"rejects %s principals even with platform scope",
		async (authType) => {
			context = {
				...context,
				authType,
				apiKey: { scopes: ["platform:admin", "mcp:messaging.write"] },
			} as BaseContext;
			await expect(authorize()).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(revoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it.each([
		{ role: "member", status: "active" },
		{ role: "owner", status: "inactive" },
	])("rejects insufficient membership %j", async (membership) => {
		mocks.member.mockResolvedValue({ userId: "canonical-user", ...membership });
		await expect(authorize()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects a work item from another tenant", async () => {
		mocks.item.mockResolvedValue({
			id,
			orgId: "other",
			metadata: { marketingCampaign: { key: "campaign" } },
		});
		await expect(authorize()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects missing and mismatched campaign scope", async () => {
		input.campaignKey = "other";
		await expect(authorize()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(revoke()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		mocks.item.mockResolvedValue({ id, orgId, metadata: {} });
		await expect(authorize()).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it.each([-1000, 31 * 86400000])(
		"rejects an expiry offset of %i",
		async (offset) => {
			input.validUntil = new Date(Date.now() + offset).toISOString();
			await expect(authorize()).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(
				sqlite.prepare("SELECT count(*) AS count FROM work_events").get(),
			).toEqual({ count: 0 });
		},
	);
	it("writes signed revocation to the same event ledger", async () => {
		const event = await revoke();
		expect(event.eventType).toBe("owned_channel_authorization_revoked");
		const body = event.payload.body as string;
		const signature = await signOwnedChannelAuthorizationProof(
			"test-signing-secret",
			{
				commentId: event.id,
				workItemId: id,
				organizationId: orgId,
				authorId: event.actorId,
				eventType: "owned_channel_authorization_revoked",
				body,
				createdAt: event.occurredAt,
			},
		);
		expect(event.payload.ownedChannelAuthorizationProof).toEqual({
			version: 1,
			signature,
		});
		expect(JSON.parse(body)).toMatchObject({
			campaignKey: "campaign",
			reason: "Stop campaign",
		});
	});
});
