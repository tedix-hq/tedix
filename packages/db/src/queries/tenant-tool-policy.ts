import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type NewTenantToolPolicyRow,
	tenantToolPolicies,
	tenantToolPolicyMountRevisions,
	tenantToolPolicyPreparations,
	tenantToolPolicyResourceGenerations,
	tenantProviderIdentityProfiles,
	tenantProviderIdentityPreparations,
} from "../schema/tenant-tool-policy";

/** Subject keys are derived from the reviewed descriptor, never request metadata. */
export function tenantPolicySubjectKey(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const descriptor = value as Record<string, unknown>;
	const nonempty = (v: unknown): v is string =>
		typeof v === "string" && v.length > 0;
	if (descriptor.kind === "profile" && nonempty(descriptor.actorUserId))
		return JSON.stringify(["user", descriptor.actorUserId]);
	if (descriptor.kind !== "machine" && descriptor.kind !== "native_rpc")
		return null;
	const subject = descriptor.subject;
	if (!subject || typeof subject !== "object" || Array.isArray(subject))
		return null;
	const s = subject as Record<string, unknown>;
	if (!nonempty(s.principalId) || !nonempty(s.mcpServerId)) return null;
	if (s.scope === "principal")
		return JSON.stringify(["machine-principal", s.principalId, s.mcpServerId]);
	if (
		s.scope === "session" &&
		nonempty(s.sessionId) &&
		nonempty(s.clientRecordId)
	)
		return JSON.stringify([
			"machine-session",
			s.principalId,
			s.mcpServerId,
			s.sessionId,
			s.clientRecordId,
		]);
	return null;
}

export async function createProviderIdentityPreparation(
	db: DbQueryClient,
	row: typeof tenantProviderIdentityPreparations.$inferInsert,
) {
	const [created] = await db
		.insert(tenantProviderIdentityPreparations)
		.values(row)
		.returning();
	if (!created)
		throw new Error("Identity profile preparation was not recorded");
	return created;
}

export async function consumeProviderIdentityPreparation(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		ownerId: string;
		profileDigest: string;
		now: string;
	},
) {
	const [row] = await db
		.update(tenantProviderIdentityPreparations)
		.set({ consumedAt: input.now })
		.where(
			and(
				eq(tenantProviderIdentityPreparations.id, input.id),
				eq(
					tenantProviderIdentityPreparations.organizationId,
					input.organizationId,
				),
				eq(tenantProviderIdentityPreparations.ownerId, input.ownerId),
				eq(
					tenantProviderIdentityPreparations.profileDigest,
					input.profileDigest,
				),
				isNull(tenantProviderIdentityPreparations.consumedAt),
				gt(tenantProviderIdentityPreparations.expiresAt, input.now),
			),
		)
		.returning();
	return row;
}

export async function createProviderIdentityProfile(
	db: DbQueryClient,
	row: typeof tenantProviderIdentityProfiles.$inferInsert,
) {
	const [created] = await db
		.insert(tenantProviderIdentityProfiles)
		.values(row)
		.returning();
	if (!created) throw new Error("Identity profile was not recorded");
	return created;
}

export async function listProviderIdentityProfiles(
	db: DbQueryClient,
	organizationId: string,
) {
	return db
		.select()
		.from(tenantProviderIdentityProfiles)
		.where(eq(tenantProviderIdentityProfiles.organizationId, organizationId))
		.orderBy(desc(tenantProviderIdentityProfiles.createdAt))
		.limit(500);
}

export async function getProviderIdentityProfile(
	db: DbQueryClient,
	input: { organizationId: string; id: string },
) {
	const [row] = await db
		.select()
		.from(tenantProviderIdentityProfiles)
		.where(
			and(
				eq(tenantProviderIdentityProfiles.organizationId, input.organizationId),
				eq(tenantProviderIdentityProfiles.id, input.id),
			),
		)
		.limit(1);
	return row;
}

