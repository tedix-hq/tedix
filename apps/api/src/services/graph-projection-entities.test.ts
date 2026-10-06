import type { DbClient } from "@tedix/db/client";
import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import { describe, expect, it } from "vite-plus/test";
import {
	graphEntityFromCanonical,
	hydrateMemoryEntityProjectionEvent,
} from "./graph-projection-entities";

function outbox(
	entityKind: "entity" | "entity_resolution",
	entityId: string,
): GraphProjectionOutboxEvent {
	return {
		sequence: 1,
		eventId: `event:${entityKind}:${entityId}`,
		organizationId: "org-1",
		entityKind,
		entityId,
		operation: "upsert",
		payload: null,
		schemaVersion: 1,
		attemptCount: 0,
		nextAttemptAt: null,
		lastError: null,
		poisonedAt: null,
		createdAt: "2026-07-27T00:00:00.000Z",
	};
}

function dbReturning(rows: unknown[]): DbClient {
	const chain: Record<string, unknown> = {};
	chain.from = () => chain;
	chain.innerJoin = () => chain;
	chain.where = () => chain;
	chain.limit = async () => rows;
	return {
		select: () => chain,
	} as unknown as DbClient;
}

describe("memory entity graph projection hydration", () => {
	it("maps canonical entities without granting graph authority", () => {
		expect(
			graphEntityFromCanonical({
				id: "entity-1",
				organizationId: "org-1",
				entityType: "product",
				displayName: "Tedix",
				normalizedName: "tedix",
				status: "active",
				mergedIntoEntityId: null,
				version: 3,
				createdAt: "2026-07-26T00:00:00.000Z",
				updatedAt: "2026-07-27T00:00:00.000Z",
			}),
		).toEqual({
			id: "entity-1",
			orgId: "org-1",
			entityType: "product",
			displayName: "Tedix",
			normalizedName: "tedix",
			status: "active",
			mergedIntoEntityId: null,
			version: 3,
			updatedAt: "2026-07-27T00:00:00.000Z",
		});
	});

	it("hydrates active linked resolutions with mention provenance", async () => {
		const event = outbox("entity_resolution", "resolution-1");
		const hydrated = await hydrateMemoryEntityProjectionEvent(
			dbReturning([
				{
					id: "resolution-1",
					organizationId: "org-1",
					mentionId: "mention-1",
					entityId: "entity-1",
					decisionId: "decision-1",
					resolutionKind: "linked",
					status: "active",
					confidence: 0.94,
					validFrom: "2026-07-27T00:00:00.000Z",
					validTo: null,
					sourceFactId: "fact-1",
				},
			]),
			event,
		);

		expect(hydrated).toEqual({
			op: "upsert_entity_resolution",
			id: "resolution-1",
			orgId: "org-1",
			timestamp: Date.parse(event.createdAt),
			payload: {
				id: "resolution-1",
				orgId: "org-1",
				mentionId: "mention-1",
				factId: "fact-1",
				entityId: "entity-1",
				decisionId: "decision-1",
				confidence: 0.94,
				validFrom: "2026-07-27T00:00:00.000Z",
				validTo: null,
				status: "active",
			},
		});
	});

	it("skips unresolved state but preserves revoked temporal history", async () => {
		const event = outbox("entity_resolution", "resolution-2");
		const unresolved = await hydrateMemoryEntityProjectionEvent(
			dbReturning([
				{
					id: "resolution-2",
					organizationId: "org-1",
					mentionId: "mention-2",
					entityId: null,
					decisionId: "decision-2",
					resolutionKind: "unresolved",
					status: "active",
					confidence: 1,
					validFrom: event.createdAt,
					validTo: null,
					sourceFactId: null,
				},
			]),
			event,
		);
		const revoked = await hydrateMemoryEntityProjectionEvent(
			dbReturning([
				{
					id: "resolution-2",
					organizationId: "org-1",
					mentionId: "mention-2",
					entityId: "entity-2",
					decisionId: "decision-2",
					resolutionKind: "linked",
					status: "revoked",
					confidence: 1,
					validFrom: event.createdAt,
					validTo: event.createdAt,
					sourceFactId: null,
				},
			]),
			event,
		);

		expect(unresolved).toBeNull();
		expect(revoked).toMatchObject({
			op: "upsert_entity_resolution",
			id: "resolution-2",
			payload: {
				entityId: "entity-2",
				status: "revoked",
				validTo: event.createdAt,
			},
		});
	});
});
