import { and, notExists, sql, type SQLWrapper } from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { workEvents } from "../../schema/work-items";

export const OBSERVATION_EVENT = "work.observation_recorded";
export const OBSERVATION_SCHEMA = "tedix.work-observation.v1";

type EventColumns = {
	[
		K in
			| "payload"
			| "eventType"
			| "orgId"
			| "workItemId"
			| "sequence"
			| "actorType"
			| "actorId"
	]: SQLWrapper;
};

/** Comments and arbitrary comment metadata never enter this credential-derived ledger. */
export function observationEvent(
	db: DbQueryClient,
	event: EventColumns,
	kind: "verification" | "confirmation",
) {
	return sql`${event.eventType}=${OBSERVATION_EVENT}
		AND ${jsonRead(db, event.payload, ["schema"])}=${OBSERVATION_SCHEMA}
		AND ${jsonRead(db, event.payload, ["kind"])}=${kind}
		AND ${jsonRead(db, event.payload, ["record", "orgId"])}=${event.orgId}
		AND ${jsonRead(db, event.payload, ["record", "workItemId"])}=${event.workItemId}
		AND ((${event.actorType}='system' AND ${event.actorId}='work-observation-migration')
		 OR (${kind}='confirmation'
		 AND ((${event.actorType}=${jsonRead(db, event.payload, ["record", "principalType"])}
		 AND ${event.actorId}=${jsonRead(db, event.payload, ["record", "principalId"])} )
		 OR (${event.actorType}='system' AND ${jsonRead(db, event.payload, ["record", "principalType"])}='organization'
		 AND ${event.actorId}='organization:' || (${jsonRead(db, event.payload, ["record", "principalId"])})))))`;
}

/** Append-only corrections keep history; only the latest principal stance is current. */
export function currentConfirmationEvent(
	db: DbQueryClient,
	event: EventColumns,
) {
	const table = coreTable(db, workEvents);
	const newer =
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)(table, "newer_confirmation")
			: sqliteAlias(table, "newer_confirmation");
	return and(
		observationEvent(db, event, "confirmation"),
		notExists(
			db
				.select({ one: sql`1` })
				.from(newer)
				.where(
					and(
						observationEvent(db, newer, "confirmation"),
						sql`${newer.orgId}=${event.orgId} AND ${newer.workItemId}=${event.workItemId} AND ${newer.sequence}>${event.sequence}`,
						sql`${jsonRead(db, newer.payload, ["record", "principalType"])}=${jsonRead(db, event.payload, ["record", "principalType"])}`,
						sql`${jsonRead(db, newer.payload, ["record", "principalId"])}=${jsonRead(db, event.payload, ["record", "principalId"])}`,
					),
				),
		),
	);
}
