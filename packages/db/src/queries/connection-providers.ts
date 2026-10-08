/**
 * Connection Provider Query Helpers
 *
 * Canonical D1-backed connection provider lookups. Each lookup here
 * either fetches the full table once (the loop-safe pattern every live call
 * site should use) or does a single by-id/by-descopeAppId lookup for call
 * sites that only ever need 1-2 providers per request.
 */

import type {
	ConnectionProviderCategory,
	ConnectionProviderTemplate,
} from "@tedix/api-contract/schemas/connection-provider-templates";
import { asc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { ConnectionProviderRow } from "../schema/connection-providers";
import { connectionProviders } from "../schema/connection-providers";

function toConnectionProviderTemplate(
	row: ConnectionProviderRow,
): ConnectionProviderTemplate {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		icon: row.icon,
		category: row.category,
		type: row.type,
		requiredScopes: row.requiredScopes ?? [],
		supportedScopes: row.supportedScopes ?? [],
		recommendedScope: row.recommendedScope,
		descopeAppId: row.descopeAppId ?? undefined,
		descopeAppAliases: row.descopeAppAliases ?? undefined,
		credentialProfile: row.credentialProfile ?? undefined,
		oauthConfig: row.oauthConfig ?? undefined,
		pinnedIssuer: row.pinnedIssuer ?? undefined,
		authorizationResponseIssSupported:
			row.authorizationResponseIssSupported ?? undefined,
	};
}

/**
 * Fetch every connection provider template. This is the one primitive every
 * other read in this module composes from — call sites that need to look up
 * providers for a batch of Descope apps (listProviders, auditProviderSettings,
 * getUserConnections/supportsUserScope) should call this ONCE per request and
 * build a lookup Map via `buildConnectionProviderMaps`, not loop-call the
 * single-lookup helpers below.
 */
export async function listConnectionProviders(
	db: DbClient,
): Promise<ConnectionProviderTemplate[]> {
	const rows = await db
		.select()
		.from(connectionProviders)
		.orderBy(asc(connectionProviders.sortOrder), asc(connectionProviders.id));
	return rows.map(toConnectionProviderTemplate);
}

export async function listConnectionProvidersByCategory(
	db: DbClient,
	category: ConnectionProviderCategory,
): Promise<ConnectionProviderTemplate[]> {
	const rows = await db
		.select()
		.from(connectionProviders)
		.where(eq(connectionProviders.category, category))
		.orderBy(asc(connectionProviders.sortOrder), asc(connectionProviders.id));
	return rows.map(toConnectionProviderTemplate);
}

export async function listConnectionProvidersByType(
	db: DbClient,
	type: ConnectionProviderTemplate["type"],
): Promise<ConnectionProviderTemplate[]> {
	const rows = await db
		.select()
		.from(connectionProviders)
		.where(eq(connectionProviders.type, type))
		.orderBy(asc(connectionProviders.sortOrder), asc(connectionProviders.id));
	return rows.map(toConnectionProviderTemplate);
}

/** Single-lookup convenience wrapper for call sites doing 1-2 lookups, not a loop. */
export async function getConnectionProviderById(
	db: DbClient,
	id: string,
): Promise<ConnectionProviderTemplate | undefined> {
	const rows = await db
		.select()
		.from(connectionProviders)
		.where(eq(connectionProviders.id, id))
		.limit(1);
	return rows[0] ? toConnectionProviderTemplate(rows[0]) : undefined;
}

/**
 * Look up a provider by its Descope outbound app ID. A row's own
 * `descopeAppId` and any `descopeAppAliases` all resolve to it — mirrors the
 * `descopeAppAliases?.includes(descopeAppId)` fallback the in-memory registry
 * used to do. Single-lookup convenience wrapper; call sites that do this in a
 * loop over many apps should use `buildConnectionProviderMaps` instead.
 */
export async function getConnectionProviderByDescopeAppId(
	db: DbClient,
	descopeAppId: string,
): Promise<ConnectionProviderTemplate | undefined> {
	const rows = await db
		.select()
		.from(connectionProviders)
		.orderBy(asc(connectionProviders.id));
	const match = rows.find(
		(row) =>
			row.descopeAppId === descopeAppId ||
			row.descopeAppAliases?.includes(descopeAppId),
	);
	return match ? toConnectionProviderTemplate(match) : undefined;
}

