import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createApprovalRequest, resolveApprovalRequest } from "./approvals";
import { countBlocked, getDecisionContext } from "./decision-graph";
import { createFact } from "./memory-graph/facts";
import { insertSessionFeedbackLesson } from "./memory-graph/session-feedback";
import {
	decideWorkApproval,
	proposeWorkApproval,
} from "./work-items/approvals";
import {
	createWorkInteraction,
	respondToWorkInteraction,
} from "./work-items/interactions";
import { addWorkItemRelation } from "./work-items/relations";

const NOW = "2026-10-21T12:00:00.000Z";

it("links a captured chat instruction only to explicit same-organization Work and card references", async () => {
	const f = fixture();
	await f.card();
	f.sqlite.exec(
		`INSERT INTO learning_interaction_events(id,organization_id,actor_type,actor_id,client_event_id,event_kind,scope_kind,scope_id,surface,target_type,target_id,metadata,occurred_at,created_at) VALUES('chat-event','org','user','owner','chat-event','answered','personal','owner','agent_session_feedback','session_feedback','chat','{"answer":"Rotate /work/items/work and /work/interactions/card; /work/items/foreign-work is unrelated"}','${NOW}','${NOW}');`,
	);
	await insertSessionFeedbackLesson(f.db, {
		id: "chat-lesson",
		organizationId: "org",
		content: "Rotate the referenced old key",
		factType: "preference",
		reviewStatus: "confirmed",
		createdAt: "2026-10-22T12:00:00.000Z",
		metadata: {
			learningFeed: {
				ownerUserId: "owner",
				evidence: { sources: [{ kind: "correction", id: "chat-event" }] },
			},
		},
	});
	const edges = f.edges().filter((e) => e.to_id === "chat-lesson");
	expect(edges).toHaveLength(2);
	expect(edges.map((e) => e.from_id).sort()).toEqual(["card", "work"]);
	expect(edges.every((e) => e.occurred_at === NOW)).toBe(true);
});
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

it("links only confirmed lessons from a user's same-organization Work comment", async () => {
	const f = fixture();
	f.sqlite.exec(
		`INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,created_at) VALUES('comment','org','work','user','owner','Rotate the old key','${NOW}'),('foreign-comment','foreign','foreign-work','user','other','Other instruction','${NOW}');`,
	);
	for (const [id, reviewStatus, source] of [
		["confirmed", "confirmed", "work-comment:comment"],
		["pending", "pending", "work-comment:comment"],
		["foreign", "confirmed", "work-comment:foreign-comment"],
	] as const)
		await createFact(f.db, {
			id,
			organizationId: "org",
			content: "Rotate the old key",
			factType: "decision",
			reviewStatus,
			source,
			createdAt: NOW,
		});
	expect(f.edges()).toEqual([
		expect.objectContaining({
			kind: "decided_by",
			from_id: "work",
			to_id: "confirmed",
			to_kind: "owner_instruction",
			occurred_at: NOW,
		}),
	]);
});

