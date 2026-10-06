/**
 * Durable workstation coordination.
 *
 * Workstations are Tedix-owned capability environments. Runtime bodies remain
 * replaceable adapters; these rows keep the lease, participants, sessions, and
 * Kernel/work-item linkage durable.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	WORKSTATION_ADAPTER_VALUES,
	WORKSTATION_LEASE_STATUS_VALUES,
	WORKSTATION_PARTICIPANT_STATUS_VALUES,
	WORKSTATION_PROFILE_ID_VALUES,
	WORKSTATION_SEAT_ROLE_VALUES,
	WORKSTATION_SESSION_KIND_VALUES,
	WORKSTATION_STATUS_VALUES,
	type WorkstationAdapter,
	type WorkstationCapability,
	type WorkstationSeat,
	type WorkstationStatus,
} from "@tedix/api-contract/schemas/workstation";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import {
	BODY_GENERATION_STATUS_VALUES,
	BODY_KIND_VALUES,
	tedis,
} from "./tedis";
import { workItems } from "./work-items";

export const workstations = sqliteTable(
	"workstations",
	{
		id: text("id").primaryKey(),
		profileId: text("profile_id", {
			enum: WORKSTATION_PROFILE_ID_VALUES,
		}).notNull(),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		status: text("status", { enum: WORKSTATION_STATUS_VALUES }).notNull(),
		seats: text("seats", { mode: "json" })
			.$type<WorkstationSeat[]>()
			.notNull()
			.default([]),
		capabilities: text("capabilities", { mode: "json" })
			.$type<WorkstationCapability[]>()
			.notNull()
			.default([]),
		adapters: text("adapters", { mode: "json" })
			.$type<WorkstationAdapter[]>()
			.notNull()
			.default([]),
		artifactRefs: text("artifact_refs", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_workstations_org_profile").on(table.orgId, table.profileId),
		index("idx_workstations_status").on(table.status),
	],
);

export type WorkstationRow = typeof workstations.$inferSelect;
export type NewWorkstationRow = typeof workstations.$inferInsert;

export const workstationLeases = sqliteTable(
	"workstation_leases",
	{
		id: text("id").primaryKey(),
		workstationId: text("workstation_id")
			.notNull()
			.references(() => workstations.id, { onDelete: "cascade" }),
		profileId: text("profile_id", {
			enum: WORKSTATION_PROFILE_ID_VALUES,
		}).notNull(),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		workItemId: text("work_item_id").references(() => workItems.id, {
			onDelete: "set null",
		}),
		attemptId: text("attempt_id"),
		repositoryPath: text("repository_path"),
		repoStartSha: text("repo_start_sha"),
		preparedStartSha: text("prepared_start_sha"),
		/**
		 * POLYMORPHIC RUN REFERENCE — deliberately NOT a foreign key.
		 *
		 * The name says "kernel" but the column carries whichever run id the
		 * calling surface had, from two different spaces:
		 *  - the tedi RUNTIME run id, `${tediId}:${surface}:${turnKey}`, joinable
		 *    to `tedi_runtime_events.run_id` (see `buildRunId`);
		 *  - a kernel/Home run UUID, joinable to `kernel_runtime_runs.id`.
		 *
		 * Most values resolve only in `tedi_runtime_events`, some in both, a few
		 * only in `kernel_runtime_runs`, and validation-smoke correlation ids in
		 * neither.
		 *
		 * So the obvious join is a trap. `JOIN kernel_runtime_runs ON id =
		 * kernel_run_id` returns rows, succeeds, and silently covers a fraction of
		 * the table — which reads as "these leases have no run" rather than "you
		 * joined the wrong space". Resolve against `tedi_runtime_events` first,
		 * or accept both.
		 */
		kernelRunId: text("kernel_run_id"),
		traceBundleId: text("trace_bundle_id"),
		status: text("status", { enum: WORKSTATION_LEASE_STATUS_VALUES }).notNull(),
		capabilities: text("capabilities", { mode: "json" })
			.$type<WorkstationCapability[]>()
			.notNull()
			.default([]),
		adapters: text("adapters", { mode: "json" })
			.$type<WorkstationAdapter[]>()
			.notNull()
			.default([]),
		approvalIds: text("approval_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		artifactRefs: text("artifact_refs", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		bodyGenerationId: text("body_generation_id"),
		bodyGenerationKind: text("body_generation_kind", {
			enum: [...BODY_KIND_VALUES],
		}),
		bodyGenerationStatus: text("body_generation_status", {
			enum: [...BODY_GENERATION_STATUS_VALUES],
		}),
		bodyGenerationTokenHash: text("body_generation_token_hash"),
		bodyGenerationTokenExpiresAt: text("body_generation_token_expires_at"),
		bodyGenerationExternalId: text("body_generation_external_id"),
		bodyGenerationHeartbeatAt: text("body_generation_heartbeat_at"),
		/**
		 * CONTAINER IDENTITY — the join from a lease row to a running container.
		 *
		 * Without these, no Cloudflare dashboard row can be mapped to a lease.
		 * Production showed 9 Running `tedi-workstation-v1-production` instances
		 * for one tedi against 5 non-terminal leases, and no operator could say
		 * which instance belonged to which lease, so nothing could be stopped.
		 *
		 * `body_instance_name` is the Sandbox Durable Object NAME — exactly the
		 * string the dashboard prints as the instance. It looks truncated
		 * (`ws_general_<org>_cto_-y4hb4n-we2` for a lease whose workstation id is
		 * `ws_general_<org>_cto_episode_computer-<uuid>`) but Cloudflare did not
		 * truncate it: `workstationSandboxId()` in apps/tedi did, to fit the
		 * Sandbox SDK's 63-character DNS limit, appending an FNV-1a base-36 hash
		 * and the `we2` generation suffix. The dashboard shows our own name
		 * verbatim.
		 *
		 * `body_instance_id` is `DurableObjectNamespace.idFromName(name)` — the
		 * 64-hex id of the object that owns the container, identical to
		 * `this.ctx.id.toString()` inside `TediWorkstationRuntimeSandbox` (which
		 * `computerStatus()` already returns as `workspace`). It is derived, not
		 * allocated, so it is stable for the life of the name.
		 *
		 * Both are recorded, not recomputed at read time: recomputation would
		 * silently follow a future change to the naming function and re-point old
		 * rows at a container they never ran on.
		 */
		bodyInstanceId: text("body_instance_id"),
		bodyInstanceName: text("body_instance_name"),
		bodyInstanceObservedAt: text("body_instance_observed_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		expiresAt: text("expires_at"),
		releasedAt: text("released_at"),
	},
	(table) => [
		index("idx_workstation_leases_workstation").on(table.workstationId),
		index("idx_workstation_leases_org").on(table.orgId),
		index("idx_workstation_leases_kernel_run").on(table.kernelRunId),
		index("idx_workstation_leases_work_item").on(table.workItemId),
		index("idx_workstation_leases_attempt").on(table.attemptId),
		index("idx_workstation_leases_trace_bundle").on(table.traceBundleId),
		index("idx_workstation_leases_status").on(table.status),
		index("idx_workstation_leases_body_generation").on(table.bodyGenerationId),
		index("idx_workstation_leases_body_instance").on(table.bodyInstanceName),
	],
);

