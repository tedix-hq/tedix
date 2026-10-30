import { sha256Hex } from "@tedix/worker-kit/crypto";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { SelectedConnectionCredential } from "@tedix/api-contract/schemas/connections";
import { aggregateAndPrefixTools } from "../aggregate-surface";
import { getApiClient } from "../lib/api-client";
import type { AppTool } from "./server-context";

/** A server-produced description; it conveys no authority by itself. */
export interface TenantPolicyMountDescriptor {
	version: 1;
	organizationId: string;
	rootAppId: string;
	sourceAppId: string;
	sourceToolRowId: string;
	sourceToolId: string;
	mountAppIds: string[];
	mountedToolId: string;
	transport: "mcp";
	upstreamOperation: string;
	providerId: string;
	connectionInstanceId: string;
	credentialScope: "tenant";
	requestedScopes: string[];
	effectiveToolDigest: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (isRecord(value)) {
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			if (value[key] !== undefined) result[key] = canonicalize(value[key]);
		}
		return result;
	}
	return value;
}

export function tenantPolicyDescriptorDigest(
	descriptor: unknown,
): Promise<string> {
	return sha256Hex(JSON.stringify(canonicalize(descriptor)));
}

export function tenantPolicyEffectiveToolDigest(
	tool: AppTool,
): Promise<string> {
	return tenantPolicyDescriptorDigest({
		config: tool.config,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
		meta: tool.meta,
		writeCapability: tool.writeCapability,
		actionType: tool.actionType,
		sensitiveData: tool.sensitiveData,
		publicEgress: tool.publicEgress,
		authRequired: tool.authRequired ?? false,
		visibility: tool.visibility ?? "public",
	});
}

/** Compare only presentation-independent mount data; connection overrides remain bound. */
export function tenantPolicyCrossMountDigest(tool: AppTool): Promise<string> {
	const config = { ...(tool.config ?? {}) };
	delete config._aggregateNamespace;
	delete config._aggregateLegacyNamespace;
	delete config._multiOrgOrganizationId;
	delete config._sourceAppId;
	delete config._sourceAppSlug;
	delete config._sourceAuthRequired;
	delete config._sourceVisibility;
	return tenantPolicyEffectiveToolDigest({ ...tool, config });
}

/**
 * Compare two independently verified mounts without depending on their wire
 * namespaces. Only presentation/projection fields are removed; the effective
 * connection, resource, schema and operation remain in the digest.
 */
export async function tenantPolicyLogicalToolDigest(input: {
	organizationId: string;
	sourceAppId: string;
	sourceToolId: string;
	tool: AppTool;
	credential: SelectedConnectionCredential;
	accountRevisionDigest: string;
}): Promise<string | null> {
	const {
		organizationId,
		sourceAppId,
		sourceToolId,
		tool,
		credential,
		accountRevisionDigest,
	} = input;
	const config = tool.config;
	if (
		!organizationId ||
		!sourceAppId ||
		!sourceToolId ||
		!tool.id ||
		!config ||
		!/^[a-f0-9]{64}$/.test(accountRevisionDigest) ||
		credential.organizationId !== organizationId ||
		!credential.providerId ||
		!credential.connectionInstanceId ||
		!UUID.test(credential.connectionInstanceId) ||
		(credential.scope === "user" && !credential.userId) ||
		(config._sourceAppId !== undefined &&
			config._sourceAppId !== sourceAppId) ||
		(config._multiOrgOrganizationId !== undefined &&
			config._multiOrgOrganizationId !== organizationId)
	)
		return null;
	const normalizedConfig = { ...config };
	delete normalizedConfig._aggregateNamespace;
	delete normalizedConfig._aggregateLegacyNamespace;
	delete normalizedConfig._multiOrgOrganizationId;
	delete normalizedConfig._sourceAppSlug;
	return sha256Hex(
		JSON.stringify(
			canonicalize({
				organizationId,
				sourceAppId,
				sourceToolId,
				sourceToolRowId: tool.id,
				config: normalizedConfig,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
				writeCapability: tool.writeCapability,
				actionType: tool.actionType,
				sensitiveData: tool.sensitiveData,
				publicEgress: tool.publicEgress,
				credential,
				accountRevisionDigest,
			}),
		),
	);
}

/**
 * Build only after a fresh server-owned mount resolution and multi-org selection.
 * Refuse ambiguous credential selection: the vault's named-account path checks
 * the organization, provider and exact instance without a default fallback.
 */
