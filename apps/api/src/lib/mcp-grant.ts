import { tracing } from "cloudflare:workers";
import type {
	StageHumanMcpConsentInput,
	VerifyHumanMcpGrantInput,
} from "@tedix/api-contract/contracts/organizations";
import {
	loadDescopeMcpServer,
	searchDescopeMcpServerClients,
} from "@tedix/auth/aih-client";
import { getManagementClient } from "@tedix/auth/client";
import type { DbClient } from "@tedix/db/client";
import {
	getMemberByUserId,
	getOrganizationAggregatorGateways,
} from "@tedix/db/queries/organization-members";
import { getOrganizationByDescopeId } from "@tedix/db/queries/organizations";
import {
	getMcpConsentResource,
	disableMcpConsentSelection,
	listMcpConsentSelections,
	getMcpConsentSelection,
	getMcpConsentPending,
	stageMcpConsentPending,
	promoteMcpConsentPending,
	replaceMcpConsentSelection,
} from "@tedix/db/queries/mcp-consent";

export interface SelectedMcpOrganization {
	organizationId: string;
	descopeTenantId: string;
	gatewaySlug: string;
}

export type HumanMcpGrantDecision =
	| {
			allowed: true;
			reason: "active";
			organizations: SelectedMcpOrganization[];
	  }
	| {
			allowed: false;
			reason:
				| "consent_missing"
				| "selection_replaced"
				| "scope_missing"
				| "membership_missing"
				| "provider_unavailable";
			organizations: [];
	  };

function deny(
	reason: Extract<HumanMcpGrantDecision, { allowed: false }>["reason"],
): HumanMcpGrantDecision {
	return { allowed: false, reason, organizations: [] };
}

function sameCanonicalSet(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		new Set(right).size === right.length &&
		left.every((value) => right.includes(value))
	);
}

/** Provider-owned permission names are authoritative; attribute scopes are not capabilities. */
async function registeredResourceScopes(
	db: DbClient,
	env: CloudflareEnv,
	resource: NonNullable<Awaited<ReturnType<typeof getMcpConsentResource>>>,
	mcpServerId: string,
	resourceUrl?: string,
): Promise<Set<string> | null> {
	const server = await loadDescopeMcpServer(
		{
			DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
			DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY!,
			DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
		},
		mcpServerId,
	);
	if (
		server.id !== mcpServerId ||
		server.type !== "mcp" ||
		!Array.isArray(server.audienceWhitelist) ||
		server.audienceWhitelist.length !== 1 ||
		typeof server.audienceWhitelist[0] !== "string"
	)
		return null;
	const audience = server.audienceWhitelist[0];
	if (resourceUrl !== undefined && audience !== resourceUrl) return null;
	const owner = await getMcpConsentResource(db, { resourceUrl: audience });
	if (
		!owner ||
		owner.appId !== resource.appId ||
		owner.organizationId !== resource.organizationId ||
		owner.metadata?.mcpConfig?.descopeResourceId !== mcpServerId
	)
		return null;
	const approved = server.approvedScopes;
	if (!approved || typeof approved !== "object" || Array.isArray(approved))
		return null;
	const names: string[] = [];
	for (const group of [
		approved.permissionsScopes,
		approved.connectionsScopes,
	]) {
		if (group === undefined) continue;
		if (!Array.isArray(group)) return null;
		for (const scope of group) {
			if (
				!scope ||
				typeof scope !== "object" ||
				typeof scope.name !== "string" ||
				!scope.name.trim()
			)
				return null;
			names.push(scope.name);
		}
	}
	return names.length ? new Set(names) : null;
}

