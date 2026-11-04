import { getDescopeManagement } from "../../../lib/descope-management";
import {
	connectionRefreshState,
	isMissingUserToken,
	isNamedConnectionExternalIdentifier,
} from "@tedix/auth/connections";
import { ConnectionProviderSchema } from "@tedix/api-contract/schemas/connections";
import { projectConnectionCapabilities } from "@tedix/api-contract/utils/connection-capabilities";
import type {
	ConnectionInventory,
	ConnectionInventoryInput,
	ConnectionInventoryRow,
} from "@tedix/api-contract/schemas/connections";
import { AUTHZ, type BaseContext } from "../../orpc";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	buildConnectionProviderMaps,
	listConnectionProviders,
} from "@tedix/db/queries/connection-providers";
import { resolveConnectionAccessCheck } from "../../../services/connection-access-check";
import { requireOrgId } from "../../org-scope";
import { listConnectionInstances } from "@tedix/db/queries/connection-instances";
import {
	getAppByIdForOrganization,
	getAppMetadataJson,
} from "@tedix/db/queries/app-records";
import {
	authedOs,
	requireUserId,
	fetchNamedConnection,
} from "./policy-resolution";
import { collectReferencedProviders } from "./provider-registration";
import { mapConnectionRecord } from "./url-and-scopes";
import { readConnectionProviders } from "./discovery-user";

type CredentialResponse = {
	ok: boolean;
	code?: number;
	error?: { errorCode?: string };
	data?: {
		id?: string;
		accessToken?: string;
		accessTokenExpiry?: number | string;
		scopes?: string[];
		externalIdentifier?: string;
		lastRefreshTime?: string;
		lastRefreshError?: string;
		reconnectNeeded?: boolean;
	};
};
type AppPin = { providerId?: string; connectionInstanceId?: string };
type InventoryAccount = Omit<
	ConnectionInventoryRow,
	"capabilities" | "toolCapabilities" | "toolCapabilitiesComplete"
>;

const GOOGLE_SCOPE =
	/^https:\/\/(www\.googleapis\.com\/auth\/|mail\.google\.com\/)/;
const GMAIL_PROFILE_SCOPE =
	/^https:\/\/(mail\.google\.com\/$|www\.googleapis\.com\/auth\/gmail\.(readonly|modify|compose|metadata)$)/;
const EMAIL_SCOPE =
	/^(email|https:\/\/www\.googleapis\.com\/auth\/userinfo\.email)$/;

/**
 * The Google account address behind a token, read live. Only a token granted
 * Google scopes is ever sent to Google; null when Google did not say.
 */
export async function readGoogleAccountEmail(
	accessToken: string,
	scopes: readonly string[],
	fetcher: typeof fetch = fetch,
): Promise<string | null> {
	if (!accessToken || !scopes.some((scope) => GOOGLE_SCOPE.test(scope)))
		return null;
	const endpoints = [
		...(scopes.some((scope) => GMAIL_PROFILE_SCOPE.test(scope))
			? [
					"https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
				]
			: []),
		...(scopes.some((scope) => EMAIL_SCOPE.test(scope))
			? ["https://openidconnect.googleapis.com/v1/userinfo"]
			: []),
	];
	for (const endpoint of endpoints) {
		try {
			const response = await fetcher(endpoint, {
				headers: { Authorization: `Bearer ${accessToken}` },
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) continue;
			const body = (await response.json()) as {
				emailAddress?: unknown;
				email?: unknown;
			};
			const email = body.emailAddress ?? body.email;
			if (typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email))
				return email;
		} catch {
			// An address is a label, never a status: a failed read leaves it unknown.
		}
	}
	return null;
}

/**
 * One row per account. The default row keeps only apps no listed named
 * account claims, and a named slot that adopted the default login absorbs
 * it: the same Descope grant is one account, not two.
 */
