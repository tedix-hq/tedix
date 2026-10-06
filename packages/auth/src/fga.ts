/**
 * @tedix/auth - Fine-Grained Authorization (FGA)
 *
 * Wraps Descope's FGA API for tedi-app permission management.
 *
 * Schema (Descope `AuthZ 1.0` DSL — NOT OpenFGA `model schema 1.1`, which the
 * Descope parser rejects with E172008; see `initFGASchema`):
 *   model AuthZ 1.0
 *   type user
 *   type app
 *     relation operator: user
 *     relation observer: user
 *
 * SDK methods used:
 * - management.fga.saveSchema(schema)
 * - management.fga.createRelations(relations)
 * - management.fga.deleteRelations(relations)
 * - management.fga.check(relations)
 * - management.authz.targetsRelations(targets)
 * - management.authz.resourceRelations(resource)
 * - management.authz.deleteRelationsForIds(ids)
 */

import type { DescopeClient } from "@tedix/auth/descope";

// =============================================================================
// HELPERS
// =============================================================================

function rel(appId: string, relation: string, descopeUserId: string) {
	return {
		resource: appId,
		resourceType: "app",
		relation,
		target: descopeUserId,
		targetType: "user",
	};
}

/**
 * App-assignment checks are runtime authorization gates. A failed provider
 * response must still deny access without making every tedi request fail, but
 * it must be visible to operators instead of looking like a genuine empty
 * assignment. Keep identities and resource IDs out of the log.
 */
function logUnavailableAppCheck(
	operation: string,
	response: { ok: boolean; error?: { errorCode?: string } | null },
): void {
	console.error("[FGA] App assignment check unavailable", {
		operation,
		reason: response.ok ? "missing_data" : "provider_failure",
		providerCode: response.error?.errorCode ?? null,
	});
}

// =============================================================================
// SCHEMA
// =============================================================================

/**
 * Initialize the Tedix FGA schema in Descope.
 *
 * NOTE: no code path currently calls this — the `app`/`operator`/`observer`
 * schema is bootstrapped out-of-band (Descope console). The relation
 * grant/check helpers below assume it already exists. Kept as the canonical
 * definition of the schema; wire it into a bootstrap/migration step if we ever
 * want deploys to self-heal schema drift. It IS idempotent (Descope upserts).
 */
export async function initFGASchema(client: DescopeClient): Promise<void> {
	// Descope FGA DSL — `model AuthZ 1.0` declaration + `relation <name>: <type>`
	// per https://docs.descope.com/authorization/rebac/define-schema. The older
	// OpenFGA-style `model schema 1.1` + `relations` block is rejected by
	// Descope's parser with E172008.
	const dsl = [
		"model AuthZ 1.0",
		"type user",
		"type app",
		"  relation operator: user",
		"  relation observer: user",
	].join("\n");

	const resp = await client.management.fga.saveSchema({ dsl });
	if (!resp.ok) {
		throw new Error(`Failed to save FGA schema: ${JSON.stringify(resp)}`);
	}
}

// =============================================================================
// RELATIONS — Tedi ↔ App
// =============================================================================

/**
 * Grant a tedi operator access to an app.
 */
export async function grantAppOperator(
	client: DescopeClient,
	descopeUserId: string,
	appId: string,
): Promise<void> {
	const resp = await client.management.fga.createRelations([
		rel(appId, "operator", descopeUserId),
	]);
	if (!resp.ok) {
		throw new Error(`Failed to grant app operator: ${JSON.stringify(resp)}`);
	}
}

/**
 * Grant a tedi observer access to an app.
 */
export async function grantAppObserver(
	client: DescopeClient,
	descopeUserId: string,
	appId: string,
): Promise<void> {
	const resp = await client.management.fga.createRelations([
		rel(appId, "observer", descopeUserId),
	]);
	if (!resp.ok) {
		throw new Error(`Failed to grant app observer: ${JSON.stringify(resp)}`);
	}
}

/**
 * Revoke a tedi's access to an app (both operator and observer).
 */
export async function revokeAppAccess(
	client: DescopeClient,
	descopeUserId: string,
	appId: string,
): Promise<void> {
	const resp = await client.management.fga.deleteRelations([
		rel(appId, "operator", descopeUserId),
		rel(appId, "observer", descopeUserId),
	]);
	if (!resp.ok) {
		throw new Error(`Failed to revoke app access: ${JSON.stringify(resp)}`);
	}
}

