import { sql, type SQL } from "drizzle-orm";
import {
	type TediRuntimeEventKind,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";

/**
 * Predicates for `tedi_runtime_events` reads that are already scoped by
 * `tedi_id` (and usually `run_id`).
 *
 * Production `sqlite_stat1` rates `organization_id = ?` at the same ~515 rows
 * as the `(tedi_id, run_id)` prefix, so once a `kind IN (...)` list
 * multiplied the run-and-kind estimate the planner took
 * `idx_tedi_runtime_events_org` and read every event of the tenant (334k
 * rows per call on 23 Oct 2026, the top D1 query by total time). A unary
 * plus keeps the filter but makes the term unusable for an index, which
 * leaves only the tedi-led indexes; with equal estimates SQLite keeps the
 * loop that satisfies more terms, the run index. `INDEXED BY` would need an
 * SQL source in FROM, which the router test fakes cannot dispatch on.
 */
export function unindexedOrganizationId(organizationId: string): SQL {
	return sql`+${tediRuntimeEvents.organizationId} = ${sql.param(
		organizationId,
		tediRuntimeEvents.organizationId,
	)}`;
}

export function unindexedKind(kind: TediRuntimeEventKind): SQL {
	return sql`+${tediRuntimeEvents.kind} = ${sql.param(kind, tediRuntimeEvents.kind)}`;
}

/** Caller guarantees a non-empty subset of the closed kind enum. */
export function unindexedKindIn(kinds: readonly TediRuntimeEventKind[]): SQL {
	return sql`+${tediRuntimeEvents.kind} in (${sql.join(
		kinds.map((kind) => sql.param(kind, tediRuntimeEvents.kind)),
		sql`, `,
	)})`;
}
