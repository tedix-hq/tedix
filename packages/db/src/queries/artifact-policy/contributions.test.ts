import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	tediArtifactContributionReceipts,
	tediArtifacts,
	tediRuntimeEvents,
} from "../../schema/cognitive-runtime";
import { organizations } from "../../schema/organizations";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import { tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	recordTediArtifactContributionReceipt,
	TediArtifactContributionReceiptConflictError,
} from "./contributions";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			tediArtifacts,
			tediRuntimeEvents,
			tediArtifactContributionReceipts,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org-1','One','one'), ('org-2','Two','two');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES ('tedi-1','org-1','One','one'), ('tedi-2','org-2','Two','two');
		INSERT INTO tedi_runtime_events (id, organization_id, tedi_id, kind, conversation_id, run_id, payload, runtime_backend, created_at)
		VALUES ('event-1','org-1','tedi-1','tool.completed','conversation-1','run-1','${JSON.stringify(producerPayload).replaceAll("'", "''")}','cloudflare-agents','2026-09-23T00:00:00.000Z'),
		('event-2','org-1','tedi-1','tool.completed','conversation-1','run-1','${JSON.stringify(producerPayload).replaceAll("'", "''")}','cloudflare-agents','2026-09-23T00:00:01.000Z');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const digest = "a".repeat(64);
const observations = [{ source: "connector", ref: "item-1" }];
const producerPayload = {
	artifactContributionReceipt: {
		version: 1,
		artifactIds: ["artifact-1"],
		completeness: "observed_prefix",
		observations,
	},
};
const receipt = {
	id: "event-1:artifact-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	artifactId: "artifact-1",
	producerRuntimeEventId: "event-1",
	conversationId: "conversation-1",
	runId: "run-1",
	contentDigest: digest,
	observationDigest:
		"11dc693cd39da3f38508e1e6748aa93d9c3c533df16f7f03c377447b4f92e0a6",
	observations,
	completeness: "observed_prefix" as const,
	createdAt: "2026-09-23T00:00:00.000Z",
	producerEventPayload: producerPayload,
};

describe("artifact contribution receipts", () => {
	it("binds a null-conversation legacy claim only when the trusted caller explicitly authorizes it", async () => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: null,
			runId: receipt.runId,
			kind: "log",
			name: "workstation_process/job/stdout.log",
			contentDigest: receipt.contentDigest,
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		await expect(
			recordTediArtifactContributionReceipt(db, receipt),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
		await expect(
			recordTediArtifactContributionReceipt(db, {
				...receipt,
				allowLegacyNullConversation: true,
				runId: "different-run",
			}),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
		expect(
			(
				await recordTediArtifactContributionReceipt(db, {
					...receipt,
					allowLegacyNullConversation: true,
				})
			).created,
		).toBe(true);
	});

	it("records one append-only receipt for an exact ready runtime-private artifact and replays exactly", async () => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: receipt.conversationId,
			runId: receipt.runId,
			kind: "file",
			name: "private.txt",
			contentDigest: receipt.contentDigest,
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		expect(
			(await recordTediArtifactContributionReceipt(db, receipt)).created,
		).toBe(true);
		expect(
			(await recordTediArtifactContributionReceipt(db, receipt)).created,
		).toBe(false);
		await expect(
			recordTediArtifactContributionReceipt(db, {
				...receipt,
				observationDigest: "c".repeat(64),
			}),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
	});

	it("rejects an incorrect observation digest before the first insert", async () => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: receipt.conversationId,
			runId: receipt.runId,
			kind: "file",
			name: "private.txt",
			contentDigest: receipt.contentDigest,
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		await expect(
			recordTediArtifactContributionReceipt(db, {
				...receipt,
				observationDigest: "f".repeat(64),
			}),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
		expect(
			await db.select().from(tediArtifactContributionReceipts),
		).toHaveLength(0);
	});

	it.each([
		["cross organization", { organizationId: "org-2" }],
		["cross tedi", { tediId: "tedi-2" }],
		["wrong conversation", { conversationId: "conversation-2" }],
		["wrong run", { runId: "run-2" }],
		["wrong digest", { contentDigest: "c".repeat(64) }],
	])("rejects %s claims", async (_name, patch) => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: receipt.conversationId,
			runId: receipt.runId,
			kind: "file",
			name: "private.txt",
			contentDigest: receipt.contentDigest,
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		await expect(
			recordTediArtifactContributionReceipt(db, { ...receipt, ...patch }),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
	});

	it.each([
		["pending", "runtime_private"],
		["legacy", null],
		["explicit shareable", "explicit_shareable"],
		["source derived", "source_derived"],
	] as const)("rejects %s artifacts", async (state, classification) => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: receipt.conversationId,
			runId: receipt.runId,
			kind: "file",
			name: "private.txt",
			contentDigest: receipt.contentDigest,
			accessClassification: classification,
			publicationState: state === "pending" ? "pending" : "ready",
		});
		await expect(
			recordTediArtifactContributionReceipt(db, receipt),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
	});

	it("preserves the first receipt when a later tool observes the same immutable artifact", async () => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: receipt.conversationId,
			runId: receipt.runId,
			kind: "file",
			name: "private.txt",
			contentDigest: receipt.contentDigest,
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		await recordTediArtifactContributionReceipt(db, receipt);
		const replay = await recordTediArtifactContributionReceipt(db, {
			...receipt,
			id: "other-id",
			producerRuntimeEventId: "event-2",
		});
		expect(replay.created).toBe(false);
		expect(replay.receipt.id).toBe(receipt.id);
	});

	it.each([
		[
			"missing artifact membership",
			{
				...producerPayload,
				artifactContributionReceipt: {
					...producerPayload.artifactContributionReceipt,
					artifactIds: ["other"],
				},
			},
		],
		[
			"different completeness",
			{
				...producerPayload,
				artifactContributionReceipt: {
					...producerPayload.artifactContributionReceipt,
					completeness: "unavailable",
				},
			},
		],
		[
			"different observations",
			{
				...producerPayload,
				artifactContributionReceipt: {
					...producerPayload.artifactContributionReceipt,
					observations: [],
				},
			},
		],
	])("rejects canonical event payloads with %s", async (_name, payload) => {
		const { db } = fixture();
		await db.insert(tediArtifacts).values({
			id: receipt.artifactId,
			organizationId: receipt.organizationId,
			tediId: receipt.tediId,
			conversationId: receipt.conversationId,
			runId: receipt.runId,
			kind: "file",
			name: "private.txt",
			contentDigest: receipt.contentDigest,
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		await expect(
			recordTediArtifactContributionReceipt(db, {
				...receipt,
				producerEventPayload: payload,
			}),
		).rejects.toBeInstanceOf(TediArtifactContributionReceiptConflictError);
	});
});
