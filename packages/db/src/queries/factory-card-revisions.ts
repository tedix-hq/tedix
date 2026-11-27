import { and, desc, eq, sql } from "drizzle-orm";
import { jsonRead } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import { learningInteractionEvents as events } from "../schema/learning-feedback";

export async function listPendingFactoryCardRevisions(
	db: DbQueryClient,
	orgId: string,
	outputId: string,
	personId: string,
) {
	return db
		.select()
		.from(events)
		.where(
			and(
				eq(events.organizationId, orgId),
				eq(events.scopeKind, "personal"),
				eq(events.scopeId, personId),
				eq(events.targetId, outputId),
				sql`${jsonRead(db, events.metadata, ["schema"])}='tedix.factory-card-change.v1'`,
				sql`NOT EXISTS (SELECT 1 FROM learning_interaction_events paired WHERE paired.organization_id=${orgId} AND paired.client_event_id=('factory-card-rewrite:' || ${events.id}))`,
			),
		)
		.orderBy(desc(events.occurredAt))
		.limit(50);
}
