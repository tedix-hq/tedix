/**
 * Tedi Query Helpers
 * Database queries for tedi instance management
 *
 * Tedis are durable worker identities with runtime profiles and body adapters.
 * Each tedi belongs to an organization for multi-tenant isolation.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { runtimeProfiles } from "../schema/control-plane";
import { tediRoleAssignments } from "../schema/earned-delegation";
import {
	type BackupHandles,
	type NewTedi,
	type NewTediCustomDomain,
	type NewTediRuntimeSnapshot,
	type NewTediUsageEvent,
	type RuntimeState,
	type Tedi,
	type TediCustomDomain,
	type TediDevice,
	type TediRuntimeSnapshot,
	type TediStatus,
	type TediUsageEvent,
	tediCustomDomains,
	tediDevices,
	tediRuntimeLeases,
	tediRuntimeSnapshots,
	tedis,
	tediUsageEvents,
} from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";
import { getAffectedRows } from "../utils/d1-result";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * List tedis whose assigned runtime profile sets `runtimePolicy.alwaysOn=true`.
 *
 * Used by the keepalive cron in apps/api to wake any always-on tedi that
 * Cloudflare Sandbox has reaped (max_instances cap, placement migration,
 * region resync — anything that bypasses keepAlive). Returns id + slug only;
 * the cron probes health and calls TEDI_SERVICE.fetch to wake.
 *
 * Filters on the JSON path `runtime_profiles.config.runtimePolicy.alwaysOn`
 * via D1's `json_extract`. Tedis without an assigned profile (FK NULL) are
 * excluded, and so are retired tedis — retirement keeps the row (and its
 * memory) alive, so without this predicate the keepalive cron would keep
 * resurrecting workers their organization has already retired.
 */
export async function getAlwaysOnTedis(
	db: DbClient,
): Promise<Array<{ id: string; slug: string }>> {
	const rows = await db
		.select({ id: tedis.id, slug: tedis.slug })
		.from(tedis)
		.innerJoin(runtimeProfiles, eq(tedis.runtimeProfileId, runtimeProfiles.id))
		.where(
			and(
				sql`json_extract(${runtimeProfiles.config}, '$.runtimePolicy.alwaysOn') = 1`,
				isNull(tedis.retiredAt),
			),
		);
	return rows;
}

export interface TryAcquireTediRuntimeLeaseParams {
	tediId: string;
	name: string;
	owner: string;
	ttlMs: number;
	nowMs?: number;
}

/**
 * Try to acquire a short-lived per-tedi runtime lease.
 *
 * This is an atomic D1 lease for cross-isolate coordination. It intentionally
 * does not release early; callers should choose a small TTL that represents the
 * desired debounce window. Expired rows are updated in place.
 */
export async function tryAcquireTediRuntimeLease(
	db: DbClient,
	params: TryAcquireTediRuntimeLeaseParams,
): Promise<boolean> {
	const nowMs = params.nowMs ?? Date.now();
	const expiresAt = nowMs + params.ttlMs;
	const leaseId = `${params.tediId}:${params.name}`;
	const values = {
		id: leaseId,
		tediId: params.tediId,
		name: params.name,
		owner: params.owner,
		expiresAt,
	};

	try {
		const insertResult = await db.insert(tediRuntimeLeases).values(values);
		if (getAffectedRows(insertResult) !== 0) return true;
	} catch {
		// Most insert failures here are duplicate-key races. Let the conditional
		// expired-row update below decide whether this caller may take over.
	}

	const updateResult = await db
		.update(tediRuntimeLeases)
		.set({
			owner: params.owner,
			expiresAt,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(tediRuntimeLeases.id, leaseId),
				sql`${tediRuntimeLeases.expiresAt} <= ${nowMs}`,
			),
		);
	return getAffectedRows(updateResult) !== 0;
}

export interface ReleaseTediRuntimeLeaseParams {
	tediId: string;
	name: string;
	owner?: string;
}

/**
 * Release a per-tedi runtime lease held by the caller.
 *
 * Startup coordination needs a real critical section rather than a pure debounce:
 * a successful gateway start must not block a later recovery until the original
 * TTL expires. When `owner` is provided, only that caller's lease is removed.
 */