export function foldDefaultAccounts<T extends InventoryAccount>(
	rows: readonly T[],
	input: {
		instances: readonly {
			id: string;
			providerId: string;
			tokenIds: readonly string[];
		}[];
		defaultTokenIds: ReadonlyMap<string, string>;
		pins: ReadonlyMap<string, AppPin>;
	},
): T[] {
	const listed = new Set(rows.map((row) => row.connectionInstanceId));
	const claimed = (providerId: string, appId: string) => {
		const pin = input.pins.get(appId);
		return (
			pin?.providerId === providerId &&
			!!pin.connectionInstanceId &&
			listed.has(pin.connectionInstanceId)
		);
	};
	const adopted = new Map<string, T>();
	const result: T[] = [];
	for (const row of rows) {
		if (row.connectionInstanceId) {
			result.push(row);
			continue;
		}
		const own = {
			...row,
			references: row.references.filter(
				(reference) => !claimed(row.provider.appId, reference.appId),
			),
		};
		const tokenId = input.defaultTokenIds.get(row.provider.appId);
		const adopter = tokenId
			? input.instances.find(
					(instance) =>
						instance.providerId === row.provider.appId &&
						instance.tokenIds.includes(tokenId) &&
						listed.has(instance.id),
				)
			: undefined;
		if (adopter) adopted.set(adopter.id, own);
		else result.push(own);
	}
	return result.map((row) => {
		const base = row.connectionInstanceId
			? adopted.get(row.connectionInstanceId)
			: undefined;
		if (!base) return row;
		return {
			...row,
			isDefault: true,
			accountEmail: row.accountEmail ?? base.accountEmail,
			references: [
				...row.references,
				...base.references.filter(
					(reference) =>
						!row.references.some((own) => own.appId === reference.appId),
				),
			],
		};
	});
}

/** Deliberately return metadata only. Provider outages are never evidence of absence. */
export function summarizeCredential(
	response: CredentialResponse,
	now = Date.now(),
	personal = false,
): {
	reconnectNeeded?: boolean;
	state: ConnectionInventoryRow["accountState"];
	expiresAt: number | null;
	scopes: string[];
} {
	const empty = { expiresAt: null, scopes: [] as string[] };
	if (!response.ok)
		return {
			...empty,
			state:
				response.code === 404 ||
				(personal &&
					isMissingUserToken(response.code, response.error?.errorCode))
					? "missing"
					: response.code === 401 || response.code === 403
						? "restricted"
						: "unknown",
		};
	if (!response.data) return { ...empty, state: "unknown" };
	if (isNamedConnectionExternalIdentifier(response.data.externalIdentifier))
		return { ...empty, state: "missing" };
	const refresh = response.data.reconnectNeeded
		? { reconnectNeeded: true }
		: connectionRefreshState(response.data, now / 1000);
	if (!response.data.accessToken?.trim() && !refresh.reconnectNeeded)
		return { ...empty, state: "missing" };
	// Descope's wire response encodes int64 timestamps as decimal strings,
	// even though its SDK declares a number. Normalize before projecting metadata.
	const rawExpiry = response.data.accessTokenExpiry;
	const numericExpiry =
		typeof rawExpiry === "number"
			? rawExpiry
			: typeof rawExpiry === "string" && /^\d+$/.test(rawExpiry)
				? Number(rawExpiry)
				: NaN;
	const expiresAt =
		Number.isSafeInteger(numericExpiry) && numericExpiry > 0
			? numericExpiry
			: null;

	return {
		...refresh,
		state:
			refresh.reconnectNeeded || (expiresAt !== null && expiresAt * 1000 <= now)
				? "expired"
				: "present",
		expiresAt,
		scopes: response.data.scopes ?? [],
	};
}

