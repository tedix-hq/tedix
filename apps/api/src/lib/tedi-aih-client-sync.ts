import type { TediAppAssignmentRole } from "@tedix/api-contract/schemas/tedi-app-assignments";
import {
	type AihEnv,
	aihClientSecretNames,
	createDescopeMcpServerClient,
	deleteDescopeMcpServerClient,
	getDescopeMcpServerClientSecret,
	loadDescopeMcpServer,
	type McpServerClientRecord,
	type McpServerApprovedScopes,
	searchDescopeMcpServerClients,
	updateDescopeMcpServerClient,
} from "@tedix/auth/aih-client";
import {
	ATTR_ENTITY_TYPE,
	ATTR_TEDI_ID,
	buildTediLoginId,
	ENTITY_TYPE_TEDI,
} from "@tedix/auth/tedi-identity";
import { getManagementClient } from "@tedix/auth/client";
import {
	PLATFORM_SCOPES,
	resolveTediScopes,
	TEDI_MCP_SCOPES,
} from "@tedix/auth/app-assignment-policy";
import type { DbClient } from "@tedix/db/client";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import type { App } from "@tedix/db/schema/apps";
import {
	deleteTediSecret,
	getTediSecret,
	upsertTediSecret,
} from "@tedix/db/queries/tedi-secrets";
import {
	decryptTediSecret,
	encryptTediSecret,
	timingSafeCompare,
} from "@tedix/db/utils/secrets-encryption";

const OBSERVER_SCOPES = [
	"mcp:catalog.read",
	"mcp:observe.read",
	"connections.read",
] as const;
const LEGACY_CAPABILITY_SCOPE_RE =
	/^mcp:(tedis|apps|memory|skills|content|catalog|observe|messaging|settings)$/;
const TEDI_OPERATOR_SCOPES = ["tedi:admin"] as const;
const TEDI_OBSERVER_SCOPES = TEDI_MCP_SCOPES.filter((scope) =>
	scope.endsWith(".read"),
);
const AGGREGATE_TEDI_WORK_SCOPES = ["mcp:work.read", "mcp:work.write"] as const;

type TediAihClientIdentity = {
	id: string;
	name: string;
	slug: string;
	descopeUserId?: string | null;
	mcpCapabilityProfile?: string | null;
};

type DescopeSubjectRecord = {
	userId?: string;
	loginIds?: string[];
	customAttributes?: Record<string, unknown>;
};

export interface TediDescopeSubjectAttestation {
	source: "descope_management_api";
	subjectId: string;
	subjectIdMatches: boolean;
	expectedLoginId: string;
	loginIdPresent: boolean;
	entityTypeMatches: boolean;
	tediIdMatches: boolean;
	verified: boolean;
	checkedAt: string;
}

export type TediAihClientSyncStatus =
	| "created"
	| "updated"
	| "deleted"
	| "skipped";

export interface TediAihClientSyncResult {
	status: TediAihClientSyncStatus;
	appId: string;
	appSlug: string;
	tediId: string;
	mcpServerId?: string;
	clientId?: string;
	scopes: string[];
	secretNames?: {
		clientIdName: string;
		clientSecretName: string;
	};
	reason?: string;
}

export interface TediAihClientAccessValidationResult {
	status: "valid" | "invalid" | "skipped";
	ok: boolean;
	appId: string;
	appSlug: string;
	tediId: string;
	role: TediAppAssignmentRole;
	mcpServerId?: string;
	clientId?: string;
	clientName: string;
	expectedScopes: string[];
	clientScopes: string[];
	missingScopes: string[];
	extraScopes: string[];
	secrets: {
		appClientId: boolean;
		appClientSecret: boolean;
		resourceClientId: boolean;
		resourceClientSecret: boolean;
	};
	identity: TediDescopeSubjectAttestation;
	evidenceRefs: string[];
	reason?: string;
}