export async function releaseTediRuntimeLease(
	db: DbClient,
	params: ReleaseTediRuntimeLeaseParams,
): Promise<void> {
	const leaseId = `${params.tediId}:${params.name}`;
	await db
		.delete(tediRuntimeLeases)
		.where(
			params.owner
				? and(
						eq(tediRuntimeLeases.id, leaseId),
						eq(tediRuntimeLeases.owner, params.owner),
					)
				: eq(tediRuntimeLeases.id, leaseId),
		);
}

/**
 * List an organization's live tedis.
 *
 * Retired tedis are excluded by default. Retirement is a soft delete — the row
 * (and every tediId-scoped cognitive table hanging off it) stays in D1 — so
 * every caller that means "the workers this org currently operates" must not
 * see them. Pass `includeRetired` only for recovery/audit reads that
 * deliberately want the retired estate.
 */
export async function getTedisByOrganization(
	db: DbClient,
	organizationId: string,
	options?: { includeRetired?: boolean },
): Promise<Tedi[]> {
	return db
		.select()
		.from(tedis)
		.where(
			options?.includeRetired
				? eq(tedis.organizationId, organizationId)
				: and(
						eq(tedis.organizationId, organizationId),
						isNull(tedis.retiredAt),
					),
		);
}

/** Complete tenant-scoped roster search with a bounded page and matching total. */
export async function listTediRoster(
	db: DbClient,
	options: {
		organizationId: string;
		limit: number;
		offset: number;
		search?: string;
		status?: TediStatus | "unknown";
		includeRetired?: boolean;
	},
): Promise<{ data: Tedi[]; total: number }> {
	const conditions: SQL[] = [
		eq(tedis.organizationId, options.organizationId),
		options.includeRetired
			? isNotNull(tedis.retiredAt)
			: isNull(tedis.retiredAt),
	];
	if (options.status) {
		conditions.push(
			options.status === "unknown"
				? isNull(tedis.status)
				: eq(tedis.status, options.status),
		);
	}
	for (const term of options.search?.trim().split(/\s+/).filter(Boolean) ??
		[]) {
		const matchingRole = db
			.select({ id: tediRoleAssignments.id })
			.from(tediRoleAssignments)
			.where(
				and(
					eq(tediRoleAssignments.organizationId, options.organizationId),
					eq(tediRoleAssignments.tediId, tedis.id),
					eq(tediRoleAssignments.status, "active"),
					or(
						sql`instr(lower(${tediRoleAssignments.roleName}), lower(${term})) > 0`,
						sql`instr(lower(${tediRoleAssignments.careerStage}), lower(${term})) > 0`,
					),
				),
			);
		conditions.push(
			or(
				sql`instr(lower(${tedis.displayName}), lower(${term})) > 0`,
				sql`instr(lower(${tedis.name}), lower(${term})) > 0`,
				sql`instr(lower(${tedis.slug}), lower(${term})) > 0`,
				sql`instr(lower(${tedis.personality}), lower(${term})) > 0`,
				exists(matchingRole),
			)!,
		);
	}
	const where = and(...conditions);
	const data = await db
		.select()
		.from(tedis)
		.where(where)
		.orderBy(
			options.includeRetired ? desc(tedis.retiredAt) : asc(tedis.slug),
			asc(tedis.id),
		)
		.limit(options.limit)
		.offset(options.offset);
	const total = await db.$count(tedis, where);
	return { data, total };
}

/**
 * List an organization's retired tedis, newest retirement first.
 *
 * This is the read that makes the retention claim checkable: a retired worker's
 * memory, rationale, skills, artifacts and growth history are still in D1 keyed
 * by this `id`, and `retiredSlug` is the name it answered to before retirement
 * renamed `slug` to free the unique namespace.
 */
export async function listRetiredTedisByOrganization(
	db: DbClient,
	organizationId: string,
): Promise<Tedi[]> {
	return db
		.select()
		.from(tedis)
		.where(
			and(
				eq(tedis.organizationId, organizationId),
				sql`${tedis.retiredAt} IS NOT NULL`,
			),
		)
		.orderBy(desc(tedis.retiredAt));
}

