import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { onTestFinished } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	memoryFacts,
	memoryEdges,
	memoryDomains,
} from "@tedix/db/schema/memory-graph";
import {
	memoryFactCitations,
	memoryFactCitationBackfills,
} from "@tedix/db/schema/memory-fact-citations";
import { OrganizationMemoryAdapter } from "@tedix/db/queries/memory-graph/memory-adapter";
import {
	getChangeRecord,
	listChangeRecords,
} from "../../services/organization-log";
import { installOrganizationLogFixture } from "../../../test/organization-log-fixture";
import type { BaseContext } from "../orpc";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { learningFeedbackContractRouter } from "./learning-feedback";
import { learn } from "./memory-graph/retrieval-learning";
import {
	review,
	promote,
	opine,
	gapsDetect,
	gapsResolve,
} from "./memory-graph/review-reasoning";
import { describe, expect, it } from "vite-plus/test";
import {
	resolveMemoryFactOwnership,
	resolveMemoryFactReviewUpdates,
} from "./memory-graph/policy-operations";

describe("resolveMemoryFactOwnership", () => {
	it("uses the forwarded unified-gateway tedi id for tedi-scoped memory", () => {
		expect(
			resolveMemoryFactOwnership({
				memoryScope: "tedi",
				forwardedTediId: "tedi-acme",
			}),
		).toEqual({ tediId: "tedi-acme", visibility: "private" });
	});

	it("rejects tedi-scoped memory without a concrete tedi owner", () => {
		expect(() => resolveMemoryFactOwnership({ memoryScope: "tedi" })).toThrow(
			"tedi-scoped memory requires a tediId",
		);
	});

	it("keeps org memory org-visible and unowned by a tedi", () => {
		expect(
			resolveMemoryFactOwnership({
				memoryScope: "org",
				forwardedTediId: "tedi-acme",
			}),
		).toEqual({ tediId: null, visibility: "org" });
	});
});

describe("resolveMemoryFactReviewUpdates", () => {
	const now = "2026-06-29T12:00:00.000Z";

	it("rejects noisy facts with safe recall defaults", () => {
		expect(
			resolveMemoryFactReviewUpdates(
				{ reviewStatus: "rejected", archived: true },
				{ now, reviewerTediId: "tedi-acme", reviewerAuthType: "service" },
			),
		).toMatchObject({
			reviewStatus: "rejected",
			usePolicy: "do_not_inject_automatically",
			priority: "background",
			archivedAt: now,
			metadata: {
				memoryLifecycle: {
					lastReview: {
						reviewedAt: now,
						reviewerTediId: "tedi-acme",
						reviewerAuthType: "service",
						reviewStatus: "rejected",
						archived: true,
					},
				},
			},
		});
	});

	it("preserves explicit lifecycle choices and existing metadata", () => {
		const updates = resolveMemoryFactReviewUpdates(
			{
				reviewStatus: "rejected",
				usePolicy: "requires_user_confirmation",
				priority: "active",
				reason: "Needs human review.",
			},
			{
				now,
				existingMetadata: {
					source: "smoke",
					memoryLifecycle: { previous: true },
				},
			},
		);

		expect(updates).toMatchObject({
			usePolicy: "requires_user_confirmation",
			priority: "active",
			metadata: {
				source: "smoke",
				memoryLifecycle: {
					previous: true,
					lastReview: {
						reason: "Needs human review.",
					},
				},
			},
		});
	});

	it("confirms facts as active and verified", () => {
		expect(
			resolveMemoryFactReviewUpdates({ reviewStatus: "confirmed" }, { now }),
		).toMatchObject({
			reviewStatus: "confirmed",
			status: "active",
			lastVerifiedAt: now,
		});
	});
});

it("records a fact review as a new organization memory revision with a readable change record", async () => {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(memoryFacts, memoryFactCitations, memoryFactCitationBackfills),
	);
	installOrganizationLogFixture();
	const organizationId = "00000000-0000-4000-8000-000000000501";
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(memoryFacts).values({
		id: "reviewed-fact",
		organizationId,
		content: "Use the shared review procedure.",
		factType: "technical",
		memoryScope: "org",
		visibility: "org",
		reviewStatus: "pending",
		metadata: { source: "example" },
	});
	const client = createRouterClient(
		{ review },
		{
			context: {
				db,
				organizationId,
				authType: "user",
				userId: "reviewer",
				user: { sub: "reviewer", permissions: ["tedis:update"] },
				headers: new Headers(),
				env: { ENVIRONMENT: "test" } as CloudflareEnv,
				url: new URL("https://api.tedix.test/rpc/memoryGraph"),
			} as BaseContext,
		},
	);
	const { fact } = await client.review({
		factId: "reviewed-fact",
		reviewStatus: "evidence_only",
		reason: "Checked the source.",
	});
	expect(fact).toMatchObject({
		content: "Use the shared review procedure.",
		reviewStatus: "evidence_only",
		metadata: {
			source: "example",
			memoryLifecycle: {
				lastReview: {
					reviewStatus: "evidence_only",
					reason: "Checked the source.",
				},
			},
		},
	});
	const history = await new OrganizationMemoryAdapter(db, {
		organizationId,
	}).history(fact.id);
	expect(history).toHaveLength(2);
	const revision = history.at(-1)!;
	expect(revision).toMatchObject({
		review: "approved",
		reviewedBy: "reviewer",
		value: fact.content,
	});
	const record = await getChangeRecord(
		organizationId,
		revision.provenance.changeRecordId!,
	);
	expect(record).toMatchObject({
		id: revision.provenance.changeRecordId,
		resource: `memory:organization:${fact.id}`,
		operation: "review",
		outcome: "applied",
		actor: { id: "reviewer", kind: "user" },
		after: { revisionId: revision.revisionId, hash: revision.hash },
	});
	expect(
		await listChangeRecords(organizationId, {
			resource: `memory:organization:${fact.id}`,
		}),
	).toEqual([record]);
});

