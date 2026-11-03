import type { AggregateTediEntry } from "./mcp/aggregate-tedis-shared";
import type { CallerIdentity } from "./mcp/server-context";
import { getApiClient } from "./lib/api-client";
import { withStepBudget } from "./lib/step-budget";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";

/** Configured peers must not determine whether a tedi can call its own skills. */
export async function withSelfTediSkills(input: {
	entries: AggregateTediEntry[] | undefined;
	caller: CallerIdentity | undefined;
	organizationId: string | null | undefined;
	env: CloudflareEnv;
}): Promise<AggregateTediEntry[] | undefined> {
	const { entries, caller, organizationId, env } = input;
	if (
		!entries ||
		caller?.authType !== "tedi" ||
		!caller.tediId ||
		!organizationId ||
		caller.organizationId !== organizationId ||
		!env.API_SERVICE
	)
		return entries;
	const client = getApiClient({
		serviceFetch: env.API_SERVICE,
		orgId: organizationId,
	});
	const tedi = await withStepBudget(
		"aggregate_self_tedi",
		UPSTREAM_ATTEMPT_TIMEOUT_MS,
		client.tedis.get({ tediId: caller.tediId }),
	);
	const slug = tedi.slug;
	if (
		tedi.id !== caller.tediId ||
		tedi.organizationId !== organizationId ||
		tedi.status !== "active" ||
		tedi.runtimeState === "archived" ||
		!slug ||
		entries.some(
			(entry) =>
				entry.slug === slug ||
				(entry.namespace ?? entry.slug).replace(/[^a-zA-Z0-9_]/g, "_") ===
					slug.replace(/[^a-zA-Z0-9_]/g, "_"),
		)
	)
		return entries;
	return [
		...entries,
		{
			slug,
			tediId: tedi.id,
			organizationId,
			runtimeKind: "agent",
			selfSkillsOnly: true,
		},
	];
}
