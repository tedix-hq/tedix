import { DatabaseSync } from "node:sqlite";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { workDue } from "../../schema/work-due";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { commitmentWakeOutbox } from "../../schema/work-items";
import { organizations } from "../../schema/organizations";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import { projects } from "../../schema/projects";
import { tediObjectives } from "../../schema/tedi-objectives";
import {
	workItems,
	workAttempts,
	workItemRelations,
} from "../../schema/work-items";
import { skillRuns } from "../../schema/cognitive";
import {
	kernelConversations,
	kernelConversationGrants,
	kernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	workAdmissions,
	workInteractions,
	workInteractionResponses,
	workInteractionDeliveries,
	workInteractionAttention,
	workInteractionCardRevisions,
	workInteractionReplyDrafts,
} from "../../schema/work-factory";
import { osGadgetExecutions, osWorkspaces } from "../../schema/os-workspaces";
import {
	listWorkInteractionInbox,
	listLastRelatedDecisions,
	setWorkInteractionAttention,
	getWorkInteractionAttention,
	getWorkInteraction,
} from "./interactions";
import {
	listCardObjectives,
	listCardSourceWorkFacts,
	listCardStatuses,
	listDeckSourceStates,
	listDeckSweepOrganizations,
	listDeckSweepRecipients,
	listRecipientCards,
	findNotUsefulAnswer,
	getDeckSweepReceipt,
	recordDeckSweepReceipt,
	setDeckPipelineLearned,
} from "./deck-sweep";
import {
	listUndeliveredWorkInteractionResponses,
	recordWorkInteractionDeliveries,
	listWorkInteractionDeliveries,
} from "./interaction-deliveries";
import {
	attentionProjectBriefs,
	attentionProjectExists,
	listUnattendedObjectives,
	readAttentionSources,
	readAttentionFactoryLinks,
} from "../work-attention";

import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { tediEmailThreads, tediEmailMessages } from "../../schema/tedi-email";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { memoryEntities } from "../../schema/memory-entities";
import { organizationSecrets } from "../../schema/organization-secrets";
import { auditEvents } from "../../schema/audit-events";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import { flushWorkInteractionDigests } from "./interaction-digests";
import { reviewWorkInteraction } from "./interaction-reviews";
import { retireDecisionReviews } from "./decision-review-retirement";
import {
	createWorkInteraction,
	respondToWorkInteraction,
} from "./interactions";
import { decisionEdges } from "../../schema/decision-graph";
import {
	workItemComments,
	workItemCorroborations,
	workEvents,
} from "../../schema/work-items";
import {
	addWorkItemComment,
	addWorkItemCorroboration,
	decisionRelevantWorkComment,
	recordWorkDecisionContinuation,
} from "./comments";
import { nudgeLaneHandoffs, withdrawStaleLaneNudges } from "./lane-handoffs";
import {
	decisionSourcesReview,
	prefetchDecisionSources,
} from "./decision-sources";
import { decisionActionChangeDetail } from "./decision-action-recheck";
import {
	upsertDecisionEdges,
	getDeckDecisionContexts,
	getDecisionContext,
	listCardSourceWork,
	terminalWorkItemIds,
} from "../decision-graph";