it("records procedure fact lifecycles with matching revisions and preserves fact defaults", async () => {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			memoryFacts,
			memoryEdges,
			memoryDomains,
			memoryFactCitations,
			memoryFactCitationBackfills,
			learningInteractionEvents,
		),
	);
	installOrganizationLogFixture();
	const organizationId = "00000000-0000-4000-8000-000000000502";
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(memoryFacts).values([
		{
			id: "private-evidence",
			organizationId,
			tediId: "example-tedi",
			content: "Use the current guide.",
			factType: "technical",
			memoryScope: "tedi",
			visibility: "private",
			reviewStatus: "confirmed",
			source: "doc://guide",
			metadata: { retained: true },
		},
		{
			id: "previous-guide",
			organizationId,
			content: "Use the previous guide.",
			factType: "technical",
			memoryScope: "org",
			visibility: "org",
			topicKey: "guide",
			reviewStatus: "confirmed",
			metadata: { retained: true },
		},
	]);
	const client = createRouterClient(
		{
			promote,
			opine,
			learn,
			gapsDetect,
			gapsResolve,
			correct: learningFeedbackContractRouter.correct,
		},
		{
			context: {
				db,
				organizationId,
				authType: "user",
				userId: "operator",
				user: { sub: "operator", permissions: ["tedis:update", "tedis:read"] },
				headers: new Headers(),
				env: { ENVIRONMENT: "test" } as CloudflareEnv,
				url: new URL("https://api.tedix.test/rpc/memoryGraph"),
			} as BaseContext,
		},
	);
	const { fact: promoted } = await client.promote({
		factId: "private-evidence",
		visibility: "org",
		topicKey: "guide",
	});
	expect(promoted).toMatchObject({
		content: "Use the current guide.",
		tediId: null,
		memoryScope: "org",
		source: "doc://guide",
		reviewStatus: "confirmed",
		metadata: { retained: true },
	});
	await client.promote({
		factId: promoted.id,
		visibility: "shared",
		priority: "background",
	});
	const { opinion } = await client.opine({
		question: "Which guide should we use?",
	});
	// Opine historically leaves memoryScope to the database's tedi default.
	expect(opinion).toMatchObject({
		memoryScope: "tedi",
		visibility: "org",
		reviewStatus: "pending",
		source: "reflection",
	});
	const eventId = crypto.randomUUID();
	await db.insert(learningInteractionEvents).values({
		id: eventId,
		organizationId,
		actorType: "user",
		actorId: "operator",
		clientEventId: "original",
		eventKind: "accepted",
		scopeKind: "personal",
		scopeId: "operator",
		surface: "decision_learning",
		occurredAt: new Date().toISOString(),
	});
	const learning = {
		content: "Use the revised guide with verified examples.",
		domain: "guides",
		factType: "technical" as const,
		memoryScope: "org" as const,
		topicKey: "guide",
		metadata: {
			learningFeed: {
				ownerUserId: "operator",
				autoConfirmed: true,
				evidenceEventIds: [eventId],
			},
		},
	};
	const { fact: learned } = await client.learn(learning);
	await client.learn(learning); // Verification counters must not create revisions or records.
	await client.correct({ eventId, clientEventId: crypto.randomUUID() });
	await db.insert(memoryDomains).values({
		id: "guide-detail",
		organizationId,
		name: "examples",
		parentId: learned.domainId,
	});
	const { gapsFound } = await client.gapsDetect({ domain: "guides" });
	expect(gapsFound).toHaveLength(1);
	const gap = gapsFound[0]!;
	await client.gapsResolve({ gapId: gap.id, resolvedByFactId: promoted.id });
	const archivedLesson = await db.query.memoryFacts.findFirst({
		where: { id: learned.id, organizationId },
	});
	expect(archivedLesson?.archivedAt).toBeTruthy();
	expect(archivedLesson?.validTo).toBeTruthy();

	const memory = new OrganizationMemoryAdapter(db, { organizationId });
	for (const [factId, operations] of [
		[promoted.id, ["create", "promote", "supersede"]],
		["previous-guide", ["supersede"]],
		[opinion.id, ["create"]],
		[learned.id, ["create", "archive"]],
		[gap.id, ["create", "archive"]],
	] as const) {
		const history = await memory.history(factId);
		const revisions = history.filter(
			(revision) => revision.provenance.changeRecordId,
		);
		expect(revisions).toHaveLength(operations.length);
		const records = await listChangeRecords(organizationId, {
			resource: `memory:organization:${factId}`,
		});
		expect(records).toHaveLength(operations.length);
		for (const [index, revision] of revisions.entries()) {
			const record = await getChangeRecord(
				organizationId,
				revision.provenance.changeRecordId!,
			);
			expect(record).toMatchObject({
				id: revision.provenance.changeRecordId,
				resource: `memory:organization:${factId}`,
				operation: operations[index],
				outcome: "applied",
				actor: { id: "operator", kind: "user" },
				after: { revisionId: revision.revisionId, hash: revision.hash },
			});
		}
	}
	const previous = await db.query.memoryFacts.findFirst({
		where: { id: "previous-guide", organizationId },
	});
	expect(previous).toMatchObject({
		reviewStatus: "superseded",
		metadata: {
			retained: true,
			invalidationReason: `Superseded by promoted fact ${promoted.id} for topic guide`,
		},
	});
	expect(previous?.validTo).toBeTruthy();
	expect(await memory.history("private-evidence")).toHaveLength(1);
});
