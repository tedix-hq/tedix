#!/usr/bin/env bun

/**
 * Read-only audit: compare every live installed provider tool binding and
 * connection against the reviewed provider capability profiles
 * (`packages/api-contract/src/utils/provider-capability-profiles.ts`).
 *
 * Since Work 332131b9 the runtime refuses a binding or connection whose
 * declared resources or requested scopes exceed its reviewed profile. This
 * script lists, for every organization, the rows that would now be refused —
 * for GitHub, Notion, Gmail, Google Calendar and Microsoft Graph calendar —
 * plus a dated per-provider count, so the result can be posted to Work with
 * no customer content (ids and provider constants only; never resource ids,
 * labels or account subjects).
 *
 * Ops only: runs the same audited remote-D1 transport as the other operator
 * scripts. It reads; it never writes.
 *
 *   bun scripts/db/audit-provider-capabilities.ts
 *
 * Exits 1 when any binding exceeds its profile, 0 otherwise.
 */

import { fileURLToPath } from "node:url";
import { ConnectionAllowedResourcesSchema } from "@tedix/api-contract/schemas/connections";
import {
	consentScopeProfile,
	personalAccountCapabilityProfile,
	PERSONAL_ORGANISE_OPERATION,
	resourceCapabilityProfile,
} from "@tedix/api-contract/utils/provider-capability-profiles";
import { effectivePersonalResourceBinding } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { resolveConnectionResourceAccess } from "@tedix/api-contract/utils/connection-resource-policy";
import { remoteD1Execute } from "../lib/remote-d1.ts";

const CALLER = "scripts/db/audit-provider-capabilities.ts";

/** The five providers under review: canonical `connection_providers.id` values. */
export const WATCHED_PROVIDER_IDS = [
	"github",
	"notion",
	"google-gmail",
	"google-calendar",
	"microsoft-graph-calendar-tedix",
] as const;

/** Consent scope profiles a provider's stored `required_scopes` must stay inside. */
const CONSENT_PROFILES_BY_PROVIDER: Record<string, readonly string[]> = {
	"google-calendar": [
		"google-calendar-attach",
		"google-calendar-event-read",
		"google-calendar-event-write",
	],
	"google-gmail": ["google-gmail-compose"],
	"microsoft-graph-calendar-tedix": [
		"microsoft-calendar-read",
		"microsoft-calendar-write",
	],
};

/** Operations the stored delegation paths are reviewed to use. */
const REVIEWED_DELEGATION_OPERATIONS = new Set([
	"read",
	PERSONAL_ORGANISE_OPERATION,
	"create",
	"update",
	"delete",
]);

// ---------------------------------------------------------------------------
// Snapshot rows (projection only — no labels, token ids or resource payloads)
// ---------------------------------------------------------------------------

export interface ProviderRow {
	id: string;
	descope_app_id: string | null;
	descope_app_aliases: string | null;
}
export interface InstanceRow {
	id: string;
	organization_id: string | null;
	provider_id: string;
	allowed_resources: string | null;
}
export interface OrgLimitsRow {
	id: string;
	resource_limits: string | null;
}
export interface ToolRow {
	tool_row_id: string;
	app_id: string;
	tool_id: string;
	organization_id: string;
	transport: string | null;
	mcp_tool_name: string | null;
	mcp_server_url: string | null;
	auth_type: string | null;
	auth_connection_id: string | null;
	auth_connection_instance_id: string | null;
	auth_scope: string | null;
	auth_credential_scope: string | null;
	personal_resource_binding: string | null;
	app_connection_provider_id: string | null;
	app_connection_instance_id: string | null;
	app_connection_scope: string | null;
}
export interface WorkspaceResourceRow {
	id: string;
	organization_id: string;
	provider_id: string;
	connection_scope: string;
	resource_type: string;
	required_scopes: string;
}
export interface DelegationRow {
	id: string;
	organization_id: string;
	provider_id: string;
	resource_type: string;
	required_scopes: string;
	operations: string;
	expires_at: string;
}

