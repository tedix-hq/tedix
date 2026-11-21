import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { onTestFinished } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import {
	memoryFactCitations,
	memoryFactCitationBackfills,
} from "@tedix/db/schema/memory-fact-citations";
import { gatewayChangeRecords } from "@tedix/db/schema/gateway-change-records";
import { OrganizationMemoryAdapter } from "@tedix/db/queries/memory-graph/memory-adapter";
import {
	getChangeRecord,
	listChangeRecords,
} from "../../services/organization-log";
import type { BaseContext } from "../orpc";
import { review } from "./memory-graph/review-reasoning";
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
		schemaDdl(
			memoryFacts,
			memoryFactCitations,
			memoryFactCitationBackfills,
			gatewayChangeRecords,
		),
	);
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
		db,
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
		await listChangeRecords(db, organizationId, {
			resource: `memory:organization:${fact.id}`,
		}),
	).toEqual([record]);
});
