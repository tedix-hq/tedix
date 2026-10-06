/**
 * Entity-specific D1 hydration for the durable graph-projection drain.
 *
 * The generic drain owns cursoring, retry, poison handling, and all Neo4j
 * writes. This extension only reads canonical D1 state and builds projection
 * events; it never performs a best-effort graph write from the request path.
 */

import type { DbClient } from "@tedix/db/client";
import {
	getMemoryEntityProjection,
	getMemoryEntityResolutionProjection,
	type MemoryEntityProjection,
	type MemoryEntityResolutionProjection,
} from "@tedix/db/queries/graph-projection-entities";
import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import type {
	GraphEntity,
	GraphEntityResolution,
	SyncEvent,
} from "../integrations/graph-db/types";
import type { GraphProjectionExtensionHydrator } from "./graph-projection-drain";

export function graphEntityFromCanonical(
	entity: MemoryEntityProjection,
): GraphEntity {
	return {
		id: entity.id,
		orgId: entity.organizationId,
		entityType: entity.entityType,
		displayName: entity.displayName,
		normalizedName: entity.normalizedName,
		status: entity.status,
		mergedIntoEntityId: entity.mergedIntoEntityId ?? null,
		version: entity.version,
		updatedAt: entity.updatedAt,
	};
}

export function graphEntityResolutionFromCanonical(
	resolution: MemoryEntityResolutionProjection & { entityId: string },
): GraphEntityResolution {
	return {
		id: resolution.id,
		orgId: resolution.organizationId,
		mentionId: resolution.mentionId,
		factId: resolution.sourceFactId,
		entityId: resolution.entityId,
		decisionId: resolution.decisionId,
		confidence: resolution.confidence,
		validFrom: resolution.validFrom,
		validTo: resolution.validTo,
		status: resolution.status,
	};
}

function syncEvent(
	event: GraphProjectionOutboxEvent,
	op: "upsert_entity" | "upsert_entity_resolution",
	payload: GraphEntity | GraphEntityResolution,
): SyncEvent {
	return {
		op,
		id: event.entityId,
		orgId: event.organizationId,
		timestamp: Date.parse(event.createdAt) || Date.now(),
		payload,
	} as SyncEvent;
}

/**
 * Hydrate only entity projection kinds. Linked resolutions remain projected
 * after revocation so their canonical validity interval survives a full
 * repair. Unresolved rows have no entity relationship and therefore remain
 * outside the Neo4j projection.
 */
export const hydrateMemoryEntityProjectionEvent: GraphProjectionExtensionHydrator =
	async (
		db: DbClient,
		event: GraphProjectionOutboxEvent,
	): Promise<SyncEvent | null> => {
		if (event.entityKind === "entity") {
			const entity = await getMemoryEntityProjection(db, {
				entityId: event.entityId,
				organizationId: event.organizationId,
			});
			return entity
				? syncEvent(event, "upsert_entity", graphEntityFromCanonical(entity))
				: null;
		}

		if (event.entityKind === "entity_resolution") {
			const row = await getMemoryEntityResolutionProjection(db, {
				resolutionId: event.entityId,
				organizationId: event.organizationId,
			});
			if (row?.resolutionKind !== "linked" || !row.entityId) {
				return null;
			}
			return syncEvent(
				event,
				"upsert_entity_resolution",
				graphEntityResolutionFromCanonical({
					...row,
					entityId: row.entityId,
				}),
			);
		}

		return null;
	};