async function verifiedHumanClient(
	db: DbClient,
	env: CloudflareEnv,
	clientReference: string,
	resourceUrl: string,
): Promise<{
	appId: string;
	clientId: string;
	mcpServerId: string;
	supportedScopes: Set<string>;
	resource: NonNullable<Awaited<ReturnType<typeof getMcpConsentResource>>>;
} | null> {
	const resource = await getMcpConsentResource(db, { resourceUrl });
	const config = resource?.metadata?.mcpConfig;
	const mcpServerId = config?.descopeResourceId;
	if (!resource || typeof mcpServerId !== "string" || !mcpServerId) {
		return null;
	}
	let supportedScopes: Set<string> | null;
	try {
		supportedScopes = await registeredResourceScopes(
			db,
			env,
			resource,
			mcpServerId,
			resourceUrl,
		);
	} catch {
		return null;
	}
	if (!supportedScopes) return null;
	// Descope redirects expose an app ID even when referrer policy hides client_id.
	// Treat either value only as a lookup key; persist the verified canonical ID.
	const byAppId = /^TPA[A-Za-z0-9_-]{1,252}$/.test(clientReference);
	const clients = await searchDescopeMcpServerClients(env, {
		mcpServerId,
		...(byAppId ? {} : { clientId: clientReference }),
	});
	const matches = clients.filter(
		(client) =>
			client.mcpServerId === mcpServerId &&
			(byAppId
				? client.id === clientReference
				: (client.clientId ?? client.client_id) === clientReference) &&
			(client.clientId ?? client.client_id) &&
			client.status === "verified",
	);
	if (matches.length !== 1) return null;
	return {
		resource,
		appId: matches[0]!.id,
		clientId: (matches[0]!.clientId ?? matches[0]!.client_id)!,
		mcpServerId,
		supportedScopes,
	};
}

/** Stage one browser decision before Descope creates consent. */
export async function stageHumanMcpConsent(
	db: DbClient,
	env: CloudflareEnv,
	descopeUserId: string,
	input: StageHumanMcpConsentInput,
): Promise<string | null> {
	if (!env.DESCOPE_MANAGEMENT_KEY) return null;
	const registered = await verifiedHumanClient(
		db,
		env,
		input.clientId,
		input.resourceUrl,
	);
	if (!registered) return null;
	if (
		registered.resource.metadata?.mcpConfig?.multiOrgConsent !== true &&
		(input.selectedTenantIds.length !== 1 ||
			input.selectedTenantIds[0] !== registered.resource.descopeTenantId)
	)
		return null;
	if (
		input.approvedScopes.some((scope) => !registered.supportedScopes.has(scope))
	) {
		return null;
	}
	const management = getManagementClient({
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
	});
	const user = await management.management.user.loadByUserId(descopeUserId);
	if (!user.ok || !user.data) return null;
	if (
		input.approvedScopes.includes("platform:admin") &&
		!user.data.roleNames?.includes("platform-admin")
	)
		return null;
	const liveTenants = new Set(
		(user.data.userTenants ?? []).map((tenant) => tenant.tenantId),
	);
	if (!input.selectedTenantIds.every((id) => liveTenants.has(id))) return null;
	const rows = await Promise.all(
		input.selectedTenantIds.map(async (tenantId) => {
			const organization = await getOrganizationByDescopeId(db, tenantId);
			if (!organization) return null;
			const member = await getMemberByUserId(
				db,
				organization.id,
				descopeUserId,
			);
			return member?.status === "active" ? organization.id : null;
		}),
	);
	if (rows.some((id) => !id)) return null;
	const gateways = await getOrganizationAggregatorGateways(
		db,
		rows as string[],
	);
	if (
		registered.resource.metadata?.mcpConfig?.multiOrgConsent === true &&
		rows.some((id) => !gateways.has(id!))
	)
		return null;
	const key = {
		descopeUserId,
		mcpServerId: registered.mcpServerId,
		clientId: registered.clientId,
	};
	const current = await getMcpConsentSelection(db, key);
	const revision = crypto.randomUUID();
	await stageMcpConsentPending(db, {
		...key,
		appId: registered.appId,
		revision,
		expectedActiveRevision: current?.revision ?? null,
		selectedTenantIds: [...input.selectedTenantIds].sort(),
		approvedScopes: [...input.approvedScopes].sort(),
		expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
	});
	return revision;
}

