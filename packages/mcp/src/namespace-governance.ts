export type McpNamespaceClass =
	| "discovery"
	| "host"
	| "platform"
	| "tenant_app"
	| "virtual_tedi";

export interface McpNamespaceGovernance {
	owner: string;
	class: McpNamespaceClass;
	aliases: readonly string[];
	requiredScopes: readonly string[];
	visibility: "internal" | "tenant";
	freshness: "build" | "request" | "d1_config";
	collisionPolicy: "reserved_wins" | "reject_duplicate";
}

const RESERVED = {
	discover: ["mcp-platform", "discovery", "tenant", "build"],
	codemode: ["mcp-platform", "host", "tenant", "build"],
	ui: ["mcp-platform", "host", "tenant", "build"],
	flow: ["mcp-platform", "host", "tenant", "build"],
	home: ["tedi-runtime", "platform", "tenant", "request"],
	kernel: ["tedi-runtime", "platform", "internal", "request"],
	tedi: ["tedi-runtime", "virtual_tedi", "tenant", "request"],
	tedis: ["tedi-runtime", "virtual_tedi", "tenant", "request"],
	app: ["mcp-platform", "platform", "tenant", "d1_config"],
	apps: ["mcp-platform", "platform", "tenant", "d1_config"],
	tools: ["mcp-platform", "host", "tenant", "build"],
	skills: ["mcp-platform", "platform", "tenant", "d1_config"],
} as const satisfies Record<
	string,
	readonly [
		string,
		McpNamespaceClass,
		"internal" | "tenant",
		"build" | "request" | "d1_config",
	]
>;

const ALIAS_PAIRS = [
	["app", "apps"],
	["tedi", "tedis"],
] as const;

export const NAMESPACE_PEER_ALIASES: ReadonlyMap<string, string> = new Map(
	ALIAS_PAIRS.flatMap(([left, right]) => [
		[left, right] as const,
		[right, left] as const,
	]),
);

export const RESERVED_MCP_NAMESPACES: ReadonlySet<string> = new Set([
	...Object.keys(RESERVED),
	...NAMESPACE_PEER_ALIASES.keys(),
]);

/** Metadata for discovery output and collision enforcement. */
export function namespaceGovernanceFor(
	namespace: string,
): McpNamespaceGovernance {
	const reserved = RESERVED[namespace as keyof typeof RESERVED];
	if (reserved) {
		return {
			owner: reserved[0],
			class: reserved[1],
			aliases: NAMESPACE_PEER_ALIASES.has(namespace)
				? [NAMESPACE_PEER_ALIASES.get(namespace)!]
				: [],
			requiredScopes: [],
			visibility: reserved[2],
			freshness: reserved[3],
			collisionPolicy: "reserved_wins",
		};
	}
	return {
		owner: "app-config",
		class: "tenant_app",
		aliases: NAMESPACE_PEER_ALIASES.has(namespace)
			? [NAMESPACE_PEER_ALIASES.get(namespace)!]
			: [],
		requiredScopes: [],
		visibility: "tenant",
		freshness: "d1_config",
		collisionPolicy: "reject_duplicate",
	};
}
