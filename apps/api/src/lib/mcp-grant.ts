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
import { withTransientD1ReadRetry } from "@tedix/db/utils/d1-retry";
import {
	getMemberByUserId,
	getMembershipsByDescopeTenants,
	getOrganizationAggregatorGateways,
} from "@tedix/db/queries/organization-members";
import {
	getOrganizationByDescopeId,
	isOrganizationOffboarding,
} from "@tedix/db/queries/organizations";
import {
	getMcpConsentResource,
	disableMcpConsentSelection,
	listMcpConsentSelections,
	getMcpConsentGrant,
	getMcpConsentSelection,
	getMcpConsentPending,
	stageMcpConsentPending,
	promoteMcpConsentPending,
	replaceMcpConsentSelection,
} from "@tedix/db/queries/mcp-consent";
import {
	evaluateInboundClientPolicy,
	parseStoredInboundClientPolicy,
	recordInboundClientVerdict,
} from "./mcp-inbound-client-policy";
import { ProviderFactsCache } from "./provider-facts-cache";

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
				| "client_not_allowed"
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
	deadline?: number,
): Promise<Set<string> | null> {
	const server = await loadDescopeMcpServer(
		{
			DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
			DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY!,
			DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
		},
		mcpServerId,
		{ deadline },
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
	const owner = await readGrantState("resource_owner", () =>
		getMcpConsentResource(db, { resourceUrl: audience }),
	);
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
	clientName: string | null;
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
	const supportedScopes = await registeredResourceScopes(
		db,
		env,
		resource,
		mcpServerId,
		resourceUrl,
	);
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
		clientName: matches[0]!.name ?? null,
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
	const client = {
		mcpServerId: registered.mcpServerId,
		clientId: registered.clientId,
	};
	const rows = await Promise.all(
		input.selectedTenantIds.map(async (tenantId) => {
			const organization = await getOrganizationByDescopeId(db, tenantId);
			// A new consent may not select an organization being offboarded.
			if (!organization || isOrganizationOffboarding(organization.metadata))
				return null;
			const member = await getMemberByUserId(
				db,
				organization.id,
				descopeUserId,
			);
			if (member?.status !== "active") return null;
			const verdict = evaluateInboundClientPolicy(
				organization.metadata?.mcpInboundClientPolicy,
				client,
			);
			await recordInboundClientVerdict(
				db,
				"consent",
				organization.id,
				{ ...client, clientName: registered.clientName },
				verdict,
			);
			return verdict.allowed ? organization.id : null;
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

/** Explicit revocation advances the fence and removes every grant for the client. */
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
	forgetHumanMcpProviderFacts({
		descopeUserId,
		mcpServerId: registered.mcpServerId,
		clientId: registered.clientId,
	});
	return revision;
}

function readGrantState<T>(label: string, read: () => Promise<T>): Promise<T> {
	return withTransientD1ReadRetry(`mcp_grant.${label}`, read, {
		delayMs: 150 + Math.floor(Math.random() * 150),
		timeoutMs: 5000,
	});
}

/**
 * What the identity provider said about one exact consent: the resource's
 * registered scopes, the verified client registration, the user's live tenants
 * and admin role, and the consent's granted scopes.
 *
 * Every Connect request used to ask the provider four questions. Under many
 * concurrent agents those reads hit the provider's management rate limit, its
 * retries outlived the edge budget, and every lane saw a 503. The answers
 * change rarely, so a complete, successful set is kept for a short time.
 *
 * Only facts are kept, never a decision and never a pending read: each request
 * still judges its own token scopes and tenants against them, and still reads
 * the Tedix consent ledger and memberships, so a Tedix revoke, switch-off or
 * membership removal takes effect on the next request. A change made only at
 * the provider (consent deleted there, user removed from a tenant there) takes
 * effect within the TTL. Failed or incomplete provider reads are never kept.
 */
interface ProviderGrantFacts {
	supportedScopes: ReadonlySet<string>;
	appId: string;
	consentScopes: ReadonlySet<string>;
	liveTenants: ReadonlySet<string>;
	platformAdmin: boolean;
}

const providerFactsCache = new ProviderFactsCache<ProviderGrantFacts>();

/**
 * The MCP edge gives this check 15 s. Provider reads stop retrying in time
 * for the request to answer "retry later" with a 503 instead of being cut off
 * while a Retry-After sleep is still running.
 */
const PROVIDER_DEADLINE_MS = 10_000;

function providerFactsKey(
	input: Pick<
		VerifyHumanMcpGrantInput,
		"descopeUserId" | "mcpServerId" | "clientId" | "consentId"
	>,
	resource: { appId: string; organizationId: string | null },
) {
	return JSON.stringify([
		input.descopeUserId,
		input.mcpServerId,
		input.clientId,
		input.consentId,
		resource.appId,
		resource.organizationId,
	]);
}

/** Drop this isolate's provider facts for one user's client, or for all. */
export function forgetHumanMcpProviderFacts(filter?: {
	descopeUserId: string;
	mcpServerId?: string;
	clientId?: string;
}) {
	providerFactsCache.forget(
		filter &&
			((key) => {
				const [userId, mcpServerId, clientId] = JSON.parse(key) as string[];
				return (
					userId === filter.descopeUserId &&
					(filter.mcpServerId === undefined ||
						mcpServerId === filter.mcpServerId) &&
					(filter.clientId === undefined || clientId === filter.clientId)
				);
			}),
	);
}

/** Authorization I/O belongs to this request: an isolate-wide pending promise
 * can outlive its owner after disconnect and strand every subsequent caller.
 * Never retain a pending read or a decision across requests; only the
 * complete provider facts above are kept, for a short time.
 */
export async function verifyHumanMcpGrant(
	db: DbClient,
	env: CloudflareEnv,
	input: VerifyHumanMcpGrantInput,
	options: { defer?: (promise: Promise<unknown>) => void } = {},
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
		decision = await verifyHumanMcpGrantStages(
			db,
			env,
			input,
			mark,
			started + PROVIDER_DEADLINE_MS,
			options.defer,
		);
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
	deadline: number,
	defer?: (promise: Promise<unknown>) => void,
): Promise<HumanMcpGrantDecision> {
	if (!env.DESCOPE_MANAGEMENT_KEY) return deny("provider_unavailable");
	const resource = await readGrantState("resource", () =>
		getMcpConsentResource(db, { mcpServerId: input.mcpServerId }),
	);
	if (
		!resource ||
		resource.metadata?.mcpConfig?.descopeResourceId !== input.mcpServerId ||
		(resource.metadata?.mcpConfig?.multiOrgConsent !== true &&
			(input.selectedTenantIds.length !== 1 ||
				input.selectedTenantIds[0] !== resource.descopeTenantId))
	)
		return deny("membership_missing");
	mark("resource");

	const key = {
		descopeUserId: input.descopeUserId,
		mcpServerId: input.mcpServerId,
		clientId: input.clientId,
	};
	const grantKey = { ...key, revision: input.consentRevision };
	// The ledger reads do not depend on the provider answers, so they run while
	// Descope is asked. Every result is still judged after the provider checks,
	// in the same order, and the active grant is re-read before allowing.
	const ledgerReads = Promise.all([
		readGrantState("active", () => getMcpConsentGrant(db, grantKey)),
		readGrantState("pending", () => getMcpConsentPending(db, grantKey)),
		readGrantState("memberships", () =>
			getMembershipsByDescopeTenants(
				db,
				input.selectedTenantIds,
				input.descopeUserId,
			),
		).then(async (memberships) => ({
			memberships,
			gateways: await readGrantState("gateways", () =>
				getOrganizationAggregatorGateways(
					db,
					memberships.map((row) => row.organizationId),
				),
			),
		})),
	]).then(
		([current, pending, membership]) => ({
			ok: true as const,
			current,
			pending,
			...membership,
		}),
		() => ({ ok: false as const }),
	);

	// Platform administration is never served from kept facts: removing the
	// provider role must end it on the next request.
	const cacheable = !input.tokenScopes.includes("platform:admin");
	const factsKey = providerFactsKey(input, resource);
	let facts = cacheable ? providerFactsCache.get(factsKey) : null;
	if (facts) {
		mark("provider_cache");
	} else {
		const loaded = await loadProviderFacts(
			db,
			env,
			input,
			resource,
			mark,
			deadline,
		);
		if ("denied" in loaded) return deny(loaded.denied);
		facts = loaded.facts;
		if (cacheable) providerFactsCache.set(factsKey, facts);
	}
	// Provider facts may be shared by requests with different tokens, so this
	// request's own scopes are always judged against them here.
	const { supportedScopes, consentScopes, platformAdmin } = facts;
	if (
		input.tokenScopes.some((scope) => !supportedScopes.has(scope)) ||
		(input.tokenScopes.includes("platform:admin") && !platformAdmin) ||
		!input.tokenScopes.every((scope) => consentScopes.has(scope))
	)
		return deny("scope_missing");
	const appId = facts.appId;
	const liveTenants = facts.liveTenants;

	const ledger = await ledgerReads;
	if (!ledger.ok) return deny("provider_unavailable");
	return judgeLedger(
		db,
		input,
		resource,
		ledger,
		appId,
		liveTenants,
		mark,
		defer,
	);
}

type ProviderFactsResult =
	| { facts: ProviderGrantFacts }
	| { denied: Extract<HumanMcpGrantDecision, { allowed: false }>["reason"] };

/** Ask the provider every question for one consent, in the existing denial order. */
async function loadProviderFacts(
	db: DbClient,
	env: CloudflareEnv,
	input: VerifyHumanMcpGrantInput,
	resource: NonNullable<Awaited<ReturnType<typeof getMcpConsentResource>>>,
	mark: (stage: string) => void,
	deadline: number,
): Promise<ProviderFactsResult> {
	const deny = (
		reason: Extract<HumanMcpGrantDecision, { allowed: false }>["reason"],
	): ProviderFactsResult => ({ denied: reason });
	try {
		const management = getManagementClient(
			{
				DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
				DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
				DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
			},
			{ deadline },
		);
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
								registeredResourceScopes(
									db,
									env,
									resource,
									input.mcpServerId,
									undefined,
									deadline,
								),
							),
							measure("client", () =>
								searchDescopeMcpServerClients(
									env,
									{
										mcpServerId: input.mcpServerId,
										clientId: input.clientId,
									},
									{ deadline },
								),
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
		const appId = registered[0]!.id;
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
		const consentScopes = new Set(consent.scopes);
		if (!input.tokenScopes.every((scope) => consentScopes.has(scope))) {
			return deny("scope_missing");
		}
		return {
			facts: {
				supportedScopes: supported,
				appId,
				consentScopes,
				liveTenants: new Set(
					(user.data?.userTenants ?? []).map((tenant) => tenant.tenantId),
				),
				platformAdmin:
					user.data?.roleNames?.includes("platform-admin") === true,
			},
		};
	} catch {
		return deny("provider_unavailable");
	}
}

/** Judge the request's Tedix ledger and memberships; never cached. */
async function judgeLedger(
	db: DbClient,
	input: VerifyHumanMcpGrantInput,
	resource: NonNullable<Awaited<ReturnType<typeof getMcpConsentResource>>>,
	ledger: {
		current: Awaited<ReturnType<typeof getMcpConsentGrant>>;
		pending: Awaited<ReturnType<typeof getMcpConsentPending>>;
		memberships: Awaited<ReturnType<typeof getMembershipsByDescopeTenants>>;
		gateways: Awaited<ReturnType<typeof getOrganizationAggregatorGateways>>;
	},
	appId: string,
	liveTenants: ReadonlySet<string>,
	mark: (stage: string) => void,
	defer?: (promise: Promise<unknown>) => void,
): Promise<HumanMcpGrantDecision> {
	const key = {
		descopeUserId: input.descopeUserId,
		mcpServerId: input.mcpServerId,
		clientId: input.clientId,
	};
	const grantKey = { ...key, revision: input.consentRevision };
	// Several installs of one OAuth client may each hold an active grant; the
	// signed revision selects exactly one, whose authority must match exactly.
	const matchesActive = (
		grant: Awaited<ReturnType<typeof getMcpConsentGrant>>,
	) =>
		grant?.appId === appId &&
		grant.revision === input.consentRevision &&
		sameCanonicalSet(grant.selectedTenantIds, input.selectedTenantIds) &&
		sameCanonicalSet(grant.approvedScopes, input.tokenScopes);
	const pending = matchesActive(ledger.current) ? null : ledger.pending;
	if (
		!matchesActive(ledger.current) &&
		(!pending ||
			pending.appId !== appId ||
			pending.expiresAt <= new Date().toISOString() ||
			!sameCanonicalSet(pending.selectedTenantIds, input.selectedTenantIds) ||
			!sameCanonicalSet(pending.approvedScopes, input.tokenScopes))
	) {
		return deny("selection_replaced");
	}

	mark("selection");
	if (!input.selectedTenantIds.every((id) => liveTenants.has(id))) {
		return deny("membership_missing");
	}

	const organizations: SelectedMcpOrganization[] = [];
	for (const descopeTenantId of input.selectedTenantIds) {
		const row = ledger.memberships.find(
			(membership) => membership.descopeTenantId === descopeTenantId,
		);
		if (row?.status !== "active") return deny("membership_missing");
		const client = { mcpServerId: input.mcpServerId, clientId: input.clientId };
		const verdict = evaluateInboundClientPolicy(
			parseStoredInboundClientPolicy(row.inboundClientPolicyJson),
			client,
		);
		await recordInboundClientVerdict(
			db,
			"grant",
			row.organizationId,
			client,
			verdict,
			defer,
		);
		if (!verdict.allowed) return deny("client_not_allowed");
		organizations.push({
			organizationId: row.organizationId,
			descopeTenantId,
			gatewaySlug:
				resource.metadata?.mcpConfig?.multiOrgConsent === true
					? (ledger.gateways.get(row.organizationId)?.slug ?? "")
					: resource.slug,
		});
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
		// revoke may have won. Only an exact active grant can allow.
		if (
			!matchesActive(
				await readGrantState("finalize", () =>
					getMcpConsentGrant(db, grantKey),
				),
			)
		) {
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
	forgetHumanMcpProviderFacts({
		descopeUserId,
		mcpServerId: input.mcpServerId,
		clientId: input.clientId,
	});
	return row?.revision ?? null;
}
