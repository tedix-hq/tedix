import { expect, it } from "vite-plus/test";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { cancelWorkItem, completeWorkItem } from "./crud";
import {
	cancelWorkInteraction,
	listWorkInteractionInbox,
	respondToWorkInteraction,
} from "./interactions";
import { retireDecisionReviews } from "./decision-review-retirement";

const now = "2026-10-27T08:00:00.000Z";
const envelope = DecisionEnvelopeSchema.parse({
	version: 1,
	kind: "question",
	classId: "decision-facts-changed",
	proposal: "Review updated facts for: Delete the database?",
	whyNow: "Facts changed",
	recommendation: "Request an updated proposal",
	reversibility: "two_way",
	protectedEffects: [],
	blastRadius: "Review only",
	confidence: null,
	costOfWaiting: "Earlier action stays blocked",
	reasoning: "The facts changed",
	options: [
		{
			id: "review",
			label: "Reviewed",
			intent: "approve",
			consequence: "Record review",
			cost: "No action approved",
		},
		{
			id: "dismiss",
			label: "Not needed",
			intent: "reject",
			consequence: "Close this review",
			cost: "No action approved",
		},
	],
});

// Build the migration template before timing lifecycle operations.
createMigratedSqlite({ foreignKeys: false }).close();

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('foreign','Foreign','foreign');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES ('project','org','P','Project','${now}'),('foreign-project','foreign','F','Foreign','${now}');
		INSERT INTO work_items(id,org_id,project_id,title,created_at,disposition,admission_spec_revision) VALUES ('work','org','project','Work','${now}','accepted','revision-1');
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status) VALUES ('member','org','person','person','person@example.test','active'),('foreign-member','foreign','person','person','person@example.test','active');`);
	const insert =
		sqlite.prepare(`INSERT INTO work_interactions(id,org_id,work_item_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
		VALUES (?, ?, ?, ?, 'question', 'Review changed decision facts', 'Review only', 'system', 'tedix', 'user', 'person', ?, ?)`);
	insert.run("original", "org", "work", null, now, "{}");
	const add = (
		id = "review",
		org = "org",
		metadata: Record<string, unknown> = {},
	) =>
		insert.run(
			id,
			org,
			null,
			org === "org" ? "project" : "foreign-project",
			now,
			JSON.stringify({
				decisionDeck: envelope,
				replacesDecisionId: "original",
				...metadata,
			}),
		);
	add();
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)), add };
}

it.each(["resolved", "cancelled"])(
	"retires follow-ups when their earlier card is %s",
	async (status) => {
		const { sqlite, db } = fixture();
		try {
			if (status === "resolved")
				await respondToWorkInteraction(db, {
					id: "answer",
					orgId: "org",
					interactionId: "original",
					expectedVersion: 1,
					responder: { type: "user", id: "person" },
					responseKind: "answer",
					body: "Reviewed",
					resolvesRequest: true,
					now,
				});
			else
				await cancelWorkInteraction(db, {
					orgId: "org",
					interactionId: "original",
					expectedVersion: 1,
					actor: { type: "system", id: "tedix" },
					now,
				});
			expect(
				sqlite
					.prepare(
						"SELECT status,version FROM work_interactions WHERE id='review'",
					)
					.get(),
			).toMatchObject({ status: "cancelled", version: 2 });
			expect(
				sqlite
					.prepare(
						"SELECT action,metadata FROM audit_events WHERE resource_id='review'",
					)
					.get(),
			).toMatchObject({
				action: "decision.review.retired",
				metadata: expect.stringContaining("earlier_decision_or_work_closed"),
			});
			expect(
				(
					await listWorkInteractionInbox(db, {
						orgId: "org",
						states: ["open"],
						observedAt: now,
					})
				).data,
			).toHaveLength(0);
		} finally {
			sqlite.close();
		}
	},
);

it.each(["completed", "cancelled"])(
	"retires project-filed follow-ups when original Work is %s",
	async (disposition) => {
		const { sqlite, db } = fixture();
		try {
			const params = {
				orgId: "org",
				workItemId: "work",
				actor: { type: "system" as const, id: "tedix" },
			};
			if (disposition === "completed")
				await completeWorkItem(db, { ...params, completedAt: now });
			else await cancelWorkItem(db, { ...params, cancelledAt: now });
			expect(
				sqlite
					.prepare("SELECT status FROM work_interactions WHERE id='original'")
					.get(),
			).toMatchObject({ status: "open" });
			expect(
				sqlite
					.prepare("SELECT status FROM work_interactions WHERE id='review'")
					.get(),
			).toMatchObject({ status: "cancelled" });
			expect(await retireDecisionReviews(db, { orgId: "org", now })).toBe(0);
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS n FROM audit_events WHERE action='decision.review.retired'",
					)
					.get(),
			).toMatchObject({ n: 1 });
		} finally {
			sqlite.close();
		}
	},
);

it("backfills legacy reviews on inbox read without crossing tenants or closing protected cards", async () => {
	const { sqlite, db, add } = fixture();
	try {
		add("foreign-review", "foreign");
		add("protected-review", "org", {
			decisionDeck: { ...envelope, protectedEffects: ["money"] },
		});
		add("effect-review", "org", {
			decisionDeck: {
				...envelope,
				options: [
					{
						...envelope.options[0],
						effect: {
							kind: "publish_docs",
							siteId: "11111111-1111-4111-8111-111111111111",
							buildId: "11111111-1111-4111-8111-111111111111",
						},
					},
					envelope.options[1],
				],
			},
		});
		sqlite.exec(
			"UPDATE work_items SET disposition='cancelled',version=version+1,cancelled_at='2026-10-27T08:00:00.000Z' WHERE id='work'",
		);
		const inbox = await listWorkInteractionInbox(db, {
			orgId: "org",
			states: ["open"],
			observedAt: now,
		});
		expect(inbox.data.map((row) => row.request.id)).not.toContain("review");
		for (const id of ["foreign-review", "protected-review", "effect-review"])
			expect(
				sqlite
					.prepare("SELECT status FROM work_interactions WHERE id=?")
					.get(id),
			).toMatchObject({ status: "open" });
	} finally {
		sqlite.close();
	}
});

it("agent dismissal only closes the review, with a version fence and actual actor receipt", async () => {
	const { sqlite, db } = fixture();
	try {
		const dismiss = {
			id: "review",
			version: 2,
			actorType: "external_agent",
			actorId: "executor",
			note: "No updated proposal needed",
		};
		expect(
			await retireDecisionReviews(db, { orgId: "org", now, dismiss }),
		).toBe(0);
		expect(
			await retireDecisionReviews(db, {
				orgId: "org",
				now,
				dismiss: { ...dismiss, version: 1 },
			}),
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT actor_id,metadata FROM audit_events WHERE resource_id='review'",
				)
				.get(),
		).toMatchObject({
			actor_id: "executor",
			metadata: expect.stringContaining("review_dismissed"),
		});
		expect(
			sqlite
				.prepare("SELECT status FROM work_interactions WHERE id='original'")
				.get(),
		).toMatchObject({ status: "open" });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get(),
		).toMatchObject({ n: 0 });
	} finally {
		sqlite.close();
	}
});

it("rolls back retirement when its audit receipt fails", async () => {
	const { sqlite, db } = fixture();
	try {
		sqlite.exec(
			"CREATE TRIGGER reject_retirement BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END",
		);
		await expect(
			retireDecisionReviews(db, {
				orgId: "org",
				now,
				dismiss: {
					id: "review",
					version: 1,
					actorType: "external_agent",
					actorId: "executor",
					note: "Close review",
				},
			}),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare(
					"SELECT status,version FROM work_interactions WHERE id='review'",
				)
				.get(),
		).toMatchObject({ status: "open", version: 1 });
	} finally {
		sqlite.close();
	}
});