export type WorkstationLeaseRow = typeof workstationLeases.$inferSelect;
export type NewWorkstationLeaseRow = typeof workstationLeases.$inferInsert;

export const workstationParticipants = sqliteTable(
	"workstation_participants",
	{
		id: text("id").primaryKey(),
		leaseId: text("lease_id")
			.notNull()
			.references(() => workstationLeases.id, { onDelete: "cascade" }),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		slug: text("slug"),
		role: text("role", { enum: WORKSTATION_SEAT_ROLE_VALUES }).notNull(),
		status: text("status", {
			enum: WORKSTATION_PARTICIPANT_STATUS_VALUES,
		}).notNull(),
		permissionScopes: text("permission_scopes", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		joinedAt: text("joined_at").notNull(),
		leftAt: text("left_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
	},
	(table) => [
		index("idx_workstation_participants_lease").on(table.leaseId),
		index("idx_workstation_participants_tedi").on(table.tediId),
		index("idx_workstation_participants_org").on(table.orgId),
	],
);

export type WorkstationParticipantRow =
	typeof workstationParticipants.$inferSelect;
export type NewWorkstationParticipantRow =
	typeof workstationParticipants.$inferInsert;

export const workstationSessions = sqliteTable(
	"workstation_sessions",
	{
		id: text("id").primaryKey(),
		leaseId: text("lease_id")
			.notNull()
			.references(() => workstationLeases.id, { onDelete: "cascade" }),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		participantId: text("participant_id").references(
			() => workstationParticipants.id,
			{ onDelete: "set null" },
		),
		kind: text("kind", { enum: WORKSTATION_SESSION_KIND_VALUES }).notNull(),
		adapter: text("adapter", { enum: WORKSTATION_ADAPTER_VALUES }).notNull(),
		status: text("status", { enum: WORKSTATION_STATUS_VALUES })
			.$type<WorkstationStatus>()
			.notNull(),
		sessionKey: text("session_key"),
		externalId: text("external_id"),
		artifactRefs: text("artifact_refs", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
	},
	(table) => [
		index("idx_workstation_sessions_lease").on(table.leaseId),
		index("idx_workstation_sessions_participant").on(table.participantId),
		index("idx_workstation_sessions_org").on(table.orgId),
		index("idx_workstation_sessions_kind").on(table.kind),
	],
);

export type WorkstationSessionRow = typeof workstationSessions.$inferSelect;
export type NewWorkstationSessionRow = typeof workstationSessions.$inferInsert;