export async function revokeProviderIdentityProfile(
	db: DbQueryClient,
	input: { organizationId: string; id: string; now: string },
) {
	const [row] = await db
		.update(tenantProviderIdentityProfiles)
		.set({ revokedAt: input.now })
		.where(
			and(
				eq(tenantProviderIdentityProfiles.organizationId, input.organizationId),
				eq(tenantProviderIdentityProfiles.id, input.id),
				isNull(tenantProviderIdentityProfiles.revokedAt),
			),
		)
		.returning();
	return row;
}

/** Read a bounded resource vector; missing rows mean no mutation was recorded. */
export async function getTenantToolPolicyResourceGenerations(
	db: DbQueryClient,
	input: {
		organizationId: string;
		appIds: string[];
		toolRowId: string;
		connectionInstanceId: string;
	},
) {
	const requested = [
		...input.appIds.map((id) => ({ kind: "app", id })),
		{ kind: "tool", id: input.toolRowId },
		{ kind: "connection", id: input.connectionInstanceId },
	];
	const ids = [...new Set(requested.map((item) => item.id))];
	const rows = await db
		.select()
		.from(tenantToolPolicyResourceGenerations)
		.where(
			and(
				eq(
					tenantToolPolicyResourceGenerations.organizationId,
					input.organizationId,
				),
				inArray(tenantToolPolicyResourceGenerations.resourceId, ids),
			),
		);
	const map = new Map(
		rows.map((row) => [
			JSON.stringify([row.resourceKind, row.resourceId]),
			row.generation,
		]),
	);
	return requested.map((item) => ({
		...item,
		generation: map.get(JSON.stringify([item.kind, item.id])) ?? 0,
	}));
}

export async function createTenantToolPolicyPreparation(
	db: DbQueryClient,
	row: typeof tenantToolPolicyPreparations.$inferInsert,
) {
	const [created] = await db
		.insert(tenantToolPolicyPreparations)
		.values(row)
		.returning();
	if (!created) throw new Error("Policy preparation was not recorded");
	return created;
}

/** Atomic one-use receipt, bound to the owner and the descriptor they reviewed. */
export async function consumeTenantToolPolicyPreparation(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		ownerId: string;
		descriptorDigest: string;
		now: string;
	},
) {
	const [row] = await db
		.update(tenantToolPolicyPreparations)
		.set({ consumedAt: input.now })
		.where(
			and(
				eq(tenantToolPolicyPreparations.id, input.id),
				eq(tenantToolPolicyPreparations.organizationId, input.organizationId),
				eq(tenantToolPolicyPreparations.ownerId, input.ownerId),
				eq(
					tenantToolPolicyPreparations.descriptorDigest,
					input.descriptorDigest,
				),
				isNull(tenantToolPolicyPreparations.consumedAt),
				gt(tenantToolPolicyPreparations.expiresAt, input.now),
			),
		)
		.returning();
	return row;
}

export async function createTenantToolPolicy(
	db: DbQueryClient,
	row: NewTenantToolPolicyRow,
) {
	if (!row.rootAppId || !row.mountedToolId)
		throw new Error("Mount identity is required");
	const descriptor = row.mountDescriptor as {
		sourceToolId?: unknown;
		mount?: { sourceToolId?: unknown };
	} | null;
	const sourceToolId =
		descriptor?.mount?.sourceToolId ?? descriptor?.sourceToolId;
	const [createdRows] = await db.batch([
		db.insert(tenantToolPolicies).values(row).returning(),
		db
			.insert(tenantToolPolicyMountRevisions)
			.values({
				organizationId: row.organizationId,
				rootAppId: row.rootAppId,
				mountedToolId: row.mountedToolId,
				policyId: row.id,
				subjectKey: tenantPolicySubjectKey(row.mountDescriptor),
				sourceAppId: row.appId,
				sourceToolRowId: row.toolRowId,
				sourceToolId:
					typeof sourceToolId === "string" && sourceToolId
						? sourceToolId
						: null,
			})
			.returning(),
	]);
	const created = createdRows[0];
	if (!created) throw new Error("Policy revision was not recorded");
	return created;
}