export async function attestTediDescopeSubject(
	env: AihEnv,
	tedi: TediAihClientIdentity,
): Promise<TediDescopeSubjectAttestation> {
	const expectedSubjectId = tedi.descopeUserId?.trim() ?? "";
	const expectedLoginId = buildTediLoginId(tedi.slug);
	let subject: DescopeSubjectRecord | null = null;
	if (expectedSubjectId) {
		const response =
			await getManagementClient(env).management.user.loadByUserId(
				expectedSubjectId,
			);
		if (response.ok && response.data) {
			subject = response.data as DescopeSubjectRecord;
		}
	}

	const subjectId = subject?.userId ?? expectedSubjectId;
	const subjectIdMatches =
		Boolean(expectedSubjectId) && subject?.userId === expectedSubjectId;
	const loginIdPresent = subject?.loginIds?.includes(expectedLoginId) ?? false;
	const entityTypeMatches =
		subject?.customAttributes?.[ATTR_ENTITY_TYPE] === ENTITY_TYPE_TEDI;
	const tediIdMatches = subject?.customAttributes?.[ATTR_TEDI_ID] === tedi.id;
	return {
		source: "descope_management_api",
		subjectId,
		subjectIdMatches,
		expectedLoginId,
		loginIdPresent,
		entityTypeMatches,
		tediIdMatches,
		verified:
			subjectIdMatches && loginIdPresent && entityTypeMatches && tediIdMatches,
		checkedAt: new Date().toISOString(),
	};
}

function getDescopeMcpResourceId(app: App): string | null {
	const metadata = getAppMetadataJson(app);
	const mcpConfig = metadata?.mcpConfig as Record<string, unknown> | undefined;
	const value = mcpConfig?.descopeResourceId;
	return typeof value === "string" && value.trim() ? value : null;
}

function getConfiguredAppMcpScopes(app: {
	metadata?: unknown;
}): Set<string> | null {
	const metadata = getAppMetadataJson(app);
	const mcpConfig = metadata?.mcpConfig as Record<string, unknown> | undefined;
	const toolScopes = mcpConfig?.toolScopes;
	if (
		!toolScopes ||
		typeof toolScopes !== "object" ||
		Array.isArray(toolScopes)
	) {
		return null;
	}

	const scopes = new Set<string>();
	for (const value of Object.values(toolScopes)) {
		if (!Array.isArray(value)) continue;
		for (const scope of value) {
			if (typeof scope === "string" && scope.startsWith("mcp:")) {
				if (LEGACY_CAPABILITY_SCOPE_RE.test(scope)) {
					scopes.add(`${scope}.read`);
					scopes.add(`${scope}.write`);
					scopes.add(`${scope}.admin`);
				} else {
					scopes.add(scope);
				}
			}
		}
	}

	// aggregateTedis mounts the Work lifecycle bridge in the MCP Worker even
	// though those tools are not persisted in this app's toolScopes metadata.
	// Admit the same scopes when minting the assigned Tedi's AIH credential so
	// designated reviewers can read and decide evidence under their own identity.
	if (
		Array.isArray(mcpConfig?.aggregateTedis) &&
		mcpConfig.aggregateTedis.some(
			(entry) =>
				entry !== null &&
				typeof entry === "object" &&
				!Array.isArray(entry) &&
				(entry as Record<string, unknown>).surface !== "collaboration",
		)
	) {
		for (const scope of AGGREGATE_TEDI_WORK_SCOPES) scopes.add(scope);
	}
	return scopes.size > 0 ? scopes : null;
}

function isConnectedAggregateApp(app: { metadata?: unknown }): boolean {
	const metadata = getAppMetadataJson(app);
	const mcpConfig = metadata?.mcpConfig as Record<string, unknown> | undefined;
	const aggregateApps = mcpConfig?.aggregateApps;
	if (!Array.isArray(aggregateApps) || aggregateApps.length === 0) return false;

	const rootProvider =
		typeof mcpConfig?.connectionProviderId === "string" &&
		mcpConfig.connectionProviderId.trim().length > 0;
	return aggregateApps.every((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			return false;
		const provider = (entry as Record<string, unknown>).connectionProviderId;
		return (
			rootProvider ||
			(typeof provider === "string" && provider.trim().length > 0)
		);
	});
}

