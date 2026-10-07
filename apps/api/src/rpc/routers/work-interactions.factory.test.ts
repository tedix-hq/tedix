import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workInteractionReplyDrafts,
	workInteractionResponses,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000002";

function fixture(publish?: (request: Request) => Promise<Response>) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workInteractions,
			workInteractionResponses,
			workInteractionReplyDrafts,
			organizationMembers,
			tedis,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
		)
		.run(
			WORK_ITEM_ID,
			ORG_ID,
			"Targeted interaction",
			"2026-08-21T00:00:00.000Z",
		);
	const insertMember = sqlite.prepare(`INSERT INTO organization_members
		(id,organization_id,user_id,descope_user_id,email,role,status)
		VALUES (?,?,?,?,?,?,'active')`);
	insertMember.run(
		"membership-owner",
		ORG_ID,
		"owner-id",
		"owner-sub",
		"owner@tedix.test",
		"owner",
	);
	insertMember.run(
		"membership-target",
		ORG_ID,
		"target-id",
		"target-sub",
		"target@tedix.test",
		"admin",
	);
	insertMember.run(
		"membership-other",
		ORG_ID,
		"other-id",
		"other-sub",
		"other@tedix.test",
		"member",
	);
	const facade = createD1Facade(sqlite);
	const clientFor = (identity: {
		userId: string;
		sub: string;
		role: "owner" | "admin" | "member";
	}) =>
		createRouterClient(workInteractionsContractRouter, {
			context: {
				authType: "user",
				db: createDbClient(facade),
				env: {
					ENVIRONMENT: "test",
					DB: facade,
					...(publish ? { MCP_SERVICE: { fetch: publish } } : {}),
				} as CloudflareEnv,
				headers: new Headers(),
				organizationId: ORG_ID,
				url: new URL("https://api.tedix.test/rpc/work-interactions"),
				userId: identity.userId,
				userRole: identity.role,
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: [],
					roles: [],
					sub: identity.sub,
				},
			} as BaseContext,
		});
	return {
		sqlite,
		owner: clientFor({ userId: "owner-id", sub: "owner-sub", role: "owner" }),
		target: clientFor({
			userId: "target-id",
			sub: "target-sub",
			role: "admin",
		}),
		other: clientFor({ userId: "other-id", sub: "other-sub", role: "member" }),
	};
}

async function createTargetedInteraction(
	owner: ReturnType<typeof fixture>["owner"],
) {
	return owner.create({
		workItemId: WORK_ITEM_ID,
		kind: "question",
		subject: "Need an exact answer",
		prompt: "Review the admission evidence.",
		requestedFrom: { type: "user", id: "target-id" },
	});
}

describe("Work interactions router", () => {
	it("mounts the complete structured interaction lifecycle", () => {
		expect(Object.keys(workInteractionsContractRouter)).toEqual([
			"create",
			"respond",
			"delegate",
			"cancel",
			"get",
			"listInbox",
			"listCliInboxProjection",
			"listOutbox",
			"listAudit",
		]);
	});
});

it("projects targeted open inbox prompts and strips metadata/drafts with truthful continuation", async () => {
	const { owner, target, other, sqlite } = fixture();
	for (let i = 0; i < 6; i++)
		await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "question",
			subject: "Bounded",
			prompt: "p".repeat(i === 0 ? 800 : 801),
			metadata: { policy: "x".repeat(20000) },
			requestedFrom: { type: "user", id: "target-id" },
		});
	const page = await target.listCliInboxProjection({
		workItemId: WORK_ITEM_ID,
	});
	expect(page.data).toHaveLength(5);
	expect(page.hasMore).toBe(true);
	expect(page.nextCursor).not.toBeNull();
	for (const row of page.data) {
		expect(row.request.prompt.length).toBeLessThanOrEqual(800);
		expect(row.request).not.toHaveProperty("metadata");
		expect(row).not.toHaveProperty("latestDraft");
		expect(row.canRespond).toBe(true);
	}
	const last = await target.listCliInboxProjection({
		workItemId: WORK_ITEM_ID,
		cursor: page.nextCursor!,
	});
	expect(last.data).toHaveLength(1);
	expect(last.hasMore).toBe(false);
	expect(last.nextCursor).toBeNull();
	expect(
		[...page.data, ...last.data].filter((row) => row.request.promptComplete),
	).toHaveLength(1);
	expect(
		(await other.listCliInboxProjection({ workItemId: WORK_ITEM_ID })).data,
	).toEqual([]);
	const request = await createTargetedInteraction(owner);
	sqlite
		.prepare(
			"INSERT INTO work_interaction_reply_drafts(id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,turn_type,delivery,created_at) VALUES (?,?,?,'tedi','drafter','Reply','Reason','approval',?,?)",
		)
		.run(
			"00000000-0000-4000-8000-000000000099",
			ORG_ID,
			request.id,
			"auto",
			"2026-10-07T00:00:00.000Z",
		);
	expect(
		(await target.get({ requestId: request.id })).latestDraft,
	).toMatchObject({
		body: "Reply",
		delivery: "auto",
		drafterName: null,
		gate: null,
	});
	sqlite
		.prepare("UPDATE work_interaction_reply_drafts SET delivery='review'")
		.run();
	expect(
		(await target.get({ requestId: request.id })).latestDraft?.delivery,
	).toBe("review");
});

it("requires messaging scope and a verified active actor for compact inbox", async () => {
	const { sqlite } = fixture();
	const facade = createD1Facade(sqlite);
	function keyClient(scopes: string[]) {
		return createRouterClient(workInteractionsContractRouter, {
			context: {
				authType: "apikey",
				apiKey: {
					id: "fictional-key",
					name: "projection",
					organizationId: ORG_ID,
					scopes,
				},
				db: createDbClient(facade),
				env: { DB: facade },
				organizationId: ORG_ID,
				headers: new Headers(),
				url: new URL("https://api.test/rpc"),
			} as BaseContext,
		});
	}
	await expect(
		keyClient(["mcp:work.read"]).listCliInboxProjection({}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		keyClient(["mcp:messaging.read"]).listCliInboxProjection({}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
