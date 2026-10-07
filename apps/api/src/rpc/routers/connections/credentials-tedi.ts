import { ORPCError } from "@orpc/server";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { constrainPersonalResourceToolArguments } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import {
	authorizePersonalResourceDelegation,
	resolvePersonalResourceDelegatedCredential,
} from "../../../services/personal-resource-delegation-authority";
import {
	AUTHZ,
	type BaseContext,
	ErrorCodes,
	createError,
	withAuthorization,
	withConnectionCredentialResolutionAuthority,
} from "../../orpc";
import { type ConnectionCredentialProfile } from "@tedix/api-contract/schemas/connection-provider-templates";
import {
	createConnectionProvider,
	createConnectionProviderWithId,
	fetchConnectionToken,
	fetchTenantConnectionToken,
	uploadTenantApiKeyToken,
	uploadUserApiKeyToken,
} from "@tedix/auth/connections";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { requireOrgId } from "../../org-scope";
import {
	CredentialPreference,
	CredentialScope,
	authedOs,
	composeApiKeyCredential,
	getDescopeManagement,
	mapConnectionRecord,
	mcpOrAuthOs,
	requireUserId,
	resolveCredentialChain,
	resolveTediTenantId,
} from "./policy-resolution";

export const fetchTediToken = mcpOrAuthOs.fetchTediToken
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The credential-specific guard below preserves platform-only direct user access and validates MCP actor provenance.",
			},
			"connections.read",
		),
	)
	.use(withConnectionCredentialResolutionAuthority)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				tediId: string;
				providerId: string;
				connectionInstanceId?: string;
				scopes?: string[];
				scope?: CredentialScope;
				preference?: CredentialPreference;
				userId?: string;
				delegatedToolUse?: { appId: string; arguments: JsonValue };
			};
			context: BaseContext;
		}) => {
			const { descopeTenantId, organizationId } = await resolveTediTenantId(
				context,
				input.tediId,
			);

			const backgroundRunId = context.headers.get("X-Tedix-Skill-Run-Id");
			const backgroundRun = backgroundRunId
				? await getSkillRun(
						context.db,
						backgroundRunId,
						organizationId,
						context.env.ENVIRONMENT,
					)
				: null;
			const envelope = OsDerivedAccessEnvelopeSchema.safeParse(
				backgroundRun?.resourceAccessEnvelope,
			);
			const personalSources = envelope.success
				? envelope.data.sources.filter(
						(source) =>
							source.connectionScope === "user" &&
							source.providerId === input.providerId,
					)
				: [];
			if (personalSources.length) {
				const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
				if (
					!input.delegatedToolUse ||
					!toolId ||
					context.tediId !== input.tediId ||
					!backgroundRun?.skillRevision
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Personal credential use requires the exact admitted provider arguments",
					);
				const tool = await getToolByAppAndToolIdForOrganization(context.db, {
					organizationId,
					appId: input.delegatedToolUse.appId,
					toolId,
				});
				if (!tool?.enabled)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"The provider tool is not installed and enabled in this organization",
					);
				let matched;
				try {
					matched = constrainPersonalResourceToolArguments({
						binding: tool.config?.personalResourceBinding,
						arguments: input.delegatedToolUse.arguments,
						sources: personalSources,
						providerId: input.providerId,
						toolId,
					});
				} catch {
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Unknown or escaping personal-resource provider arguments",
					);
				}
				const uses = matched.sources.map((source) => ({
					delegationId: source.delegationId!,
					tediId: input.tediId,
					skillId: backgroundRun.skillId,
					skillRevision: backgroundRun.skillRevision!,
					workspaceId: source.workspaceId,
					resourceId: source.workspaceResourceId,
					providerId: source.providerId,
					connectionInstanceId: source.connectionInstanceId!,
					providerResourceId: source.providerResourceId,
					operation: matched.operation,
					toolId,
					requiredScopes: input.scopes ?? source.requiredScopes,
				}));
				if (
					input.connectionInstanceId &&
					uses.some(
						(use) => use.connectionInstanceId !== input.connectionInstanceId,
					)
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"The requested named account differs from the admitted provider resources",
					);
				for (const use of uses)
					await authorizePersonalResourceDelegation(context, use);
				const resolved = await resolvePersonalResourceDelegatedCredential(
					context,
					uses[0]!,
				);
				for (const use of uses)
					await authorizePersonalResourceDelegation(context, use);
				return {
					accessToken: resolved.accessToken,
					scopes: resolved.delegation.requiredScopes,
				};
			}
			if (context.tediId && input.scope === "user")
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Background personal credentials require an explicit admitted resource consent",
				);
			// A hybrid app may serve a tedi only through the organization's own
			// connection: without an admitted personal-resource envelope (handled
			// above) no caller- or owner-personal credential may enter a tedi run,
			// so resolve the tenant target alone and never reach the user hops.
			if (context.tediId && input.scope === "hybrid") {
				try {
					return await resolveCredentialChain(context, {
						organizationId,
						descopeTenantId,
						providerId: input.providerId,
						connectionInstanceId: input.connectionInstanceId,
						scopes: input.scopes,
						scope: "tenant",
					});
				} catch (error) {
					if (
						error instanceof ORPCError &&
						error.code === ErrorCodes.NOT_FOUND &&
						!error.message.includes("has been retired")
					)
						throw createError(
							ErrorCodes.FORBIDDEN,
							`Background use of ${input.providerId} requires an organization-level (tenant) connection; personal connections are not used without an admitted resource consent.`,
						);
					throw error;
				}
			}

			// `input.userId` selects WHOSE personal credential the chain resolves, and
			// it arrived unvalidated from the request body: resolveTediTenantId above
			// binds the tediId axis, but this second caller-supplied id was not bound
			// at all, so any caller could name another user and receive that user's
			// OAuth token. Same rule this file already applies to
			// Credential resolution rule: you act as yourself unless you are a platform
			// principal (which includes the trusted service-binding edge forwarding an
			// acting user).
			const callerUserId = context.descopeUserId ?? context.user?.sub ?? null;
			const actingUserId = input.userId ?? callerUserId ?? undefined;
			if (
				input.userId &&
				input.userId !== callerUserId &&
				!isPlatformPrincipal(context)
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Fetching another user's credential requires platform-admin authority",
				);
			}

			// Resolve tedi owner — adds the Step 2 owner-personal hop to the chain.
			// fetchOrgToken (the tedi-less variant) skips this step.
			let ownerUserId: string | null = null;
			try {
				const tedi = await getTediByIdForOrganization(
					context.db,
					input.tediId,
					organizationId,
				);
				ownerUserId = tedi?.ownerUserId ?? null;
			} catch {
				// Non-fatal — owner step just gets skipped
			}
			const result = await resolveCredentialChain(context, {
				organizationId,
				descopeTenantId,
				providerId: input.providerId,
				connectionInstanceId: input.connectionInstanceId,
				scopes: input.scopes,
				scope: input.scope,
				preference: input.preference,
				callerUserId: actingUserId,
				ownerUserId,
			});
			console.log(
				`[Connections] Fetched tedi token: providerId=${input.providerId} tediId=${input.tediId} tenantId=${descopeTenantId} scope=${input.scope ?? "tenant"}`,
			);

			// Compound-credential safety check — see resolveCredentialChain comment block.
			// Detect when DESCOPE_PROJECT_ID:KEY_ID:KEY_SECRET is accidentally stored as
			// a connection token (root cause: storeTediApiKey called with mgmt creds).
			const COMPOUND_TOKEN_RE =
				/^[0-9a-f]{32}:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{16,}$/;
			if (COMPOUND_TOKEN_RE.test(result.accessToken)) {
				console.error(
					`[Connections] CREDENTIAL BUG: accessToken for providerId=${input.providerId} tediId=${input.tediId} ` +
						`looks like Descope management credentials (DESCOPE_PROJECT_ID:KEY_ID:KEY_SECRET) stored as ` +
						`the connection token. Fix: call disconnectTediProvider({appId: "${input.providerId}"}) ` +
						`then storeTediApiKey with the correct API token.`,
				);
			}
			return result;
		},
	);

