import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
	getWorkInteraction,
	listWorkInteractionInbox,
	listWorkInteractionResponses,
} from "@tedix/db/queries/work-items/interactions";
import { listCardRevisions } from "@tedix/db/queries/work-items/card-revisions";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import type { BaseContext } from "../rpc/orpc";
import { handleInternalDecision } from "./internal-decision-handling";
import { executeInternalDecisionTask } from "./internal-decision-task";
import { reviseCardContent } from "./card-revisions";
import { internalDecisionFeed } from "./internal-decision-feed";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";

vi.mock("./internal-decision-task", () => ({
	executeInternalDecisionTask: vi.fn(),
}));
vi.mock("../rpc/routers/work-items-principal", async (original) => ({
	...(await original<typeof import("../rpc/routers/work-items-principal")>()),
	verifiedActiveWorkActor: vi.fn(),
}));
const org = "11111111-1111-4111-8111-111111111111";
const work = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
const task = "55555555-5555-4555-8555-555555555555";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	const migrations = new URL(
		"../../../../packages/db/drizzle/",
		import.meta.url,
	);
	for (const name of readdirSync(migrations).sort())
		sqlite.exec(
			readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"),
		);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${org}','Fictional','fictional');
INSERT INTO users(id,email) VALUES('person','person@example.test');
INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('member','${org}','person-sub','person','person@example.test','active','owner');
INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${agent}','${org}','Draft author','draft-author','active');
INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('${work}','${org}','Draft','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z'),('${task}','${org}','Follow-up','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z');
`);
	const decision = DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "proposal",
		classId: "crm.followup",
		proposal: "Create a follow-up task?",
		whyNow: "Prepare the next step",
		recommendation: "Create internal Work",
		reversibility: "two_way",
		protectedEffects: [],
		blastRadius: "Internal",
		confidence: 0.9,
		costOfWaiting: "Delay",
		reasoning: "Drafting is reversible",
		options: [
			{
				id: "create",
				label: "Create",
				intent: "approve",
				consequence: "Create internal Work",
				cost: "None",
				effect: {
					kind: "create_owner_task",
					workItemId: work,
					title: "Follow-up",
					description: "Prepare a draft",
				},
			},
			{
				id: "later",
				label: "Later",
				intent: "later",
				consequence: "Wait",
				cost: "Delay",
			},
		],
	});
	sqlite
		.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,?,?,'question','Create a follow-up task?','Original story','tedi',?,'user','person','2026-10-19T00:00:00.000Z',?)",
		)
		.run(card, org, work, agent, JSON.stringify({ decisionDeck: decision }));
	sqlite
		.prepare(
			"UPDATE work_items SET source_intent_id=?, parent_work_item_id=?, description='Prepare a draft', accountable_owner_type='user', accountable_owner_id='person', metadata=? WHERE id=?",
		)
		.run(
			`decision-owner-task:${card}`,
			work,
			JSON.stringify({
				source: "decision-owner-task",
				requestId: card,
				sendingReservedForOwner: true,
			}),
			task,
		);
	const db = createDbClient(createD1Facade(sqlite));
	return {
		sqlite,
		db,
		context: {
			db,
			organizationId: org,
			authType: "service-binding",
			tediId: agent,
			env: {},
			headers: new Headers(),
			url: new URL("https://api.example.test/rpc"),
		} as BaseContext,
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(verifiedActiveWorkActor).mockResolvedValue({
		type: "tedi",
		id: agent,
	});
	vi.mocked(executeInternalDecisionTask).mockResolvedValue({
		taskId: task,
		state: "proposed",
		classId: "internal.work.create",
		policyPack: { id: "policy-fictional", version: 1 },
	});
});
it("supersedes the ask immutably, preserves zero human answers, and makes the receipt queryable for Feed and undo", async () => {
	const { sqlite, context, db } = fixture();
	try {
		const request = (await getWorkInteraction(db, {
			orgId: org,
			interactionId: card,
		}))!;
		await handleInternalDecision(context, request, 0);
		const after = (await getWorkInteraction(db, {
			orgId: org,
			interactionId: card,
		}))!;
		expect(after.status).toBe("cancelled");
		expect(after.metadata.curation).toMatchObject({
			internalTask: {
				taskId: task,
				actorType: "tedi",
				actorId: agent,
				policyPack: { id: "policy-fictional", version: 1 },
			},
		});
		expect(
			await listWorkInteractionResponses(db, {
				orgId: org,
				interactionId: card,
			}),
		).toEqual([]);
		const revisions = await listCardRevisions(db, org, card);
		expect(revisions.map((r) => [r.revision, r.cause])).toEqual([
			[1, "initial"],
			[2, "agent_rewrite"],
		]);
		expect(revisions[0]?.body).toBe("Original story");
		const open = await listWorkInteractionInbox(db, {
			orgId: org,
			targetType: "user",
			targetId: "person",
			states: ["open"],
			observedAt: new Date().toISOString(),
		});
		expect(open.data).toHaveLength(0);
		const handled = await listWorkInteractionInbox(db, {
			orgId: org,
			targetType: "user",
			targetId: "person",
			states: ["cancelled"],
			observedAt: new Date().toISOString(),
		});
		expect(handled.data).toHaveLength(1);
		expect(await internalDecisionFeed(context, org)).toEqual([]);
		vi.mocked(verifiedActiveWorkActor).mockResolvedValue({
			type: "user",
			id: "other-person",
		});
		expect(await internalDecisionFeed(context, org)).toEqual([]);
		vi.mocked(verifiedActiveWorkActor).mockResolvedValue({
			type: "user",
			id: "person",
		});
		const feed = await internalDecisionFeed(context, org);
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({
			sentence: "Handled for you: created an internal follow-up task.",
			actorIdentity: { type: "tedi", id: agent },
			workItemId: task,
			internalDecisionUndo: {
				requestId: card,
				expectedRequestVersion: after.version,
				expectedRevision: 2,
				restoreRevision: 1,
			},
		});
		expect((await getWorkItemById(db, task, org))?.disposition).toBe(
			"proposed",
		);
		await reviseCardContent(
			{
				...context,
				authType: "user",
				tediId: undefined,
				user: { sub: "person-sub" },
				userId: "person",
				userRole: "owner",
			},
			{
				requestId: card,
				expectedRequestVersion: after.version,
				expectedRevision: 2,
				restoreRevision: 1,
			},
		);
		expect(
			(await getWorkInteraction(db, { orgId: org, interactionId: card }))
				?.status,
		).toBe("open");
		expect((await getWorkItemById(db, task, org))?.disposition).toBe(
			"cancelled",
		);
		expect(await internalDecisionFeed(context, org)).toEqual([]);
		expect((await listCardRevisions(db, org, card)).at(-1)?.cause).toBe(
			"restore",
		);
		expect(
			await listWorkInteractionResponses(db, {
				orgId: org,
				interactionId: card,
			}),
		).toEqual([]);
	} finally {
		sqlite.close();
	}
});
it("rejects stale request/revision and human execution before invoking the adapter", async () => {
	const { sqlite, context, db } = fixture();
	try {
		const request = (await getWorkInteraction(db, {
			orgId: org,
			interactionId: card,
		}))!;
		await expect(
			handleInternalDecision(
				context,
				{ ...request, version: request.version + 1 },
				0,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			handleInternalDecision(context, request, 9),
		).rejects.toMatchObject({ code: "CONFLICT" });
		vi.mocked(verifiedActiveWorkActor).mockResolvedValue({
			type: "user",
			id: "person",
		});
		await expect(
			handleInternalDecision(context, request, 0),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(executeInternalDecisionTask).not.toHaveBeenCalled();
	} finally {
		sqlite.close();
	}
});