/** Atomically create on an empty mount or replace the latest unrevoked revision. */
export async function replaceTenantToolPolicy(
	db: DbQueryClient,
	row: NewTenantToolPolicyRow,
	expectedRevisionId: string | null,
	regrantRevoked = false,
	recoverDeleted = false,
	recoverUnknownRevisionId: string | null = null,
	subjectRecoveryMode: "revoked" | "deleted" | null = null,
) {
	if (!row.rootAppId || !row.mountedToolId)
		throw new Error("Mount identity is required");
	if (
		(regrantRevoked || recoverDeleted) &&
		!expectedRevisionId &&
		!recoverUnknownRevisionId
	)
		throw new Error("Prior revision identity is required");
	if (regrantRevoked && recoverDeleted)
		throw new Error("Choose one recovery mode");
	const descriptor = row.mountDescriptor as {
		sourceToolId?: unknown;
		mount?: { sourceToolId?: unknown };
	} | null;
	const sourceToolId =
		descriptor?.mount?.sourceToolId ?? descriptor?.sourceToolId;
	const subjectKey = tenantPolicySubjectKey(row.mountDescriptor);
	if (!subjectKey) throw new Error("A verified subject is required");
	if (recoverUnknownRevisionId && !regrantRevoked && !recoverDeleted)
		throw new Error("Select a recovery mode");
	const unknownRecovery = recoverUnknownRevisionId !== null;
	if (subjectRecoveryMode && (!unknownRecovery || !expectedRevisionId))
		throw new Error("Subject recovery requires both reviewed revisions");
	const [createdRows] = await db.batch([
		db
			.insert(tenantToolPolicies)
			.select(
				sql`SELECT ${row.id}, ${row.organizationId}, ${row.appId}, ${row.rootAppId}, ${row.mountedToolId}, ${row.toolRowId}, ${row.toolDigest}, ${row.ruleDigest}, ${JSON.stringify(row.mountDescriptor ?? null)}, ${row.mountDigest ?? null}, ${row.resourceGenerationDigest ?? null}, ${JSON.stringify(row.predicate)}, ${JSON.stringify(row.effect)}, ${JSON.stringify(row.policySet ?? null)}, ${row.createdBy}, ${row.createdAt}, ${row.revokedAt ?? null} WHERE ((${!unknownRecovery} AND NOT EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS unknown WHERE unknown.organization_id = ${row.organizationId} AND unknown.root_app_id = ${row.rootAppId} AND unknown.mounted_tool_id = ${row.mountedToolId} AND unknown.subject_key IS NULL AND unknown.sequence = (SELECT MAX(u2.sequence) FROM tenant_tool_policy_mount_revisions AS u2 WHERE u2.organization_id = unknown.organization_id AND u2.root_app_id = unknown.root_app_id AND u2.mounted_tool_id = unknown.mounted_tool_id AND u2.subject_key IS NULL) AND NOT EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS retired WHERE retired.organization_id = unknown.organization_id AND retired.root_app_id = unknown.root_app_id AND retired.mounted_tool_id = unknown.mounted_tool_id AND retired.retired_unknown_sequence = unknown.sequence))) OR (${unknownRecovery} AND EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS unknown LEFT JOIN tenant_tool_policies AS old ON old.id = unknown.policy_id AND old.organization_id = unknown.organization_id WHERE unknown.organization_id = ${row.organizationId} AND unknown.root_app_id = ${row.rootAppId} AND unknown.mounted_tool_id = ${row.mountedToolId} AND unknown.subject_key IS NULL AND unknown.policy_id = ${recoverUnknownRevisionId} AND unknown.sequence = (SELECT MAX(u2.sequence) FROM tenant_tool_policy_mount_revisions AS u2 WHERE u2.organization_id = unknown.organization_id AND u2.root_app_id = unknown.root_app_id AND u2.mounted_tool_id = unknown.mounted_tool_id AND u2.subject_key IS NULL) AND ((old.id IS NULL AND ${recoverDeleted}) OR (old.id IS NOT NULL AND old.revoked_at IS NOT NULL AND ${regrantRevoked})) AND NOT EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS retired WHERE retired.organization_id = unknown.organization_id AND retired.root_app_id = unknown.root_app_id AND retired.mounted_tool_id = unknown.mounted_tool_id AND retired.retired_unknown_sequence = unknown.sequence)))) AND ((${expectedRevisionId} IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS existing WHERE existing.organization_id = ${row.organizationId} AND existing.root_app_id = ${row.rootAppId} AND existing.mounted_tool_id = ${row.mountedToolId} AND existing.subject_key IS ${subjectKey})) OR (${expectedRevisionId} IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS fence LEFT JOIN tenant_tool_policies AS previous ON previous.id = fence.policy_id AND previous.organization_id = fence.organization_id WHERE fence.organization_id = ${row.organizationId} AND fence.root_app_id = ${row.rootAppId} AND fence.mounted_tool_id = ${row.mountedToolId} AND fence.subject_key IS ${subjectKey} AND fence.policy_id = ${expectedRevisionId} AND ((previous.id IS NOT NULL AND previous.revoked_at IS NULL AND ${unknownRecovery ? subjectRecoveryMode === null : !regrantRevoked && !recoverDeleted}) OR (previous.id IS NOT NULL AND previous.revoked_at IS NOT NULL AND ${unknownRecovery ? subjectRecoveryMode === "revoked" : regrantRevoked}) OR (previous.id IS NULL AND ${unknownRecovery ? subjectRecoveryMode === "deleted" : recoverDeleted})) AND fence.sequence = (SELECT MAX(newer.sequence) FROM tenant_tool_policy_mount_revisions AS newer WHERE newer.organization_id = fence.organization_id AND newer.root_app_id = fence.root_app_id AND newer.mounted_tool_id = fence.mounted_tool_id AND newer.subject_key IS fence.subject_key))))`,
			)
			.returning(),
		db
			.insert(tenantToolPolicyMountRevisions)
			.select(
				sql`SELECT NULL, ${row.organizationId}, ${row.rootAppId}, ${row.mountedToolId}, ${row.id}, ${row.appId}, ${row.toolRowId}, ${typeof sourceToolId === "string" && sourceToolId ? sourceToolId : null}, ${subjectKey}, (SELECT u.sequence FROM tenant_tool_policy_mount_revisions AS u WHERE ${recoverUnknownRevisionId} IS NOT NULL AND u.organization_id = ${row.organizationId} AND u.root_app_id = ${row.rootAppId} AND u.mounted_tool_id = ${row.mountedToolId} AND u.subject_key IS NULL AND u.policy_id = ${recoverUnknownRevisionId} ORDER BY u.sequence DESC LIMIT 1) WHERE EXISTS (SELECT 1 FROM tenant_tool_policies WHERE id = ${row.id} AND organization_id = ${row.organizationId})`,
			)
			.returning(),
	]);
	return createdRows[0];
}