/**
 * Pure, no I/O. Builds id/descopeAppId(+aliases) lookup maps from an
 * already-fetched provider list — the "fetch once per request" pattern every
 * loop call site (listProviders, auditProviderSettings,
 * getUserConnections/supportsUserScope) should use instead of a lookup per
 * iteration. Mirrors the map-building
 * `descope-aih-drift.ts` already does today.
 */
export function buildConnectionProviderMaps(
	providers: ConnectionProviderTemplate[],
): {
	byId: Map<string, ConnectionProviderTemplate>;
	byDescopeAppId: Map<string, ConnectionProviderTemplate>;
} {
	const byId = new Map<string, ConnectionProviderTemplate>();
	const byDescopeAppId = new Map<string, ConnectionProviderTemplate>();
	for (const provider of providers) {
		byId.set(provider.id, provider);
		if (provider.descopeAppId) {
			byDescopeAppId.set(provider.descopeAppId, provider);
		}
		for (const alias of provider.descopeAppAliases ?? []) {
			byDescopeAppId.set(alias, provider);
		}
	}
	return { byId, byDescopeAppId };
}

// =============================================================================
// Issuer pinning (ADR decisions/tedi-client-oauth-cimd.md, phase 1a)
// =============================================================================

export interface ConnectionProviderIssuerPin {
	/** RFC 8414-validated issuer recorded at first discovery; null = never pinned. */
	pinnedIssuer: string | null;
	/** RFC 9207 iss-parameter support recorded at pin time; null = unknown. */
	authorizationResponseIssSupported: boolean | null;
}

/**
 * Read the issuer pin for a provider row. `undefined` = no row at all (an
 * MCP-derived provider that has never been pinned and has no template);
 * a result with `pinnedIssuer: null` = row exists but predates pinning.
 */
export async function getConnectionProviderIssuerPin(
	db: DbClient,
	id: string,
): Promise<ConnectionProviderIssuerPin | undefined> {
	const rows = await db
		.select({
			pinnedIssuer: connectionProviders.pinnedIssuer,
			authorizationResponseIssSupported:
				connectionProviders.authorizationResponseIssSupported,
		})
		.from(connectionProviders)
		.where(eq(connectionProviders.id, id))
		.limit(1);
	return rows[0];
}

/**
 * Persist the issuer pin after a successful MCP OAuth discovery + provision.
 *
 * Existing row → updates only the pin columns (template metadata untouched).
 * No row → inserts a minimal decoration row for the Descope outbound app so
 * MCP-derived providers (which have no hand-authored template) still carry
 * their pin. Insert defaults deliberately mirror the template-less fallbacks
 * in apps/api (`supportedScopes: ["tenant","user"]`, `recommendedScope:
 * "user"` for OAuth) so creating the row does not change scope behavior.
 *
 * The RFC 9207 support flag is a ratchet: once an AS has advertised
 * `authorization_response_iss_parameter_supported`, a later discovery that
 * stops advertising it does not weaken response validation back to the
 * permissive absent-iss branch.
 */
export async function pinConnectionProviderIssuer(
	db: DbClient,
	params: {
		id: string;
		issuer: string;
		authorizationResponseIssSupported: boolean;
		/** Display fields, used only when no template row exists yet. */
		name: string;
		description?: string | null;
		icon?: string | null;
	},
): Promise<void> {
	await db
		.insert(connectionProviders)
		.values({
			id: params.id,
			name: params.name,
			description: params.description ?? "",
			icon: params.icon ?? "",
			category: "infrastructure",
			type: "oauth",
			recommendedScope: "user",
			supportedScopes: ["tenant", "user"],
			requiredScopes: [],
			pinnedIssuer: params.issuer,
			authorizationResponseIssSupported:
				params.authorizationResponseIssSupported,
		})
		.onConflictDoUpdate({
			target: connectionProviders.id,
			set: {
				pinnedIssuer: params.issuer,
				authorizationResponseIssSupported:
					params.authorizationResponseIssSupported
						? true
						: sql`COALESCE(${connectionProviders.authorizationResponseIssSupported}, 0)`,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			},
		});
}

/**
 * Fill a credential template (e.g. Descope Token Vault opaque-value template
 * "{projectId}:{managementKey}") from collected field values. Pure string
 * templating with no registry or DB dependency.
 */
export function applyConnectionCredentialTemplate(
	template: string,
	fields: Record<string, string>,
): string {
	return template.replace(/\{([a-zA-Z_]\w*)\}/g, (_match, key: string) => {
		const value = fields[key];
		if (value == null) {
			throw new Error(`Missing credential field: ${key}`);
		}
		return value.trim();
	});
}