function constrainToConfiguredAppScopes(
	app: { metadata?: unknown },
	scopes: readonly string[],
) {
	const configuredScopes = getConfiguredAppMcpScopes(app);
	const platformScopes = new Set<string>(PLATFORM_SCOPES);
	if (!configuredScopes) {
		return isConnectedAggregateApp(app)
			? scopes.filter((scope) => platformScopes.has(scope))
			: scopes;
	}
	return scopes.filter(
		(scope) => platformScopes.has(scope) || configuredScopes.has(scope),
	);
}

function isTediMcpBridgeApp(app: { metadata?: unknown }): boolean {
	const metadata = getAppMetadataJson(app);
	const mcpConfig = metadata?.mcpConfig as Record<string, unknown> | undefined;
	const upstreamMcpUrl = mcpConfig?.upstreamMcpUrl;
	if (typeof upstreamMcpUrl !== "string" || !upstreamMcpUrl.trim()) {
		return false;
	}

	try {
		const hostname = new URL(upstreamMcpUrl).hostname;
		return (
			hostname === "tedi.tedix.dev" ||
			hostname.endsWith(".tedi.tedix.dev") ||
			hostname.endsWith(".tedi.tedix.tech")
		);
	} catch {
		return false;
	}
}

function getTediClientName(
	tedi: Pick<TediAihClientIdentity, "id" | "slug">,
): string {
	return `tedi:${tedi.slug}:${tedi.id}`;
}

function getLegacyTediClientName(
	tedi: Pick<TediAihClientIdentity, "name" | "slug">,
): string {
	return `tedi:${tedi.slug || tedi.name}`;
}

async function findExistingTediClient(params: {
	env: AihEnv;
	mcpServerId: string;
	tedi: TediAihClientIdentity;
}): Promise<McpServerClientRecord | undefined> {
	const clientName = getTediClientName(params.tedi);
	const clientsByName = await searchDescopeMcpServerClients(params.env, {
		mcpServerId: params.mcpServerId,
		name: clientName,
	});
	const exact = clientsByName.find((client) => client.name === clientName);
	if (exact) return exact;

	const legacyClientName = getLegacyTediClientName(params.tedi);
	const legacyClients = await searchDescopeMcpServerClients(params.env, {
		mcpServerId: params.mcpServerId,
		name: legacyClientName,
	});
	return legacyClients.find(
		(client) =>
			client.name === legacyClientName ||
			client.tags?.includes(`tedi:${params.tedi.id}`),
	);
}

/**
 * The tedis whose AIH client on one of the organization's unified gateways
 * (`*-unified` apps) was issued without `scope`. A client may narrow a tedi
 * below its D1 profile and the gateway enforces the narrower set, so a tedi
 * returned here cannot call a tool that needs `scope` through that gateway. A
 * tedi with no client there is not returned. Throws when Descope fails.
 */
export async function tedisDeniedUnifiedGatewayScope(params: {
	env: AihEnv;
	db: DbClient;
	organizationId: string;
	scope: string;
}): Promise<Set<string>> {
	const serverIds = (
		await getAppsByOrganization(params.db, params.organizationId)
	)
		.filter((app) => app.slug.endsWith("-unified"))
		.map(getDescopeMcpResourceId)
		.filter((id): id is string => id !== null);
	const clients = (
		await Promise.all(
			serverIds.map((mcpServerId) =>
				searchDescopeMcpServerClients(params.env, { mcpServerId }),
			),
		)
	).flat();
	const denied = new Set<string>();
	for (const client of clients) {
		const tediTag = client.tags?.find((tag) => tag.startsWith("tedi:"));
		if (tediTag && !hasScope(client.scopes ?? [], params.scope))
			denied.add(tediTag.slice("tedi:".length));
	}
	return denied;
}

function getClientId(client: McpServerClientRecord): string | null {
	return client.clientId ?? client.client_id ?? null;
}

function normalizeScopes(
	scopes: readonly string[] | null | undefined,
): string[] {
	return [...new Set(scopes ?? [])].filter(Boolean).sort();
}