export async function listTenantToolPolicies(
	db: DbQueryClient,
	organizationId: string,
) {
	return db
		.select()
		.from(tenantToolPolicies)
		.where(eq(tenantToolPolicies.organizationId, organizationId))
		.orderBy(desc(tenantToolPolicies.createdAt))
		.limit(500);
}

/** Latest fences whose policy row is gone; no old grant is restored. */
export async function listDeletedTenantPolicyFences(
	db: DbQueryClient,
	organizationId: string,
) {
	const fence = tenantToolPolicyMountRevisions;
	return db
		.select({
			rootAppId: fence.rootAppId,
			mountedToolId: fence.mountedToolId,
			revisionId: fence.policyId,
			sourceAppId: fence.sourceAppId,
			sourceToolId: fence.sourceToolId,
			subjectKey: fence.subjectKey,
		})
		.from(fence)
		.leftJoin(
			tenantToolPolicies,
			and(
				eq(tenantToolPolicies.id, fence.policyId),
				eq(tenantToolPolicies.organizationId, fence.organizationId),
			),
		)
		.where(
			and(
				eq(fence.organizationId, organizationId),
				isNull(tenantToolPolicies.id),
				sql`(${fence.subjectKey} IS NOT NULL OR NOT EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS retired WHERE retired.organization_id = ${fence.organizationId} AND retired.root_app_id = ${fence.rootAppId} AND retired.mounted_tool_id = ${fence.mountedToolId} AND retired.retired_unknown_sequence = ${fence.sequence}))`,
				sql`${fence.sequence} = (SELECT MAX(newer.sequence) FROM tenant_tool_policy_mount_revisions AS newer WHERE newer.organization_id = ${fence.organizationId} AND newer.root_app_id = ${fence.rootAppId} AND newer.mounted_tool_id = ${fence.mountedToolId} AND newer.subject_key IS ${fence.subjectKey})`,
			),
		)
		.limit(500);
}

