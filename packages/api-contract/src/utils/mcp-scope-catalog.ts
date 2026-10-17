import scopePolicy from "../config/mcp-scope-policy.v1.json";

/** Generic consent policy; provider mappings remain in D1 app mcpConfig. */
export const MCP_SCOPE_POLICY = scopePolicy;
export const CONNECTION_SCOPE_DESCRIPTIONS: Record<string, string> =
	Object.fromEntries(
		Object.entries({
			...scopePolicy.connectionScopes,
			...scopePolicy.operatorScopes,
		}).map(([name, definition]) => [name, definition.description]),
	);
export const MCP_PLATFORM_SCOPES = [
	...Object.keys(scopePolicy.connectionScopes),
	...Object.entries(scopePolicy.protocolScopes)
		.filter(([, definition]) => definition.advertise)
		.map(([name]) => name),
];

export interface ConnectionScopeDefinition {
	name: string;
	description?: string;
	optional?: boolean;
	values?: string[];
	[key: string]: unknown;
}
export interface ConnectionScopeCatalog {
	permissionsScopes?: ConnectionScopeDefinition[];
	attributesScopes?: ConnectionScopeDefinition[];
	connectionsScopes?: ConnectionScopeDefinition[];
	[key: string]: unknown;
}

export function normalizeConnectionScopes(scopes: readonly string[]): string[] {
	return [
		...new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
	].sort();
}

export interface ConnectionScopeConfig {
	connectionProviderId?: string;
	connectionScopes?: string[];
	toolScopes?: Record<string, string[]>;
	aggregateApps?: Array<{
		prefix?: string;
		slug: string;
		connectionProviderId?: string;
		connectionScopes?: string[];
	}>;
}

export function connectionScopeMappingState(
	approved: ConnectionScopeCatalog | null | undefined,
): Record<string, { values: string[]; optional: boolean }> {
	return Object.fromEntries(
		(approved?.connectionsScopes ?? [])
			.filter((scope) => scope.values !== undefined)
			.map(
				(scope) =>
					[
						scope.name,
						{
							values: normalizeConnectionScopes(scope.values ?? []),
							optional: scope.optional === true,
						},
					] as const,
			)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

export function connectionScopeMappingValues(
	approved: ConnectionScopeCatalog | null | undefined,
): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(connectionScopeMappingState(approved)).map(
			([name, state]) => [name, state.values],
		),
	);
}

/** Map only explicitly configured capabilities; never infer provider access from a scope name. */
export function reconcileConnectionScopeMappings(
	approved: ConnectionScopeCatalog | null | undefined,
	config: ConnectionScopeConfig,
): ConnectionScopeCatalog {
	const valuesByName = new Map<string, Set<string>>();
	for (const [namespace, names] of Object.entries(config.toolScopes ?? {})) {
		const entry = config.aggregateApps?.find(
			(app) => (app.prefix ?? app.slug) === namespace,
		);
		const providerId =
			entry?.connectionProviderId ?? config.connectionProviderId;
		const scopes =
			entry?.connectionProviderId &&
			entry.connectionProviderId !== config.connectionProviderId
				? entry.connectionScopes
				: (entry?.connectionScopes ?? config.connectionScopes);
		if (!providerId || scopes === undefined) continue;
		for (const name of names) {
			const values = valuesByName.get(name) ?? new Set<string>();
			for (const scope of normalizeConnectionScopes(scopes)) values.add(scope);
			valuesByName.set(name, values);
		}
	}
	if (!valuesByName.size) return approved ?? {};
	const connectionsScopes = (approved?.connectionsScopes ?? []).map((scope) => {
		const values = valuesByName.get(scope.name);
		valuesByName.delete(scope.name);
		return values
			? {
					...scope,
					optional: scopePolicy.optionalScopes,
					values: [...values].sort(),
				}
			: scope;
	});
	for (const [name, values] of valuesByName) {
		connectionsScopes.push({
			name,
			optional: scopePolicy.optionalScopes,
			values: [...values].sort(),
		});
	}
	return { ...approved, connectionsScopes };
}

