/**
 * Canonical accountable PARTY for separation-of-duties comparisons.
 *
 * A principal reference (`type:id`) is not a party. An `external_agent`
 * principal bound `owner_user` is a plugin host acting on its human owner's
 * OAuth session, so it and that owner are ONE party: the owner cannot approve,
 * decide, corroborate, or review what their own owner-host agent requested or
 * executed. Every independence check compares canonical parties, never raw
 * principal references. Suspended/retired principals keep their party: status
 * never makes an owner independent of their own agent.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";

export interface WorkPartyRef {
	type: string;
	id: string;
}

export function workPartyKey(party: WorkPartyRef): string {
	return `${party.type}:${party.id}`;
}

/** Party keys resolve through this map; unknown refs are their own party. */
export type CanonicalPartyMap = ReadonlyMap<string, string>;

export function canonicalPartyKey(
	map: CanonicalPartyMap,
	party: WorkPartyRef,
): string {
	const key = workPartyKey(party);
	return map.get(key) ?? key;
}

export function isSameCanonicalParty(
	map: CanonicalPartyMap,
	left: WorkPartyRef,
	right: WorkPartyRef,
): boolean {
	return canonicalPartyKey(map, left) === canonicalPartyKey(map, right);
}

const MAX_RESOLVED_EXTERNAL_PRINCIPALS = 50;

/**
 * One bounded statement: map every supplied owner-host external-agent
 * principal to `user:<owner canonical user id>`. Other refs map to themselves.
 */
export async function resolveCanonicalWorkParties(
	db: DbQueryClient,
	params: { organizationId: string; parties: readonly WorkPartyRef[] },
): Promise<CanonicalPartyMap> {
	const principalIds = [
		...new Set(
			params.parties
				.filter((party) => party.type === "external_agent")
				.map((party) => party.id),
		),
	];
	const map = new Map<string, string>();
	if (principalIds.length === 0) return map;
	if (principalIds.length > MAX_RESOLVED_EXTERNAL_PRINCIPALS)
		throw new Error(
			`Canonical party resolution is capped at ${MAX_RESOLVED_EXTERNAL_PRINCIPALS} external-agent principals`,
		);
	const rows = await db
		.select({
			principalId: externalAgentPrincipals.id,
			ownerUserId: externalAgentPrincipals.credentialBindingId,
		})
		.from(externalAgentPrincipals)
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				eq(externalAgentPrincipals.credentialBindingType, "owner_user"),
				// bound-params: capped to 50 distinct principal ids above.
				inArray(externalAgentPrincipals.id, principalIds),
			),
		);
	for (const row of rows) {
		map.set(
			workPartyKey({ type: "external_agent", id: row.principalId }),
			workPartyKey({ type: "user", id: row.ownerUserId }),
		);
	}
	return map;
}

/** Convenience for a single pairwise independence check. */
export async function areSameWorkParty(
	db: DbQueryClient,
	params: { organizationId: string; left: WorkPartyRef; right: WorkPartyRef },
): Promise<boolean> {
	const map = await resolveCanonicalWorkParties(db, {
		organizationId: params.organizationId,
		parties: [params.left, params.right],
	});
	return isSameCanonicalParty(map, params.left, params.right);
}