const at = "2026-11-25T12:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "postgres") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			} else {
				const sqlite = new DatabaseSync(":memory:");
				const tables = new Set<SQLiteTable>();
				const include = (table: SQLiteTable) => {
					if (tables.has(table)) return;
					tables.add(table);
					for (const key of getTableConfig(table).foreignKeys)
						include(key.reference().foreignTable);
				};
				[
					organizations,
					organizationMembers,
					tedis,
					projects,
					tediObjectives,
					workItems,
					workAttempts,
					workItemRelations,
					workItemComments,
					workItemCorroborations,
					workEvents,
					decisionEdges,
					auditEvents,
					agentSessionRequests,
					memoryEntities,
					organizationSecrets,
					tediEmailThreads,
					tediEmailMessages,
					workspaceOutputIndex,
					skillRuns,
					kernelConversations,
					kernelConversationGrants,
					kernelRuntimeRuns,
					workAdmissions,
					workInteractions,
					workInteractionResponses,
					workInteractionDeliveries,
					workInteractionAttention,
					workInteractionCardRevisions,
					workInteractionReplyDrafts,
					workDue,
					externalAgentPrincipals,
					externalAgentSessions,
					commitmentWakeOutbox,
					osWorkspaces,
					osGadgetExecutions,
				].forEach(include);
				sqlite.exec(schemaDdl(...tables));
				const migrated = createMigratedSqlite();
				for (const row of migrated
					.prepare(
						"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'work_interaction%'",
					)
					.all()) {
					sqlite.exec(`DROP TRIGGER IF EXISTS "${row.name}"`);
					sqlite.exec(String(row.sql));
				}
				migrated.close();
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
			}
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "orchard",
					name: "Orchard",
					slug: "orchard",
					metadata: {
						secretEgressMode: "warn",
						decisionLearning: DecisionLearningConfigSchema.parse({}),
					},
				},
				{ id: "river", name: "River", slug: "river", metadata: {} },
			]);
			await db.insert(coreTable(db, organizationMembers)).values(
				["reader", "someone"].map((id) => ({
					id,
					organizationId: "orchard",
					userId: id,
					descopeUserId: id,
					email: `${id}@example.test`,
				})),
			);

			await db.insert(coreTable(db, tedis)).values({
				id: "gardener",
				organizationId: "orchard",
				name: "Gardener",
				slug: "gardener",
			});
			await db.insert(coreTable(db, tediObjectives)).values({
				id: "grow",
				orgId: "orchard",
				tediId: "gardener",
				title: "Grow",
				priority: 1,
				createdAt: at,
			});
			await db.insert(coreTable(db, projects)).values({
				id: "trees",
				orgId: "orchard",
				key: "TREES",
				name: "Trees",
				objectiveId: "grow",
				metadata: { factory: { goal: "Harvest" } },
				createdAt: at,
			});
			await db.insert(coreTable(db, workItems)).values([
				{
					id: "source",
					orgId: "orchard",
					projectId: "trees",
					title: "Harvest",
					disposition: "accepted",
					riskLevel: "medium",
					createdAt: at,
				},
				{
					id: "waiting",
					orgId: "orchard",
					projectId: "trees",
					title: "Pack",
					disposition: "accepted",
					admissionSpecRevision: "spec-waiting",
					createdAt: at,
				},
				{
					id: "foreign",
					orgId: "river",
					title: "Foreign",
					disposition: "completed",
					createdAt: at,
				},
			]);
			await db.insert(coreTable(db, workAdmissions)).values({
				id: "admission",
				orgId: "orchard",
				workItemId: "waiting",
				workItemVersion: 1,
				admissionSpecRevision: "spec-waiting",
				executorType: "tedi",
				executorId: "gardener",
				decision: "admitted",
				decidedAt: at,
				expiresAt: "2099-01-01T00:00:00.000Z",
				createdAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				admissionId: "admission",
				orgId: "orchard",
				workItemId: "waiting",
				executorType: "tedi",
				executorId: "gardener",
				runtimeState: "running",
				attemptNumber: 1,
				startedAt: at,
				heartbeatAt: at,
				expiresAt: "2099-01-01T00:00:00.000Z",
				metadata: { lane: true },
			});
			// A dependency can arrive after the attempt was admitted.
			await db.insert(coreTable(db, workItemRelations)).values({
				id: "blocks",
				orgId: "orchard",
				fromWorkItemId: "source",
				toWorkItemId: "waiting",
				relationType: "blocks",
				createdAt: at,
			});
			await db.insert(coreTable(db, workInteractions)).values([
				{
					id: "card",
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					status: "open",
					subject: "Harvest?",
					prompt: "Ready?",
					creatorType: "user",
					creatorId: "reader",
					targetType: "user",
					targetId: "reader",
					createdAt: at,
					metadata: { sessionId: "session", host: "codex" },
				},
				{
					id: "private",
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					status: "open",
					subject: "Private",
					prompt: "Private",
					creatorType: "user",
					creatorId: "someone",
					targetType: "user",
					targetId: "someone",
					createdAt: at,
					metadata: { sessionId: "private" },
				},
				{
					id: "refused",
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					status: "open",
					subject: "  Harvest? ",
					prompt: "Ready?",
					creatorType: "user",
					creatorId: "reader",
					targetType: "user",
					targetId: "reader",
					createdAt: at,
					metadata: { curation: { notUseful: { reason: "Later" } } },
				},
			]);
			await db.insert(coreTable(db, workInteractionResponses)).values([
				{
					id: "answer",
					orgId: "orchard",
					interactionId: "card",
					resolvedRequestVersion: 2,
					resolutionFence: "answer",
					responderType: "user",
					responderId: "reader",
					responseKind: "answer",
					body: "Yes",
					resolvesRequest: true,
					respondedAt: at,
					metadata: { source: "tedix-os" },
				},
				{
					id: "private-answer",
					orgId: "orchard",
					interactionId: "private",
					resolvedRequestVersion: 2,
					resolutionFence: "private-answer",
					responderType: "user",
					responderId: "someone",
					responseKind: "answer",
					body: "Private",
					resolvesRequest: true,
					respondedAt: at,
				},
			]);
			const interactions = coreTable(db, workInteractions);
			await db
				.update(interactions)
				.set({
					status: "cancelled",
					cancelledAt: at,
					resolutionFence: "cancel",
					version: 2,
				})
				.where(eq(interactions.id, "refused"));
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		it("prefetches output and email citations as sets and rereads them at the answer boundary", async () => {
			const uuid = (n: number) =>
				`20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
			const tediId = uuid(999),
				threadId = uuid(400),
				outputId = uuid(600),
				revisionId = uuid(800);
			await db
				.insert(coreTable(db, tedis))
				.values({
					id: tediId,
					organizationId: "orchard",
					name: "Mailer",
					slug: "mailer",
				});
			await db
				.insert(coreTable(db, tediEmailThreads))
				.values({
					id: threadId,
					organizationId: "orchard",
					tediId,
					subjectNorm: "Review",
					lastMessageAt: at,
					updatedAt: at,
				});
			const message = {
				threadId,
				organizationId: "orchard",
				tediId,
				direction: "inbound" as const,
				fromAddr: "sender@example.test",
				to: [{ email: "mailer@example.test" }],
				subject: "Review",
				status: "received" as const,
				receivedAt: at,
			};
			await db
				.insert(coreTable(db, tediEmailMessages))
				.values({ id: "first-message", ...message });
			await db
				.insert(coreTable(db, workspaceOutputIndex))
				.values({
					id: `${outputId}:1`,
					organizationId: "orchard",
					workspaceId: "review-space",
					outputId,
					revision: 1,
					revisionId,
					isCurrent: 1,
					outputKind: "document",
					title: "Review",
					status: "active",
					outputCreatedByKind: "user",
					outputCreatedById: "reader",
					outputCreatedAt: at,
					revisionCreatedByKind: "user",
					revisionCreatedById: "reader",
					revisionCreatedAt: at,
					updatedAt: at,
				});
			const requests = Array.from({ length: 150 }, (_, n) => ({
				status: "open",
				kind: "question",
				targetType: "user",
				subject: "Review",
				prompt: "Ready?",
				metadata: {
					decisionSources: [
						{ kind: "output", id: n ? uuid(n) : outputId, revisionId },
						{
							kind: "email_thread",
							id: n ? uuid(n) : threadId,
							tediId,
							updatedAt: at,
							lastMessageAt: at,
							messageCount: 1,
						},
					],
				},
			}));
			const select = vi.spyOn(db, "select");
			try {
				const prefetch = await prefetchDecisionSources(db, "orchard", requests);
				expect(select).toHaveBeenCalledTimes(2);
				const reviews = await Promise.all(
					requests.map((request) =>
						decisionSourcesReview(db, "orchard", request, { prefetch }),
					),
				);
				expect(reviews[0]).toEqual({ current: true });
				expect(reviews.slice(1).every((review) => !review.current)).toBe(true);
				expect(select).toHaveBeenCalledTimes(2);
				const foreign = await prefetchDecisionSources(db, "river", requests);
				expect(
					await decisionSourcesReview(db, "river", requests[0]!, {
						prefetch: foreign,
					}),
				).toEqual({ current: false });
				await db
					.insert(coreTable(db, tediEmailMessages))
					.values({ id: "delayed-message", ...message });
				expect(
					await decisionSourcesReview(db, "orchard", requests[0]!),
				).toEqual({ current: false });
				const refreshed = await prefetchDecisionSources(
					db,
					"orchard",
					requests,
				);
				expect(
					await decisionSourcesReview(db, "orchard", requests[0]!, {
						prefetch: refreshed,
					}),
				).toEqual({ current: false });
			} finally {
				select.mockRestore();
			}
		});
		it("keeps comment relevance and continuation fences identical for decision callers", async () => {
			const later = "2026-11-26T08:00:00.000Z";
			const workId = "10000000-0000-4000-8000-000000000001";
			await db.insert(coreTable(db, workItems)).values({
				id: workId,
				orgId: "orchard",
				title: "Comment facts",
				disposition: "accepted",
				createdAt: at,
			});
			for (const [id, authorId, metadata] of [
				["progress", "reader", { decisionImpact: "progress" }],
				["answer-record", "reader", { schema: "tedix.decision-answer.v1" }],
				["fact", "someone", {}],
			] as const)
				await addWorkItemComment(db, {
					id,
					orgId: "orchard",
					workItemId: workId,
					authorType: "external_agent",
					authorId,
					body: id,
					metadata,
					createdAt: later,
					recordActivity: true,
				});
			const comments = coreTable(db, workItemComments);
			const request = {
				creatorType: "external_agent",
				creatorId: "reader",
				createdAt: at,
			};
			expect(
				(
					await db
						.select({ id: comments.id })
						.from(comments)
						.where(
							and(
								eq(comments.orgId, "orchard"),
								decisionRelevantWorkComment(db, request),
							),
						)
				).map((row) => row.id),
			).toEqual(["fact"]);
			const change = await decisionActionChangeDetail(db, "orchard", {
				...request,
				id: "protected",
				workItemId: workId,
				status: "open",
				kind: "question",
				targetType: "user",
				targetId: "reader",
				subject: "Publish the release",
				prompt: "Publish now?",
				metadata: {},
			});
			expect(change).toMatchObject({ reviewableThrough: later, note: "fact" });
			const pinned = {
				...request,
				workItemId: workId,
				targetType: "user",
				kind: "question",
				status: "open",
				subject: "Review",
				prompt: "Review?",
				metadata: {
					decisionSources: [
						{ kind: "work", id: workId, version: 1, commentCount: 0 },
					],
				},
			};
			const prefetch = await prefetchDecisionSources(db, "orchard", [pinned]);
			expect(prefetch.workReviews.get(pinned)?.get(`${workId}:0`)).toEqual({
				through: later,
				note: "fact",
			});
			expect(
				await decisionSourcesReview(db, "orchard", pinned, { prefetch }),
			).toEqual(await decisionSourcesReview(db, "orchard", pinned));

			const signal = {
				orgId: "orchard",
				workItemId: workId,
				kind: "answer" as const,
				requestId: "card",
				responseId: "answer",
				at: later,
			};
			expect(await recordWorkDecisionContinuation(db, signal)).toHaveLength(1);
			expect(await recordWorkDecisionContinuation(db, signal)).toHaveLength(0);
			expect(
				await recordWorkDecisionContinuation(db, { ...signal, orgId: "river" }),
			).toHaveLength(0);
			const items = coreTable(db, workItems);
			const [item] = await db.select().from(items).where(eq(items.id, workId));
			expect(item).toMatchObject({
				version: 1,
				metadata: { decisionContinuation: { responseId: "answer" } },
			});
			const corroboration = {
				id: "corroboration",
				orgId: "orchard",
				workItemId: workId,
				principalType: "user" as const,
				principalId: "reader",
				evidenceRef: "test:proof",
				body: "Observed",
				occurredAt: later,
				createdAt: later,
			};
			expect((await addWorkItemCorroboration(db, corroboration)).inserted).toBe(
				true,
			);
			expect(
				(
					await addWorkItemCorroboration(db, {
						...corroboration,
						sessionId: "session",
					})
				).corroboration.sessionId,
			).toBe("session");
		});
		it("reads large graph sets and the shared deck snapshot without mixing organizations", async () => {
			const edges = [
				{
					kind: "card_from_work" as const,
					from: { kind: "deck_card" as const, id: "graph-card" },
					to: { kind: "work_item" as const, id: "source" },
					source: "backfill",
					occurredAt: at,
				},
				{
					kind: "blocks" as const,
					from: { kind: "work_item" as const, id: "source" },
					to: { kind: "work_item" as const, id: "waiting" },
					source: "test",
					occurredAt: at,
				},
			];
			const batch = vi.spyOn(db, "batch");
			await upsertDecisionEdges(db, "orchard", edges);
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockRestore();
			await upsertDecisionEdges(db, "orchard", [
				{ ...edges[0]!, occurredAt: "2026-11-26T08:00:00.000Z" },
			]);
			await upsertDecisionEdges(db, "river", [
				{ ...edges[0]!, to: { kind: "work_item", id: "foreign" } },
			]);
			const ids = [
				...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
				"graph-card",
			];
			expect(await listCardSourceWork(db, "orchard", ids)).toEqual(
				new Map([["graph-card", "source"]]),
			);
			expect(
				await terminalWorkItemIds(db, "orchard", [...ids, "foreign"]),
			).toEqual(new Set());
			expect(
				await terminalWorkItemIds(db, "river", [...ids, "foreign"]),
			).toEqual(new Set(["foreign"]));
			const single = await getDecisionContext(db, "orchard", "graph-card");
			const deck = await getDeckDecisionContexts(
				db,
				"orchard",
				ids.map((id) => ({ id })),
			);
			expect(deck.get("graph-card")).toEqual(single);
			expect(single.chain[0]).toMatchObject({
				node: { id: "source" },
				edge: { note: "Harvest", occurredAt: at },
			});
			expect(single.blocksCount).toBe(1);
		});
		it("creates a page of reminders in one batch and withdraws them when their asks close", async () => {
			const now = "2026-11-26T09:00:00.000Z";
			const table = coreTable(db, workInteractions);
			for (const id of ["remind-a", "remind-b", "snoozed"])
				await db.insert(table).values({
					id,
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					creatorType: "system",
					creatorId: "tedix",
					targetType: "user",
					targetId: "reader",
					subject: id,
					prompt: "Ready?",
					createdAt: "2026-11-24T08:00:00.000Z",
					metadata: {
						laneHandoff: {},
						followThrough: {
							reviewAt: "2026-12-01T00:00:00.000Z",
							...(id === "snoozed"
								? { snoozedUntil: "2026-11-27T00:00:00.000Z" }
								: {}),
						},
					},
				});
			const batch = vi.spyOn(db, "batch");
			try {
				expect(await nudgeLaneHandoffs(db, now)).toBe(2);
				expect(batch).toHaveBeenCalledTimes(1);
				expect(batch.mock.calls[0]![0]).toHaveLength(1);
				expect(await nudgeLaneHandoffs(db, now)).toBe(0);
			} finally {
				batch.mockRestore();
			}
			await db
				.update(table)
				.set({
					status: "cancelled",
					cancelledAt: now,
					resolutionFence: "cancel-nudge",
					version: sql`${table.version}+1`,
				})
				.where(eq(table.id, "remind-a"));
			expect(await withdrawStaleLaneNudges(db, now)).toBe(1);
		});
		it("creates, bundles, reviews and answers native interactions with the deployed guards", async () => {
			const createdAt = "2026-11-25T22:00:00.000Z";
			const now = "2026-11-26T12:00:00.000Z";
			for (const [id, kind] of [
				["digest-update", "coordination"],
				["review-ask", "question"],
			] as const)
				await createWorkInteraction(db, {
					id,
					orgId: "orchard",
					workItemId: "source",
					kind,
					subject: id,
					prompt: "Ready?",
					creator: { type: "tedi", id: "gardener" },
					targetType: "user",
					targetId: "someone",
					now: createdAt,
				});
			expect(await flushWorkInteractionDigests(db, now)).toMatchObject({
				digests: 1,
			});
			expect(await flushWorkInteractionDigests(db, now)).toMatchObject({
				digests: 0,
			});
			expect(
				await reviewWorkInteraction(db, {
					orgId: "orchard",
					interactionId: "review-ask",
					expectedVersion: 1,
					actor: { type: "tedi", id: "gardener" },
					action: "reask",
					note: "Please review",
					now: "2026-11-29T08:00:00.000Z",
				}),
			).toMatchObject({ status: "open", version: 2 });
			const answered = await respondToWorkInteraction(db, {
				id: "lifecycle-answer",
				orgId: "orchard",
				interactionId: "review-ask",
				expectedVersion: 2,
				responder: { type: "user", id: "someone" },
				responseKind: "answer",
				body: "Ready",
				resolvesRequest: true,
				now: "2026-11-29T08:01:00.000Z",
			});
			expect(answered).toMatchObject({ id: "lifecycle-answer" });
			const envelope = DecisionEnvelopeSchema.parse({
				version: 1,
				kind: "question",
				classId: "decision-facts-changed",
				proposal: "Review new facts",
				whyNow: "Changed",
				recommendation: "Review",
				reversibility: "two_way",
				protectedEffects: [],
				blastRadius: "Review only",
				confidence: null,
				costOfWaiting: "Delayed",
				reasoning: "Changed facts",
				options: [
					{
						id: "review",
						label: "Reviewed",
						intent: "approve",
						consequence: "Record review",
						cost: "None",
					},
					{
						id: "dismiss",
						label: "Not needed",
						intent: "reject",
						consequence: "Close",
						cost: "None",
					},
				],
			});
			await db.insert(coreTable(db, workInteractions)).values({
				id: "facts-review",
				orgId: "orchard",
				projectId: "trees",
				kind: "question",
				subject: "Review changed facts",
				prompt: "Review only",
				creatorType: "system",
				creatorId: "tedix",
				targetType: "user",
				targetId: "someone",
				metadata: {
					decisionDeck: envelope,
					replacesDecisionId: "review-ask",
				},
				createdAt: now,
			});
			expect(
				await retireDecisionReviews(db, {
					orgId: "orchard",
					originalIds: ["review-ask"],
					now: "2026-11-29T08:02:00.000Z",
				}),
			).toBe(1);
		});
		it("reads deck sets beyond D1's parameter limit with tenant-scoped state, objectives and dependency facts", async () => {
			const ids = [
				...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
				"source",
				"waiting",
				"foreign",
			];
			expect(
				await listDeckSourceStates(db, "orchard", ids, new Date(at)),
			).toEqual(
				new Map([
					["source", "accepted"],
					["waiting", "blocked"],
				]),
			);
			expect(await listCardStatuses(db, "orchard", [...ids, "card"])).toEqual(
				new Map([["card", "resolved"]]),
			);
			expect(
				(
					await listCardObjectives(db, "orchard", [
						{ id: "card", workItemId: "source" },
					])
				).get("card"),
			).toMatchObject({ id: "grow", top: true });
			expect(
				(
					await listCardSourceWorkFacts(db, "orchard", [
						{ id: "card", workItemId: "source" },
					])
				).get("card"),
			).toMatchObject({ blocksCount: 1, blocksRunning: true });
			expect(await listDeckSweepOrganizations(db)).toEqual(["orchard"]);
			expect(
				(await listDeckSweepRecipients(db, "orchard", 10))
					.flatMap((row) => row.recipientIds)
					.sort(),
			).toEqual(["reader", "someone"]);
			expect(
				(
					await listRecipientCards(db, {
						orgId: "orchard",
						recipientId: "reader",
						status: "resolved",
						limit: 20,
					})
				)[0]?.id,
			).toBe("card");
			expect(
				await findNotUsefulAnswer(db, {
					orgId: "orchard",
					recipientId: "reader",
					subject: "Harvest?",
					workItemId: "source",
				}),
			).toMatchObject({ id: "refused", reason: "Later" });
		});
		it("preserves organization metadata while writing nested learned config and a sweep receipt", async () => {
			await setDeckPipelineLearned(db, "orchard", {
				rules: [],
				hidingClasses: [],
			});
			const receipt = {
				at,
				mode: "shadow" as const,
				recipients: 1,
				retired: 0,
				merged: 0,
				proposed: 0,
				ranked: 0,
				rankNotes: {},
				hidden: 0,
				wouldRetire: 0,
				errors: 0,
				removed: [],
				metrics: [],
			};
			await recordDeckSweepReceipt(db, "orchard", receipt);
			expect(await getDeckSweepReceipt(db, "orchard")).toEqual(receipt);
			const table = coreTable(db, organizations);
			const [row] = await db
				.select({ metadata: table.metadata })
				.from(table)
				.where(eq(table.id, "orchard"));
			expect(row?.metadata).toMatchObject({
				secretEgressMode: "warn",
				decisionLearning: { deckPipeline: { rules: [], hidingClasses: [] } },
			});
			expect(await getDeckSweepReceipt(db, "river")).toBeNull();
		});
		it("writes only owned delivery rows and preserves the first channel and timestamp on acknowledgement", async () => {
			const actor = { type: "user" as const, id: "reader" };
			const p = {
				orgId: "orchard",
				actor,
				responseIds: ["answer", "private-answer"],
				via: "hook" as const,
				acknowledged: false,
				now: at,
			};
			expect(
				(
					await listUndeliveredWorkInteractionResponses(db, {
						orgId: "orchard",
						actor,
						respondedAfter: at,
						sessionId: "session",
						host: "codex",
					})
				).map((row) => row.responseId),
			).toEqual(["answer"]);
			expect(await recordWorkInteractionDeliveries(db, p)).toMatchObject([
				{
					responseId: "answer",
					deliveredAt: at,
					deliveredVia: "hook",
					acknowledgedAt: null,
				},
			]);
			expect(
				await recordWorkInteractionDeliveries(db, {
					...p,
					via: "handoff",
					acknowledged: true,
					now: "2026-11-25T13:00:00.000Z",
				}),
			).toMatchObject([
				{
					deliveredAt: at,
					deliveredVia: "hook",
					acknowledgedAt: "2026-11-25T13:00:00.000Z",
				},
			]);
			expect(
				await listWorkInteractionDeliveries(db, {
					orgId: "orchard",
					interactionId: "private",
				}),
			).toEqual([]);
			expect(
				await listUndeliveredWorkInteractionResponses(db, {
					orgId: "orchard",
					actor,
					respondedAfter: at,
				}),
			).toEqual([]);
		});
		it("pages native inbox rows without leaking generated fields and keeps attention scoped", async () => {
			await setWorkInteractionAttention(db, {
				orgId: "orchard",
				interactionId: "card",
				kind: "fyi",
				need: null,
				asks: 0,
				decidedAt: at,
			});
			expect(
				await getWorkInteractionAttention(db, {
					orgId: "river",
					interactionId: "card",
				}),
			).toBeNull();
			const page = await listWorkInteractionInbox(db, {
				orgId: "orchard",
				targetType: "user",
				targetId: "reader",
				states: ["resolved"],
				subjectSearch: "HARVEST",
				urgency: "later",
				observedAt: at,
			});
			expect(page.data).toHaveLength(1);
			expect(page.data[0]).toMatchObject({
				request: { id: "card", metadata: { host: "codex" } },
				effectiveState: "resolved",
				responseCount: 1,
				attentionKind: "fyi",
			});
			expect(page.data[0]!.request).not.toHaveProperty("source");
			expect(page.data[0]!.request).not.toHaveProperty("delegatedOwnerId");
			expect(
				(
					await getWorkInteraction(db, {
						orgId: "orchard",
						interactionId: "card",
					})
				)?.metadata.host,
			).toBe("codex");
		});

		it("guards responses, rolls back a later write failure and maintains related history and wake projections", async () => {
			const requests = coreTable(db, workInteractions);
			const responses = coreTable(db, workInteractionResponses);
			const source = {
				kind: "output",
				id: "harvest-plan",
				revisionId: "draft",
			};
			await db.insert(requests).values({
				id: "guarded",
				orgId: "orchard",
				workItemId: "source",
				kind: "question",
				subject: "Approve harvest",
				prompt: "Ready?",
				creatorType: "user",
				creatorId: "reader",
				targetType: "user",
				targetId: "reader",
				createdAt: at,
				metadata: { decisionSources: [source] },
			});
			const reply = {
				id: "guarded-answer",
				orgId: "orchard",
				interactionId: "guarded",
				resolvedRequestVersion: 2,
				resolutionFence: "guarded-answer",
				responderType: "user" as const,
				responderId: "reader",
				responseKind: "answer" as const,
				body: "Yes",
				resolvesRequest: true,
				respondedAt: "2026-11-25T14:00:00.000Z",
			};
			await expect(
				db
					.insert(responses)
					.values({ ...reply, id: "wrong-reader", responderId: "someone" }),
			).rejects.toThrow();
			await expect(
				db.batch([
					db.insert(responses).values(reply),
					db.insert(responses).values({ ...reply, id: "stale-answer" }),
				]),
			).rejects.toThrow();
			expect(
				await getWorkInteraction(db, {
					orgId: "orchard",
					interactionId: "guarded",
				}),
			).toMatchObject({ status: "open", version: 1 });
			expect(
				await db
					.select({ id: responses.id })
					.from(responses)
					.where(eq(responses.interactionId, "guarded")),
			).toEqual([]);
			await db.insert(responses).values(reply);
			expect(
				await getWorkInteraction(db, {
					orgId: "orchard",
					interactionId: "guarded",
				}),
			).toMatchObject({
				status: "resolved",
				version: 2,
				resolutionFence: reply.resolutionFence,
			});
			await expect(
				db
					.update(requests)
					.set({ prompt: "Changed" })
					.where(eq(requests.id, "guarded")),
			).rejects.toThrow();
			await expect(
				db.delete(responses).where(eq(responses.id, reply.id)),
			).rejects.toThrow();
			await db.insert(requests).values({
				id: "related",
				orgId: "orchard",
				projectId: "trees",
				kind: "question",
				subject: "Next harvest",
				prompt: "Ready?",
				creatorType: "user",
				creatorId: "reader",
				targetType: "user",
				targetId: "reader",
				createdAt: at,
				metadata: { decisionSources: [source] },
			});
			expect(
				await listLastRelatedDecisions(db, "orchard", [
					...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
					"related",
				]),
			).toMatchObject([
				{
					interactionId: "related",
					decision: { requestId: "guarded", body: "Yes" },
				},
			]);
			const due = coreTable(db, workDue);
			expect(
				await db
					.select({ kind: due.kind })
					.from(due)
					.where(eq(due.objectId, "guarded")),
			).toContainEqual({ kind: "interaction-review-dispatch" });
			const outbox = coreTable(db, commitmentWakeOutbox);
			expect(
				await db
					.select({ sourceId: outbox.sourceId })
					.from(outbox)
					.where(eq(outbox.sourceId, reply.id)),
			).toEqual([{ sourceId: reply.id }]);
		});

		it("reads Attention aggregates, boolean JSON and project briefs with tenant boundaries", async () => {
			expect(await attentionProjectExists(db, "river", "trees")).toBe(false);
			expect((await attentionProjectBriefs(db, "orchard"))[0]).toMatchObject({
				id: "trees",
			});
			const result = await readAttentionSources(
				db,
				"orchard",
				"2026-01-01T00:00:00.000Z",
				"reader",
				"reader",
			);
			expect(result.attempts[0]).toMatchObject({
				id: "attempt",
				registeredLane: true,
			});
			expect(result.projects[0]).toMatchObject({
				id: "trees",
				active: 1,
				recent: 1,
			});
			expect(await listUnattendedObjectives(db, "orchard", at)).toMatchObject([
				{ id: "grow", lastAttentionAt: null },
			]);
			expect(
				await readAttentionFactoryLinks(db, "river", "reader", at),
			).toEqual([]);
		});
	});