function scopesEqual(
	left: readonly string[] | null | undefined,
	right: readonly string[] | null | undefined,
): boolean {
	const a = normalizeScopes(left);
	const b = normalizeScopes(right);
	return a.length === b.length && a.every((scope, index) => scope === b[index]);
}

/**
 * Is moving a tedi from `previousProfile` to `nextProfile` a capability
 * DOWNGRADE — i.e. does the next profile grant STRICTLY FEWER scopes than the
 * previous one? True when at least one scope the previous profile held is no
 * longer granted by the next profile (e.g. `org_admin` → `standard` drops
 * `mcp:settings`; `platform_admin` → `org_admin` drops `platform:admin`).
 *
 * A downgrade is the security-critical direction: the tedi's managed AIH M2M
 * clients must shed the removed scopes, so this must propagate reliably rather
 * than best-effort. An upgrade or lateral/no-op change returns false — those
 * only add scope (or none) and the live D1 profile already governs the edge, so
 * their re-sync can stay best-effort.
 */
export function isTediCapabilityDowngrade(
	previousProfile: string | null | undefined,
	nextProfile: string | null | undefined,
): boolean {
	const nextScopes = new Set(resolveTediScopes(nextProfile));
	return resolveTediScopes(previousProfile).some(
		(scope) => !nextScopes.has(scope),
	);
}

export function resolveTediAihClientScopesForApp(params: {
	app: { metadata?: unknown };
	role: TediAppAssignmentRole;
	tedi: Pick<TediAihClientIdentity, "mcpCapabilityProfile">;
}): string[] {
	if (isTediMcpBridgeApp(params.app)) {
		const scopes =
			params.role === "observer"
				? TEDI_OBSERVER_SCOPES
				: [
						...TEDI_OPERATOR_SCOPES,
						...resolveTediScopes(params.tedi.mcpCapabilityProfile),
					];
		return [...new Set<string>(scopes)].sort();
	}

	const scopes: readonly string[] =
		params.role === "observer"
			? OBSERVER_SCOPES
			: resolveTediScopes(params.tedi.mcpCapabilityProfile);
	return [
		...new Set<string>(constrainToConfiguredAppScopes(params.app, scopes)),
	].sort();
}

function diffScopes(params: {
	expected: readonly string[];
	actual: readonly string[];
}) {
	const actualSet = new Set(params.actual);
	const expectedSet = new Set(params.expected);
	return {
		missingScopes: params.expected.filter((scope) => !actualSet.has(scope)),
		extraScopes: params.actual.filter((scope) => !expectedSet.has(scope)),
	};
}

export function constrainToApprovedMcpServerScopes(
	scopes: readonly string[],
	approvedScopes: McpServerApprovedScopes | null | undefined,
): string[] {
	const approved = new Set<string>();
	for (const value of Object.values(approvedScopes ?? {})) {
		if (!Array.isArray(value)) continue;
		for (const scope of value) {
			if (
				scope &&
				typeof scope === "object" &&
				"name" in scope &&
				typeof scope.name === "string"
			) {
				approved.add(scope.name);
			}
		}
	}
	return scopes.filter((scope) => approved.has(scope));
}

async function storeSecret(params: {
	db: DbClient;
	masterKey: string;
	tediId: string;
	name: string;
	value: string;
	createdBy?: string | null;
}) {
	const encrypted = await encryptTediSecret(
		params.masterKey,
		params.tediId,
		params.value,
	);
	await upsertTediSecret(
		params.db,
		params.tediId,
		params.name,
		encrypted,
		null,
		params.createdBy ?? null,
	);
}

async function storeAihCredentials(params: {
	db: DbClient;
	masterKey: string;
	tediId: string;
	appSlug: string;
	mcpServerId: string;
	clientId: string;
	clientSecret: string;
	createdBy?: string | null;
}) {
	const appNames = aihClientSecretNames(params.appSlug);
	const resourceNames = aihClientSecretNames(params.mcpServerId);
	const secretPairs: Array<readonly [string, string]> = [
		[appNames.clientIdName, params.clientId],
		[appNames.clientSecretName, params.clientSecret],
		[resourceNames.clientIdName, params.clientId],
		[resourceNames.clientSecretName, params.clientSecret],
	];

	for (const [name, value] of secretPairs) {
		await storeSecret({
			db: params.db,
			masterKey: params.masterKey,
			tediId: params.tediId,
			name,
			value,
			createdBy: params.createdBy,
		});
	}

	return appNames;
}

