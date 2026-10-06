import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	tediArtifactContributionReceipts,
	tediArtifacts,
	tediRuntimeEvents,
} from "../../schema/cognitive-runtime";
import { sha256Hex } from "@tedix/worker-kit/crypto";

export type TediArtifactContributionReceiptRow =
	typeof tediArtifactContributionReceipts.$inferSelect;
export type RecordTediArtifactContributionReceiptParams = Omit<
	typeof tediArtifactContributionReceipts.$inferInsert,
	"createdAt"
> & { createdAt: string };
export type RecordArtifactContributionReceiptInput =
	RecordTediArtifactContributionReceiptParams & {
		producerEventPayload: Record<string, JsonValue>;
		/** Trusted legacy workstation claim only; all other ownership fields remain exact. */
		allowLegacyNullConversation?: boolean;
	};

export class TediArtifactContributionReceiptConflictError extends Error {
	constructor(readonly receiptId: string) {
		super(
			`Artifact contribution receipt ${receiptId} conflicts with its immutable claim`,
		);
		this.name = "TediArtifactContributionReceiptConflictError";
	}
}

const sameJson = (left: unknown, right: unknown): boolean =>
	JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function hasCanonicalContributionClaim(
	payload: Record<string, JsonValue>,
	input: RecordArtifactContributionReceiptInput,
): boolean {
	const claim = payload.artifactContributionReceipt;
	if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
	const artifactIds = claim.artifactIds;
	return (
		claim.version === 1 &&
		Array.isArray(artifactIds) &&
		artifactIds.every((value) => typeof value === "string") &&
		artifactIds.includes(input.artifactId) &&
		claim.completeness === input.completeness &&
		sameJson(claim.observations, input.observations)
	);
}

export async function recordTediArtifactContributionReceipt(
	db: DbQueryClient,
	input: RecordArtifactContributionReceiptInput,
): Promise<{ receipt: TediArtifactContributionReceiptRow; created: boolean }> {
	if (
		!hasCanonicalContributionClaim(input.producerEventPayload, input) ||
		(await sha256Hex(JSON.stringify(input.observations ?? null))) !==
			input.observationDigest
	) {
		throw new TediArtifactContributionReceiptConflictError(input.id);
	}
	const inserted = await db
		.insert(tediArtifactContributionReceipts)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: tediArtifacts.organizationId.as("organization_id"),
					tediId: tediArtifacts.tediId.as("tedi_id"),
					artifactId: tediArtifacts.id.as("artifact_id"),
					producerRuntimeEventId: tediRuntimeEvents.id.as(
						"producer_runtime_event_id",
					),
					conversationId:
						tediRuntimeEvents.conversationId.as("conversation_id"),
					runId: tediRuntimeEvents.runId.as("run_id"),
					contentDigest: tediArtifacts.contentDigest.as("content_digest"),
					observationDigest: sql<string>`${input.observationDigest}`.as(
						"observation_digest",
					),
					observations: sql`${JSON.stringify(input.observations ?? null)}`.as(
						"observations",
					),
					completeness: sql<
						"observed_prefix" | "unavailable"
					>`${input.completeness}`.as("completeness"),
					createdAt: sql<string>`${input.createdAt}`.as("created_at"),
				})
				.from(tediArtifacts)
				.innerJoin(
					tediRuntimeEvents,
					and(
						eq(tediRuntimeEvents.id, input.producerRuntimeEventId),
						eq(tediRuntimeEvents.organizationId, input.organizationId),
						eq(tediRuntimeEvents.tediId, input.tediId),
						eq(tediRuntimeEvents.conversationId, input.conversationId),
						eq(tediRuntimeEvents.runId, input.runId),
						inArray(tediRuntimeEvents.kind, ["tool.completed", "tool.failed"]),
						eq(tediRuntimeEvents.payload, input.producerEventPayload),
					),
				)
				.where(
					and(
						eq(tediArtifacts.id, input.artifactId),
						eq(tediArtifacts.organizationId, input.organizationId),
						eq(tediArtifacts.tediId, input.tediId),
						input.allowLegacyNullConversation
							? isNull(tediArtifacts.conversationId)
							: eq(tediArtifacts.conversationId, input.conversationId),
						eq(tediArtifacts.runId, input.runId),
						eq(tediArtifacts.contentDigest, input.contentDigest),
						eq(tediArtifacts.accessClassification, "runtime_private"),
						eq(tediArtifacts.publicationState, "ready"),
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	if (inserted[0]) return { receipt: inserted[0], created: true };
	const [canonicalEvent] = await db
		.select({ id: tediRuntimeEvents.id })
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.id, input.producerRuntimeEventId),
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.conversationId, input.conversationId),
				eq(tediRuntimeEvents.runId, input.runId),
				inArray(tediRuntimeEvents.kind, ["tool.completed", "tool.failed"]),
				eq(tediRuntimeEvents.payload, input.producerEventPayload),
			),
		)
		.limit(1);
	if (!canonicalEvent)
		throw new TediArtifactContributionReceiptConflictError(input.id);

	const [existing] = await db
		.select()
		.from(tediArtifactContributionReceipts)
		.where(
			or(
				eq(tediArtifactContributionReceipts.id, input.id),
				eq(tediArtifactContributionReceipts.artifactId, input.artifactId),
			),
		)
		.limit(1);
	if (
		existing &&
		existing.id !== input.id &&
		existing.organizationId === input.organizationId &&
		existing.tediId === input.tediId &&
		existing.artifactId === input.artifactId &&
		existing.conversationId === input.conversationId &&
		existing.runId === input.runId &&
		existing.contentDigest === input.contentDigest
	) {
		// The first serialized production event owns immutable provenance. A later
		// tool observation of the same immutable artifact is acknowledged without
		// replacing it, so the runtime outbox can drain without replaying effects.
		return { receipt: existing, created: false };
	}
	if (
		!existing ||
		existing.organizationId !== input.organizationId ||
		existing.tediId !== input.tediId ||
		existing.artifactId !== input.artifactId ||
		existing.producerRuntimeEventId !== input.producerRuntimeEventId ||
		existing.conversationId !== (input.conversationId ?? null) ||
		existing.runId !== (input.runId ?? null) ||
		existing.contentDigest !== input.contentDigest ||
		existing.observationDigest !== input.observationDigest ||
		!sameJson(existing.observations, input.observations) ||
		existing.completeness !== input.completeness ||
		existing.createdAt !== input.createdAt
	) {
		throw new TediArtifactContributionReceiptConflictError(input.id);
	}
	return { receipt: existing, created: false };
}