/** Explicit revocation advances the current-revision fence. */
export async function revokeHumanMcpConsent(
	db: DbClient,
	env: CloudflareEnv,
	descopeUserId: string,
	input: { clientId: string; resourceUrl: string },
): Promise<string | null> {
	if (!env.DESCOPE_MANAGEMENT_KEY) return null;
	const registered = await verifiedHumanClient(
		db,
		env,
		input.clientId,
		input.resourceUrl,
	);
	if (!registered) return null;
	const revision = crypto.randomUUID();
	await replaceMcpConsentSelection(db, {
		descopeUserId,
		mcpServerId: registered.mcpServerId,
		clientId: registered.clientId,
		appId: registered.appId,
		revision,
		status: "revoked",
		selectedTenantIds: [],
		approvedScopes: [],
	});
	return revision;
}

/**
 * Recheck every signed selected tenant on each human MCP request. The MCP
 * edge first validates token signature and exact resource audience. No grant
 * or membership result is cached here: deleting consent must stop the next
 * request even while a previously issued access token remains unexpired.
 */
export async function verifyHumanMcpGrant(
	db: DbClient,
	env: CloudflareEnv,
	input: VerifyHumanMcpGrantInput,
): Promise<HumanMcpGrantDecision> {
	// Content-free stage timing: fixed names, durations and counts only. Spans
	// carry the same values but are not queryable from Workers logs, and this
	// check runs on every Connect request.
	const started = Date.now();
	const stages: Record<string, number> = {};
	let last = started;
	const mark = (stage: string) => {
		const now = Date.now();
		stages[`${stage}_ms`] = now - last;
		last = now;
	};
	let decision: HumanMcpGrantDecision | undefined;
	try {
		decision = await verifyHumanMcpGrantStages(db, env, input, mark);
		return decision;
	} finally {
		console.log(
			JSON.stringify({
				_tr: "mcp_grant_timing",
				total_ms: Date.now() - started,
				...stages,
				organizations: input.selectedTenantIds.length,
				outcome: decision?.allowed ? "allowed" : (decision?.reason ?? "error"),
			}),
		);
	}
}