/**
 * List connections available to a tedi.
 *
 * For each configured provider, checks for tenant-scoped and user-scoped tokens.
 * User-scoped tokens are resolved via the tedi owner's Descope userId.
 */

/**
 * List connections available to a tedi.
 *
 * For each configured provider, checks for tenant-scoped and user-scoped tokens.
 * User-scoped tokens are resolved via the tedi owner's Descope userId.
 */
export const getTediConnections = mcpOrAuthOs.getTediConnections
	.use(AUTHZ.tedisRead)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				tediId: string;
			};
			context: BaseContext;
		}) => {
			const { descopeTenantId, organizationId } = await resolveTediTenantId(
				context,
				input.tediId,
			);
			const client = getDescopeManagement(context.env);

			// Resolve tedi owner for user-scoped token checks
			let ownerUserId: string | null = null;
			try {
				const tedi = await getTediByIdForOrganization(
					context.db,
					input.tediId,
					organizationId,
				);
				ownerUserId = tedi?.ownerUserId ?? null;
			} catch {
				// Non-fatal — user-scoped checks will be skipped
			}
			try {
				const response =
					await client.management.outboundApplication.loadAllApplications();
				if (!response.ok || !response.data) {
					return {
						data: [],
					};
				}
				const apps = response.data;
				const connections: ReturnType<typeof mapConnectionRecord>[] = [];

				// Fan out the per-app token checks concurrently (mirrors
				// getUserConnections) instead of awaiting each app sequentially.
				const [tenantResults, userResults] = await Promise.all([
					Promise.all(
						apps.map((app) =>
							fetchTenantConnectionToken(client, app.id, descopeTenantId).catch(
								() => null,
							),
						),
					),
					Promise.all(
						apps.map((app) =>
							ownerUserId
								? fetchConnectionToken(client, app.id, ownerUserId).catch(
										() => null,
									)
								: Promise.resolve(null),
						),
					),
				]);
				const now = Math.floor(Date.now() / 1000);
				for (let i = 0; i < apps.length; i++) {
					const app = apps[i];
					if (!app) continue;
					const tenantToken = tenantResults[i];
					const userToken = userResults[i];
					if (tenantToken) {
						const expiresAt =
							typeof tenantToken.expiresAt === "number" &&
							tenantToken.expiresAt > 0
								? tenantToken.expiresAt
								: null;
						const isExpired = expiresAt != null && expiresAt < now;
						connections.push(
							mapConnectionRecord({
								appId: app.id,
								providerName: app.name,
								status: isExpired ? "expired" : "connected",
								connectedAt: null,
								tokenExpiresAt: expiresAt,
								scopes: Array.isArray(tenantToken.scopes)
									? tenantToken.scopes
									: [],
								tokenScope: "tenant",
							}),
						);
					}
					if (userToken) {
						const expiresAt =
							typeof userToken.expiresAt === "number" && userToken.expiresAt > 0
								? userToken.expiresAt
								: null;
						const isExpired = expiresAt != null && expiresAt < now;
						connections.push(
							mapConnectionRecord({
								appId: app.id,
								providerName: app.name,
								status: isExpired ? "expired" : "connected",
								connectedAt: null,
								tokenExpiresAt: expiresAt,
								scopes: Array.isArray(userToken.scopes) ? userToken.scopes : [],
								tokenScope: "user",
								connectedByUserId: ownerUserId,
							}),
						);
					}
				}
				return {
					data: connections,
				};
			} catch (error) {
				console.error("[Connections] Failed to list tedi connections:", error);
				return {
					data: [],
				};
			}
		},
	);