/** Bounded identity/display projection for an org-scoped set of tedis. */
export async function listTediDisplayNamesByIds(
	db: DbClient,
	input: { organizationId: string; ids: string[] },
): Promise<Array<Pick<Tedi, "id" | "name" | "displayName" | "slug">>> {
	if (input.ids.length === 0) return [];
	const rows: Array<Pick<Tedi, "id" | "name" | "displayName" | "slug">> = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(input.ids)], 50)) {
		rows.push(
			...(await db
				.select({
					id: tedis.id,
					name: tedis.name,
					displayName: tedis.displayName,
					slug: tedis.slug,
				})
				.from(tedis)
				.where(
					and(
						eq(tedis.organizationId, input.organizationId),
						inArray(tedis.id, chunk),
					),
				)),
		);
	}
	return rows;
}

/**
 * Get tedi by ID.
 *
 * Deliberately resolves retired tedis too. Retirement keeps the worker's
 * memory, rationale and artifacts in D1; audit reads, the retired-estate list
 * and any future restore all need the parent row to still be reachable by id.
 * Callers that must not act on a retired worker check `retiredAt`.
 */
export async function getTediById(
	db: DbClient,
	tediId: string,
): Promise<Tedi | undefined> {
	const [row] = await db
		.select()
		.from(tedis)
		.where(eq(tedis.id, tediId))
		.limit(1);
	return row;
}

/** Resolve a tedi only inside the caller's organization boundary. */
export async function getTediByIdForOrganization(
	db: DbClient,
	tediId: string,
	organizationId: string,
): Promise<Tedi | undefined> {
	return db.query.tedis.findFirst({
		where: { id: tediId, organizationId },
	});
}

/**
 * Resolve the live tedi behind a Descope user ID.
 *
 * Retirement purges the Descope identity but leaves `descope_user_id` on the
 * retired row as evidence of who the worker was. Excluding retired rows keeps a
 * recycled Descope subject from ever authenticating as the retired worker.
 */
export async function getTediByDescopeUserId(
	db: DbClient,
	descopeUserId: string,
): Promise<Tedi | undefined> {
	return db.query.tedis.findFirst({
		where: { descopeUserId, retiredAt: { isNull: true } },
	});
}

/**
 * Get only the organizationId for a tedi (lightweight ownership check)
 */
export async function getTediOrganizationId(
	db: DbClient,
	tediId: string,
): Promise<string | undefined> {
	const result = await db.query.tedis.findFirst({
		where: { id: tediId },
		columns: { organizationId: true },
	});
	return result?.organizationId;
}

/**
 * Get tedi by slug within an organization
 */
