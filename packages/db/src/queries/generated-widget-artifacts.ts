import type { TediArtifact } from "@tedix/api-contract/schemas/cognitive-runtime";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { tediArtifacts, tediRuntimeEvents } from "../schema/cognitive-runtime";
import { generatedWidgetArtifacts } from "../schema/generated-widget-artifacts";
import { tedis } from "../schema/tedis";
import { toJsonRecord } from "../utils/json";

export type GeneratedWidgetArtifactRow =
	typeof generatedWidgetArtifacts.$inferSelect;
export type NewGeneratedWidgetArtifact =
	typeof generatedWidgetArtifacts.$inferInsert;

export async function createGeneratedWidgetArtifact(
	db: DbClient,
	value: NewGeneratedWidgetArtifact,
): Promise<void> {
	await db.insert(generatedWidgetArtifacts).values(value);
}

export async function getGeneratedWidgetArtifact(
	db: DbClient,
	input: { organizationId: string; id: string },
): Promise<GeneratedWidgetArtifactRow | undefined> {
	const [row] = await db
		.select()
		.from(generatedWidgetArtifacts)
		.where(
			and(
				eq(generatedWidgetArtifacts.id, input.id),
				eq(generatedWidgetArtifacts.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row;
}

export async function listGeneratedWidgetArtifacts(
	db: DbClient,
	input: {
		organizationId: string;
		appId?: string;
		appSlug?: string;
		status?: GeneratedWidgetArtifactRow["status"];
		kind?: GeneratedWidgetArtifactRow["kind"];
		source?: GeneratedWidgetArtifactRow["source"];
		toolId?: string;
		limit: number;
		offset: number;
	},
): Promise<GeneratedWidgetArtifactRow[]> {
	const conditions: SQL[] = [
		eq(generatedWidgetArtifacts.organizationId, input.organizationId),
	];
	if (input.appId)
		conditions.push(eq(generatedWidgetArtifacts.appId, input.appId));
	if (input.appSlug)
		conditions.push(eq(generatedWidgetArtifacts.appSlug, input.appSlug));
	if (input.status)
		conditions.push(eq(generatedWidgetArtifacts.status, input.status));
	if (input.kind)
		conditions.push(eq(generatedWidgetArtifacts.kind, input.kind));
	if (input.source)
		conditions.push(eq(generatedWidgetArtifacts.source, input.source));
	if (input.toolId)
		conditions.push(eq(generatedWidgetArtifacts.toolId, input.toolId));
	return db
		.select()
		.from(generatedWidgetArtifacts)
		.where(and(...conditions))
		.orderBy(desc(generatedWidgetArtifacts.createdAt))
		.limit(input.limit)
		.offset(input.offset);
}

export async function updateGeneratedWidgetArtifact(
	db: DbClient,
	input: {
		organizationId: string;
		id: string;
		patch: Partial<NewGeneratedWidgetArtifact>;
	},
): Promise<GeneratedWidgetArtifactRow | undefined> {
	await db
		.update(generatedWidgetArtifacts)
		.set({ ...input.patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(generatedWidgetArtifacts.id, input.id),
				eq(generatedWidgetArtifacts.organizationId, input.organizationId),
			),
		);
	return getGeneratedWidgetArtifact(db, input);
}

export async function upsertGeneratedWidgetTediArtifact(
	db: DbClient,
	input: {
		organizationId: string;
		artifact: TediArtifact;
		eventId: string;
		externalId: string;
	},
): Promise<boolean> {
	const [tedi] = await db
		.select({ id: tedis.id })
		.from(tedis)
		.where(
			and(
				eq(tedis.id, input.artifact.tediId),
				eq(tedis.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!tedi) return false;
	const [existing] = await db
		.select({ organizationId: tediArtifacts.organizationId })
		.from(tediArtifacts)
		.where(eq(tediArtifacts.id, input.artifact.id))
		.limit(1);
	if (existing) return false;
	const artifact = input.artifact;
	const artifactMetadata = artifact.metadata
		? toJsonRecord(artifact.metadata)
		: artifact.metadata;
	const inserted = await db
		.insert(tediArtifacts)
		.values({
			id: artifact.id,
			tediId: artifact.tediId,
			conversationId: artifact.conversationId,
			runId: artifact.runId,
			messageId: artifact.messageId,
			kind: artifact.kind,
			name: artifact.name,
			mimeType: artifact.mimeType,
			uri: artifact.uri,
			sizeBytes: artifact.sizeBytes,
			createdAt: artifact.createdAt,
			metadata: artifactMetadata,
			organizationId: input.organizationId,
			accessClassification: "runtime_private",
			publicationState: "ready",
		})
		.onConflictDoNothing({ target: tediArtifacts.id })
		.returning({ id: tediArtifacts.id });
	// The generated-widget record remains the mutable workflow projection. Its
	// first artifact snapshot is immutable; later status revisions must not
	// rewrite bytes/metadata behind that artifact id.
	if (inserted.length !== 1) return false;
	const safeArtifact = {
		...artifact,
		uri: undefined,
		metadata: undefined,
		accessClassification: "runtime_private" as const,
	};
	await db
		.insert(tediRuntimeEvents)
		.values({
			id: input.eventId,
			organizationId: input.organizationId,
			tediId: artifact.tediId,
			kind: "artifact.created",
			conversationId: artifact.conversationId,
			runId: artifact.runId,
			messageId: artifact.messageId,
			artifactId: artifact.id,
			payload: toJsonRecord({ artifact: safeArtifact }),
			runtimeBackend: "custom",
			runtimeExternalId: input.externalId,
			runtimeMetadata: {
				generatedWidgetArtifactId: input.externalId,
				source: "generatedWidgetArtifacts",
			},
			createdAt: new Date().toISOString(),
		})
		.onConflictDoNothing({ target: tediRuntimeEvents.id });
	return true;
}