async function deleteSecretByName(params: {
	db: DbClient;
	tediId: string;
	name: string;
}) {
	const secret = await getTediSecret(params.db, params.tediId, params.name);
	if (secret) {
		await deleteTediSecret(params.db, secret.id);
	}
}

async function deleteAihCredentialSecrets(params: {
	db: DbClient;
	tediId: string;
	appSlug: string;
	mcpServerId: string;
}) {
	const appNames = aihClientSecretNames(params.appSlug);
	const resourceNames = aihClientSecretNames(params.mcpServerId);
	const names = [
		appNames.clientIdName,
		appNames.clientSecretName,
		resourceNames.clientIdName,
		resourceNames.clientSecretName,
	];

	for (const name of new Set(names)) {
		await deleteSecretByName({
			db: params.db,
			tediId: params.tediId,
			name,
		});
	}
}

export async function ensureTediAihClientForApp(params: {
	env: AihEnv;
	db: DbClient;
	masterKey: string;
	tedi: TediAihClientIdentity;
	app: App;
	role: TediAppAssignmentRole;
	createdBy?: string | null;
}): Promise<TediAihClientSyncResult> {
	const mcpServerId = getDescopeMcpResourceId(params.app);
	const desiredScopes = resolveTediAihClientScopesForApp({
		app: params.app,
		role: params.role,
		tedi: params.tedi,
	});

	if (!mcpServerId) {
		return {
			status: "skipped",
			appId: params.app.id,
			appSlug: params.app.slug,
			tediId: params.tedi.id,
			scopes: desiredScopes,
			reason: "App has no mcpConfig.descopeResourceId",
		};
	}
	const server = await loadDescopeMcpServer(params.env, mcpServerId);
	const scopes = constrainToApprovedMcpServerScopes(
		desiredScopes,
		server.approvedScopes,
	);

	const clientName = getTediClientName(params.tedi);
	const existing = await findExistingTediClient({
		env: params.env,
		mcpServerId,
		tedi: params.tedi,
	});

	if (existing) {
		if (!scopesEqual(existing.scopes, scopes)) {
			await deleteDescopeMcpServerClient(params.env, {
				id: existing.id,
				mcpServerId,
			});
			const credentials = await createDescopeMcpServerClient(params.env, {
				name: clientName,
				mcpServerId,
				scopes,
				tags: [`tedi:${params.tedi.id}`, `app:${params.app.slug}`],
			});
			const secretNames = await storeAihCredentials({
				db: params.db,
				masterKey: params.masterKey,
				tediId: params.tedi.id,
				appSlug: params.app.slug,
				mcpServerId,
				clientId: credentials.clientId,
				clientSecret: credentials.clientSecret,
				createdBy: params.createdBy,
			});
			return {
				status: "updated",
				appId: params.app.id,
				appSlug: params.app.slug,
				tediId: params.tedi.id,
				mcpServerId,
				clientId: credentials.clientId,
				scopes,
				secretNames,
			};
		}

		await updateDescopeMcpServerClient(params.env, {
			id: existing.id,
			name: clientName,
			mcpServerId,
			scopes,
			tags: [`tedi:${params.tedi.id}`, `app:${params.app.slug}`],
		});
		const clientId = getClientId(existing);
		if (!clientId) {
			throw new Error(
				`AIH client ${existing.id} for ${clientName} is missing clientId`,
			);
		}
		const clientSecret = await getDescopeMcpServerClientSecret(params.env, {
			id: existing.id,
			mcpServerId,
		});
		const secretNames = await storeAihCredentials({
			db: params.db,
			masterKey: params.masterKey,
			tediId: params.tedi.id,
			appSlug: params.app.slug,
			mcpServerId,
			clientId,
			clientSecret,
			createdBy: params.createdBy,
		});
		return {
			status: "updated",
			appId: params.app.id,
			appSlug: params.app.slug,
			tediId: params.tedi.id,
			mcpServerId,
			clientId,
			scopes,
			secretNames,
		};
	}

	const credentials = await createDescopeMcpServerClient(params.env, {
		name: clientName,
		mcpServerId,
		scopes,
		tags: [`tedi:${params.tedi.id}`, `app:${params.app.slug}`],
	});
	const secretNames = await storeAihCredentials({
		db: params.db,
		masterKey: params.masterKey,
		tediId: params.tedi.id,
		appSlug: params.app.slug,
		mcpServerId,
		clientId: credentials.clientId,
		clientSecret: credentials.clientSecret,
		createdBy: params.createdBy,
	});

	return {
		status: "created",
		appId: params.app.id,
		appSlug: params.app.slug,
		tediId: params.tedi.id,
		mcpServerId,
		clientId: credentials.clientId,
		scopes,
		secretNames,
	};
}