export async function readConnectionsOverview(
	context: BaseContext,
	input: ConnectionInventoryInput,
	providerIds?: ReadonlySet<string>,
): Promise<ConnectionInventory> {
	const organizationId = requireOrgId(context);
	const userId =
		input.scope === "personal" ? requireUserId(context) : undefined;
	const scope = input.scope === "personal" ? "user" : "tenant";
	const [catalog, references, org, templates] = await Promise.all([
		readConnectionProviders(context),
		collectReferencedProviders(context.db, organizationId, {
			includeToolReferences: true,
		}),
		getOrganizationById(context.db, organizationId),
		listConnectionProviders(context.db),
	]);
	const { byDescopeAppId: templateByAppId } =
		buildConnectionProviderMaps(templates);
	const client = getDescopeManagement(context.env, true);
	const providers = catalog.data
		.map((provider) => ConnectionProviderSchema.parse(provider))
		.filter(
			(p) =>
				(!input.providerId || p.appId === input.providerId) &&
				(!providerIds || providerIds.has(p.appId)) &&
				p.supportedScopes.includes(scope),
		);
	const rows: Omit<
		ConnectionInventoryRow,
		"capabilities" | "toolCapabilities" | "toolCapabilitiesComplete"
	>[] = [];
	const defaultTokenIds = new Map<string, string>();
	// App id -> the provider and account slot its MCP config pins, read once.
	const appPins = new Map<string, Promise<AppPin>>();
	const appPin = (appId: string) => {
		let pin = appPins.get(appId);
		if (!pin) {
			pin = getAppByIdForOrganization(context.db, appId, organizationId).then(
				(app) => {
					const config = app ? getAppMetadataJson(app)?.mcpConfig : undefined;
					return {
						providerId: config?.connectionProviderId,
						connectionInstanceId: config?.connectionInstanceId,
					};
				},
			);
			appPins.set(appId, pin);
		}
		return pin;
	};
	let instancesTruncated = false;
	// Bound concurrency without serializing every provider request. Each request has a deadline.
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(6, providers.length) }, async () => {
			for (;;) {
				const provider = providers[cursor++];
				if (!provider) return;
				let credential: ReturnType<typeof summarizeCredential> = {
					state: "unknown",
					expiresAt: null,
					scopes: [],
				};
				let timer: ReturnType<typeof setTimeout> | undefined;
				let token: CredentialResponse["data"];
				try {
					if (scope === "user" || org?.descopeTenantId) {
						const operation =
							scope === "user"
								? client.management.outboundApplication.fetchToken(
										provider.appId,
										userId!,
										undefined,
										{ forceRefresh: false },
									)
								: client.management.outboundApplication.fetchTenantToken(
										provider.appId,
										org!.descopeTenantId!,
										{ forceRefresh: false },
									);
						const response: CredentialResponse = await Promise.race([
							operation,
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new Error("Credential inspection timed out")),
									8000,
								);
							}),
						]);
						credential = summarizeCredential(
							response,
							Date.now(),
							scope === "user",
						);
						if (credential.state === "present") token = response.data;
					}
				} catch {
					console.warn("[connections] Credential inspection unavailable");
				} finally {
					if (timer) clearTimeout(timer);
				}
				const appReferences = references.references.get(provider.appId) ?? [];
				if (
					!isInventoryProviderVisible(
						credential.state,
						appReferences.length > 0,
						!!input.providerId || !!providerIds?.has(provider.appId),
					)
				)
					continue;
				// Only a personal default login can be adopted by a named slot.
				if (scope === "user" && token?.id)
					defaultTokenIds.set(provider.appId, token.id);
				rows.push({
					provider,
					scope,
					accountState: credential.state,
					accountLabel: scope === "user" ? (context.user?.email ?? null) : null,
					accountEmail: token?.accessToken
						? await readGoogleAccountEmail(token.accessToken, credential.scopes)
						: null,
					isDefault: true,
					connection:
						credential.state === "present" || credential.state === "expired"
							? mapConnectionRecord({
									appId: provider.appId,
									providerName: provider.name,
									status: credential.reconnectNeeded
										? "reconnect_needed"
										: credential.state === "expired"
											? "expired"
											: "connected",
									connectedAt: null,
									tokenExpiresAt: credential.expiresAt,
									scopes: credential.scopes,
									tokenScope: scope,
									...(scope === "user"
										? {
												connectedByUserId: userId,
												connectedByEmail: context.user?.email,
											}
										: {}),
								})
							: null,
					references: appReferences,
					referencesComplete: references.complete,
					access: "not_evaluated",
					health: "not_checked",
				});
			}
		}),
	);
	const owner = scope === "user" ? { userId: userId! } : { organizationId };
	const instances = await listConnectionInstances(context.db, owner);
	{
		instancesTruncated = instances.length === 100;
		let instanceCursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(6, instances.length) }, async () => {
				for (;;) {
					const instance = instances[instanceCursor++];
					if (!instance) return;
					const provider = providers.find(
						(provider) => provider.appId === instance.providerId,
					);
					if (!provider) continue;
					let credential: ReturnType<typeof summarizeCredential> = {
						state: "unknown",
						expiresAt: null,
						scopes: [],
					};
					let accountEmail: string | null = null;
					try {
						const token = await fetchNamedConnection(
							context,
							userId
								? { userId }
								: { organizationId, tenantId: org?.descopeTenantId ?? "" },
							provider.appId,
							instance.id,
							undefined,
							"inventory",
						);
						credential = token
							? summarizeCredential({
									ok: true,
									data: {
										accessToken: token.accessToken,
										accessTokenExpiry: token.expiresAt,
										reconnectNeeded: token.reconnectNeeded,
										scopes: token.scopes,
									},
								})
							: { state: "missing", expiresAt: null, scopes: [] };
						if (token && credential.state === "present")
							accountEmail = await readGoogleAccountEmail(
								token.accessToken,
								credential.scopes,
							);
					} catch {
						// Leaves the row "unknown"; isInventoryVerified reports it.
					}
					const appReferences = [] as ConnectionInventoryRow["references"];
					const bindingTargets = [] as ConnectionInventoryRow["references"];
					for (const reference of references.references.get(provider.appId) ??
						[]) {
						const config = await appPin(reference.appId);
						if (config.providerId === provider.appId) {
							if (
								!bindingTargets.some(
									(target) => target.appId === reference.appId,
								)
							)
								bindingTargets.push(reference);
							if (config.connectionInstanceId === instance.id)
								appReferences.push(reference);
						}
					}
					rows.push({
						provider,
						scope,
						connectionInstanceId: instance.id,
						instanceLabel: instance.label,
						allowedResources: instance.allowedResources,
						accountLabel: instance.label,
						accountEmail,
						isDefault: false,
						accountState: credential.state,
						connection:
							credential.state === "present" || credential.state === "expired"
								? mapConnectionRecord({
										appId: provider.appId,
										providerName: provider.name,
										status: credential.reconnectNeeded
											? "reconnect_needed"
											: credential.state === "expired"
												? "expired"
												: "connected",
										connectedAt: null,
										tokenExpiresAt: credential.expiresAt,
										scopes: credential.scopes,
										tokenScope: scope,
										connectedByUserId: userId,
										connectedByEmail: context.user?.email,
									})
								: null,
						references: appReferences,
						bindingTargets,
						referencesComplete: references.complete,
						...(scope === "tenant"
							? {
									accessCheck: resolveConnectionAccessCheck(
										org?.metadata,
										instance.id,
										{
											appId: provider.appId,
											category: templateByAppId.get(provider.appId)?.category,
										},
									),
								}
							: {}),
						access: "not_evaluated",
						health: "not_checked",
					});
				}
			}),
		);
	}
	const named = new Set(instances.map((instance) => instance.providerId));
	const accounts = foldDefaultAccounts(rows, {
		instances,
		defaultTokenIds,
		pins: new Map(
			await Promise.all(
				[
					...new Set(
						rows.flatMap((row) =>
							!row.connectionInstanceId && named.has(row.provider.appId)
								? row.references.map((reference) => reference.appId)
								: [],
						),
					),
				].map(async (appId) => [appId, await appPin(appId)] as const),
			),
		),
	});
	const verificationComplete =
		!instancesTruncated && isInventoryVerified(accounts);
	const filtered = accounts
		.map((row) => ({
			...row,
			capabilities: projectConnectionCapabilities(row),
			toolCapabilities:
				references.toolCapabilities.get(row.provider.appId) ?? [],
			toolCapabilitiesComplete:
				references.complete &&
				(references.toolCapabilitiesComplete.get(row.provider.appId) ?? true),
		}))
		.filter(
			(row) =>
				`${row.provider.name} ${row.instanceLabel ?? ""}`
					.toLowerCase()
					.includes(input.q.toLowerCase()) &&
				(input.status === "all" ||
					(input.status === "attention" &&
						(row.accountState === "missing" ||
							row.accountState === "expired")) ||
					(input.status === "unchecked" &&
						(row.accountState === "restricted" ||
							row.accountState === "unknown")) ||
					(input.status === "in_use" && row.references.length > 0) ||
					(input.status === "unused" &&
						row.referencesComplete &&
						row.references.length === 0)),
		)
		.sort((a, b) => a.provider.name.localeCompare(b.provider.name));
	return {
		organizationId,
		scope: input.scope,
		observedAt: new Date().toISOString(),
		rows: filtered.slice(input.offset, input.offset + input.limit),
		total: filtered.length,
		hasMore: input.offset + input.limit < filtered.length,
		verificationComplete,
		referencesComplete: references.complete,
		issues: [
			...(!verificationComplete
				? [
						{
							source: "credentials" as const,
							message:
								"Some accounts could not be verified. Missing rows do not prove that no account exists.",
						},
					]
				: []),
			...(!references.complete
				? [
						{
							source: "references" as const,
							message: "App references could not be completely verified.",
						},
					]
				: []),
		],
	};
}

/**
 * Only rows the caller can see decide whether the inventory is verified. A
 * catalog provider that is neither referenced nor connected is skipped before
 * this check, so a failed read of it can never raise a page-level issue that
 * names no account.
 */
export function isInventoryVerified(
	rows: readonly Pick<ConnectionInventoryRow, "accountState">[],
): boolean {
	return rows.every(
		(row) =>
			row.accountState !== "unknown" && row.accountState !== "restricted",
	);
}

/** Include setup targets in either ownership scope, but not the global catalog.
 * A reference makes a provider relevant; it never proves credential presence or access.
 */
export function isInventoryProviderVisible(
	accountState: ConnectionInventoryRow["accountState"],
	hasReferences: boolean,
	explicitlyRequested: boolean,
): boolean {
	return (
		explicitlyRequested ||
		hasReferences ||
		accountState === "present" ||
		accountState === "expired"
	);
}

export const getConnectionsOverview = authedOs.getConnectionsOverview
	.use(AUTHZ.appsRead)
	.handler(({ context, input }) => readConnectionsOverview(context, input));
