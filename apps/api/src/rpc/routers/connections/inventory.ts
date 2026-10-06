import { isNamedConnectionExternalIdentifier } from "@tedix/auth/connections";
import { ConnectionProviderSchema } from "@tedix/api-contract/schemas/connections";
import type {
	ConnectionInventory,
	ConnectionInventoryInput,
	ConnectionInventoryRow,
} from "@tedix/api-contract/schemas/connections";
import { AUTHZ, type BaseContext } from "../../orpc";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { requireOrgId } from "../../org-scope";
import { listConnectionInstances } from "@tedix/db/queries/connection-instances";
import {
	getAppByIdForOrganization,
	getAppMetadataJson,
} from "@tedix/db/queries/app-records";
import {
	authedOs,
	collectReferencedProviders,
	getDescopeManagement,
	mapConnectionRecord,
	requireUserId,
	fetchNamedConnection,
} from "./policy-resolution";
import { readConnectionProviders } from "./discovery-user";

type CredentialResponse = {
	ok: boolean;
	code?: number;
	data?: {
		accessToken?: string;
		accessTokenExpiry?: number | string;
		scopes?: string[];
		externalIdentifier?: string;
	};
};
/** Deliberately return metadata only. Provider outages are never evidence of absence. */
export function summarizeCredential(
	response: CredentialResponse,
	now = Date.now(),
): {
	state: ConnectionInventoryRow["accountState"];
	expiresAt: number | null;
	scopes: string[];
} {
	const empty = { expiresAt: null, scopes: [] as string[] };
	if (!response.ok)
		return {
			...empty,
			state:
				response.code === 404
					? "missing"
					: response.code === 401 || response.code === 403
						? "restricted"
						: "unknown",
		};
	if (!response.data) return { ...empty, state: "unknown" };
	if (isNamedConnectionExternalIdentifier(response.data.externalIdentifier))
		return { ...empty, state: "missing" };
	if (!response.data.accessToken?.trim()) return { ...empty, state: "missing" };
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
		state:
			expiresAt !== null && expiresAt * 1000 <= now ? "expired" : "present",
		expiresAt,
		scopes: response.data.scopes ?? [],
	};
}

async function readConnectionsOverview(
	context: BaseContext,
	input: ConnectionInventoryInput,
): Promise<ConnectionInventory> {
	const organizationId = requireOrgId(context);
	const userId =
		input.scope === "personal" ? requireUserId(context) : undefined;
	const scope = input.scope === "personal" ? "user" : "tenant";
	const [catalog, references, org] = await Promise.all([
		readConnectionProviders(context),
		collectReferencedProviders(context.db, organizationId, {
			includeToolReferences: true,
		}),
		getOrganizationById(context.db, organizationId),
	]);
	const client = getDescopeManagement(context.env);
	const providers = catalog.data
		.map((provider) => ConnectionProviderSchema.parse(provider))
		.filter(
			(p) =>
				(!input.providerId || p.appId === input.providerId) &&
				p.supportedScopes.includes(scope),
		);
	const rows: ConnectionInventoryRow[] = [];
	let verificationComplete = true;
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
						credential = summarizeCredential(
							await Promise.race([
								operation,
								new Promise<never>((_, reject) => {
									timer = setTimeout(
										() => reject(new Error("Credential inspection timed out")),
										8000,
									);
								}),
							]),
						);
					}
				} catch {
					console.warn("[connections] Credential inspection unavailable");
				} finally {
					if (timer) clearTimeout(timer);
				}
				const uncertain =
					credential.state === "unknown" || credential.state === "restricted";
				if (uncertain) verificationComplete = false;
				const appReferences = references.references.get(provider.appId) ?? [];
				if (
					!isInventoryProviderVisible(
						credential.state,
						appReferences.length > 0,
						!!input.providerId,
					)
				)
					continue;
				rows.push({
					provider,
					scope,
					accountState: credential.state,
					accountLabel: scope === "user" ? (context.user?.email ?? null) : null,
					connection:
						credential.state === "present" || credential.state === "expired"
							? mapConnectionRecord({
									appId: provider.appId,
									providerName: provider.name,
									status:
										credential.state === "expired" ? "expired" : "connected",
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
	{
		const owner = scope === "user" ? { userId: userId! } : { organizationId };
		const instances = await listConnectionInstances(context.db, owner);
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
					try {
						const token = await fetchNamedConnection(
							context,
							userId
								? { userId }
								: { organizationId, tenantId: org?.descopeTenantId ?? "" },
							provider.appId,
							instance.id,
						);
						credential = token
							? summarizeCredential({
									ok: true,
									data: {
										accessToken: token.accessToken,
										accessTokenExpiry: token.expiresAt,
										scopes: token.scopes,
									},
								})
							: { state: "missing", expiresAt: null, scopes: [] };
					} catch {
						verificationComplete = false;
					}
					const appReferences = [] as ConnectionInventoryRow["references"];
					const bindingTargets = [] as ConnectionInventoryRow["references"];
					for (const reference of references.references.get(provider.appId) ??
						[]) {
						const app = await getAppByIdForOrganization(
							context.db,
							reference.appId,
							organizationId,
						);
						const config = app ? getAppMetadataJson(app)?.mcpConfig : undefined;
						if (config?.connectionProviderId === provider.appId) {
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
						accountLabel: instance.label,
						accountState: credential.state,
						connection:
							credential.state === "present" || credential.state === "expired"
								? mapConnectionRecord({
										appId: provider.appId,
										providerName: provider.name,
										status:
											credential.state === "expired" ? "expired" : "connected",
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
						access: "not_evaluated",
						health: "not_checked",
					});
				}
			}),
		);
	}
	const filtered = rows
		.filter(
			(row) =>
				`${row.provider.name} ${row.instanceLabel ?? ""}`
					.toLowerCase()
					.includes(input.q.toLowerCase()) &&
				(input.status === "all" ||
					(input.status === "attention" && row.accountState !== "present") ||
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