export async function validateTediAihClientForApp(params: {
	env: AihEnv;
	db: DbClient;
	masterKey: string;
	tedi: TediAihClientIdentity;
	app: App;
	role: TediAppAssignmentRole;
	identity?: TediDescopeSubjectAttestation;
}): Promise<TediAihClientAccessValidationResult> {
	const identity =
		params.identity ??
		(await attestTediDescopeSubject(params.env, params.tedi));
	const evidenceRefs = [
		`descope-user://${encodeURIComponent(identity.subjectId)}`,
		`tedi://${params.tedi.id}`,
	];
	const mcpServerId = getDescopeMcpResourceId(params.app);
	const desiredScopes = resolveTediAihClientScopesForApp({
		app: params.app,
		role: params.role,
		tedi: params.tedi,
	});
	const clientName = getTediClientName(params.tedi);

	const emptySecrets = {
		appClientId: false,
		appClientSecret: false,
		resourceClientId: false,
		resourceClientSecret: false,
	};

	if (!mcpServerId) {
		return {
			status: "skipped",
			ok: false,
			appId: params.app.id,
			appSlug: params.app.slug,
			tediId: params.tedi.id,
			role: params.role,
			clientName,
			expectedScopes: desiredScopes,
			clientScopes: [],
			missingScopes: desiredScopes,
			extraScopes: [],
			secrets: emptySecrets,
			identity,
			evidenceRefs,
			reason: "App has no mcpConfig.descopeResourceId",
		};
	}
	const server = await loadDescopeMcpServer(params.env, mcpServerId);
	const expectedScopes = constrainToApprovedMcpServerScopes(
		desiredScopes,
		server.approvedScopes,
	);

	const existing = await findExistingTediClient({
		env: params.env,
		mcpServerId,
		tedi: params.tedi,
	});
	const clientScopes = normalizeScopes(existing?.scopes);
	const { missingScopes, extraScopes } = diffScopes({
		expected: expectedScopes,
		actual: clientScopes,
	});

	const appNames = aihClientSecretNames(params.app.slug);
	const resourceNames = aihClientSecretNames(mcpServerId);
	const [appClientId, appClientSecret, resourceClientId, resourceClientSecret] =
		await Promise.all([
			getTediSecret(params.db, params.tedi.id, appNames.clientIdName),
			getTediSecret(params.db, params.tedi.id, appNames.clientSecretName),
			getTediSecret(params.db, params.tedi.id, resourceNames.clientIdName),
			getTediSecret(params.db, params.tedi.id, resourceNames.clientSecretName),
		]);
	const secrets = {
		appClientId: Boolean(appClientId),
		appClientSecret: Boolean(appClientSecret),
		resourceClientId: Boolean(resourceClientId),
		resourceClientSecret: Boolean(resourceClientSecret),
	};
	const hasSecrets =
		secrets.appClientId &&
		secrets.appClientSecret &&
		secrets.resourceClientId &&
		secrets.resourceClientSecret;
	let credentialsMatch = false;
	let credentialsUnreadable = false;
	if (
		existing &&
		hasSecrets &&
		appClientId &&
		appClientSecret &&
		resourceClientId &&
		resourceClientSecret
	) {
		try {
			const clientId = getClientId(existing);
			if (clientId) {
				const [
					storedAppClientId,
					storedAppClientSecret,
					storedResourceClientId,
					storedResourceClientSecret,
					liveClientSecret,
				] = await Promise.all([
					decryptTediSecret(
						params.masterKey,
						params.tedi.id,
						appClientId.encryptedValue,
					),
					decryptTediSecret(
						params.masterKey,
						params.tedi.id,
						appClientSecret.encryptedValue,
					),
					decryptTediSecret(
						params.masterKey,
						params.tedi.id,
						resourceClientId.encryptedValue,
					),
					decryptTediSecret(
						params.masterKey,
						params.tedi.id,
						resourceClientSecret.encryptedValue,
					),
					getDescopeMcpServerClientSecret(params.env, {
						id: existing.id,
						mcpServerId,
					}),
				]);
				credentialsMatch =
					timingSafeCompare(storedAppClientId, clientId) &&
					timingSafeCompare(storedResourceClientId, clientId) &&
					timingSafeCompare(storedAppClientSecret, liveClientSecret) &&
					timingSafeCompare(storedResourceClientSecret, liveClientSecret);
			}
		} catch {
			credentialsUnreadable = true;
		}
	}
	const hasExpectedScopes =
		missingScopes.length === 0 && extraScopes.length === 0;
	const accessOk =
		Boolean(existing) && hasExpectedScopes && hasSecrets && credentialsMatch;
	const ok = accessOk && identity.verified;

	return {
		status: ok ? "valid" : "invalid",
		ok,
		appId: params.app.id,
		appSlug: params.app.slug,
		tediId: params.tedi.id,
		role: params.role,
		mcpServerId,
		clientId: existing ? (getClientId(existing) ?? undefined) : undefined,
		clientName,
		expectedScopes,
		clientScopes,
		missingScopes,
		extraScopes,
		secrets,
		identity,
		evidenceRefs,
		reason: ok
			? undefined
			: !identity.verified
				? "Descope subject does not match the canonical tedi identity"
				: !existing
					? "No matching Descope AIH client found"
					: !hasExpectedScopes
						? "Descope AIH client scopes do not match expected assignment scopes"
						: !hasSecrets
							? "One or more tedi AIH credential secrets are missing"
							: credentialsUnreadable
								? "Stored tedi AIH credentials cannot be decrypted with the configured master key"
								: "Stored tedi AIH credentials do not match the live Descope client",
	};
}