/**
 * Delete one exact app relation after the caller has independently proven that
 * the referenced app is stale. Keeping this primitive exact avoids broad
 * resource cleanup when repairing drift discovered by the cross-system audit.
 */
export async function deleteAppRelation(
	client: DescopeClient,
	descopeUserId: string,
	appId: string,
	relation: "operator" | "observer",
): Promise<void> {
	const resp = await client.management.fga.deleteRelations([
		rel(appId, relation, descopeUserId),
	]);
	if (!resp.ok) {
		throw new Error(`Failed to delete app relation: ${JSON.stringify(resp)}`);
	}
}

// =============================================================================
// CHECKS
// =============================================================================

/**
 * Batch check — which apps can a tedi operate?
 * Single batch check call — one API request for N checks.
 */
export async function getOperableApps(
	client: DescopeClient,
	descopeUserId: string,
	appIds: string[],
): Promise<string[]> {
	if (appIds.length === 0) return [];

	const relations = appIds.map((appId) =>
		rel(appId, "operator", descopeUserId),
	);
	const resp = await client.management.fga.check(relations);
	if (!resp.ok || !resp.data) {
		logUnavailableAppCheck("getOperableApps", resp);
		return [];
	}

	return resp.data.filter((r) => r.allowed).map((r) => r.tuple.resource);
}

/**
 * Batch resolve current app roles for a tedi across a set of app IDs.
 * Operator wins over observer when both relations are present.
 */
export async function getAssignedAppRoles(
	client: DescopeClient,
	descopeUserId: string,
	appIds: string[],
): Promise<Record<string, "operator" | "observer">> {
	if (appIds.length === 0) return {};

	const relations = appIds.flatMap((appId) => [
		rel(appId, "operator", descopeUserId),
		rel(appId, "observer", descopeUserId),
	]);

	const resp = await client.management.fga.check(relations);
	if (!resp.ok || !resp.data) {
		logUnavailableAppCheck("getAssignedAppRoles", resp);
		return {};
	}

	const roles: Record<string, "operator" | "observer"> = {};
	for (const result of resp.data) {
		if (!result.allowed) continue;
		if (result.tuple.relation === "operator") {
			roles[result.tuple.resource] = "operator";
		} else if (
			!roles[result.tuple.resource] &&
			result.tuple.relation === "observer"
		) {
			roles[result.tuple.resource] = "observer";
		}
	}
	return roles;
}

/**
 * A mutation must distinguish an absent relation from an unavailable or partial
 * provider check. The read-only listing above deliberately returns no access on
 * outage; using that fallback before a role change could destroy a real grant.
 */
export async function getAppRoleStateForMutation(
	client: DescopeClient,
	descopeUserId: string,
	appId: string,
): Promise<{ operator: boolean; observer: boolean }> {
	const resp = await client.management.fga.check([
		rel(appId, "operator", descopeUserId),
		rel(appId, "observer", descopeUserId),
	]);
	if (!resp.ok || !Array.isArray(resp.data)) {
		throw new Error("Unable to verify app FGA relations");
	}
	const result = { operator: false, observer: false };
	for (const role of ["operator", "observer"] as const) {
		const matching = resp.data.filter(
			(entry) =>
				entry.tuple.resource === appId &&
				entry.tuple.target === descopeUserId &&
				entry.tuple.relation === role,
		);
		if (matching.length !== 1) {
			throw new Error("Incomplete app FGA relation check");
		}
		result[role] = matching[0]!.allowed;
	}
	return result;
}

/**
 * Which of the given targets can operate an app?
 * Batch-checks candidateTargets against a single app.
 */
export async function getAppOperators(
	client: DescopeClient,
	appId: string,
	candidateTargets: string[],
): Promise<string[]> {
	if (candidateTargets.length === 0) return [];

	const relations = candidateTargets.map((target) =>
		rel(appId, "operator", target),
	);
	const resp = await client.management.fga.check(relations);
	if (!resp.ok || !resp.data) {
		logUnavailableAppCheck("getAppOperators", resp);
		return [];
	}

	return resp.data.filter((r) => r.allowed).map((r) => r.tuple.target);
}