/** Include revocations: a revoked newest revision must never revive an older one. */
export async function findTenantToolPolicyRevisions(
	db: DbQueryClient,
	scope: {
		organizationId: string;
		rootAppId: string;
		mountedToolId: string;
		subjectKey?: string;
	},
) {
	const latest = db
		.select({ policyId: tenantToolPolicyMountRevisions.policyId })
		.from(tenantToolPolicyMountRevisions)
		.where(
			and(
				eq(tenantToolPolicyMountRevisions.organizationId, scope.organizationId),
				eq(tenantToolPolicyMountRevisions.rootAppId, scope.rootAppId),
				eq(tenantToolPolicyMountRevisions.mountedToolId, scope.mountedToolId),
				scope.subjectKey === undefined
					? undefined
					: eq(tenantToolPolicyMountRevisions.subjectKey, scope.subjectKey),
			),
		)
		.orderBy(desc(tenantToolPolicyMountRevisions.sequence))
		.limit(1);
	return db
		.select()
		.from(tenantToolPolicies)
		.where(
			and(
				eq(tenantToolPolicies.organizationId, scope.organizationId),
				eq(tenantToolPolicies.id, latest),
			),
		)
		.limit(1);
}

/** Read all current subject fences in one snapshot, including deleted policies. */
export async function findTenantToolPolicySubjectFences(
	db: DbQueryClient,
	scope: { organizationId: string; rootAppId: string; mountedToolId: string },
) {
	const fence = tenantToolPolicyMountRevisions;
	return db
		.select({
			subjectKey: fence.subjectKey,
			sequence: fence.sequence,
			policyId: fence.policyId,
			policyRowId: tenantToolPolicies.id,
			revokedAt: tenantToolPolicies.revokedAt,
		})
		.from(fence)
		.leftJoin(
			tenantToolPolicies,
			and(
				eq(tenantToolPolicies.id, fence.policyId),
				eq(tenantToolPolicies.organizationId, fence.organizationId),
			),
		)
		.where(
			and(
				eq(fence.organizationId, scope.organizationId),
				eq(fence.rootAppId, scope.rootAppId),
				eq(fence.mountedToolId, scope.mountedToolId),
				sql`(${fence.subjectKey} IS NOT NULL OR NOT EXISTS (SELECT 1 FROM tenant_tool_policy_mount_revisions AS retired WHERE retired.organization_id = ${fence.organizationId} AND retired.root_app_id = ${fence.rootAppId} AND retired.mounted_tool_id = ${fence.mountedToolId} AND retired.retired_unknown_sequence = ${fence.sequence}))`,
				sql`${fence.sequence} = (SELECT MAX(other.sequence) FROM tenant_tool_policy_mount_revisions AS other WHERE other.organization_id = ${fence.organizationId} AND other.root_app_id = ${fence.rootAppId} AND other.mounted_tool_id = ${fence.mountedToolId} AND other.subject_key IS ${fence.subjectKey})`,
			),
		)
		.orderBy(fence.subjectKey, fence.sequence);
}

