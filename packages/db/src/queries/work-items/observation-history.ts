import { and, asc, eq, gt } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { anyIds } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	workEvents as d1Events,
	workEvidenceVerifications as d1Verifications,
	workItemCorroborations as d1Confirmations,
} from "../../schema/work-items";

import { OBSERVATION_EVENT, OBSERVATION_SCHEMA } from "./observation-ledger";

/** Operator-only copy, before deploying ledger readers. No source rows are changed.
 * Quiesce legacy writers first; keep the source tables until reconciliation and
 * cutover deployment are independently confirmed. Cursors are per org and kind.
 */
export async function migrateWorkObservationHistoryPage(
	db: DbQueryClient,
	p: { orgId: string; kind: "verification" | "confirmation"; after?: string },
) {
	const table = coreTable(
		db,
		p.kind === "verification" ? d1Verifications : d1Confirmations,
	);
	const events = coreTable(db, d1Events);
	const rows = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.orgId, p.orgId),
				p.after ? gt(table.id, p.after) : undefined,
			),
		)
		.orderBy(asc(table.id))
		.limit(25);
	for (const row of rows) {
		await db
			.insert(events)
			.values({
				id: `work-observation:${p.kind}:${row.id}`,
				orgId: row.orgId,
				workItemId: row.workItemId,
				eventType: OBSERVATION_EVENT,
				actorType: "system",
				actorId: "work-observation-migration",
				payload: { schema: OBSERVATION_SCHEMA, kind: p.kind, record: row },
				occurredAt: "observedAt" in row ? row.observedAt : row.occurredAt,
			})
			.onConflictDoNothing({ target: events.id });
	}
	const copied = rows.length
		? await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.orgId, p.orgId),
						anyIds(
							db,
							events.id,
							rows.map((row) => `work-observation:${p.kind}:${row.id}`),
						),
					),
				)
		: [];
	// Compare every field, including nested observations; JSONB reorders keys.
	const canonical = (value: unknown): string =>
		JSON.stringify(value, (_key, v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(
						Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
					)
				: v,
		);
	for (const row of rows) {
		const event = copied.find(
			(event) => event.id === `work-observation:${p.kind}:${row.id}`,
		);
		if (
			!event ||
			event.eventType !== OBSERVATION_EVENT ||
			event.workItemId !== row.workItemId ||
			event.actorType !== "system" ||
			event.actorId !== "work-observation-migration" ||
			event.occurredAt !==
				("observedAt" in row ? row.observedAt : row.occurredAt) ||
			canonical(event.payload) !==
				canonical({ schema: OBSERVATION_SCHEMA, kind: p.kind, record: row })
		)
			throw new Error(
				`Observation history reconciliation failed: ${p.kind}:${row.id}`,
			);
	}
	return {
		checked: rows.length,
		after: rows.at(-1)?.id ?? p.after ?? null,
		done: rows.length < 25,
	};
}