/**
 * Which of the given targets can observe an app?
 * Batch-checks candidateTargets against a single app.
 */
export async function getAppObservers(
	client: DescopeClient,
	appId: string,
	candidateTargets: string[],
): Promise<string[]> {
	if (candidateTargets.length === 0) return [];

	const relations = candidateTargets.map((target) =>
		rel(appId, "observer", target),
	);
	const resp = await client.management.fga.check(relations);
	if (!resp.ok || !resp.data) {
		logUnavailableAppCheck("getAppObservers", resp);
		return [];
	}

	return resp.data.filter((r) => r.allowed).map((r) => r.tuple.target);
}

// =============================================================================
// AUTHZ QUERY — Direct queries (no candidate lists)
// =============================================================================

/**
 * The row shape the direct relation queries return — Descope's `AuthzRelation`
 * narrowed to the fields Tedix reads.
 *
 * `target` stays optional because Descope also models target-SET relations,
 * which carry `targetSetResource` instead of a `target`. Tedix never writes
 * one, so a row without a target is itself drift a caller must be able to see
 * rather than a shape we may assume away.
 */
export type FgaRelationRow = {
	target?: string;
	relationDefinition: string;
	namespace: string;
	resource: string;
};

/**
 * Query all relations for a set of tedi user IDs.
 * Bulk query — single call for multiple targets.
 *
 * THROWS on a failed query rather than returning empty. The distinction is
 * load-bearing for the only caller: `getDescopeAihDriftReport` has a
 * purpose-built `fga_relation_audit_unavailable` warning ("stale tedi app
 * assignments may be hidden") that it raises from `fgaQueryError`, and it sets
 * that only from a `catch`. While this returned `[]` on a non-ok response, a
 * Descope FGA outage produced zero relations, no warning, and therefore zero
 * `fga_relation_missing_d1_app` issues — a report that read as a clean bill of
 * health, generated by a query that never succeeded. An audit that cannot
 * distinguish "nothing is wrong" from "I could not look" is worse than no
 * audit, because it is trusted.
 */
export async function queryTediRelations(
	client: DescopeClient,
	descopeUserIds: string[],
): Promise<FgaRelationRow[]> {
	if (descopeUserIds.length === 0) return [];
	const resp = await client.management.authz.targetsRelations(descopeUserIds);
	if (!resp.ok || !resp.data) {
		throw new Error(
			`FGA targetsRelations query failed: ${resp.error?.errorDescription ?? resp.error?.errorMessage ?? `ok=${resp.ok}`}`,
		);
	}
	return resp.data;
}

/**
 * Query every relation held ON one app resource — the read that answers "who
 * can operate this app?" without a candidate list.
 *
 * THROWS on a failed query, for the same reason `queryTediRelations` does: an
 * empty relation list is indistinguishable from "the query never succeeded",
 * and returning `[]` on a non-ok response answers "nobody holds any relation
 * on this app" — the strongest possible claim — from no evidence at all.
 *
 * Deliberately NOT the shape of `getOperableApps` / `getAssignedAppRoles`
 * above, which do return `[]` on a non-ok response. Those are permission
 * CHECKS whose callers read empty as denial, so an outage there fails closed.
 * This is an audit READ whose caller reads empty as a fact about Descope, so
 * the same silence would fail open into a false clean bill of health.
 */
export async function queryAppRelations(
	client: DescopeClient,
	appId: string,
): Promise<FgaRelationRow[]> {
	const resp = await client.management.authz.resourceRelations(appId);
	if (!resp.ok || !resp.data) {
		throw new Error(
			`FGA resourceRelations query failed: ${resp.error?.errorDescription ?? resp.error?.errorMessage ?? `ok=${resp.ok}`}`,
		);
	}
	return resp.data;
}

// =============================================================================
// FGA CLEANUP
// =============================================================================

/**
 * Delete ALL FGA relations for given app IDs.
 * Useful for org teardown — removes all operator/observer grants at once.
 */
export async function deleteAllAppRelations(
	client: DescopeClient,
	appIds: string[],
): Promise<void> {
	if (appIds.length === 0) return;
	const resp = await client.management.authz.deleteRelationsForIds(appIds);
	if (!resp.ok) {
		throw new Error(`Failed to delete app relations: ${JSON.stringify(resp)}`);
	}
}
