/** Portable bootstrap reads; JSON stays text for the runtime's existing parsers. */
import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import { tedis } from "../schema/tedis";
import { organizations } from "../schema/organizations";
import { tediSecrets } from "../schema/tedi-secrets";
import { apiKeys } from "../schema/api-keys";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { policyPacks } from "../schema/control-plane";
import { tediApprovalRequests } from "../schema/approvals";

export interface TediRuntimeRouteRow {
	id: string;
	slug: string;
	organizationId: string | null;
	runtimeKind: string | null;
	isolateAgentId: string | null;
	status: string | null;
	descopeMcpResourceId: string | null;
	organizationDescopeTenantId: string | null;
}

export async function getTediRuntimeRouteBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<TediRuntimeRouteRow | null> {
	return (
		(await db.get<TediRuntimeRouteRow>(sql`
  SELECT t.id, t.slug, t.organization_id AS "organizationId",
   t.runtime_kind AS "runtimeKind", t.isolate_agent_id AS "isolateAgentId", t.status,
   t.descope_mcp_resource_id AS "descopeMcpResourceId", o.descope_tenant_id AS "organizationDescopeTenantId"
  FROM ${coreTable(db, tedis)} t
  LEFT JOIN ${coreTable(db, organizations)} o ON o.id = t.organization_id
  WHERE t.slug = ${slug} LIMIT 1`)) ?? null
	);
}

/** Inbound email dispatch only targets an active, non-retired tedi body. */
export async function getTediEmailIngressRouteBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<{ agentId: string } | null> {
	return (
		(await db.get<{ agentId: string }>(sql`
  SELECT coalesce(isolate_agent_id, slug) AS "agentId" FROM ${coreTable(db, tedis)}
  WHERE slug = ${slug} AND retired_at IS NULL AND (status IS NULL OR status != 'paused') LIMIT 1`)) ??
		null
	);
}

export async function getTediRuntimeBodyGeneration(
	db: DbQueryClient,
	tediId: string,
) {
	return (
		(await db.get<{
			bodyGenerationId: string | null;
			bodyGenerationTokenHash: string | null;
			bodyGenerationTokenExpiresAt: string | null;
		}>(sql`SELECT body_generation_id AS "bodyGenerationId",
  body_generation_token_hash AS "bodyGenerationTokenHash",
  body_generation_token_expires_at AS "bodyGenerationTokenExpiresAt"
  FROM ${coreTable(db, tedis)} WHERE id = ${tediId} LIMIT 1`)) ?? null
	);
}

export async function markTediRuntimeBodyGenerationReady(
	db: DbQueryClient,
	input: {
		tediId: string;
		generationId: string;
		externalId: string;
		at: string;
	},
): Promise<void> {
	await db.run(sql`UPDATE ${coreTable(db, tedis)} SET body_generation_status = 'ready',
  body_generation_external_id = ${input.externalId}, body_generation_heartbeat_at = ${input.at},
  last_seen_at = ${input.at}, updated_at = ${input.at}
  WHERE id = ${input.tediId} AND body_generation_id = ${input.generationId}`);
}

export async function getTediRuntimeEncryptedSecret(
	db: DbQueryClient,
	tediId: string,
	name: string,
): Promise<string | null> {
	const row = await db.get<{ encrypted_value: string | null }>(sql`
  SELECT encrypted_value FROM ${coreTable(db, tediSecrets)} WHERE tedi_id = ${tediId} AND name = ${name} LIMIT 1`);
	return row?.encrypted_value ?? null;
}

export interface TediRuntimeApiKeyRow {
	id: string;
	organizationId: string;
	status: string;
	expiresAt: string | null;
	ipAllowlist: string | null;
}

export async function findTediRuntimeApiKeyByHash(
	db: DbQueryClient,
	keyHash: string,
	now: string,
): Promise<TediRuntimeApiKeyRow | null> {
	const select = sql`SELECT id, organization_id AS "organizationId", status,
  expires_at AS "expiresAt", CAST(ip_allowlist AS text) AS "ipAllowlist" FROM ${coreTable(db, apiKeys)}`;
	const current = await db.get<TediRuntimeApiKeyRow>(
		sql`${select} WHERE key_hash = ${keyHash} LIMIT 1`,
	);
	if (current) return current;
	return (
		(await db.get<TediRuntimeApiKeyRow>(sql`${select} WHERE previous_key_hash = ${keyHash}
  AND status = 'active' AND previous_key_expires_at IS NOT NULL AND previous_key_expires_at > ${now} LIMIT 1`)) ??
		null
	);
}

export async function recordTediRuntimeApiKeyUsage(
	db: DbQueryClient,
	id: string,
	now: string,
): Promise<void> {
	await db.run(sql`UPDATE ${coreTable(db, apiKeys)} SET last_used_at = ${now},
  requests_this_month = COALESCE(requests_this_month, 0) + 1,
  total_requests = COALESCE(total_requests, 0) + 1, updated_at = ${now} WHERE id = ${id}`);
}

export interface TediRuntimeIdentityRow {
	id: string;
	orgId: string | null;
	slug: string;
	isolateAgentId: string | null;
	runtimeKind: string | null;
	status: string | null;
}

/** A single read snapshot refuses ambiguous physical parent mappings. */
export async function resolveCanonicalRuntimeParentIdentity(
	db: DbQueryClient,
	name: string,
): Promise<TediRuntimeIdentityRow | null> {
	const t = coreTable(db, tedis);
	return (
		(await db.get<TediRuntimeIdentityRow>(sql`SELECT id, organization_id AS "orgId", slug,
  isolate_agent_id AS "isolateAgentId", runtime_kind AS "runtimeKind", status FROM ${t}
  WHERE COALESCE(isolate_agent_id, slug) = ${name}
   AND (SELECT COUNT(*) FROM ${t} WHERE COALESCE(isolate_agent_id, slug) = ${name}) = 1 LIMIT 1`)) ??
		null
	);
}