async function verifyHumanMcpGrantStages(
	db: DbClient,
	env: CloudflareEnv,
	input: VerifyHumanMcpGrantInput,
	mark: (stage: string) => void,
): Promise<HumanMcpGrantDecision> {
	if (!env.DESCOPE_MANAGEMENT_KEY) return deny("provider_unavailable");
	const resource = await getMcpConsentResource(db, {
		mcpServerId: input.mcpServerId,
	});
	if (
		!resource ||
		resource.metadata?.mcpConfig?.descopeResourceId !== input.mcpServerId ||
		(resource.metadata?.mcpConfig?.multiOrgConsent !== true &&
			(input.selectedTenantIds.length !== 1 ||
				input.selectedTenantIds[0] !== resource.descopeTenantId))
	)
		return deny("membership_missing");
	mark("resource");

	let liveTenants: Set<string>;
	let appId: string;
	try {
		const management = getManagementClient({
			DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
			DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
			DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
		});
		// Registration and live grant reads are independent. Await all outcomes
		// together, then retain the existing scope-first denial precedence.
		const [scopeResult, clientResult, userResult, consentResult] =
			await tracing.enterSpan(
				"tedix.api.mcp_grant.provider_reads",
				async (span) => {
					const started = Date.now();
					const measure = async <T>(
						phase: "registered_scopes" | "client" | "user" | "consent",
						read: () => Promise<T>,
					): Promise<T> => {
						const start = Date.now();
						try {
							return await read();
						} finally {
							// Fixed phase names and durations only: no identity or grant data.
							span.setAttribute(
								`tedix.mcp_grant.${phase}_ms`,
								Date.now() - start,
							);
						}
					};
					try {
						return await Promise.allSettled([
							measure("registered_scopes", () =>
								registeredResourceScopes(db, env, resource, input.mcpServerId),
							),
							measure("client", () =>
								searchDescopeMcpServerClients(env, {
									mcpServerId: input.mcpServerId,
									clientId: input.clientId,
								}),
							),
							measure("user", () =>
								management.management.user.loadByUserId(input.descopeUserId),
							),
							measure("consent", () =>
								management.management.inboundApplication.searchConsents({
									userId: input.descopeUserId,
									consentId: input.consentId,
								}),
							),
						]);
					} finally {
						span.setAttribute(
							"tedix.mcp_grant.provider_reads_ms",
							Date.now() - started,
						);
					}
				},
			);
		mark("provider");
		if (scopeResult.status === "rejected") return deny("provider_unavailable");
		const supported = scopeResult.value;
		if (!supported || input.tokenScopes.some((scope) => !supported.has(scope)))
			return deny("scope_missing");
		if (
			clientResult.status === "rejected" ||
			userResult.status === "rejected" ||
			consentResult.status === "rejected"
		)
			return deny("provider_unavailable");
		const clients = clientResult.value;
		const user = userResult.value;
		const consents = consentResult.value;
		const registered = clients.filter(
			(client) =>
				client.mcpServerId === input.mcpServerId &&
				(client.clientId ?? client.client_id) === input.clientId &&
				client.id &&
				client.status === "verified",
		);
		if (registered.length !== 1) return deny("consent_missing");
		appId = registered[0]!.id;
		if (!user.ok || !consents.ok || !Array.isArray(consents.data)) {
			return deny("provider_unavailable");
		}
		if (
			input.tokenScopes.includes("platform:admin") &&
			!user.data?.roleNames?.includes("platform-admin")
		)
			return deny("scope_missing");
		const consent = consents.data.find(
			(record) =>
				record.id === input.consentId &&
				record.appId === appId &&
				record.userId === input.descopeUserId,
		);
		if (!consent) return deny("consent_missing");
		const grantedScopes = new Set(consent.scopes);
		if (!input.tokenScopes.every((scope) => grantedScopes.has(scope))) {
			return deny("scope_missing");
		}
		liveTenants = new Set(
			(user.data?.userTenants ?? []).map((tenant) => tenant.tenantId),
		);
	} catch {
		return deny("provider_unavailable");
	}

	const key = {
		descopeUserId: input.descopeUserId,
		mcpServerId: input.mcpServerId,
		clientId: input.clientId,
	};
	const matchesActive = (
		current: Awaited<ReturnType<typeof getMcpConsentSelection>>,
	) =>
		current?.status === "active" &&
		current.appId === appId &&
		current.revision === input.consentRevision &&
		sameCanonicalSet(current.selectedTenantIds, input.selectedTenantIds) &&
		sameCanonicalSet(current.approvedScopes, input.tokenScopes);
	let pending: Awaited<ReturnType<typeof getMcpConsentPending>> = null;
	try {
		const current = await getMcpConsentSelection(db, key);
		if (!matchesActive(current)) {
			pending = await getMcpConsentPending(db, {
				...key,
				revision: input.consentRevision,
			});
			if (
				!pending ||
				pending.appId !== appId ||
				pending.expiresAt <= new Date().toISOString() ||
				!sameCanonicalSet(pending.selectedTenantIds, input.selectedTenantIds) ||
				!sameCanonicalSet(pending.approvedScopes, input.tokenScopes)
			) {
				return deny("selection_replaced");
			}
		}
	} catch {
		return deny("provider_unavailable");
	}

	mark("selection");
	if (!input.selectedTenantIds.every((id) => liveTenants.has(id))) {
		return deny("membership_missing");
	}

	let organizations: SelectedMcpOrganization[];
	try {
		const rows = await Promise.all(
			input.selectedTenantIds.map(async (descopeTenantId) => {
				const organization = await getOrganizationByDescopeId(
					db,
					descopeTenantId,
				);
				if (!organization) return null;
				const member = await getMemberByUserId(
					db,
					organization.id,
					input.descopeUserId,
				);
				if (member?.status !== "active") return null;
				return { organizationId: organization.id, descopeTenantId };
			}),
		);
		if (rows.some((row) => !row)) return deny("membership_missing");
		const activeRows = rows.filter((row): row is NonNullable<typeof row> =>
			Boolean(row),
		);
		const gateways = await getOrganizationAggregatorGateways(
			db,
			activeRows.map((row) => row.organizationId),
		);
		organizations = activeRows.map((row) => ({
			...row,
			gatewaySlug:
				resource.metadata?.mcpConfig?.multiOrgConsent === true
					? (gateways.get(row.organizationId)?.slug ?? "")
					: resource.slug,
		}));
	} catch {
		return deny("provider_unavailable");
	}
	mark("membership");
	if (organizations.some((org) => !org.gatewaySlug)) {
		return deny("membership_missing");
	}
	try {
		if (pending) {
			await promoteMcpConsentPending(db, {
				...key,
				appId,
				revision: input.consentRevision,
				expectedActiveRevision: pending.expectedActiveRevision,
				selectedTenantIds: input.selectedTenantIds,
				approvedScopes: input.tokenScopes,
			});
		}
		// A concurrent request may already have activated this revision, or a
		// revoke/replacement may have won. Only the current exact row can allow.
		if (!matchesActive(await getMcpConsentSelection(db, key))) {
			return deny("selection_replaced");
		}
	} catch {
		return deny("provider_unavailable");
	}
	mark("finalize");
	return { allowed: true, reason: "active", organizations };
}

