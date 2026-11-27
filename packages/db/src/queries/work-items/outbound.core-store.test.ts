import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { OutboundState } from "@tedix/api-contract/schemas/outbound";
import { createDbClient, type DbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	advanceCardSummaryBackfill,
	listMissingCardSummaries,
	saveDecisionCardPresentation,
} from "./card-presentation";
import {
	appendCardRevision,
	latestCardChangeRequest,
	listCardRevisions,
	listHandledInternalDecisionCards,
} from "./card-revisions";
import {
	getOutboundPolicy,
	listOutbound,
	outboundApprovalHistory,
	outboundInteractionOverlays,
	putOutboundPolicy,
	saveOutbound,
	sweepStuckOutboundReviews,
} from "./outbound";
import {
	countConsecutiveAutoReplies,
	getPreviousSessionDraftTurnType,
	getReplyDraftAcceptance,
	getReplyDraftLeaderboard,
	insertReplyDraft,
	recordAutoReplyDelivery,
} from "./reply-drafts";
import { listReplyExamples } from "./reply-examples";

const NOW = "2026-10-17T10:00:00.000Z";
const LATER = "2026-10-17T10:05:00.000Z";
const WORK = "11111111-1111-4111-8111-111111111111";
const QUESTION = "33333333-3333-4333-8333-333333333333";
const REVIEWER = "22222222-2222-4222-8222-222222222222";
const QUIET = JSON.stringify({
	schema: "tedix.decision-capture.v1",
	sessionId: "session",
	repository: "repo",
	triage: { status: "ok", urgency: "later", labels: {}, urgentLabels: [] },
});
const state: OutboundState = {
	schema: "tedix.outbound.v1",
	draft: {
		channel: "email",
		topic: "partners",
		recipient: "lina@example.test",
		subject: "Our conversation",
		body: "Hi Lina,\nThanks.\nRosa",
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

// Outbound, card copy and reply-draft queries run on both core stores, with
// the migrated triggers in place.
for (const store of ["d1", "postgres"] as const)
	describe(`outbound and card queries ${store}`, () => {
		let db: DbClient;
		let exec: (statement: string) => unknown;
		let close: () => unknown;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				exec = (statement) => sqlite.exec(statement);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				db = fixture.db;
				exec = (statement) => fixture.engine.exec(statement);
				close = fixture.close;
			}
			await exec(`
				INSERT INTO organizations(id,name,slug) VALUES('org','Harbor','harbor');
				INSERT INTO users(id,email) VALUES('rosa','rosa@example.test');
				INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role)
				VALUES('membership','org','rosa','rosa','rosa@example.test','active','owner');
				INSERT INTO tedis(id,organization_id,name,slug,status)
				VALUES('${REVIEWER}','org','Reviewer','reviewer','active'),('drafter','org','Drafter','drafter','active');
				INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at,metadata)
				VALUES('${WORK}','org','Reply to Lina','hygiene','2027-01-01T00:00:00.000Z','fictional-revision','${NOW}','{"keep":"original"}');
				INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
				VALUES('${QUESTION}','org','${WORK}','question','Review reply','Draft','user','rosa','user','rosa','${NOW}');
			`);
		});
		afterAll(() => close());

		it("saves outbound drafts, history and timeouts", async () => {
			await putOutboundPolicy(db, "org", {
				routes: [],
				reviewTimeoutMinutes: 30,
			} as never);
			expect(await getOutboundPolicy(db, "org")).toMatchObject({
				routes: [],
			});
			expect(
				await saveOutbound(db, {
					orgId: "org",
					workItemId: WORK,
					expectedVersion: 1,
					state,
					actor: { type: "user", id: "rosa" },
					action: "submitted",
					now: NOW,
					revisionFeedback: { summary: "First", keptHunks: [] },
				}),
			).toBe(true);
			expect(await listOutbound(db, "org", undefined, 10)).toEqual([
				expect.objectContaining({ workItemId: WORK, version: 2 }),
			]);
			expect(
				await outboundInteractionOverlays(db, "org", [QUESTION]),
			).toHaveLength(1);
			expect(
				await saveOutbound(db, {
					orgId: "org",
					workItemId: WORK,
					expectedVersion: 2,
					state: {
						...state,
						draftRevision: 2,
						draft: { ...state.draft, body: "Hi Lina, final." },
					},
					actor: { type: "user", id: "rosa" },
					action: "approve_manual",
					now: NOW,
					response: {
						body: "Hi Lina, final.",
						before: state.draft.body,
						resolves: false,
					},
				}),
			).toBe(true);
			const [history] = await outboundApprovalHistory(db, "org", "rosa");
			expect(history).toMatchObject({ totalCount: 1 });
			expect(
				await sweepStuckOutboundReviews(db, {
					now: "2026-10-17T10:29:59.000Z",
					limit: 10,
				}),
			).toMatchObject({ outboundReviewsTimedOut: 0 });
			expect(
				await sweepStuckOutboundReviews(db, {
					now: "2026-10-18T10:30:00.000Z",
					limit: 10,
				}),
			).toMatchObject({
				outboundReviewCandidates: 1,
				outboundReviewsTimedOut: 1,
			});
		});

		it("appends card revisions and keeps display copy history", async () => {
			await exec(`
				INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
				VALUES('card','org','${WORK}','question','Pick','Original','tedi','drafter','user','rosa','${NOW}','{"cardPresentation":{"title":"Old"}}');
			`);
			const base = {
				orgId: "org",
				requestId: "card",
				expectedVersion: 1,
				expectedRevision: 0,
				body: "Original",
				cause: "initial" as const,
				actorType: "tedi",
				actorId: "drafter",
			};
			expect(await appendCardRevision(db, base)).not.toBeNull();
			expect(
				await appendCardRevision(db, {
					...base,
					expectedRevision: 1,
					body: "Rewritten",
					cause: "human_edit",
					actorType: "user",
					actorId: "rosa",
					keptHunks: [],
					anchors: [],
					proposal: { title: "Pick" } as never,
				}),
			).not.toBeNull();
			expect(
				(await listCardRevisions(db, "org", "card")).map((row) => row.body),
			).toEqual(["Original", "Rewritten"]);
			expect(await latestCardChangeRequest(db, "org", "card")).toBeNull();
			expect(
				await listHandledInternalDecisionCards(db, {
					orgId: "org",
					recipientId: "rosa",
					limit: 10,
				}),
			).toEqual([]);

			const { rows, previous } = await listMissingCardSummaries(db, LATER);
			expect(previous).toBeNull();
			expect(rows.map((row) => row.id)).toContain(QUESTION);
			await advanceCardSummaryBackfill(db, null, `org:${QUESTION}`);
			await advanceCardSummaryBackfill(db, "stale", "org:zzz");
			expect((await listMissingCardSummaries(db, LATER)).previous).toBe(
				`org:${QUESTION}`,
			);

			const presentation = { title: "New", summary: "Pick one" } as never;
			const [card] = await db.all<{ version: number }>(
				"SELECT version FROM work_interactions WHERE id='card'",
			);
			const version = card!.version;
			const first = await saveDecisionCardPresentation(db, {
				orgId: "org",
				requestId: "card",
				personId: "rosa",
				expectedVersion: Number(version),
				presentation,
			});
			expect(first?.presentation).toMatchObject({ title: "New" });
			await saveDecisionCardPresentation(db, {
				orgId: "org",
				requestId: "card",
				personId: "rosa",
				expectedVersion: Number(version),
				presentation: { title: "Newer" } as never,
			});
			const [face] = (await db.all(
				"SELECT presentation FROM work_interaction_card_presentations WHERE interaction_id='card'",
			)) as { presentation: unknown }[];
			const stored =
				typeof face!.presentation === "string"
					? JSON.parse(face!.presentation)
					: face!.presentation;
			expect(stored.copyHistory.map((x: { title: string }) => x.title)).toEqual(
				["Old", "New"],
			);
		});

		it("scores reply drafts and lists reply examples", async () => {
			await exec(`
				INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
				VALUES('q1','org','${WORK}','question','Q1','Ship it?','system','tedix','user','rosa','${NOW}','${QUIET}'),
					('q2','org','${WORK}','question','Q2','Merge it?','system','tedix','user','rosa','${LATER}','${QUIET}');
			`);
			await insertReplyDraft(db, {
				id: "d1",
				orgId: "org",
				interactionId: "q1",
				drafterId: "drafter",
				body: "Yes",
				rationale: "Tests pass",
				turnType: "steer",
				delivery: "auto",
				now: "2026-10-17T10:01:00.000Z",
			});
			const delivered = await recordAutoReplyDelivery(db, {
				orgId: "org",
				interactionId: "q1",
				draftId: "d1",
				actor: { type: "user", id: "rosa" },
				via: "hook",
				responseId: "auto-response",
				now: "2026-10-17T10:02:00.000Z",
			} as never);
			expect(delivered).toMatchObject({ created: true });
			const session = {
				orgId: "org",
				interactionId: "q2",
				targetUserId: "rosa",
				sessionId: "session",
				createdAt: LATER,
			};
			expect(
				await countConsecutiveAutoReplies(db, { ...session, limit: 5 }),
			).toBe(1);
			expect(await getPreviousSessionDraftTurnType(db, session)).toBe("steer");
			expect(
				await getReplyDraftAcceptance(
					db,
					{ orgId: "org", targetUserId: "rosa" },
					{ minRate: 0.5, minDrafts: 1 },
				),
			).toEqual([
				expect.objectContaining({ turnType: "steer", drafts: 1, autoSent: 1 }),
			]);
			expect(
				await getReplyDraftLeaderboard(db, {
					orgId: "org",
					targetUserId: "rosa",
					since: NOW,
					todaySince: NOW,
				}),
			).toEqual([
				expect.objectContaining({
					tediId: "drafter",
					name: "Drafter",
					week: expect.objectContaining({
						answered: 1,
						autoSent: 1,
						avgReplySeconds: 60,
					}),
				}),
			]);
			expect(
				await listReplyExamples(db, {
					orgId: "org",
					targetUserId: "rosa",
					repository: "repo",
					excludeInteractionId: "q2",
					limit: 5,
				}),
			).toEqual([]);
		});
	});