export interface ScopeConfigLike extends ConnectionScopeConfig {
	enforcePolicies?: boolean;
	scopeDescriptions?: Record<string, string>;
}

export interface RegisteredScopeDefinition {
	/** Registered or advertised scope string */
	name: string;
	/** Human-readable description */
	description: string;
}

/**
 * Collect deduplicated configured scopes from MCP config.
 */
export function collectConfiguredScopes(
	mcpConfig: ScopeConfigLike | null | undefined,
): RegisteredScopeDefinition[] {
	if (!mcpConfig) return [];

	const seen = new Set<string>();
	const scopes: RegisteredScopeDefinition[] = [];
	const scopeDescriptions = mcpConfig.scopeDescriptions;

	const addScope = (scope: string) => {
		if (!scope || seen.has(scope)) return;
		seen.add(scope);
		scopes.push({
			name: scope,
			description:
				scopeDescriptions?.[scope] ??
				CONNECTION_SCOPE_DESCRIPTIONS[scope] ??
				scope,
		});
	};

	for (const scopeList of Object.values(mcpConfig.toolScopes ?? {})) {
		for (const scope of scopeList ?? []) addScope(scope);
	}
	// `scopeDescriptions` is the Resource's declared grant catalog, not a
	// per-tool authorization override. Keep it independently enumerable so an
	// aggregate app can use the shared namespace resolver for tool enforcement
	// (`toolScopes: {}`) without making RFC 9728 discovery disappear. Descope's
	// live metadata remains authoritative when it is reachable; this catalog is
	// the exact D1 fallback used during an upstream discovery failure.
	for (const scope of Object.keys(scopeDescriptions ?? {})) addScope(scope);

	return scopes;
}

/**
 * Collect the scopes an MCP server should advertise/register.
 *
 * - Policy mode (`enforcePolicies: true`): per-tool `mcp:<tool>` scopes from live tools
 * - D1 config mode: the Resource catalog from `scopeDescriptions`, plus any
 *   scopes referenced by explicit per-tool overrides
 */
export function collectAdvertisedScopes(params: {
	mcpConfig: ScopeConfigLike | null | undefined;
	tools?: Array<{ name: string; description?: string }>;
	toolToScope?: (toolId: string) => string;
}): RegisteredScopeDefinition[] {
	const { mcpConfig, tools = [] } = params;
	const toScope =
		params.toolToScope ?? ((id: string) => `mcp:${id.replace(/_/g, ".")}`);

	if (mcpConfig?.enforcePolicies) {
		return tools.map((tool) => {
			const scope = toScope(tool.name);
			return {
				name: scope,
				description:
					mcpConfig.scopeDescriptions?.[scope] ??
					tool.description ??
					`Access to ${tool.name}`,
			};
		});
	}

	return collectConfiguredScopes(mcpConfig);
}

/** The same declared catalog serves OAuth metadata and Descope registration. */
export function collectDescopeResourceScopes(params: {
	mcpConfig: ScopeConfigLike | null | undefined;
	tools?: Array<{ name: string; description?: string }>;
}): RegisteredScopeDefinition[] {
	const scopes = collectAdvertisedScopes(params);
	const seen = new Set(scopes.map((scope) => scope.name));
	for (const name of MCP_PLATFORM_SCOPES) {
		if (seen.has(name)) continue;
		scopes.push({
			name,
			description:
				params.mcpConfig?.scopeDescriptions?.[name] ??
				CONNECTION_SCOPE_DESCRIPTIONS[name] ??
				name,
		});
		seen.add(name);
	}
	return scopes;
}

export function toDescopeConnectionScopes(
	scopes: readonly RegisteredScopeDefinition[],
	config: ScopeConfigLike | null = {},
): ConnectionScopeDefinition[] {
	return (
		reconcileConnectionScopeMappings(
			{
				connectionsScopes: scopes.map((scope) => ({
					...scope,
					optional: scopePolicy.optionalScopes,
				})),
			},
			config ?? {},
		).connectionsScopes ?? []
	);
}
