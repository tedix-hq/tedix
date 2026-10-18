import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	type OutboundState,
	OutboundStateSchema,
} from "@tedix/api-contract/schemas/outbound";
import {
	getOutboundPolicy,
	putOutboundPolicy,
	listOutbound,
	saveOutbound,
	outboundApprovalHistory,
	outboundInteractionOverlays,
} from "./outbound";

const WORK = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "22222222-2222-4222-8222-222222222222";
const QUESTION = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-17T10:00:00.000Z";
const state: OutboundState = {
	schema: "tedix.outbound.v1",
	draft: {
		channel: "email",
		topic: "partners",
		recipient: "lina@example.test",
		subject: "Our conversation",
		body: "Hi Lina,\nThanks for the conversation.\nRosa",
		reasoning: "Follow up on the fictional meeting.",
		sources: [
			{ uri: "work://fictional-meeting", fact: "Lina asked for a summary." },
		],
		risks: [],
	},
	draftRevision: 1,
	author: { type: "user", id: "rosa" },
	ownerUserId: "rosa",
	reviewerTediId: REVIEWER,
	interactionId: QUESTION,
	status: "reviewing",
	review: null,
};

function fixture(kind: "question" | "input" = "question") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	const root = new URL("../../../drizzle/", import.meta.url);
	for (const name of readdirSync(root).sort())
		sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), "utf8"));
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Harbor','harbor'),('foreign','Other','other');
		INSERT INTO users(id,email) VALUES('rosa','rosa@example.test');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('membership','org','rosa','rosa','rosa@example.test','active','owner');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${REVIEWER}','org','Partnership reviewer','partnership-reviewer','active');
		INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at,metadata) VALUES('${WORK}','org','Reply to Lina','hygiene','2027-01-01T00:00:00.000Z','fictional-revision','${NOW}','{"keep":"original"}');
		INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('${QUESTION}','org','${WORK}','${kind}','Review reply','Draft','user','rosa','user','rosa','${NOW}');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

describe("outbound work on migrated D1", () => {
	it("creates one card atomically and exposes its overlay without rewriting the request", async () => {
		const { sqlite, db } = fixture();
		const interactionId = "44444444-4444-4444-8444-444444444444";
		const params = {
			orgId: "org",
			workItemId: WORK,
			expectedVersion: 1,
			state: { ...state, interactionId },
			actor: { type: "user" as const, id: "rosa" },
			action: "submitted",
			now: NOW,
			createInteraction: true,
		};
		expect(await saveOutbound(db, params)).toBe(true);
		expect(
			await saveOutbound(db, {
				...params,
				state: {
					...params.state,
					interactionId: "55555555-5555-4555-8555-555555555555",
				},
			}),
		).toBe(false);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_interactions").get()?.n,
		).toBe(2);
		expect(
			await outboundInteractionOverlays(db, "org", [interactionId]),
		).toEqual([
			{
				interactionId,
				workItemId: WORK,
				subject: "Review email: Our conversation",
				status: "reviewing",
				record: {
					workItemId: WORK,
					projectId: null,
					title: "Reply to Lina",
					version: 2,
					outbound: params.state,
				},
			},
		]);
		expect(
			await outboundInteractionOverlays(db, "foreign", [interactionId]),
		).toEqual([]);
		expect(
			sqlite
				.prepare("SELECT prompt FROM work_interactions WHERE id=?")
				.get(QUESTION)?.prompt,
		).toBe("Draft");
	});
	it("keeps policy tenant scoped and preserves other Work metadata", async () => {
		const { sqlite, db } = fixture();
		await putOutboundPolicy(db, "org", {
			routes: [{ channel: "email", reviewerTediId: REVIEWER }],
		});
		expect((await getOutboundPolicy(db, "foreign")).routes).toEqual([]);
		expect((await getOutboundPolicy(db, "org")).routes[0].reviewerTediId).toBe(
			REVIEWER,
		);
		expect(
			await saveOutbound(db, {
				orgId: "org",
				workItemId: WORK,
				expectedVersion: 1,
				state,
				actor: { type: "user", id: "rosa" },
				action: "submitted",
				now: NOW,
			}),
		).toBe(true);
		expect(await listOutbound(db, "foreign", undefined, 10)).toEqual([]);
		expect(
			(await listOutbound(db, "org", undefined, 10))[0].outbound.draft.body,
		).toBe(state.draft.body);
		expect(
			JSON.parse(
				String(
					sqlite.prepare("SELECT metadata FROM work_items WHERE id=?").get(WORK)
						?.metadata,
				),
			).keep,
		).toBe("original");
	});
	it("a stale CAS changes neither the Interaction nor the approval ledger", async () => {
		const { sqlite, db } = fixture();
		const params = {
			orgId: "org",
			workItemId: WORK,
			expectedVersion: 1,
			state,
			actor: { type: "user" as const, id: "rosa" },
			action: "submitted",
			now: NOW,
		};
		expect(await saveOutbound(db, params)).toBe(true);
		const before = sqlite
			.prepare("SELECT * FROM work_interactions WHERE id=?")
			.get(QUESTION);
		expect(
			await saveOutbound(db, {
				...params,
				state: { ...state, status: "approved_manual" },
				action: "approve_manual",
				response: {
					body: state.draft.body,
					before: state.draft.body,
					resolves: true,
				},
			}),
		).toBe(false);
		expect(
			sqlite
				.prepare("SELECT * FROM work_interactions WHERE id=?")
				.get(QUESTION),
		).toEqual(before);
		expect(await outboundApprovalHistory(db, "org", "rosa")).toEqual([]);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_events").get()?.n,
		).toBe(1);
	});
	it.each(["question", "input"] as const)(
		"stores positive approval and exact before/after while resolving an existing %s card",
		async (kind) => {
			const { sqlite, db } = fixture(kind);
			const approved = { ...state, status: "approved_manual" as const };
			expect(
				await saveOutbound(db, {
					orgId: "org",
					workItemId: WORK,
					expectedVersion: 1,
					state: approved,
					actor: { type: "user", id: "rosa" },
					action: "approve_manual",
					now: NOW,
					response: {
						body: state.draft.body,
						before: "Dear Lina, regarding our aforementioned discussion…",
						resolves: true,
					},
				}),
			).toBe(true);
			const history = await outboundApprovalHistory(db, "org", "rosa");
			expect(history).toHaveLength(1);
			expect(history[0].metadata).toMatchObject({
				action: "approve_manual",
				before: "Dear Lina, regarding our aforementioned discussion…",
				after: state.draft.body,
			});
			expect(
				sqlite
					.prepare("SELECT status FROM work_interactions WHERE id=?")
					.get(QUESTION)?.status,
			).toBe("resolved");
			expect(await outboundApprovalHistory(db, "foreign", "rosa")).toEqual([]);
			expect(await outboundApprovalHistory(db, "org", "someone-else")).toEqual(
				[],
			);
			expect(OutboundStateSchema.parse(approved).status).toBe(
				"approved_manual",
			);
		},
	);
});
