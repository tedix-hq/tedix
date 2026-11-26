import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import { getApiClient } from "./lib/api-client";
import { withStepBudget } from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	aggregateTediNamespace,
	configuredAggregateNamespaces,
} from "./mcp/aggregate-namespaces";
import type { AggregateTediEntry } from "./mcp/aggregate-tedis-shared";
import { PLATFORM_OPERATOR_CODE_MODE_NAMESPACES } from "./mcp/platform-operator-aggregation";
import type { AppTool, CallerIdentity } from "./mcp/server-context";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";

const log = createMcpLogger("mcp.aggregate_default_tedis");

/** Namespaces the gateway itself serves; a tedi never mounts over them. */
const RESERVED_NAMESPACES = new Set([
	"discover",
	"codemode",
	"ui",
	"flow",
	"home",
	"kernel",
	"skills",
]);

/** A tedi slug is lowercase letters, digits and hyphens; so is its namespace, with `_`. */
const TEDI_NAMESPACE = /^[a-z0-9_]{1,64}$/;
const MAX_CANDIDATES = 20;

/**
 * The signed-in person a call comes from. Only a person's own sign-in counts:
 * a tedi, service, client, API key or external agent has another auth type,
 * and a person's call that carries a tedi identity acts as that tedi.
 */
function signedInPersonUserId(
	caller: NonNullable<CallerIdentity>,
): string | undefined {
	return (caller.authType === "user" || caller.authType === "oauth") &&
		!caller.tediId
		? caller.userId
		: undefined;
}

/**
 * Tedis reachable by default: every active tedi of the organization is a Code
 * Mode namespace without being on the gateway's `aggregateTedis` list. An
 * organization tedi mounts for a caller of the organization, a personal tedi
 * only for the signed-in person who owns it; the API applies that rule.
 *
 * Nothing is read unless the program calls a namespace that no loaded tool,
 * configured app, built-in namespace or explicit tedi entry serves. Then one
 * budgeted API call resolves those names. An error or timeout mounts nothing.
 */
export async function resolveDefaultCallableTedis(input: {
	/** Explicit entries; they keep their surface, namespace and URL. */
	entries: AggregateTediEntry[] | undefined;
	caller: CallerIdentity;
	organizationId: string | null | undefined;
	env: CloudflareEnv;
	/** Undeclared names the Code Mode program calls as a namespace. */
	calledNamespaces: ReadonlySet<string>;
	tools: readonly AppTool[];
	mcpConfig: Record<string, unknown> | null | undefined;
}): Promise<AggregateTediEntry[]> {
	const { caller, organizationId, env, calledNamespaces } = input;
	const entries = input.entries ?? [];
	if (
		calledNamespaces.size === 0 ||
		!caller ||
		caller.authType === "anonymous" ||
		!organizationId ||
		caller.organizationId !== organizationId
	)
		return [];
	const explicit = new Set(entries.map(aggregateTediNamespace));
	let candidates = [...calledNamespaces].filter(
		(namespace) =>
			TEDI_NAMESPACE.test(namespace) &&
			!RESERVED_NAMESPACES.has(namespace) &&
			!PLATFORM_OPERATOR_CODE_MODE_NAMESPACES.has(namespace) &&
			!explicit.has(namespace),
	);
	if (candidates.length === 0) return [];
	const namespaceOverrides = input.mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const served = configuredAggregateNamespaces(input.mcpConfig);
	for (const tool of input.tools)
		served.add(resolveMcpToolNamespace(tool, namespaceOverrides));
	candidates = candidates
		.filter((namespace) => !served.has(namespace))
		.slice(0, MAX_CANDIDATES);
	if (candidates.length === 0) return [];

	const callerUserId = signedInPersonUserId(caller);
	let rows: Awaited<
		ReturnType<ReturnType<typeof getApiClient>["tedis"]["listCallableBySlugs"]>
	>["data"];
	try {
		const client = getApiClient({
			serviceFetch: env.API_SERVICE,
			orgId: organizationId,
		});
		rows = (
			await withStepBudget(
				"aggregate_default_tedis",
				UPSTREAM_ATTEMPT_TIMEOUT_MS,
				client.tedis.listCallableBySlugs({
					organizationId,
					// A namespace's `_` is a `-` in the slug, or was `_` already.
					slugs: [
						...new Set(
							candidates.flatMap((namespace) => [
								namespace.replace(/_/g, "-"),
								namespace,
							]),
						),
					],
					...(callerUserId ? { callerUserId } : {}),
				}),
			)
		).data;
	} catch (error) {
		log.warn("Default tedi mounts unavailable", {
			event: "aggregate.default_tedis_failed",
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return [];
	}

	const wanted = new Set(candidates);
	const byNamespace = new Map<string, AggregateTediEntry | null>();
	for (const row of rows) {
		const namespace = aggregateTediNamespace(row);
		if (
			row.organizationId !== organizationId ||
			(row.scope === "personal" && !callerUserId) ||
			!wanted.has(namespace) ||
			entries.some((entry) => entry.slug === row.slug)
		)
			continue;
		// Two slugs sharing one namespace cannot both mount; mount neither.
		byNamespace.set(
			namespace,
			byNamespace.has(namespace)
				? null
				: {
						slug: row.slug,
						surface: "turns",
						tediId: row.id,
						organizationId: row.organizationId,
						runtimeKind: row.runtimeKind,
					},
		);
	}
	return [...byNamespace.values()].filter((entry) => entry !== null);
}