export interface AuditSnapshot {
	providers: ProviderRow[];
	instances: InstanceRow[];
	orgLimits: OrgLimitsRow[];
	tools: ToolRow[];
	workspaceResources: WorkspaceResourceRow[];
	delegations: DelegationRow[];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface AuditFinding {
	organizationId: string;
	providerId: string;
	providerAppId: string;
	kind:
		| "connection-instance"
		| "org-resource-limits"
		| "app-tool"
		| "workspace-resource"
		| "delegation";
	id: string;
	detail: string;
}

export interface ProviderAuditCount {
	providerId: string;
	checked: {
		instances: number;
		orgLimits: number;
		tools: number;
		workspaceResources: number;
		delegations: number;
	};
	exceeding: number;
}

export interface AuditReport {
	checkedAt: string;
	providers: ProviderAuditCount[];
	/** Rows whose provider id matched no watched provider; excluded from counts. */
	unclassifiedProviderRows: number;
	findings: AuditFinding[];
}

function parseJson(value: string | null): { ok: boolean; value: unknown } {
	if (value === null) return { ok: true, value: null };
	try {
		return { ok: true, value: JSON.parse(value) };
	} catch {
		return { ok: false, value: undefined };
	}
}

function reviewedScopes(providerId: string): Set<string> {
	const scopes = new Set<string>(
		personalAccountCapabilityProfile(providerId)?.readScopes ?? [],
	);
	for (const profileId of CONSENT_PROFILES_BY_PROVIDER[providerId] ?? []) {
		const profile = consentScopeProfile(profileId);
		for (const scope of profile.anyOf) scopes.add(scope);
		for (const scope of profile.requests ?? []) scopes.add(scope);
	}
	return scopes;
}

/** The resourceType a canonical provider's connection profile governs. */
function expectedResourceType(providerId: string): string | undefined {
	return { github: "github_repository", notion: "notion_page" }[providerId];
}

function orgOf(row: { organization_id: string | null }): string {
	return row.organization_id ?? "(personal)";
}

/**
 * The same verdict the runtime reaches for one stored allowed-resources value:
 * null is unconstrained; anything that fails the closed resource schema, an
 * empty list, or a type the provider's profile does not govern fails closed.
 */
export function checkAllowedResources(
	raw: string | null,
	providerId: string,
): string | null {
	if (raw === null) return null;
	const parsed = parseJson(raw);
	if (!parsed.ok) return "allowed_resources is not readable JSON";
	const policy = ConnectionAllowedResourcesSchema.safeParse(parsed.value);
	if (!policy.success)
		return "allowed_resources fails the reviewed connection resource schema";
	if (!policy.data.length)
		return "empty allowed_resources refuses every bound tool";
	const type = policy.data[0]!.resourceType;
	if (!resourceCapabilityProfile(type))
		return `resource type ${type} has no reviewed capability profile`;
	if (type !== expectedResourceType(providerId))
		return `resource type ${type} is outside the ${providerId} profile`;
	return null;
}

function scopeFindings(
	raw: string,
	reviewed: Set<string>,
): { invalid: boolean; outside: string[] } {
	const parsed = parseJson(raw);
	if (!parsed.ok || !Array.isArray(parsed.value))
		return { invalid: true, outside: [] };
	const outside = parsed.value.filter(
		(scope) => typeof scope === "string" && !reviewed.has(scope),
	) as string[];
	return {
		invalid: parsed.value.some((scope) => typeof scope !== "string"),
		outside,
	};
}

/** Mirrors filterAppConnectionResourceTools' provider/instance/scope resolution. */
export function auditProviderCapabilitySnapshot(
	snapshot: AuditSnapshot,
	now = new Date(),
): AuditReport {
	const watched = new Set<string>(WATCHED_PROVIDER_IDS);
	const canonical = new Map<string, string>();
	for (const provider of snapshot.providers) {
		if (!watched.has(provider.id)) continue;
		canonical.set(provider.id, provider.id);
		for (const key of [provider.descope_app_id])
			if (key) canonical.set(key, provider.id);
		const aliases = parseJson(provider.descope_app_aliases);
		if (aliases.ok && Array.isArray(aliases.value))
			for (const key of aliases.value)
				if (typeof key === "string") canonical.set(key, provider.id);
	}
	const resolveProvider = (providerId: string | null | undefined) =>
		providerId
			? (canonical.get(providerId) ??
				(watched.has(providerId) ? providerId : undefined))
			: undefined;

	const counts = new Map<string, ProviderAuditCount>(
		WATCHED_PROVIDER_IDS.map((id) => [
			id,
			{
				providerId: id,
				checked: {
					instances: 0,
					orgLimits: 0,
					tools: 0,
					workspaceResources: 0,
					delegations: 0,
				},
				exceeding: 0,
			},
		]),
	);
	const findings: AuditFinding[] = [];
	let unclassifiedProviderRows = 0;
	const flag = (finding: AuditFinding) => {
		findings.push(finding);
		const count = counts.get(finding.providerId);
		if (count) count.exceeding += 1;
	};

	const instanceIndex = new Map<string, InstanceRow>();
	for (const instance of snapshot.instances) {
		const providerId = resolveProvider(instance.provider_id);
		if (!providerId) {
			unclassifiedProviderRows += 1;
			continue;
		}
		counts.get(providerId)!.checked.instances += 1;
		if (instance.organization_id)
			instanceIndex.set(
				`${instance.organization_id}${instance.provider_id}${instance.id}`,
				instance,
			);
		const detail = checkAllowedResources(
			instance.allowed_resources,
			providerId,
		);
		if (detail)
			flag({
				organizationId: orgOf(instance),
				providerId,
				providerAppId: instance.provider_id,
				kind: "connection-instance",
				id: instance.id,
				detail,
			});
	}

	const orgLimitMap = new Map<string, Map<string, unknown>>();
	for (const org of snapshot.orgLimits) {
		const limits = parseJson(org.resource_limits);
		const entries =
			limits.ok && typeof limits.value === "object" && limits.value !== null
				? Object.entries(limits.value as Record<string, unknown>)
				: [];
		for (const [providerKey, raw] of entries) {
			const providerId = resolveProvider(providerKey);
			if (!providerId) continue;
			counts.get(providerId)!.checked.orgLimits += 1;
			orgLimitMap.set(`${org.id}${providerKey}`, new Map([[providerKey, raw]]));
			const detail = checkAllowedResources(
				raw === null ? null : JSON.stringify(raw),
				providerId,
			);
			if (detail)
				flag({
					organizationId: org.id,
					providerId,
					providerAppId: providerKey,
					kind: "org-resource-limits",
					id: org.id,
					detail: `connectionResourceLimits["${providerKey}"]: ${detail}`,
				});
		}
	}

	for (const tool of snapshot.tools) {
		const ownProvider =
			tool.auth_type === "connection" ? tool.auth_connection_id : null;
		const providerKey = tool.app_connection_provider_id ?? ownProvider;
		const providerId = resolveProvider(providerKey);
		const installedBinding = parseJson(tool.personal_resource_binding);
		if (!providerKey || !providerId) {
			if (tool.personal_resource_binding !== null)
				unclassifiedProviderRows += 1;
			continue;
		}
		counts.get(providerId)!.checked.tools += 1;
		const inherited = Boolean(tool.app_connection_provider_id);
		const scope =
			tool.app_connection_scope ??
			tool.auth_credential_scope ??
			tool.auth_scope ??
			"tenant";
		const orgId = tool.organization_id;

		if (scope !== "user" && providerKey) {
			const instanceId =
				tool.auth_connection_instance_id ??
				(inherited ? tool.app_connection_instance_id : null);
			const instance = instanceId
				? instanceIndex.get(`${orgId}${providerKey}${instanceId}`)
				: undefined;
			const orgLimits =
				orgLimitMap.get(`${orgId}${providerKey}`)?.get(providerKey) ?? null;
			const additionalLimits = instance
				? [parseJson(instance.allowed_resources).value]
				: [];
			const config = {
				transport: tool.transport,
				mcpToolName: tool.mcp_tool_name,
				mcpServerUrl: tool.mcp_server_url,
				auth: { type: tool.auth_type, connectionId: tool.auth_connection_id },
			};
			const effectiveConfig =
				tool.auth_type && tool.auth_type !== "connection"
					? config
					: {
							...config,
							auth: {
								...config.auth,
								type: "connection",
								connectionId: providerKey,
							},
						};
			const decision = resolveConnectionResourceAccess({
				allowedResources: orgLimits,
				additionalLimits,
				providerId: providerKey,
				config: effectiveConfig,
			});
			if (!decision.allowed) {
				let detail = "connection resource policy refuses this tool binding";
				if (tool.mcp_tool_name) {
					const expected = expectedResourceType(providerId);
					const profile = expected
						? resourceCapabilityProfile(expected)
						: undefined;
					if (profile && !Object.hasOwn(profile.tools, tool.mcp_tool_name))
						detail = `provider tool ${tool.mcp_tool_name} is outside the reviewed ${expected} profile`;
					else if (profile?.endpoint && !profile.endpoint(effectiveConfig))
						detail = `upstream endpoint is outside the reviewed ${providerId} profile`;
				}
				flag({
					organizationId: orgId,
					providerId,
					providerAppId: providerKey,
					kind: "app-tool",
					id: tool.tool_row_id,
					detail: `${detail} (app ${tool.app_id}, tool ${tool.tool_id})`,
				});
			}
		}

		const hasPersonalProfile = Boolean(
			personalAccountCapabilityProfile(providerId),
		);
		const bindingSupplied = tool.personal_resource_binding !== null;
		if (bindingSupplied || (hasPersonalProfile && scope === "user")) {
			const effective = effectivePersonalResourceBinding(
				providerKey,
				tool.mcp_tool_name,
				installedBinding.ok
					? installedBinding.value
					: tool.personal_resource_binding,
			);
			if (effective === undefined)
				flag({
					organizationId: orgId,
					providerId,
					providerAppId: providerKey,
					kind: "app-tool",
					id: tool.tool_row_id,
					detail: bindingSupplied
						? `installed personal-resource binding is outside the reviewed ${providerId} profile (app ${tool.app_id}, tool ${tool.tool_id})`
						: `provider tool ${tool.mcp_tool_name ?? "?"} is absent from the reviewed ${providerId} account profile; user-scope use cannot be delegated (app ${tool.app_id}, tool ${tool.tool_id})`,
				});
		}
	}

	for (const resource of snapshot.workspaceResources) {
		const providerId = resolveProvider(resource.provider_id);
		if (!providerId) {
			unclassifiedProviderRows += 1;
			continue;
		}
		counts.get(providerId)!.checked.workspaceResources += 1;
		const reviewed = reviewedScopes(providerId);
		const scopes = scopeFindings(resource.required_scopes, reviewed);
		if (scopes.invalid || scopes.outside.length)
			flag({
				organizationId: resource.organization_id,
				providerId,
				providerAppId: resource.provider_id,
				kind: "workspace-resource",
				id: resource.id,
				detail: scopes.invalid
					? "required_scopes is not a scope list"
					: `requested scope outside the reviewed ${providerId} profile: ${scopes.outside.join(", ")}`,
			});
	}

	for (const delegation of snapshot.delegations) {
		if (Date.parse(delegation.expires_at) <= now.getTime()) continue;
		const providerId = resolveProvider(delegation.provider_id);
		if (!providerId) {
			unclassifiedProviderRows += 1;
			continue;
		}
		counts.get(providerId)!.checked.delegations += 1;
		const reviewed = reviewedScopes(providerId);
		const scopes = scopeFindings(delegation.required_scopes, reviewed);
		if (scopes.invalid || scopes.outside.length)
			flag({
				organizationId: delegation.organization_id,
				providerId,
				providerAppId: delegation.provider_id,
				kind: "delegation",
				id: delegation.id,
				detail: scopes.invalid
					? "required_scopes is not a scope list"
					: `requested scope outside the reviewed ${providerId} profile: ${scopes.outside.join(", ")}`,
			});
		const operations = parseJson(delegation.operations);
		if (operations.ok && Array.isArray(operations.value)) {
			const outside = operations.value.filter(
				(operation) =>
					typeof operation !== "string" ||
					!REVIEWED_DELEGATION_OPERATIONS.has(operation),
			);
			if (outside.length)
				flag({
					organizationId: delegation.organization_id,
					providerId,
					providerAppId: delegation.provider_id,
					kind: "delegation",
					id: delegation.id,
					detail: `operation outside the reviewed delegation vocabulary: ${outside.join(", ")}`,
				});
		}
	}

	return {
		checkedAt: now.toISOString(),
		providers: [...counts.values()],
		unclassifiedProviderRows,
		findings,
	};
}

// ---------------------------------------------------------------------------
// Reads (projection columns only — no customer content leaves the database)
// ---------------------------------------------------------------------------

const READS: { key: keyof AuditSnapshot; sql: string }[] = [
	{
		key: "providers",
		sql: `SELECT id, descope_app_id, descope_app_aliases FROM connection_providers`,
	},
	{
		key: "instances",
		sql: `SELECT id, organization_id, provider_id, allowed_resources FROM connection_instances`,
	},
	{
		key: "orgLimits",
		sql: `SELECT id, json_extract(metadata, '$.connectionResourceLimits') AS resource_limits FROM organizations`,
	},
	{
		key: "tools",
		sql: `SELECT t.id AS tool_row_id, t.app_id, t.tool_id, a.organization_id, json_extract(t.config,'$.transport') AS transport, json_extract(t.config,'$.mcpToolName') AS mcp_tool_name, json_extract(t.config,'$.mcpServerUrl') AS mcp_server_url, json_extract(t.config,'$.auth.type') AS auth_type, json_extract(t.config,'$.auth.connectionId') AS auth_connection_id, json_extract(t.config,'$.auth.connectionInstanceId') AS auth_connection_instance_id, json_extract(t.config,'$.auth.scope') AS auth_scope, json_extract(t.config,'$.auth.credentialScope') AS auth_credential_scope, json_extract(t.config,'$.personalResourceBinding') AS personal_resource_binding, json_extract(a.metadata,'$.mcpConfig.connectionProviderId') AS app_connection_provider_id, json_extract(a.metadata,'$.mcpConfig.connectionInstanceId') AS app_connection_instance_id, json_extract(a.metadata,'$.mcpConfig.connectionScope') AS app_connection_scope FROM app_tools t JOIN apps a ON a.id = t.app_id WHERE t.enabled = 1`,
	},
	{
		key: "workspaceResources",
		sql: `SELECT id, organization_id, provider_id, connection_scope, resource_type, required_scopes FROM os_workspace_resources WHERE status = 'active'`,
	},
	{
		key: "delegations",
		sql: `SELECT id, organization_id, provider_id, resource_type, required_scopes, operations, expires_at FROM personal_resource_delegations WHERE revoked_at IS NULL`,
	},
];

async function readRows<T>(sql: string): Promise<T[]> {
	const parsed = await remoteD1Execute({
		database: "DB",
		config: fileURLToPath(
			new URL("../../apps/api/wrangler.jsonc", import.meta.url),
		),
		sql,
		caller: CALLER,
	});
	return (parsed[0]?.results ?? []) as T[];
}

async function main() {
	const snapshot = Object.fromEntries(
		await Promise.all(
			READS.map(async (read) => [read.key, await readRows(read.sql)]),
		),
	) as unknown as AuditSnapshot;
	const report = auditProviderCapabilitySnapshot(snapshot);
	console.log(JSON.stringify(report, null, 2));
	const checked = (count: ProviderAuditCount) =>
		Object.values(count.checked).reduce((sum, value) => sum + value, 0);
	for (const count of report.providers) {
		console.log(
			`${report.checkedAt.slice(0, 10)} ${count.providerId}: ${checked(count)} bindings checked, ${count.exceeding} exceeding the reviewed profile`,
		);
	}
	if (report.unclassifiedProviderRows)
		console.log(
			`${report.unclassifiedProviderRows} row(s) referenced providers outside this audit and were skipped`,
		);
	if (report.findings.length)
		console.log(
			`${report.findings.length} binding(s) would now be refused; see findings (ids only, no customer content)`,
		);
	process.exitCode = report.findings.length ? 1 : 0;
}

if (import.meta.main)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