// =============================================================================
// USER-SCOPED PROVIDER MANAGEMENT
// =============================================================================

/**
 * Store an API-key credential in Descope AIH Token Vault.
 *
 * Distinct project credentials are modeled as distinct outbound app IDs
 * (`promptwatch-tedix`, `promptwatch-{project}`, etc.), so this endpoint only
 * needs the target providerId and desired user/tenant token scope.
 */

// =============================================================================
// USER-SCOPED PROVIDER MANAGEMENT
// =============================================================================

/**
 * Store an API-key credential in Descope AIH Token Vault.
 *
 * Distinct project credentials are modeled as distinct outbound app IDs
 * (`promptwatch-tedix`, `promptwatch-{project}`, etc.), so this endpoint only
 * needs the target providerId and desired user/tenant token scope.
 */
export const storeApiKey = authedOs.storeApiKey
	.use(AUTHZ.integrationAppsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				providerId: string;
				apiKey?: string;
				credentialFields?: Record<string, string>;
				tokenScope?: "tenant" | "user";
			};
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const org = await getOrganizationById(context.db, orgId);
			if (!org?.descopeTenantId) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Organization does not have a Descope tenant configured",
				);
			}
			const apiKey = await composeApiKeyCredential({
				db: context.db,
				organizationId: orgId,
				providerId: input.providerId,
				apiKey: input.apiKey,
				credentialFields: input.credentialFields,
				env: context.env,
			});
			const client = getDescopeManagement(context.env);
			const isUserScoped = input.tokenScope === "user";
			if (isUserScoped) {
				await uploadUserApiKeyToken(client, {
					appId: input.providerId,
					userId: requireUserId(context),
					tenantId: org.descopeTenantId,
					apiKey,
				});
			} else {
				await uploadTenantApiKeyToken(client, {
					appId: input.providerId,
					tenantId: org.descopeTenantId,
					apiKey,
				});
			}
			return {
				success: true as const,
				message: "API key stored in Descope Token Vault",
			};
		},
	);

