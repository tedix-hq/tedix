/**
 * Narrow D1 facade for the certified tedi runtime Worker.
 *
 * These statements intentionally use D1 prepared statements instead of
 * Drizzle. Importing a Drizzle-backed query module into `apps/tedi-runtime`
 * loads a second peer-specialized `drizzle-orm` instance under Bun and breaks
 * the Worker's global `Cloudflare.Env` merge. Keeping the exception here still
 * preserves the database package as the sole owner of platform SQL; callers
 * receive typed, purpose-specific operations and cannot issue ad hoc SQL.
 */

interface RuntimeD1Statement {
	bind(...values: unknown[]): RuntimeD1Statement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<unknown>;
}

interface RuntimeD1Read {
	prepare(query: string): {
		bind(...values: unknown[]): {
			first<T = Record<string, unknown>>(): Promise<T | null>;
		};
	};
}

interface RuntimeD1 {
	prepare(query: string): RuntimeD1Statement;
}

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
	db: RuntimeD1Read,
	slug: string,
): Promise<TediRuntimeRouteRow | null> {
	return db
		.prepare(
			`SELECT t.id, t.slug, t.organization_id AS organizationId,
			        t.runtime_kind AS runtimeKind,
			        t.isolate_agent_id AS isolateAgentId, t.status,
			        t.descope_mcp_resource_id AS descopeMcpResourceId,
			        o.descope_tenant_id AS organizationDescopeTenantId
			   FROM tedis t
			   LEFT JOIN organizations o ON o.id = t.organization_id
			  WHERE t.slug = ?
			  LIMIT 1`,
		)
		.bind(slug)
		.first<TediRuntimeRouteRow>();
}

/** Inbound email dispatch only targets an active, non-retired tedi body. */
export async function getTediEmailIngressRouteBySlug(
	db: RuntimeD1Read,
	slug: string,
): Promise<{ agentId: string } | null> {
	return db
		.prepare(
			`SELECT coalesce(isolate_agent_id, slug) AS agentId
			   FROM tedis
			  WHERE slug = ? AND retired_at IS NULL
			    AND (status IS NULL OR status != 'paused')
			  LIMIT 1`,
		)
		.bind(slug)
		.first<{ agentId: string }>();
}

export async function getTediRuntimeBodyGeneration(
	db: RuntimeD1Read,
	tediId: string,
): Promise<{
	bodyGenerationId: string | null;
	bodyGenerationTokenHash: string | null;
	bodyGenerationTokenExpiresAt: string | null;
} | null> {
	return db
		.prepare(
			`SELECT body_generation_id AS bodyGenerationId,
			        body_generation_token_hash AS bodyGenerationTokenHash,
			        body_generation_token_expires_at AS bodyGenerationTokenExpiresAt
			   FROM tedis
			  WHERE id = ?
			  LIMIT 1`,
		)
		.bind(tediId)
		.first();
}

export async function markTediRuntimeBodyGenerationReady(
	db: RuntimeD1,
	input: {
		tediId: string;
		generationId: string;
		externalId: string;
		at: string;
	},
): Promise<void> {
	await db
		.prepare(
			`UPDATE tedis
			    SET body_generation_status = 'ready',
			        body_generation_external_id = ?,
			        body_generation_heartbeat_at = ?,
			        last_seen_at = ?,
			        updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? AND body_generation_id = ?`,
		)
		.bind(
			input.externalId,
			input.at,
			input.at,
			input.tediId,
			input.generationId,
		)
		.run();
}

export async function getTediRuntimeEncryptedSecret(
	db: RuntimeD1Read,
	tediId: string,
	name: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT encrypted_value
			   FROM tedi_secrets
			  WHERE tedi_id = ? AND name = ?
			  LIMIT 1`,
		)
		.bind(tediId, name)
		.first<{ encrypted_value: string | null }>();
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
	db: RuntimeD1Read,
	keyHash: string,
	now: string,
): Promise<TediRuntimeApiKeyRow | null> {
	const select = `SELECT id, organization_id AS organizationId, status,
	                       expires_at AS expiresAt, ip_allowlist AS ipAllowlist
	                  FROM api_keys`;
	const current = await db
		.prepare(`${select} WHERE key_hash = ? LIMIT 1`)
		.bind(keyHash)
		.first<TediRuntimeApiKeyRow>();
	if (current) return current;
	return db
		.prepare(
			`${select}
			  WHERE previous_key_hash = ?
			    AND status = 'active'
			    AND previous_key_expires_at IS NOT NULL
			    AND previous_key_expires_at > ?
			  LIMIT 1`,
		)
		.bind(keyHash, now)
		.first<TediRuntimeApiKeyRow>();
}

export async function recordTediRuntimeApiKeyUsage(
	db: RuntimeD1,
	id: string,
	now: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE api_keys
			    SET last_used_at = ?,
			        requests_this_month = COALESCE(requests_this_month, 0) + 1,
			        total_requests = COALESCE(total_requests, 0) + 1,
			        updated_at = ?
			  WHERE id = ?`,
		)
		.bind(now, now, id)
		.run();
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
	db: RuntimeD1Read,
	name: string,
): Promise<TediRuntimeIdentityRow | null> {
	return db
		.prepare(
			`SELECT id, organization_id AS orgId, slug,
			        isolate_agent_id AS isolateAgentId,
			        runtime_kind AS runtimeKind, status
			   FROM tedis
			  WHERE COALESCE(isolate_agent_id, slug) = ?
			    AND (SELECT COUNT(*) FROM tedis WHERE COALESCE(isolate_agent_id, slug) = ?) = 1
			  LIMIT 1`,
		)
		.bind(name, name)
		.first<TediRuntimeIdentityRow>();
}