/** Stored decisions are not issued tokens: report provider consent separately. */
export async function listHumanMcpAuthorizations(
	db: DbClient,
	env: CloudflareEnv,
	descopeUserId: string,
	input: { limit: number; offset: number },
) {
	const rows = await listMcpConsentSelections(db, {
		descopeUserId,
		limit: input.limit + 1,
		offset: input.offset,
	});
	const management = env.DESCOPE_MANAGEMENT_KEY
		? getManagementClient(env)
		: null;
	const items = await Promise.all(
		rows.slice(0, input.limit).map(async (row) => {
			let clientName: string | null = null;
			let providerStatus:
				| "present"
				| "missing"
				| "unavailable"
				| "not_checked" =
				row.status === "revoked" ? "not_checked" : "unavailable";
			if (management) {
				const [clients, consents] = await Promise.allSettled([
					searchDescopeMcpServerClients(env, {
						mcpServerId: row.mcpServerId,
						clientId: row.clientId,
					}),
					row.status === "active"
						? management.management.inboundApplication.searchConsents({
								appId: row.appId,
								userId: descopeUserId,
							})
						: Promise.resolve(null),
				]);
				const registered =
					clients.status === "fulfilled"
						? clients.value.filter(
								(client) =>
									client.mcpServerId === row.mcpServerId &&
									(client.clientId ?? client.client_id) === row.clientId &&
									client.id === row.appId &&
									client.status === "verified",
							)
						: [];
				if (registered.length === 1) clientName = registered[0]!.name ?? null;
				if (clients.status === "rejected") {
					console.error("[mcp-grant] Application metadata unavailable");
				}
				if (row.status === "active") {
					if (consents.status === "rejected") {
						console.error(
							"[mcp-grant] Provider consent verification unavailable",
						);
					} else if (
						clients.status === "fulfilled" &&
						consents.value?.ok &&
						Array.isArray(consents.value.data)
					) {
						providerStatus =
							registered.length === 1 &&
							consents.value.data.some(
								(consent) =>
									consent.appId === row.appId &&
									consent.userId === descopeUserId &&
									row.approvedScopes.every((scope) =>
										consent.scopes.includes(scope),
									),
							)
								? "present"
								: "missing";
					}
				}
			}
			return {
				mcpServerId: row.mcpServerId,
				clientId: row.clientId,
				clientName,
				revision: row.revision,
				status: row.status,
				providerStatus,
				selectedTenantIds: row.selectedTenantIds,
				approvedScopes: row.approvedScopes,
				updatedAt: row.updatedAt,
			};
		}),
	);
	return { items, hasMore: rows.length > input.limit };
}

export async function disableHumanMcpAuthorization(
	db: DbClient,
	env: CloudflareEnv,
	descopeUserId: string,
	input: { mcpServerId: string; clientId: string; expectedRevision: string },
) {
	const row = await disableMcpConsentSelection(db, {
		...input,
		descopeUserId,
		revision: crypto.randomUUID(),
	});
	return row?.revision ?? null;
}