function fixture(broken = false) {
	const sqlite = new DatabaseSync(":memory:");
	cleanups.push(() => sqlite.close());
	const migrations = new URL("../../drizzle/", import.meta.url);
	for (const name of readdirSync(migrations).sort())
		sqlite.exec(
			readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"),
		);
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Orchard','orchard'),('foreign','Harbor','harbor');
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,name,status,role) VALUES('member','org','owner','owner','owner@example.test','Morgan','active','owner');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('worker','org','Worker','worker','active');
		INSERT INTO work_items(id,org_id,title,description,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Audit Orchard API','Ask Morgan to rotate orchard_token','maintenance','2099-01-01T00:00:00.000Z','test','${NOW}'),('waiting','org','Release','Wait','maintenance','2099-01-01T00:00:00.000Z','test','${NOW}'),('foreign-work','foreign','Other','Other','maintenance','2099-01-01T00:00:00.000Z','test','${NOW}');
		INSERT INTO memory_entities(id,organization_id,entity_type,display_name,normalized_name) VALUES('api','org','service','Orchard API','orchard api'),('foreign-api','foreign','service','Orchard API','orchard api');
		INSERT INTO organization_secrets(id,organization_id,name,encrypted_value,created_at,updated_at) VALUES('key','org','orchard_token','never-read-this','${NOW}','${NOW}'),('foreign-key','foreign','orchard_token','other-secret','${NOW}','${NOW}');
	`);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	if (broken)
		sqlite.exec(
			"CREATE TRIGGER broken_graph BEFORE INSERT ON decision_edges BEGIN SELECT RAISE(ABORT,'graph unavailable'); END;",
		);
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	const card = (id = "card") =>
		createWorkInteraction(db, {
			id,
			orgId: "org",
			workItemId: "work",
			kind: "question",
			subject: "Rotate orchard_token?",
			prompt: "Ask Morgan about Orchard API.",
			creator: { type: "tedi", id: "worker" },
			targetType: "user",
			targetId: "owner",
			now: NOW,
		});
	const edges = () =>
		sqlite
			.prepare(
				"SELECT kind,from_id,to_id,to_kind,note,occurred_at,evidence_ref FROM decision_edges ORDER BY kind,to_id",
			)
			.all();
	return { sqlite, db, card, edges, warn };
}

describe.each([false, true])(
	"decision graph writers (graph unavailable: %s)",
	(broken) => {
		it("links a new card to its Work and named people, systems and credential metadata", async () => {
			const f = fixture(broken);
			expect((await f.card()).id).toBe("card");
			if (broken) {
				expect(f.warn).toHaveBeenCalledWith(
					"[decision-graph] edge write skipped",
					{ source: "deck_creation" },
				);
				return;
			}
			expect(f.edges()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "card_from_work",
						from_id: "card",
						to_id: "work",
						note: "Audit Orchard API",
						occurred_at: NOW,
					}),
					expect.objectContaining({
						kind: "involves",
						from_id: "card",
						to_id: "api",
						to_kind: "system",
					}),
					expect.objectContaining({
						kind: "involves",
						from_id: "card",
						to_id: "key",
						to_kind: "credential",
					}),
					expect.objectContaining({
						kind: "involves",
						from_id: "card",
						to_id: "owner",
						to_kind: "person",
					}),
				]),
			);
			expect(JSON.stringify(f.edges())).not.toMatch(
				/foreign|never-read-this|other-secret/,
			);
		});

		it("records only durable resolving answers, and never a rejected response", async () => {
			const f = fixture(broken);
			await f.card();
			const answer = {
				id: "answer",
				orgId: "org",
				interactionId: "card",
				expectedVersion: 1,
				responder: { type: "user" as const, id: "owner" },
				responseKind: "answer" as const,
				body: "Rotate the old key",
				resolvesRequest: false,
				now: NOW,
			};
			await respondToWorkInteraction(f.db, answer);
			expect(f.edges().filter((e) => e.kind === "card_answers")).toEqual([]);
			await expect(
				respondToWorkInteraction(f.db, {
					...answer,
					id: "rejected",
					expectedVersion: 0,
					resolvesRequest: true,
				}),
			).rejects.toThrow();
			await respondToWorkInteraction(f.db, {
				...answer,
				id: "resolved",
				expectedVersion: 2,
				resolvesRequest: true,
			});
			if (broken) {
				expect(f.warn).toHaveBeenCalledWith(
					"[decision-graph] edge write skipped",
					{ source: "card_resolution" },
				);
				return;
			}
			expect(f.edges()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "card_answers",
						from_id: "card",
						to_id: "resolved",
					}),
					expect.objectContaining({
						kind: "decided_by",
						from_id: "work",
						to_id: "resolved",
					}),
				]),
			);
			expect(f.edges().some((e) => e.to_id === "rejected")).toBe(false);
		});

		it("preserves Work blocks direction and records supersession after the relation exists", async () => {
			const f = fixture(broken);
			for (const relationType of ["blocks", "supersedes"] as const)
				await addWorkItemRelation(f.db, {
					id: relationType,
					orgId: "org",
					fromWorkItemId: "work",
					toWorkItemId: "waiting",
					relationType,
					createdAt: NOW,
				});
			await expect(
				addWorkItemRelation(f.db, {
					id: "foreign",
					orgId: "org",
					fromWorkItemId: "work",
					toWorkItemId: "foreign-work",
					relationType: "blocks",
					createdAt: NOW,
				}),
			).rejects.toThrow();
			if (broken) {
				expect(f.warn).toHaveBeenCalledWith(
					"[decision-graph] edge write skipped",
					{ source: "work_link" },
				);
				return;
			}
			expect(await countBlocked(f.db, "org", "work")).toBe(1);
			expect(f.edges()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "supersedes",
						from_id: "work",
						to_id: "waiting",
					}),
				]),
			);
		});

		it("links resolved runtime approvals, with no edges for a lost CAS", async () => {
			const f = fixture(broken);
			await createApprovalRequest(f.db, {
				id: "approval",
				orgId: "org",
				tediId: "worker",
				actionType: "custom",
				description: "Rotate key",
				payload: { workItemId: "work" },
				createdAt: NOW,
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			if (!broken)
				expect(f.edges()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: "card_from_work",
							from_id: "approval:approval",
							to_id: "work",
						}),
					]),
				);
			expect(
				await resolveApprovalRequest(f.db, "approval", {
					status: "approved",
					resolvedBy: "owner",
				}),
			).toBeDefined();
			expect(
				await resolveApprovalRequest(f.db, "approval", {
					status: "rejected",
					resolvedBy: "owner",
				}),
			).toBeUndefined();
			if (broken) {
				expect(f.warn).toHaveBeenCalledWith(
					"[decision-graph] edge write skipped",
					{ source: "approval_resolution" },
				);
				return;
			}
			expect(f.edges()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "card_answers",
						from_id: "approval:approval",
						to_id: "approval",
					}),
					expect.objectContaining({
						kind: "decided_by",
						from_id: "work",
						to_id: "approval",
					}),
				]),
			);
		});

		it("links the successful Work approval decision", async () => {
			const f = fixture(broken);
			f.sqlite.exec(
				`UPDATE work_items SET required_authorities='["review"]',admission_spec_revision='review-revision',version=version+1 WHERE id='work'`,
			);
			await proposeWorkApproval(f.db, {
				id: "proposal",
				orgId: "org",
				workItemId: "work",
				workItemVersion: 2,
				authorityKey: "review",
				proposal: {},
				requesterType: "tedi",
				requesterId: "worker",
				approverType: "user",
				approverId: "owner",
				rationale: "Review",
				expiresAt: "2099-01-01T00:00:00.000Z",
				now: NOW,
			});
			if (!broken)
				expect(f.edges()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: "card_from_work",
							from_id: "work-approval:proposal",
							to_id: "work",
						}),
					]),
				);
			await decideWorkApproval(f.db, {
				id: "decision",
				orgId: "org",
				proposalId: "proposal",
				expectedVersion: 1,
				deciderType: "user",
				deciderId: "owner",
				decision: "approved",
				rationale: "Proceed",
				now: NOW,
			});
			if (broken) {
				expect(f.warn).toHaveBeenCalledWith(
					"[decision-graph] edge write skipped",
					{ source: "work_approval_resolution" },
				);
				return;
			}
			expect(f.edges()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "card_answers",
						from_id: "work-approval:proposal",
						to_id: "decision",
					}),
					expect.objectContaining({
						kind: "decided_by",
						from_id: "work",
						to_id: "decision",
					}),
				]),
			);
		});

		it("links captured owner lessons to their evidenced card and Work, idempotently", async () => {
			const f = fixture(broken);
			await f.card();
			f.sqlite.exec(
				`INSERT INTO learning_interaction_events(id,organization_id,actor_type,actor_id,client_event_id,event_kind,scope_kind,scope_id,surface,target_type,target_id,metadata,occurred_at,created_at) VALUES('event','org','user','owner','event','answered','personal','owner','decision_capture','work_interaction','card','{"answer":"Rotate the old key"}','${NOW}','${NOW}');`,
			);
			const fact = {
				id: "instruction",
				organizationId: "org",
				content: "Rotate the old key",
				factType: "decision" as const,
				reviewStatus: "confirmed" as const,
				usePolicy: "can_use_as_instruction" as const,
				createdAt: NOW,
				metadata: {
					learningFeed: { ownerUserId: "owner", evidenceEventIds: ["event"] },
				},
			};
			await createFact(f.db, fact);
			await insertSessionFeedbackLesson(f.db, fact);
			if (broken) {
				expect(f.warn).toHaveBeenCalledWith(
					"[decision-graph] edge write skipped",
					{ source: "owner_instruction_capture" },
				);
				return;
			}
			const edges = f.edges().filter((e) => e.to_id === "instruction");
			expect(edges).toHaveLength(2);
			expect(edges).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "decided_by",
						from_id: "card",
						to_kind: "owner_instruction",
					}),
					expect.objectContaining({
						kind: "decided_by",
						from_id: "work",
						to_kind: "owner_instruction",
					}),
				]),
			);
			expect(
				(await getDecisionContext(f.db, "org", "card")).priorDecision?.node.id,
			).toBe("instruction");
		});
	},
);
