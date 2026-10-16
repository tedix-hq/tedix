import type { McpServerApprovedScopes } from "./aih-client";

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

export function connectionScopeMappingValues(
	approved: McpServerApprovedScopes | null | undefined,
): Record<string, string[]> {
	return Object.fromEntries(
		(approved?.connectionsScopes ?? [])
			.filter((scope) => scope.values !== undefined)
			.map(
				(scope) =>
					[scope.name, normalizeConnectionScopes(scope.values ?? [])] as const,
			)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Map only explicitly configured capabilities; never infer provider access from a scope name. */
export function reconcileConnectionScopeMappings(
	approved: McpServerApprovedScopes | null | undefined,
	config: ConnectionScopeConfig,
): McpServerApprovedScopes {
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
		return values ? { ...scope, values: [...values].sort() } : scope;
	});
	for (const [name, values] of valuesByName) {
		connectionsScopes.push({
			name,
			optional: true,
			values: [...values].sort(),
		});
	}
	return { ...approved, connectionsScopes };
}