export async function tenantPolicyMountDescriptor(input: {
	organizationId: string;
	rootAppId: string;
	sourceAppId: string;
	sourceToolId: string;
	mountAppIds: string[];
	tool: AppTool;
}): Promise<TenantPolicyMountDescriptor | null> {
	const {
		organizationId,
		rootAppId,
		sourceAppId,
		sourceToolId,
		mountAppIds,
		tool,
	} = input;
	const config = tool.config;
	const auth = isRecord(config?.auth) ? config.auth : null;
	const selectedInstance =
		auth?.connectionInstanceId ?? config?._aggregateConnectionInstanceId;
	const scope = auth?.credentialScope ?? auth?.scope ?? "tenant";
	if (
		!organizationId ||
		!rootAppId ||
		!sourceAppId ||
		!sourceToolId ||
		mountAppIds.length === 0 ||
		mountAppIds.length > 16 ||
		mountAppIds[0] !== rootAppId ||
		mountAppIds.at(-1) !== sourceAppId ||
		new Set(mountAppIds).size !== mountAppIds.length ||
		!tool.id ||
		!tool.toolId ||
		!config ||
		config.transport !== "mcp" ||
		typeof config.mcpToolName !== "string" ||
		!config.mcpToolName ||
		auth?.type !== "connection" ||
		typeof auth.connectionId !== "string" ||
		!auth.connectionId ||
		(auth.scopes !== undefined &&
			(!Array.isArray(auth.scopes) ||
				!auth.scopes.every((item) => typeof item === "string"))) ||
		typeof selectedInstance !== "string" ||
		!UUID.test(selectedInstance) ||
		scope !== "tenant" ||
		(config._sourceAppId !== undefined &&
			config._sourceAppId !== sourceAppId) ||
		(config._multiOrgOrganizationId !== undefined &&
			config._multiOrgOrganizationId !== organizationId)
	)
		return null;
	const effectiveToolDigest = await tenantPolicyEffectiveToolDigest(tool);
	return {
		version: 1,
		organizationId,
		rootAppId,
		sourceAppId,
		sourceToolRowId: tool.id,
		sourceToolId,
		mountAppIds,
		mountedToolId: tool.toolId,
		transport: "mcp",
		upstreamOperation: config.mcpToolName,
		providerId: auth.connectionId,
		connectionInstanceId: selectedInstance,
		credentialScope: "tenant",
		requestedScopes: Array.isArray(auth.scopes)
			? (auth.scopes as string[])
			: [],
		effectiveToolDigest,
	};
}

type PrepareMountInput = {
	organizationId: string;
	rootAppId: string;
	mountedToolId: string;
	env: CloudflareEnv;
	ctx?: ExecutionContext;
};

/** Resolve an organization gateway mount without any aggregate cache tier. */
export async function resolveFreshPolicyMount(input: PrepareMountInput) {
	const client = getApiClient({
		serviceFetch: input.env.API_SERVICE,
		orgId: input.organizationId,
	});
	const root = await client.apps.getByIdWithTools({ appId: input.rootAppId });
	if (!root.app || root.app.organizationId !== input.organizationId)
		return null;
	const surface = await aggregateAndPrefixTools(
		[
			{
				slug: root.app.slug,
				prefix: root.app.slug,
				organizationId: input.organizationId,
				organizationMount: true,
			},
		],
		input.env,
		new Set(),
		input.ctx,
		root.app.slug,
		{ value: "tenant-policy-fresh", cacheable: false },
		false,
		false,
		true,
	);
	if (surface.degraded) return null;
	const matches = surface.tools.filter(
		(tool) => tool.toolId === input.mountedToolId,
	);
	if (matches.length !== 1) return null;
	const tool = matches[0]!;
	const mountAppIds = tool.policyMountAppIds;
	const sourceAppId = tool.config?._sourceAppId;
	if (
		typeof sourceAppId !== "string" ||
		!mountAppIds ||
		mountAppIds.length > 16 ||
		mountAppIds[0] !== input.rootAppId ||
		mountAppIds.at(-1) !== sourceAppId
	)
		return null;
	const mountedApps = await Promise.all(
		mountAppIds.map((appId) => client.apps.getByIdWithTools({ appId })),
	);
	if (
		mountedApps.some(
			(result) =>
				!result.app || result.app.organizationId !== input.organizationId,
		)
	)
		return null;
	const source = await client.apps.getByIdWithTools({ appId: sourceAppId });
	const sourceTool = source.tools.find((row) => row.id === tool.id);
	if (
		!source.app ||
		source.app.organizationId !== input.organizationId ||
		!sourceTool ||
		!sourceTool.toolId
	)
		return null;
	return { tool, sourceAppId, sourceToolId: sourceTool.toolId, mountAppIds };
}

export async function prepareTenantPolicyMount(
	input: PrepareMountInput,
): Promise<{
	descriptor: TenantPolicyMountDescriptor;
	descriptorDigest: string;
} | null> {
	const resolved = await resolveFreshPolicyMount(input);
	if (!resolved) return null;
	const descriptor = await tenantPolicyMountDescriptor({
		...input,
		...resolved,
	});
	if (!descriptor) return null;
	return {
		descriptor,
		descriptorDigest: await tenantPolicyDescriptorDigest(descriptor),
	};
}