export async function getTediBySlug(
	db: DbClient,
	organizationId: string,
	slug: string,
): Promise<Tedi | undefined> {
	return db.query.tedis.findFirst({ where: { organizationId, slug } });
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new tedi
 */
export async function createTedi(db: DbClient, data: NewTedi): Promise<Tedi> {
	const results = await db.insert(tedis).values(data).returning();
	return results[0]!;
}

/**
 * Update a tedi
 */
export async function updateTedi(
	db: DbClient,
	tediId: string,
	data: Partial<Omit<NewTedi, "id" | "organizationId">>,
): Promise<Tedi | undefined> {
	const results = await db
		.update(tedis)
		.set({
			...data,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId))
		.returning();
	return results[0];
}

export interface RetireTediParams {
	tediId: string;
	/** ISO-8601 retirement stamp recorded on the row. */
	retiredAt: string;
}

/**
 * Retire a tedi — the non-destructive replacement for `deleteTedi` on the
 * ordinary `tedis.delete` path.
 *
 * Every tediId-scoped table is `ON DELETE CASCADE`, so removing the row erases
 * the worker's memory_facts, tedi_rationale_records, tedi_artifacts,
 * tedi_runtime_events, skill_entries/skill_runs, tedi_expertise,
 * tedi_growth_snapshots and tedi_entrustment_grants — the customer-owned
 * cognitive state the product promises survives. Retiring keeps the parent row
 * so the cascade never fires.
 *
 * One conditional UPDATE, not a transaction (D1 rejects BEGIN): the
 * `retired_at IS NULL` predicate makes this a CAS, so a concurrent or repeated
 * retire returns `undefined` instead of overwriting the first retirement stamp
 * or double-renaming the slug. It performs four things at once:
 *
 * 1. stamps `retired_at` and preserves the pre-retirement name in
 *    `retired_slug`;
 * 2. renames `slug` to `<slug>-retired-<tediId>` — both slug uniques are
 *    permanent, and the retired row would otherwise hold the org's chosen name
 *    forever. The tedi id makes the new value collision-free, and the caller
 *    has already purged the `tedi:{slug}` Descope login, so nothing external
 *    still depends on the old value;
 * 3. pins `isolate_agent_id` to the pre-retirement slug when it was null.
 *    `getTediAgentIdBySlug` derives the Durable Object instance name as
 *    `coalesce(isolate_agent_id, slug)`, so without this the rename would
 *    silently repoint the worker at a different, empty DO and strand its
 *    runtime state;
 * 4. parks the runtime at `status='paused'` + `runtime_state='archived'`, the
 *    same reversible stage-1 posture `tedis.decommission` already applies.
 */
export async function retireTedi(
	db: DbClient,
	params: RetireTediParams,
): Promise<Tedi | undefined> {
	const results = await db
		.update(tedis)
		.set({
			retiredAt: params.retiredAt,
			retiredSlug: sql`${tedis.slug}`,
			slug: sql`${tedis.slug} || '-retired-' || ${tedis.id}`,
			isolateAgentId: sql`coalesce(${tedis.isolateAgentId}, ${tedis.slug})`,
			status: "paused",
			runtimeState: "archived",
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(and(eq(tedis.id, params.tediId), isNull(tedis.retiredAt)))
		.returning();
	return results[0];
}

/**
 * Hard-delete a tedi row and everything the FK cascade takes with it.
 *
 * IRREVERSIBLE and memory-destroying: this is the purge primitive, reachable
 * only through `tedis.decommission` with `hardPurge` + a matching `confirmSlug`.
 * The ordinary `tedis.delete` path uses `retireTedi` instead.
 */
export async function deleteTedi(db: DbClient, tediId: string): Promise<void> {
	await db.delete(tedis).where(eq(tedis.id, tediId));
}

/**
 * Update tedi heartbeat (called by tedi Workers)
 */
export async function updateTediHeartbeat(
	db: DbClient,
	tediId: string,
	data: {
		runtimeStatus: string;
		lastSyncAt: string | null;
		billingState?: "cold" | "warm" | "active";
		observedAt?: string;
		preserveFreshStart?: boolean;
	},
): Promise<void> {
	const observedAt = data.observedAt ?? new Date().toISOString();
	const runtimeStatus =
		data.runtimeStatus === "stopped" || data.runtimeStatus === "not_running"
			? "sleeping"
			: data.runtimeStatus;
	const demotesRuntime =
		runtimeStatus === "sleeping" ||
		runtimeStatus === "unknown" ||
		runtimeStatus === "error";

	await db
		.update(tedis)
		.set({
			runtimeStatus: runtimeStatus as Tedi["runtimeStatus"],
			lastSyncAt: data.lastSyncAt,
			lastSeenAt: new Date().toISOString(),
			...(data.billingState ? { billingState: data.billingState } : {}),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(tedis.id, tediId),
				data.preserveFreshStart && demotesRuntime
					? sql`NOT (
							${tedis.runtimeStatus} IN ('running', 'starting')
							AND ${tedis.lastSeenAt} IS NOT NULL
							AND unixepoch(replace(${tedis.lastSeenAt}, 'T', ' ')) > unixepoch(replace(${observedAt}, 'T', ' '))
						)`
					: sql`1 = 1`,
			),
		);
}

/**
 * Store backup handles directly on the tedis table (apps/tedi writes this).
 */
export async function updateTediBackupHandles(
	db: DbClient,
	tediId: string,
	backupHandles: BackupHandles,
): Promise<void> {
	await db
		.update(tedis)
		.set({
			lastBackupHandles: backupHandles,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Load backup handles from the tedis table (for cold start restore).
 */
export async function getTediBackupHandles(
	db: DbClient,
	tediId: string,
): Promise<BackupHandles | null> {
	const results = await db
		.select({ lastBackupHandles: tedis.lastBackupHandles })
		.from(tedis)
		.where(eq(tedis.id, tediId))
		.limit(1);
	return results[0]?.lastBackupHandles ?? null;
}

// ============================================================================
// Device Operations
// ============================================================================

/**
 * List devices for a tedi, grouped by status
 */
export async function getDevicesByTedi(
	db: DbClient,
	tediId: string,
): Promise<{ pending: TediDevice[]; paired: TediDevice[] }> {
	const devices = await db
		.select()
		.from(tediDevices)
		.where(eq(tediDevices.tediId, tediId));

	return {
		pending: devices.filter((d) => d.status === "pending"),
		paired: devices.filter((d) => d.status === "paired"),
	};
}

/**
 * Get a device by ID
 */
export async function getDeviceById(
	db: DbClient,
	deviceId: string,
): Promise<TediDevice | undefined> {
	return db.query.tediDevices.findFirst({ where: { id: deviceId } });
}

/**
 * Approve a pending device (set status to "paired")
 */
export async function approveDevice(
	db: DbClient,
	deviceId: string,
): Promise<TediDevice | undefined> {
	const results = await db
		.update(tediDevices)
		.set({
			status: "paired",
			pairedAt: new Date().toISOString(),
		})
		.where(and(eq(tediDevices.id, deviceId), eq(tediDevices.status, "pending")))
		.returning();
	return results[0];
}

/**
 * Revoke a device (soft-delete: set status to "revoked")
 */
export async function revokeDevice(
	db: DbClient,
	deviceId: string,
): Promise<TediDevice | undefined> {
	const results = await db
		.update(tediDevices)
		.set({
			status: "revoked",
			revokedAt: new Date().toISOString(),
		})
		.where(eq(tediDevices.id, deviceId))
		.returning();
	return results[0];
}

// ============================================================================
// Custom Domain Operations
// ============================================================================

/**
 * List custom domains for a tedi
 */
export async function getCustomDomainsByTedi(
	db: DbClient,
	tediId: string,
): Promise<TediCustomDomain[]> {
	return db
		.select()
		.from(tediCustomDomains)
		.where(eq(tediCustomDomains.tediId, tediId));
}

/**
 * Get a custom domain by ID
 */
export async function getCustomDomainById(
	db: DbClient,
	domainId: string,
): Promise<TediCustomDomain | undefined> {
	const results = await db
		.select()
		.from(tediCustomDomains)
		.where(eq(tediCustomDomains.id, domainId));
	return results[0];
}

/**
 * Add a custom domain
 */
export async function addCustomDomain(
	db: DbClient,
	data: NewTediCustomDomain,
): Promise<TediCustomDomain> {
	const results = await db.insert(tediCustomDomains).values(data).returning();
	return results[0]!;
}

/**
 * Remove a custom domain
 */
export async function removeCustomDomain(
	db: DbClient,
	domainId: string,
): Promise<void> {
	await db.delete(tediCustomDomains).where(eq(tediCustomDomains.id, domainId));
}

/**
 * Get the live tedi holding a globally-unique slug.
 *
 * Retirement renames the slug, so a retired worker cannot answer to its old
 * name; the `retiredAt` predicate also stops the renamed slug from routing.
 */
export async function getTediByGlobalSlug(
	db: DbClient,
	slug: string,
): Promise<Tedi | undefined> {
	return db.query.tedis.findFirst({
		where: { slug, retiredAt: { isNull: true } },
	});
}

/** Runtime-routing projection for a tedi, keyed by its globally-unique slug. */
export interface TediRuntimeMeta {
	slug: string;
	id: string;
	organizationId: string;
	runtimeKind: "agent";
	runtimeState: RuntimeState;
	status: TediStatus | null;
}

/**
 * Batched, cross-org runtime-metadata lookup by globally-unique slug.
 *
 * Backs the MCP aggregate edge's runtime-kind hydration: the edge only holds
 * slugs in app metadata, and `tedis` is the authoritative source of runtime
 * kind + credential identity. Slugs are globally unique (`uniq_tedi_slug`), so
 * this is deliberately NOT org-scoped — the caller is a service-binding-only
 * internal endpoint. Returns the same 6-field projection the edge consumes.
 */
export async function listTediRuntimeMetaBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<TediRuntimeMeta[]> {
	const unique = Array.from(new Set(slugs));
	if (unique.length === 0) return [];
	const rows: TediRuntimeMeta[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the slug IN() list.
	for (const chunk of chunkForBoundParams(unique, 50)) {
		rows.push(
			...(await db
				.select({
					slug: tedis.slug,
					id: tedis.id,
					organizationId: tedis.organizationId,
					runtimeKind: tedis.runtimeKind,
					runtimeState: tedis.runtimeState,
					status: tedis.status,
				})
				.from(tedis)
				.where(inArray(tedis.slug, chunk))),
		);
	}
	return rows;
}

/** Durable Object instance name for inbound Agent-runtime email routing. */
export async function getTediAgentIdBySlug(
	db: DbClient,
	slug: string,
): Promise<string | null> {
	const [row] = await db
		.select({
			agentId: sql<string>`coalesce(${tedis.isolateAgentId}, ${tedis.slug})`,
		})
		.from(tedis)
		.where(eq(tedis.slug, slug))
		.limit(1);
	return row?.agentId ?? null;
}

/**
 * Get active (non-paused) tedi slug by ID.
 * Used by outbound email to resolve the from-address slug.
 */
export async function getActiveTediSlugById(
	db: DbClient,
	tediId: string,
): Promise<string | undefined> {
	const result = await db
		.select({ slug: tedis.slug })
		.from(tedis)
		.where(
			and(
				eq(tedis.id, tediId),
				sql`${tedis.status} != 'paused'`,
				isNull(tedis.retiredAt),
			),
		)
		.limit(1);
	return result[0]?.slug;
}

// ============================================================================
// Runtime Projection Operations
// ============================================================================

/**
 * Append runtime snapshot (observed state projection from runtime plane).
 */
export async function createRuntimeSnapshot(
	db: DbClient,
	data: Omit<NewTediRuntimeSnapshot, "channelStatus" | "deviceStatus"> & {
		channelStatus?: unknown;
		deviceStatus?: unknown;
	},
): Promise<TediRuntimeSnapshot> {
	const results = await db
		.insert(tediRuntimeSnapshots)
		.values(data as NewTediRuntimeSnapshot)
		.returning();
	return results[0]!;
}

/**
 * Get latest runtime snapshot for a tedi.
 */
export async function getLatestRuntimeSnapshot(
	db: DbClient,
	tediId: string,
): Promise<TediRuntimeSnapshot | undefined> {
	const results = await db
		.select()
		.from(tediRuntimeSnapshots)
		.where(eq(tediRuntimeSnapshots.tediId, tediId))
		.orderBy(desc(tediRuntimeSnapshots.observedAt))
		.limit(1);
	return results[0];
}

/**
 * Add immutable usage events for billing/audit ledgers.
 */
export async function createUsageEvents(
	db: DbClient,
	events: Array<
		Omit<NewTediUsageEvent, "metadata"> & {
			metadata?: unknown;
		}
	>,
): Promise<TediUsageEvent[]> {
	if (events.length === 0) return [];
	// D1 caps bound parameters at 100/query (not SQLite's 999 default).
	// tediUsageEvents binds up to 8 columns/row; this insert had no chunking
	// at all (unbounded caller-supplied array). 10 rows (80 params) is the
	// safe margin. See packages/db/src/queries/tedi-usage.ts for the same
	// bug class (tedi_call_costs).
	const USAGE_EVENTS_CHUNK_SIZE = 10;
	const inserted: TediUsageEvent[] = [];
	for (const chunk of chunkForBoundParams(events, USAGE_EVENTS_CHUNK_SIZE)) {
		inserted.push(
			...(await db
				.insert(tediUsageEvents)
				.values(chunk as NewTediUsageEvent[])
				.returning()),
		);
	}
	return inserted;
}

/**
 * List recent usage events for a tedi.
 */
export async function listUsageEvents(
	db: DbClient,
	tediId: string,
	limit = 50,
): Promise<TediUsageEvent[]> {
	return db
		.select()
		.from(tediUsageEvents)
		.where(eq(tediUsageEvents.tediId, tediId))
		.orderBy(desc(tediUsageEvents.startedAt))
		.limit(limit);
}

/**
 * Delete runtime snapshots older than the given number of days.
 * Prevents unbounded table growth from 5-minute cron ticks.
 */
export async function cleanupOldSnapshots(
	db: DbClient,
	olderThanDays: number = 7,
): Promise<number> {
	const cutoff = new Date(
		Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
	).toISOString();
	// Drizzle D1 delete returns D1Result which has `meta.changes` for row count
	const result = await db
		.delete(tediRuntimeSnapshots)
		.where(sql`${tediRuntimeSnapshots.observedAt} < ${cutoff}`);
	return getAffectedRows(result);
}

/**
 * Delete usage events older than the given number of days.
 * Prevents unbounded growth of the billing ledger table.
 */
export async function cleanupOldUsageEvents(
	db: DbClient,
	olderThanDays: number = 30,
): Promise<number> {
	const result = await db
		.delete(tediUsageEvents)
		.where(
			sql`${tediUsageEvents.createdAt} < datetime('now', '-' || ${olderThanDays} || ' days')`,
		);
	return getAffectedRows(result);
}

/**
 * Update last_heartbeat_at to now (debounced user-activity signal).
 * Called by the tedi Worker middleware on external (non-service-binding) requests.
 */
export async function updateTediLastHeartbeat(
	db: DbClient,
	tediId: string,
): Promise<void> {
	await db
		.update(tedis)
		.set({
			lastHeartbeatAt: new Date().toISOString(),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Promote a newly ingested cognitive-runtime event into the tedi's canonical
 * activity clocks without letting delayed/backfilled events move time backward.
 */
export async function updateTediRuntimeActivity(
	db: DbClient,
	tediId: string,
	timestamp: string,
	opts: { heartbeat?: boolean } = {},
): Promise<void> {
	const newestHeartbeat = sql<string>`CASE
		WHEN ${tedis.lastHeartbeatAt} IS NULL OR ${tedis.lastHeartbeatAt} < ${timestamp}
		THEN ${timestamp}
		ELSE ${tedis.lastHeartbeatAt}
	END`;
	const newestActivity = sql<string>`CASE
		WHEN ${tedis.lastActivityAt} IS NULL OR ${tedis.lastActivityAt} < ${timestamp}
		THEN ${timestamp}
		ELSE ${tedis.lastActivityAt}
	END`;
	await db
		.update(tedis)
		.set({
			...(opts.heartbeat
				? { lastHeartbeatAt: newestHeartbeat }
				: { lastActivityAt: newestActivity }),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Update last_sync_result JSON (lightweight sync diagnostics for operator UIs).
 */
export async function updateTediSyncResult(
	db: DbClient,
	tediId: string,
	syncResult: Record<string, JsonValue>,
): Promise<void> {
	await db
		.update(tedis)
		.set({
			lastSyncResult: syncResult,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Flexible cron sync update — sets last_sync_result plus optional runtime_status
 * in a single D1 write. The observed runtime version flows into
 * tedi_runtime_snapshots via ingestRuntimeProjection (not stored on tedis).
 */
export async function updateTediCronSync(
	db: DbClient,
	tediId: string,
	opts: {
		syncResult: Record<string, JsonValue>;
		runtimeStatus?: string;
	},
): Promise<void> {
	await db
		.update(tedis)
		.set({
			lastSyncResult: opts.syncResult,
			lastSyncAt: new Date().toISOString(),
			...(opts.runtimeStatus !== undefined
				? {
						runtimeStatus: opts.runtimeStatus as
							| "running"
							| "sleeping"
							| "starting"
							| "error"
							| "unknown",
					}
				: {}),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Update runtime_status (e.g. after successful gateway startup).
 */
export async function updateTediRuntimeStatus(
	db: DbClient,
	tediId: string,
	status: string,
): Promise<void> {
	const now = new Date().toISOString();
	const marksLive = status === "running" || status === "starting";
	await db
		.update(tedis)
		.set({
			runtimeStatus: status as
				| "running"
				| "sleeping"
				| "starting"
				| "error"
				| "unknown",
			...(marksLive ? { lastSeenAt: now } : {}),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Read the persisted container placement ID (used to detect silent
 * container replacements across Worker isolate recycles).
 */
export async function getTediPlacementId(
	db: DbClient,
	tediId: string,
): Promise<string | null> {
	const results = await db
		.select({ placementId: tedis.placementId })
		.from(tedis)
		.where(eq(tedis.id, tediId))
		.limit(1);
	return results[0]?.placementId ?? null;
}

/**
 * Persist the current container placement ID for replacement detection.
 */
export async function updateTediPlacementId(
	db: DbClient,
	tediId: string,
	placementId: string,
): Promise<void> {
	await db
		.update(tedis)
		.set({
			placementId,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}

/**
 * Update a tedi's billing state based on runtime activity.
 * States: cold (no activity) → warm (recent cron) → active (container running)
 */
export async function updateTediBillingState(
	db: DbClient,
	tediId: string,
	billingState: "cold" | "warm" | "active",
): Promise<void> {
	await db
		.update(tedis)
		.set({
			billingState,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tedis.id, tediId));
}