/**
 * Create a new connection provider (Descope Outbound Application).
 *
 * Registers an OAuth/OIDC or API key provider that organization members
 * and tedis can later connect to.
 */

/**
 * Create a new connection provider (Descope Outbound Application).
 *
 * Registers an OAuth/OIDC or API key provider that organization members
 * and tedis can later connect to.
 */
export const createProvider = authedOs.createProvider
	.use(AUTHZ.integrationAppsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				id?: string;
				name: string;
				description?: string;
				logo?: string;
				type: "oauth" | "api_key";
				clientId?: string;
				clientSecret?: string;
				authorizationUrl?: string;
				authorizationUrlParams?: Array<{
					key: string;
					value: string;
				}>;
				tokenUrl?: string;
				tokenUrlParams?: Array<{
					key: string;
					value: string;
				}>;
				revocationUrl?: string;
				discoveryUrl?: string;
				pkce?: boolean;
				defaultScopes?: string[];
				defaultRedirectUrl?: string;
				callbackDomain?: string;
				accessType?: "offline" | "online";
				prompt?: Array<"none" | "login" | "consent" | "select_account">;
				useDcr?: boolean;
				dcrUrl?: string;
				credentialProfile?: ConnectionCredentialProfile;
			};
			context: BaseContext;
		}) => {
			requireOrgId(context);
			const config = {
				name: input.name,
				type: input.type,
				description: input.description,
				logo: input.logo,
				clientId: input.clientId,
				clientSecret: input.clientSecret,
				authorizationUrl: input.authorizationUrl,
				authorizationUrlParams: input.authorizationUrlParams,
				tokenUrl: input.tokenUrl,
				tokenUrlParams: input.tokenUrlParams,
				revocationUrl: input.revocationUrl,
				discoveryUrl: input.discoveryUrl,
				pkce: input.pkce,
				defaultScopes: input.defaultScopes,
				defaultRedirectUrl: input.defaultRedirectUrl,
				callbackDomain: input.callbackDomain,
				accessType: input.accessType,
				prompt: input.prompt,
				useDcr: input.useDcr,
				dcrUrl: input.dcrUrl,
				credentialProfile: input.credentialProfile,
			};

			// A caller-chosen provider id can collide with or overwrite another
			// tenant's project-global provider (createConnectionProviderWithId is
			// an upsert). Tenants may create providers (additive self-service) but
			// must take a generated id; only platform principals may pin an id.
			if (input.id && !isPlatformPrincipal(context)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Specifying an explicit connection-provider id is restricted to platform administrators.",
				);
			}
			const result = input.id
				? await createConnectionProviderWithId(input.id, config, context.env)
				: await createConnectionProvider(context.env, config);
			console.log(
				`[Connections] Created provider: appId=${result.id} name=${input.name}`,
			);
			return {
				appId: result.id,
				name: input.name,
			};
		},
	);

/**
 * Create a Descope outbound app from a catalog MCP app or upstream MCP URL.
 *
 * This is the operator-friendly path for catalog MCP apps: callers provide the
 * upstream MCP URL or a catalog app selector. OAuth MCP apps use protected
 * resource + authorization-server metadata to derive the DCR endpoint and
 * scopes. API-key MCP apps create a Custom API Key connection without OAuth
 * discovery.
 */

/**
 * Create a Descope outbound app from a catalog MCP app or upstream MCP URL.
 *
 * This is the operator-friendly path for catalog MCP apps: callers provide the
 * upstream MCP URL or a catalog app selector. OAuth MCP apps use protected
 * resource + authorization-server metadata to derive the DCR endpoint and
 * scopes. API-key MCP apps create a Custom API Key connection without OAuth
 * discovery.
 */
/**
 * ADR tedi-client-oauth-cimd phase 1a drift gate: compare the freshly
 * discovered authorization-server issuer against the issuer pinned on the
 * `connection_providers` row at first discovery. Drift → typed CONFLICT
 * refusal (fail closed, no re-provisioning). No row / NULL pin (legacy) →
 * pass-through; the caller pins after a successful provision.
 */
