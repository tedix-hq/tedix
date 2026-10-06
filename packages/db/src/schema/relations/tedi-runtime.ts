/**
 * Drizzle Relations v2: tedi-runtime domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const tediRuntimeRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// TEDI RUNTIME OPS (per-turn hot path: events, artifacts, leases, crons)
	// =========================================================================

	// The turn ledger behind idx_tedi_runtime_events_run_created — the hottest
	// D1 read on the platform. conversationId/runId are runtime-minted strings
	// with no D1 row of their own (tedi runs are not projected into a table the
	// way kernel runs are), so they are deliberately left unrelated; scope by
	// tedi + runId instead, which is exactly what the covering index serves.
	tediRuntimeEvents: {
		organization: r.one.organizations({
			from: r.tediRuntimeEvents.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediRuntimeEvents.tediId,
			to: r.tedis.id,
		}),
		// ORM-level: artifactId is a plain column (no .references()) carrying the
		// id of the artifact an artifact-kind event announced. Backed by the
		// tedi_artifacts primary key, same precedent as workItems.parent.
		artifact: r.one.tediArtifacts({
			from: r.tediRuntimeEvents.artifactId,
			to: r.tediArtifacts.id,
		}),
		// ORM-level for the same reason: approval events carry the canonical
		// tedi_approval_requests id, backed by that table's primary key.
		approvalRequest: r.one.tediApprovalRequests({
			from: r.tediRuntimeEvents.approvalRequestId,
			to: r.tediApprovalRequests.id,
		}),
	},

	tediArtifacts: {
		organization: r.one.organizations({
			from: r.tediArtifacts.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediArtifacts.tediId,
			to: r.tedis.id,
		}),
		// Reverse of tediRuntimeEvents.artifact: the events that announced it.
		events: r.many.tediRuntimeEvents({
			from: r.tediArtifacts.id,
			to: r.tediRuntimeEvents.artifactId,
		}),
	},

	// Bounded coordination keyspace: one row per (tedi, lease name), no org
	// column — the tedi is the only scope the lease is taken under.
	tediRuntimeLeases: {
		tedi: r.one.tedis({
			from: r.tediRuntimeLeases.tediId,
			to: r.tedis.id,
		}),
	},

	// One row per cron fire, keyed (tediId, fireKey). runId is the runtime's
	// `{tediId}:cron:{turnKey}` string, not an id into any table, so it stays
	// unrelated for the same reason as tediRuntimeEvents.runId.
	tediCronExecutions: {
		organization: r.one.organizations({
			from: r.tediCronExecutions.orgId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediCronExecutions.tediId,
			to: r.tedis.id,
		}),
	},
}));