/** Return all current matching subjects so callers can detect ambiguous mounts. */
export async function findTenantToolPolicyCandidatesBySource(
	db: DbQueryClient,
	scope: {
		organizationId: string;
		rootAppId?: string;
		sourceAppId: string;
		sourceToolRowId: string;
		subjectKeys?: string[];
	},
) {
	if (
		scope.subjectKeys &&
		(scope.subjectKeys.length < 1 || scope.subjectKeys.length > 2)
	)
		throw new Error("Expected one or two verified subject keys");
	const fence = tenantToolPolicyMountRevisions;
	const latestIds = db
		.select({ id: fence.policyId })
		.from(fence)
		.where(
			and(
				eq(fence.organizationId, scope.organizationId),
				scope.rootAppId ? eq(fence.rootAppId, scope.rootAppId) : undefined,
				scope.subjectKeys
					? or(...scope.subjectKeys.map((key) => eq(fence.subjectKey, key)))
					: undefined,
				sql`${fence.sequence} = (SELECT MAX(other.sequence) FROM tenant_tool_policy_mount_revisions AS other WHERE other.organization_id = ${fence.organizationId} AND other.root_app_id = ${fence.rootAppId} AND other.mounted_tool_id = ${fence.mountedToolId} AND other.subject_key IS ${fence.subjectKey})`,
			),
		);
	return db
		.select()
		.from(tenantToolPolicies)
		.where(
			and(
				eq(tenantToolPolicies.organizationId, scope.organizationId),
				scope.rootAppId
					? eq(tenantToolPolicies.rootAppId, scope.rootAppId)
					: undefined,
				eq(tenantToolPolicies.appId, scope.sourceAppId),
				eq(tenantToolPolicies.toolRowId, scope.sourceToolRowId),
				// bound-params: latestIds is a SQL subquery, not a parameter list.
				inArray(tenantToolPolicies.id, latestIds),
			),
		);
}

/** A missing pre-migration source binding is unknown and must block fallback. */
export async function hasTenantToolPolicyFenceForSource(
	db: DbQueryClient,
	scope: {
		organizationId: string;
		rootAppId?: string;
		mountedToolId?: string;
		sourceAppId: string;
		sourceToolRowId: string;
		sourceToolId: string;
	},
) {
	const fence = tenantToolPolicyMountRevisions;
	const rows = await db
		.select({ sequence: fence.sequence })
		.from(fence)
		.where(
			and(
				eq(fence.organizationId, scope.organizationId),
				scope.rootAppId ? eq(fence.rootAppId, scope.rootAppId) : undefined,
				sql`${fence.sequence} = (SELECT MAX(other.sequence) FROM tenant_tool_policy_mount_revisions AS other WHERE other.organization_id = ${fence.organizationId} AND other.root_app_id = ${fence.rootAppId} AND other.mounted_tool_id = ${fence.mountedToolId} AND other.subject_key IS ${fence.subjectKey})`,
				or(
					isNull(fence.sourceAppId),
					isNull(fence.sourceToolId),
					and(
						eq(fence.sourceAppId, scope.sourceAppId),
						eq(fence.sourceToolId, scope.sourceToolId),
					),
					scope.mountedToolId && scope.rootAppId
						? eq(fence.mountedToolId, scope.mountedToolId)
						: undefined,
				),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export async function revokeTenantToolPolicy(
	db: DbQueryClient,
	scope: { organizationId: string; id: string },
	revokedAt: string,
) {
	const [row] = await db
		.update(tenantToolPolicies)
		.set({ revokedAt })
		.where(
			and(
				eq(tenantToolPolicies.organizationId, scope.organizationId),
				eq(tenantToolPolicies.id, scope.id),
				isNull(tenantToolPolicies.revokedAt),
			),
		)
		.returning();
	return row;
}