export async function deleteTediAihClientForApp(params: {
	env: AihEnv;
	db: DbClient;
	tedi: TediAihClientIdentity;
	app: App;
}): Promise<TediAihClientSyncResult> {
	const mcpServerId = getDescopeMcpResourceId(params.app);
	const scopes = resolveTediAihClientScopesForApp({
		app: params.app,
		role: "observer",
		tedi: params.tedi,
	});

	if (!mcpServerId) {
		return {
			status: "skipped",
			appId: params.app.id,
			appSlug: params.app.slug,
			tediId: params.tedi.id,
			scopes,
			reason: "App has no mcpConfig.descopeResourceId",
		};
	}

	const existing = await findExistingTediClient({
		env: params.env,
		mcpServerId,
		tedi: params.tedi,
	});
	if (existing) {
		await deleteDescopeMcpServerClient(params.env, {
			id: existing.id,
			mcpServerId,
		});
	}
	await deleteAihCredentialSecrets({
		db: params.db,
		tediId: params.tedi.id,
		appSlug: params.app.slug,
		mcpServerId,
	});

	return {
		status: existing ? "deleted" : "skipped",
		appId: params.app.id,
		appSlug: params.app.slug,
		tediId: params.tedi.id,
		mcpServerId,
		scopes: [],
		reason: existing ? "AIH client deleted" : "No matching AIH client found",
	};
}