export async function resolveTediRuntimeIdentity(
	db: DbQueryClient,
	lookup: string,
	includeId = false,
): Promise<TediRuntimeIdentityRow | null> {
	const where = includeId
		? sql`slug = ${lookup} OR id = ${lookup} OR isolate_agent_id = ${lookup}`
		: sql`slug = ${lookup} OR isolate_agent_id = ${lookup}`;
	return (
		(await db.get<TediRuntimeIdentityRow>(sql`SELECT id, organization_id AS "orgId", slug,
  isolate_agent_id AS "isolateAgentId", runtime_kind AS "runtimeKind", status
  FROM ${coreTable(db, tedis)} WHERE ${where} LIMIT 1`)) ?? null
	);
}

export async function getTediRuntimeChannels(
	db: DbQueryClient,
	tediId: string,
): Promise<string | null> {
	const row = await db.get<{
		channels: string | null;
	}>(sql`SELECT CAST(channels AS text) AS channels
  FROM ${coreTable(db, tedis)} WHERE id = ${tediId} LIMIT 1`);
	return row?.channels ?? null;
}

export async function getTediRuntimeGovernance(
	db: DbQueryClient,
	tediId: string,
) {
	return (
		(await db.get<{
			budgets: unknown;
			organizationMetadata: unknown;
			/** Numeric projection: 1 when the tedi holds a Poppy signing key. */
			poppyAgentEnabled: number;
			runtimeProfileMaxIterationsPerTask: number | null;
			toolPolicy: unknown;
		}>(sql`SELECT CAST(t.tool_policy AS text) AS "toolPolicy", CAST(t.budgets AS text) AS budgets,
  CAST(o.metadata AS text) AS "organizationMetadata",
  CAST(p.max_iterations_per_task AS double precision) AS "runtimeProfileMaxIterationsPerTask",
  CASE WHEN EXISTS(SELECT 1 FROM ${coreTable(db, tediSecrets)} s
   WHERE s.tedi_id = t.id AND s.name = 'POPPY_AGENT_SIGNING_KEY') THEN 1 ELSE 0 END AS "poppyAgentEnabled"
  FROM ${coreTable(db, tedis)} t
  JOIN ${coreTable(db, organizations)} o ON o.id = t.organization_id
  LEFT JOIN ${coreTable(db, billingAccounts)} a ON a.organization_id = t.organization_id
  LEFT JOIN ${coreTable(db, billingPlanVersions)} p ON p.id = a.plan_version_id
  WHERE t.id = ${tediId} LIMIT 1`)) ?? null
	);
}

export async function getTediRuntimePolicy(db: DbQueryClient, tediId: string) {
	return (
		(await db.get<{
			definition: string | null;
			runtimeOverrides: string | null;
		}>(sql`
  SELECT CAST(pp.definition AS text) AS definition, CAST(t.runtime_overrides AS text) AS "runtimeOverrides"
  FROM ${coreTable(db, tedis)} t
  JOIN ${coreTable(db, policyPacks)} pp ON pp.id = COALESCE(t.policy_pack_id,
   (SELECT fallback.id FROM ${coreTable(db, policyPacks)} fallback
    WHERE fallback.slug = 'system-default' AND fallback.scope = 'system' AND fallback.status = 'active'
    ORDER BY fallback.version DESC LIMIT 1)) WHERE t.id = ${tediId} LIMIT 1`)) ??
		null
	);
}

export async function getTediRuntimeRepoConfig(
	db: DbQueryClient,
	tediId: string,
): Promise<string | null> {
	const row = await db.get<{
		repo_config: string | null;
	}>(sql`SELECT CAST(repo_config AS text) AS repo_config
  FROM ${coreTable(db, tedis)} WHERE id = ${tediId} LIMIT 1`);
	return row?.repo_config ?? null;
}

export interface TediRuntimeApprovalRow {
	status: string;
	resolution: string | null;
	tediId: string;
	orgId: string;
	payload: string;
	resolvedAt: string | null;
	resolvedBy: string | null;
}

export async function getTediRuntimeApproval(
	db: DbQueryClient,
	id: string,
): Promise<TediRuntimeApprovalRow | null> {
	return (
		(await db.get<TediRuntimeApprovalRow>(sql`SELECT status, resolution, tedi_id AS "tediId", org_id AS "orgId",
  CAST(payload AS text) AS payload, resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
  FROM ${coreTable(db, tediApprovalRequests)} WHERE id = ${id} LIMIT 1`)) ??
		null
	);
}

export async function updateTediRuntimeApprovalResolution(
	db: DbQueryClient,
	id: string,
	resolution: string,
): Promise<void> {
	await db.run(
		sql`UPDATE ${coreTable(db, tediApprovalRequests)} SET resolution = ${resolution} WHERE id = ${id}`,
	);
}

export async function getTediRuntimeCanonicalIsolateId(
	db: DbQueryClient,
	tediId: string,
): Promise<{
	exists: boolean;
	isolateAgentId: string | null;
	retired: boolean;
}> {
	const row = await db.get<{
		isolateAgentId: string | null;
		retiredAt: string | null;
	}>(sql`
  SELECT isolate_agent_id AS "isolateAgentId", retired_at AS "retiredAt" FROM ${coreTable(db, tedis)} WHERE id = ${tediId} LIMIT 1`);
	return {
		exists: row != null,
		isolateAgentId: row?.isolateAgentId ?? null,
		retired: row?.retiredAt != null,
	};
}
