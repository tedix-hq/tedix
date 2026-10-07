/**
 * Shared derivation of Code Mode namespaces from aggregate entries.
 *
 * Two callers need the same answer from different sides of the request:
 *
 * - `index.ts` filters the aggregate fan-out down to the namespaces a Code Mode
 *   snippet actually references, so a cold build only hydrates what the snippet
 *   needs (`filterAggregateAppsForCodeNamespaces`).
 * - `codemode.ts` needs to tell a *configured but unhydrated* namespace apart
 *   from a typo when the sandbox throws `X is not defined`. Without that split
 *   an upstream hydration timeout reads as a naming error and sends the caller
 *   hunting for a tool name that was never wrong.
 */

import type { AggregateTediEntry } from "./aggregate-tedis-shared";
import { NAMESPACE_PEER_ALIASES } from "@tedix/mcp-shared/namespace-governance";
import {
	PLATFORM_OPERATOR_ADMIN_APP_SLUG,
	PLATFORM_OPERATOR_CODE_MODE_NAMESPACES,
} from "./platform-operator-aggregation";

/** Structural shape of an `mcpConfig.aggregateApps` entry (namespace bits only). */
export type AggregateNamespaceEntry = { slug: string; prefix?: string };

/**
 * Namespaces an aggregate app entry can mount: its sanitized prefix/slug, any
 * D1 `codeModeNamespaces` override, plus the peer alias so a body calling
 * either "app" or "apps" (or "tedi"/"tedis") hydrates the right entry.
 */
export function aggregateAppNamespaceCandidates(
	entry: AggregateNamespaceEntry,
	namespaceOverrides?: Record<string, string>,
): Set<string> {
	const raw = (entry.prefix ?? entry.slug).replace(/[^a-zA-Z0-9_]/g, "_");
	const primary = [
		raw,
		namespaceOverrides?.[raw],
		namespaceOverrides?.[entry.prefix ?? entry.slug],
	].filter((value): value is string => Boolean(value));

	const withAliases = new Set(primary);
	for (const ns of primary) {
		const aliasNs = NAMESPACE_PEER_ALIASES.get(ns);
		if (aliasNs !== undefined) withAliases.add(aliasNs);
	}
	return withAliases;
}

/**
 * Code Mode namespace for one app inside a Connect organization mount.
 *
 * A Connect selection mounts each organization's unified gateway as one entry
 * (`acme-unified`). Its apps keep their own identity under that mount —
 * `acme_unified_resend_2`, `acme_unified_cms` — so two apps with the same
 * tool name stay callable instead of colliding in one flat namespace. A trailing
 * `_<org>` on the app's own prefix (`cms_acme`) is dropped as redundant.
 */
export function organizationAppNamespace(
	mountPrefix: string,
	app: AggregateNamespaceEntry,
): string {
	const mount = mountPrefix.replace(/[^a-zA-Z0-9_]/g, "_");
	const org = mount.replace(/_unified$/, "");
	const own = (app.prefix ?? app.slug).replace(/[^a-zA-Z0-9_]/g, "_");
	const trimmed = own.endsWith(`_${org}`)
		? own.slice(0, -(org.length + 1))
		: own;
	return `${mount}_${trimmed || own}`;
}

/** Whether `namespace` is served by the Connect organization mount `mountPrefix`. */
export function isOrganizationMountNamespace(
	mountPrefix: string,
	namespace: string,
): boolean {
	const mount = mountPrefix.replace(/[^a-zA-Z0-9_]/g, "_");
	return namespace === mount || namespace.startsWith(`${mount}_`);
}

/** Namespace an aggregate tedi entry mounts under (defaults to its slug). */
export function aggregateTediNamespace(
	entry: Pick<AggregateTediEntry, "namespace" | "slug">,
): string {
	return (entry.namespace ?? entry.slug).replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Every namespace this app *can* serve from its aggregate config, whether or not
 * the current request hydrated it. Membership means "configured here" — it is
 * the evidence that a missing sandbox binding is an infrastructure failure and
 * not a bad identifier.
 *
 * Deliberately narrower than what index.ts will hydrate: the platform-operator
 * admin app also serves a D1-synced tail (`skills`, `memory`, `rationale`, …)
 * that only its unmatched-namespace fail-open covers. Under-claiming costs a
 * bare ReferenceError (the status quo); over-claiming would tell someone their
 * typo was an outage.
 */
export function configuredAggregateNamespaces(
	mcpConfig: Record<string, unknown> | null | undefined,
): Set<string> {
	const namespaces = new Set<string>();
	if (!mcpConfig) return namespaces;

	const namespaceOverrides = mcpConfig.codeModeNamespaces as
		| Record<string, string>
		| undefined;

	const aggregateApps = Array.isArray(mcpConfig.aggregateApps)
		? (mcpConfig.aggregateApps as AggregateNamespaceEntry[])
		: [];
	for (const entry of aggregateApps) {
		if (!entry?.slug) continue;
		for (const ns of aggregateAppNamespaceCandidates(
			entry,
			namespaceOverrides,
		)) {
			namespaces.add(ns);
		}
		// The platform-operator admin app stores tools whose namespaces come from
		// endpoint prefixes ("tedis/list" → `tedis`), not from its slug.
		if (entry.slug === PLATFORM_OPERATOR_ADMIN_APP_SLUG) {
			for (const ns of PLATFORM_OPERATOR_CODE_MODE_NAMESPACES) {
				namespaces.add(ns);
			}
		}
	}

	const aggregateTedis = Array.isArray(mcpConfig.aggregateTedis)
		? (mcpConfig.aggregateTedis as AggregateTediEntry[])
		: [];
	for (const entry of aggregateTedis) {
		if (!entry?.slug) continue;
		namespaces.add(aggregateTediNamespace(entry));
	}

	return namespaces;
}