export async function resolveTediRuntimeIdentity(
	db: RuntimeD1Read,
	lookup: string,
	includeId = false,
): Promise<TediRuntimeIdentityRow | null> {
	const where = includeId
		? "slug = ? OR id = ? OR isolate_agent_id = ?"
		: "slug = ? OR isolate_agent_id = ?";
	const statement = db.prepare(
		`SELECT id, organization_id AS orgId, slug,
		        isolate_agent_id AS isolateAgentId,
		        runtime_kind AS runtimeKind, status
		   FROM tedis
		  WHERE ${where}
		  LIMIT 1`,
	);
	return includeId
		? statement.bind(lookup, lookup, lookup).first<TediRuntimeIdentityRow>()
		: statement.bind(lookup, lookup).first<TediRuntimeIdentityRow>();
}

export async function getTediRuntimeChannels(
	db: RuntimeD1Read,
	tediId: string,
): Promise<string | null> {
	const row = await db
		.prepare("SELECT channels FROM tedis WHERE id = ? LIMIT 1")
		.bind(tediId)
		.first<{ channels: string | null }>();
	return row?.channels ?? null;
}

export async function getTediRuntimeGovernance(
	db: RuntimeD1Read,
	tediId: string,
): Promise<{
	budgets: unknown;
	organizationMetadata: unknown;
	runtimeProfileMaxIterationsPerTask: number | null;
	toolPolicy: unknown;
} | null> {
	return db
		.prepare(
			`SELECT t.tool_policy AS toolPolicy, t.budgets,
			        o.metadata AS organizationMetadata,
			        p.max_iterations_per_task AS runtimeProfileMaxIterationsPerTask
			   FROM tedis t
			   JOIN organizations o ON o.id = t.organization_id
			   LEFT JOIN billing_accounts a ON a.organization_id = t.organization_id
			   LEFT JOIN billing_plan_versions p ON p.id = a.plan_version_id
			  WHERE t.id = ?
			  LIMIT 1`,
		)
		.bind(tediId)
		.first();
}

export async function getTediRuntimePolicy(
	db: RuntimeD1Read,
	tediId: string,
): Promise<{
	definition: string | null;
	runtimeOverrides: string | null;
} | null> {
	return db
		.prepare(
			`SELECT pp.definition AS definition,
			        t.runtime_overrides AS runtimeOverrides
			   FROM tedis t
			   JOIN policy_packs pp ON pp.id = COALESCE(
			     t.policy_pack_id,
			     (SELECT fallback.id
			        FROM policy_packs fallback
			       WHERE fallback.slug = 'system-default'
			         AND fallback.scope = 'system'
			         AND fallback.status = 'active'
			       ORDER BY fallback.version DESC
			       LIMIT 1)
			   )
			  WHERE t.id = ?
			  LIMIT 1`,
		)
		.bind(tediId)
		.first();
}

export async function getTediRuntimeRepoConfig(
	db: RuntimeD1Read,
	tediId: string,
): Promise<string | null> {
	const row = await db
		.prepare("SELECT repo_config FROM tedis WHERE id = ? LIMIT 1")
		.bind(tediId)
		.first<{ repo_config: string | null }>();
	return row?.repo_config ?? null;
}

export interface TediRuntimeApprovalRow {
	status: string;
	resolution: string | null;
	tediId: string;
	payload: string;
}

export async function getTediRuntimeApproval(
	db: RuntimeD1Read,
	id: string,
): Promise<TediRuntimeApprovalRow | null> {
	return db
		.prepare(
			`SELECT status, resolution, tedi_id AS tediId, payload
			   FROM tedi_approval_requests
			  WHERE id = ?
			  LIMIT 1`,
		)
		.bind(id)
		.first<TediRuntimeApprovalRow>();
}

export async function updateTediRuntimeApprovalResolution(
	db: RuntimeD1,
	id: string,
	resolution: string,
): Promise<void> {
	await db
		.prepare("UPDATE tedi_approval_requests SET resolution = ? WHERE id = ?")
		.bind(resolution, id)
		.run();
}

export async function getTediRuntimeCanonicalIsolateId(
	db: RuntimeD1Read,
	tediId: string,
): Promise<{ exists: boolean; isolateAgentId: string | null }> {
	const row = await db
		.prepare(
			"SELECT isolate_agent_id AS isolateAgentId FROM tedis WHERE id = ? LIMIT 1",
		)
		.bind(tediId)
		.first<{ isolateAgentId: string | null }>();
	return { exists: row != null, isolateAgentId: row?.isolateAgentId ?? null };
}