/** Accept only an object schema with no unsupported root constraints. */
export function acceptsEmptyProfileArguments(schema: unknown): boolean {
	if (!isRecord(schema) || schema.type !== "object") return false;
	const known = new Set([
		"type",
		"properties",
		"required",
		"additionalProperties",
		"title",
		"description",
		"minProperties",
		"maxProperties",
	]);
	if (Object.keys(schema).some((key) => !known.has(key))) return false;
	if (schema.properties !== undefined && !isRecord(schema.properties))
		return false;
	if (
		isRecord(schema.properties) &&
		Object.values(schema.properties).some(
			(child) => typeof child !== "boolean" && !isRecord(child),
		)
	)
		return false;
	if (
		schema.additionalProperties !== undefined &&
		typeof schema.additionalProperties !== "boolean" &&
		!isRecord(schema.additionalProperties)
	)
		return false;
	if (schema.title !== undefined && typeof schema.title !== "string")
		return false;
	if (
		schema.description !== undefined &&
		typeof schema.description !== "string"
	)
		return false;
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || schema.required.length !== 0)
	)
		return false;
	if (schema.minProperties !== undefined && schema.minProperties !== 0)
		return false;
	if (
		schema.maxProperties !== undefined &&
		(!Number.isInteger(schema.maxProperties) ||
			(schema.maxProperties as number) < 0)
	)
		return false;
	return true;
}

/** Review data only; profile identity is not an authorization decision. */
export async function prepareTenantIdentityProfileMount(
	input: PrepareMountInput,
) {
	const resolved = await resolveFreshPolicyMount(input);
	if (!resolved) return null;
	const { tool, sourceAppId, sourceToolId, mountAppIds } = resolved;
	const config = tool.config;
	const auth = isRecord(config?.auth) ? config.auth : null;
	const scope = auth?.credentialScope ?? auth?.scope ?? "tenant";
	const instance =
		auth?.connectionInstanceId ?? config?._aggregateConnectionInstanceId;
	if (
		!config ||
		config.transport !== "mcp" ||
		typeof config.mcpServerUrl !== "string" ||
		!config.mcpServerUrl ||
		typeof config.mcpToolName !== "string" ||
		!config.mcpToolName ||
		auth?.type !== "connection" ||
		typeof auth.connectionId !== "string" ||
		!auth.connectionId ||
		(scope !== "tenant" && scope !== "user" && scope !== "hybrid") ||
		(instance !== undefined &&
			(typeof instance !== "string" || !UUID.test(instance))) ||
		(auth.scopes !== undefined &&
			(!Array.isArray(auth.scopes) ||
				!auth.scopes.every((item) => typeof item === "string"))) ||
		(auth.credentialPreference !== undefined &&
			auth.credentialPreference !== "user-first" &&
			auth.credentialPreference !== "tenant-first")
	)
		return null;
	const descriptor = {
		version: 1 as const,
		organizationId: input.organizationId,
		rootAppId: input.rootAppId,
		mountAppIds,
		sourceAppId,
		sourceToolRowId: tool.id,
		sourceToolId,
		mountedToolId: tool.toolId,
		transport: "mcp" as const,
		upstreamOperation: config.mcpToolName,
		endpointDigest: await sha256Hex(config.mcpServerUrl),
		acceptsEmptyArguments: acceptsEmptyProfileArguments(tool.inputSchema),
		authBindingDigest: await sha256Hex(
			JSON.stringify(
				canonicalize({
					auth,
					aggregateLabel: config._aggregateConnectionLabel,
					forwardedQueryParams: config._forwardedQueryParams,
					headers: config.headers,
					connectionInstanceId: instance,
				}),
			),
		),
		effectiveToolDigest: await tenantPolicyEffectiveToolDigest(tool),
		providerId: auth.connectionId,
		connectionScope: scope,
		...(auth.credentialPreference
			? { credentialPreference: auth.credentialPreference }
			: {}),
		...(instance ? { connectionInstanceId: instance } : {}),
		requestedScopes: Array.isArray(auth.scopes)
			? (auth.scopes as string[])
			: [],
	};
	return {
		descriptor,
		descriptorDigest: await sha256Hex(JSON.stringify(canonicalize(descriptor))),
	};
}

/** Prepare an owner-reviewable RPC mount from fresh authoritative rows. */
export async function prepareTenantNativePolicyMount(input: PrepareMountInput) {
	const resolved = await resolveFreshPolicyMount(input);
	if (
		!resolved ||
		resolved.tool.enabled === false ||
		resolved.tool.config?.transport !== "rpc" ||
		typeof resolved.tool.config.endpoint !== "string" ||
		!resolved.tool.config.endpoint
	)
		return null;
	const descriptor = {
		version: 1 as const,
		organizationId: input.organizationId,
		rootAppId: input.rootAppId,
		mountAppIds: resolved.mountAppIds,
		sourceAppId: resolved.sourceAppId,
		sourceToolRowId: resolved.tool.id,
		sourceToolId: resolved.sourceToolId,
		mountedToolId: resolved.tool.toolId,
		transport: "rpc" as const,
		endpoint: resolved.tool.config.endpoint,
		effectiveToolDigest: await tenantPolicyEffectiveToolDigest(resolved.tool),
	};
	return {
		descriptor,
		descriptorDigest: await tenantPolicyDescriptorDigest(descriptor),
	};
}
