import type { CreateTediInput } from "@tedix/api-contract/schemas/tedi";
/**
 * Tedis Router — CRUD procedures + logs
 */

import {
	deleteDescopeMcpServer,
	registerDescopeMcpResource,
} from "@tedix/auth/aih-client";
import {
	computeManagedAssignmentsForTedi,
	TEDI_MCP_SCOPES,
} from "@tedix/auth/app-assignment-policy";
import { getManagementClient } from "@tedix/auth/client";
import {
	getAssignedAppRoles,
	grantAppObserver,
	grantAppOperator,
	revokeAppAccess,
} from "@tedix/auth/fga";
import {
	createTediIdentity,
	deleteTediIdentity,
	repairTediIdentity,
	rotateTediAccessKey,
	TEDI_DEFAULT_ROLE,
	TEDI_LOGIN_PREFIX,
} from "@tedix/auth/tedi-identity";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import { isPlatformPrincipal } from "@tedix/auth/types";
import type { RuntimeEntitlement } from "@tedix/api-contract/schemas/runtime-entitlements";
import { requireStepUp } from "../../step-up";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import { upsertTediInferencePolicy } from "@tedix/db/queries/billing/inference-policies";
import {
	getRuntimeProfileById,
	getSystemDefaultRuntimeProfile,
	getSystemDefaultWorkspaceTemplateSet,
	listPolicyPacks,
} from "@tedix/db/queries/control-plane/definitions";
import {
	rebindTediControlPlaneRevision,
	listPolicyPackRevisions,
} from "@tedix/db/queries/control-plane/revisions";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { bindPrincipalIdentity } from "@tedix/db/queries/principal-identities";
import {
	getAllTediSecrets,
	getTediSecret,
	upsertTediSecret,
} from "@tedix/db/queries/tedi-secrets";
import {
	createTedi,
	deleteTedi,
	getTediById,
	getTediBySlug,
	getTedisByOrganization,
	listTediRoster,
	retireTedi,
	updateTedi,
} from "@tedix/db/queries/tedis";
import {} from "@tedix/db/schema/control-plane";
import { TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME } from "@tedix/db/schema/tedi-secrets";
import type { McpCapabilityProfile } from "@tedix/db/schema/tedis";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";

import { invalidateConfig } from "@tedix/provisioning";
import {
	ensureTediAihClientForApp,
	isTediCapabilityDowngrade,
} from "../../../lib/tedi-aih-client-sync";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	AUTHZ,
	withAuthorization,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	fetchLiveTediRuntime,
	generateSlug,
	getPlatformDomain,
	getProvisioningConfig,
	requireOrganizationId,
	requireTediAccess,
	toTediDto,
} from "./helpers";

// =============================================================================
// TEDI MCP scopes
// =============================================================================

// The AIH MCP-server approved-scope envelope must cover every scope any tedi
// client can be synced with. Derive it from the single source of truth
// (TEDI_MCP_SCOPES) rather than hand-copying — a hand-copy previously omitted
// tedi:browser.read/.write, so observer clients synced with those scopes could
// exceed the approved envelope (Descope E113121).
const TEDI_MCP_SCOPE_NAMES = TEDI_MCP_SCOPES;

/** Resolve the newest active published default; draft revisions are not deployable. */
export function resolveNewTediDefaultPolicyPack(
	heads: Awaited<ReturnType<typeof listPolicyPacks>>,
) {
	const defaults = heads
		.filter(
			(pack) =>
				pack.scope === "system" &&
				pack.slug === "system-default" &&
				pack.status === "active" &&
				Boolean(pack.publishedAt),
		)
		.sort((a, b) => b.version - a.version);
	const pack = defaults[0];
	if (
		!pack ||
		defaults[1]?.version === pack.version ||
		pack.status !== "active" ||
		!pack.publishedAt ||
		!["tedi", "shared"].includes(pack.target)
	) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"No active published system-default tedi policy is available",
		);
	}
	return pack;
}

/** New tedis share organization inference capacity unless explicitly capped. */
export function resolveNewTediBudgets(limits: RuntimeEntitlement["limits"]) {
	return {
		dailyTokenLimit: -1,
		dailyMessageLimit: -1,
		maxCronJobs: limits.maxCronJobsPerTedi,
		maxIterationsPerTask: -1,
	};
}

async function storeEncryptedTediSecret(
	masterKey: string,
	context: BaseContext,
	tediId: string,
	name: string,
	plaintext: string,
) {
	const encrypted = await encryptTediSecret(masterKey, tediId, plaintext);
	await upsertTediSecret(context.db, tediId, name, encrypted, null, null);
}

export async function materializeManagedAppAssignments(
	context: BaseContext,
	tedi: {
		id: string;
		organizationId: string;
		name: string;
		slug: string;
		descopeUserId?: string | null;
		mcpCapabilityProfile?: string | null;
		tags?: string[] | null;
	},
): Promise<void> {
	if (!tedi.descopeUserId || !context.env.DESCOPE_MANAGEMENT_KEY) return;

	const orgApps = await getAppsByOrganization(context.db, tedi.organizationId);
	const managedAssignments = computeManagedAssignmentsForTedi(
		orgApps.map((app) => ({
			id: app.id,
			name: app.name,
			slug: app.slug,
			metadata: getAppMetadataJson(app),
		})),
		{
			id: tedi.id,
			slug: tedi.slug,
			mcpCapabilityProfile: tedi.mcpCapabilityProfile,
			tags: tedi.tags,
		},
	);

	if (managedAssignments.length === 0) return;

	const descopeClient = getManagementClient(context.env);
	const appById = new Map(orgApps.map((app) => [app.id, app]));
	for (const assignment of managedAssignments) {
		if (assignment.role === "operator") {
			await grantAppOperator(
				descopeClient,
				tedi.descopeUserId,
				assignment.appId,
			);
		} else {
			await grantAppObserver(
				descopeClient,
				tedi.descopeUserId,
				assignment.appId,
			);
		}

		const app = appById.get(assignment.appId);
		if (
			app &&
			context.env.SECRETS_MASTER_KEY &&
			context.env.DESCOPE_PROJECT_ID &&
			context.env.DESCOPE_MANAGEMENT_KEY
		) {
			const result = await ensureTediAihClientForApp({
				env: {
					DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
					DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
				},
				db: context.db,
				masterKey: context.env.SECRETS_MASTER_KEY,
				tedi,
				app,
				role: assignment.role,
				createdBy: context.user?.sub ?? null,
			});
			console.log(
				`[Tedis] Synced AIH client for ${tedi.slug} -> ${app.slug}: ${result.status}`,
			);
		}
	}

	console.log(
		`[Tedis] Materialized ${managedAssignments.length} managed app assignment(s) for ${tedi.slug}`,
	);
}

async function registerTediAihMcpServer(
	context: BaseContext,
	tedi: {
		id: string;
		name: string;
		slug: string | null;
		displayName?: string | null;
	},
): Promise<string> {
	if (!tedi.slug) {
		throw new Error("Cannot register a per-tedi AIH MCP server without a slug");
	}

	const platformDomain = getPlatformDomain(context.env);
	const mcpServerUrl = `https://${tedi.slug}.tedi.${platformDomain}/mcp`;

	const server = await registerDescopeMcpResource(context.env, {
		name: `Tedi ${tedi.displayName ?? tedi.name}`,
		description: `MCP server for tedi ${tedi.slug}`,
		audienceWhitelist: [mcpServerUrl],
		approvedScopes: {
			connectionsScopes: TEDI_MCP_SCOPE_NAMES.map((scope) => ({
				name: scope,
				description:
					scope === "tedi:admin"
						? "Full tedi access"
						: `Tedi runtime capability: ${scope}`,
				optional: true,
			})),
		},
		dynamicRegistration: {
			enabled: true,
			flowId: "sign-up-or-in",
			disableApprovedScopesAsDefault: true,
		},
		skipConsentScreen: false,
	});

	await updateTedi(context.db, tedi.id, {
		descopeMcpResourceId: server.id,
	});

	console.log(
		`[Tedis] Registered opt-in AIH MCP server for ${tedi.name} (serverId: ${server.id}, url: ${mcpServerUrl})`,
	);

	return server.id;
}

async function refreshTediRuntimeSecrets(
	context: BaseContext,
	tedi: Awaited<ReturnType<typeof requireTediAccess>>,
): Promise<boolean> {
	const provConfig = getProvisioningConfig(tedi, context.env);
	if (!provConfig) return false;
	await invalidateConfig(provConfig).catch(() => false);
	return true;
}

// =============================================================================
// CRUD procedures
// =============================================================================

export const listTedis = authedTedisOs.list
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrganizationId(context);
		const {
			limit = 20,
			offset = 0,
			includeRetired = false,
			search,
			status,
		} = input || {};

		// Disjoint by design: the default view is the org's operating workers, and
		// `includeRetired` is the recovery/audit view of workers that were retired
		// (soft-deleted) with their cognitive state intact. Merging them would make
		// a retired worker look live in every list that does not read `retiredAt`.
		const { data: paged, total } = await listTediRoster(context.db, {
			organizationId: orgId,
			limit,
			offset,
			includeRetired,
			search: search?.trim(),
			status,
		});

		// Use D1-cached status columns (written by heartbeat cron) instead of
		// probing each tedi's live runtime — avoids N sequential HTTP calls that
		// timeout when containers are sleeping. Live probing is done in getTedi.
		const enriched = paged.map((t) => toTediDto(t, { env: context.env }));

		return {
			data: enriched,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

export const getTedi = authedTedisOs.get
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const liveRuntime = await fetchLiveTediRuntime(tedi, context.env);

		return toTediDto(tedi, {
			env: context.env,
			liveRuntime: liveRuntime
				? {
						runtimeStatus: liveRuntime.normalizedRuntimeStatus,
						lastSeenAt: liveRuntime.lastSeenAt,
					}
				: undefined,
		});
	});

/**
 * Which org does a `tedis.create` land in, and is the caller allowed to say so?
 *
 * Defaults to the caller's org. Naming a different org is a cross-org write and
 * requires platform-admin authority — that is what lets a platform admin (or the
 * CTO tedi) give a freshly provisioned customer tenant its first tedi without
 * interactively logging into that customer's workspace.
 */
export function resolveTediCreateOrg(params: {
	callerOrgId: string;
	requestedOrgId?: string;
	isPlatformPrincipal: boolean;
}): { orgId: string; forbidden: boolean } {
	const orgId = params.requestedOrgId ?? params.callerOrgId;
	return {
		orgId,
		forbidden: orgId !== params.callerOrgId && !params.isPlatformPrincipal,
	};
}

/**
 * Which capability profile does a newly created tedi get?
 *
 * The first tedi in an org is its designated operator — the whole point of a
 * tenant tedi is to run the org without requiring a human UI session, so give
 * it `org_admin` (own-org governance: install MCP apps, manage connections and
 * settings). Every subsequent tedi is a `standard` worker. `org_admin` still has
 * no `platform:admin`, so it remains own-org only (not a platform principal) — this is
 * a scoped default, not an escalation. An explicit `mcpCapabilityProfile` on the
 * input (settable only by a trusted user/apikey caller, see the capability gate)
 * always wins.
 */
export function resolveNewTediCapabilityProfile(params: {
	existingTediCount: number;
	requestedProfile?: McpCapabilityProfile | null;
}): McpCapabilityProfile {
	if (params.requestedProfile) return params.requestedProfile;
	return params.existingTediCount === 0 ? "org_admin" : "standard";
}

export const createTediProcedure = authedTedisOs.create
	.use(withAuthorization("tedis:create", "apps:write"))
	.handler(({ input, context }) => createTediResources(context, input));

/** Internal provider onboarding; never exposed as a procedure or a client flag. */
export function createTediForProvider(
	context: BaseContext,
	input: CreateTediInput,
) {
	return createTediResources(context, input, true);
}

/** Import provisions a fresh destination identity without activating tools. */
export function createTediForPortableImport(
	context: BaseContext,
	input: CreateTediInput,
) {
	return createTediResources(
		context,
		{ ...input, registerDescopeAih: false },
		false,
		true,
	);
}

async function createTediResources(
	context: BaseContext,
	input: CreateTediInput,
	providerAuthorized = false,
	portableImport = false,
) {
	const callerOrgId = requireOrganizationId(context);
	const { orgId, forbidden } = resolveTediCreateOrg({
		callerOrgId,
		requestedOrgId: input.organizationId,
		isPlatformPrincipal: providerAuthorized || isPlatformPrincipal(context),
	});
	if (forbidden) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Creating a tedi in another organization requires platform-admin authority",
		);
	}
	let slug = input.slug || generateSlug(input.name);

	// Guard against empty slug (e.g. name like "!!!" produces "")
	if (!slug) {
		slug = `tedi-${crypto.randomUUID().slice(0, 6)}`;
	}

	// Check slug uniqueness within org
	const existing = await getTediBySlug(context.db, orgId, slug);
	if (existing) {
		throw createError(
			ErrorCodes.CONFLICT,
			"A tedi with this slug already exists in your organization",
		);
	}

	const org = await getOrganizationById(context.db, orgId);
	// The org id is now caller-suppliable, so a bogus one would otherwise mint a
	// tedi against an organization that does not exist.
	if (!org) {
		throw createError(ErrorCodes.NOT_FOUND, `Organization ${orgId} not found`);
	}

	if (providerAuthorized && !org.metadata?.providerCustomerKey) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Provider onboarding requires a provider-owned customer",
		);
	}
	if (portableImport && org.metadata?.providerCustomerKey) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Portable import into a provider-owned customer is unavailable",
		);
	}

	// The first tedi in an org is its operator → org_admin; the rest are
	// standard workers. (getTediBySlug above already confirmed no slug clash,
	// but we still need the count to decide the profile.)
	const existingOrgTedis = await getTedisByOrganization(context.db, orgId);
	const entitlement = await getRuntimeEntitlement(context.db, orgId);
	const now = Date.now();
	if (!entitlement || !runtimeEntitlementIsActive(entitlement, now)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An active runtime entitlement is required to create a tedi",
		);
	}
	if (
		entitlement.limits.maxTedis >= 0 &&
		existingOrgTedis.length >= entitlement.limits.maxTedis
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`The ${entitlement.profile.name} profile allows ${entitlement.limits.maxTedis} tedi(s)`,
		);
	}
	const mcpCapabilityProfile = portableImport
		? "standard"
		: resolveNewTediCapabilityProfile({
				existingTediCount: existingOrgTedis.length,
			});

	const policyHeads = await listPolicyPacks(context.db, {
		organizationId: orgId,
		includeSystem: true,
	});
	const defaultHead = policyHeads.find(
		(pack) => pack.scope === "system" && pack.slug === "system-default",
	);
	const defaultPolicyPack = resolveNewTediDefaultPolicyPack(
		defaultHead
			? await listPolicyPackRevisions(context.db, defaultHead.id)
			: [],
	);
	// Same head-of-slug resolution the policy pack above already uses, so a
	// published revision becomes the platform default without a code change.
	const [defaultRuntimeProfile, defaultWorkspaceTemplateSet] =
		await Promise.all([
			getSystemDefaultRuntimeProfile(context.db),
			getSystemDefaultWorkspaceTemplateSet(context.db),
		]);
	if (
		portableImport &&
		(!defaultRuntimeProfile || !defaultWorkspaceTemplateSet)
	) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Destination control defaults are unavailable for portable import",
		);
	}
	if (
		portableImport &&
		(!context.env.DESCOPE_PROJECT_ID ||
			!context.env.DESCOPE_MANAGEMENT_KEY ||
			!org.descopeTenantId ||
			!context.env.SECRETS_MASTER_KEY)
	) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Destination identity configuration is unavailable for portable import",
		);
	}
	const tedi = await createTedi(context.db, {
		id: crypto.randomUUID(),
		organizationId: orgId,
		name: input.name,
		slug,
		mcpCapabilityProfile,
		displayName: input.displayName ?? null,
		externalRef: input.externalRef ?? null,
		tags: input.tags ?? null,
		personality: input.personality ?? null,
		timezone: input.timezone ?? null,
		language: input.language ?? null,
		status: portableImport ? "paused" : "active",
		scope: "organization",
		ownerUserId: context.user?.sub ?? null,
		r2BucketName: input.r2BucketName ?? null,
		workerName: input.workerName ?? null,
		runtimeOverrides:
			input.runtimeOverrides == null
				? null
				: toJsonRecord(input.runtimeOverrides),
		runtimeProfileId: defaultRuntimeProfile?.id ?? null,
		policyPackId: defaultPolicyPack.id,
		workspaceTemplateSetId: defaultWorkspaceTemplateSet?.id ?? null,
		runtimeKind: input.runtimeKind ?? "agent",
		isolateAgentId: input.isolateAgentId ?? slug,
		budgets: resolveNewTediBudgets(entitlement.limits),
	});

	console.log(
		`[Tedis] Created tedi: ${tedi.name} (${tedi.id}) for org ${orgId}`,
	);

	const masterKey = context.env.SECRETS_MASTER_KEY;

	if (org?.metadata?.providerCustomerKey) {
		const { ensureProviderWorkerReady } =
			await import("../../../services/provider-worker-readiness");
		const readyTedi = await ensureProviderWorkerReady(context, {
			organizationId: orgId,
			tenantId: org.descopeTenantId!,
			tediId: tedi.id,
			slug,
		});
		await materializeManagedAppAssignments(context, readyTedi);
	} else {
		// Auto-provision Descope identity for MCP auth (V2: user + access key)
		if (
			context.env.DESCOPE_PROJECT_ID &&
			context.env.DESCOPE_MANAGEMENT_KEY &&
			org?.descopeTenantId
		) {
			try {
				const descopeClient = getManagementClient(context.env);
				const identity = await createTediIdentity(descopeClient, {
					tediId: tedi.id,
					slug,
					displayName: input.displayName ?? input.name,
					tenantId: org.descopeTenantId,
				});

				// Store descopeUserId in D1
				await updateTedi(context.db, tedi.id, {
					descopeUserId: identity.descopeUserId,
				});
				await bindPrincipalIdentity(context.db, {
					organizationId: orgId,
					principalType: "tedi",
					principalId: tedi.id,
					provider: "descope",
					issuer: descopeIssuer(
						context.env.DESCOPE_PROJECT_ID,
						context.env.DESCOPE_BASE_URL,
					),
					subject: identity.descopeUserId,
				});

				// Encrypt and store access key + Descope key id
				if (identity.cleartext && masterKey) {
					await storeEncryptedTediSecret(
						masterKey,
						context,
						tedi.id,
						"DESCOPE_ACCESS_KEY",
						identity.cleartext,
					);
					await storeEncryptedTediSecret(
						masterKey,
						context,
						tedi.id,
						"DESCOPE_ACCESS_KEY_ID",
						identity.descopeKeyId,
					);
					console.log(
						`[Tedis] Auto-provisioned V2 identity for ${tedi.name} (user: ${identity.descopeUserId})`,
					);
				}

				// Materialize config-driven managed app assignments for this tedi.
				// App metadata decides the default baseline; FGA remains the runtime grant layer.
				if (!portableImport) {
					await materializeManagedAppAssignments(context, {
						id: tedi.id,
						organizationId: tedi.organizationId,
						name: tedi.name,
						slug: tedi.slug,
						descopeUserId: identity.descopeUserId,
						mcpCapabilityProfile: tedi.mcpCapabilityProfile,
						tags: tedi.tags,
					});
				}
			} catch (error) {
				if (portableImport) {
					throw createError(
						ErrorCodes.SERVICE_UNAVAILABLE,
						`Portable import target ${tedi.id} remains paused; its identity could not be provisioned`,
					);
				}
				console.warn(
					`[Tedis] Failed to auto-provision Descope identity for ${tedi.name}:`,
					error,
				);
			}
		}

		// Auto-generate runtime access token for service auth
		if (masterKey) {
			try {
				const runtimeAccessToken = crypto.randomUUID();
				await storeEncryptedTediSecret(
					masterKey,
					context,
					tedi.id,
					TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME,
					runtimeAccessToken,
				);
				console.log(
					`[Tedis] Auto-generated runtime access token for ${tedi.name}`,
				);
			} catch (error) {
				console.warn(
					`[Tedis] Failed to auto-generate runtime access token for ${tedi.name}:`,
					error,
				);
			}
		}

		// Auto-generate CDP secret for Cloudflare Browser Rendering
		if (masterKey) {
			try {
				const cdpSecret = crypto.randomUUID();
				await storeEncryptedTediSecret(
					masterKey,
					context,
					tedi.id,
					"CDP_SECRET",
					cdpSecret,
				);
				console.log(`[Tedis] Auto-generated CDP_SECRET for ${tedi.name}`);
			} catch (error) {
				console.warn(
					`[Tedis] Failed to auto-generate CDP secret for ${tedi.name}:`,
					error,
				);
			}
		}
	}

	// Register a Descope AIH MCP server only when explicitly requested.
	// The default tedi path is internal/service-bound; per-tedi OAuth is for
	// standalone MCP clients or cross-tedi M2M meshes we intentionally expose.
	// Only register in production — local shares production Descope state,
	// so registering with a non-production URL would break the tedi's OAuth audience.
	if (
		input.registerDescopeAih === true &&
		context.env.DESCOPE_PROJECT_ID &&
		context.env.DESCOPE_MANAGEMENT_KEY &&
		context.env.ENVIRONMENT === "production"
	) {
		try {
			await registerTediAihMcpServer(context, tedi);
		} catch (error) {
			console.warn(
				`[Tedis] Failed to register AIH MCP server for ${tedi.name}:`,
				error,
			);
		}
	} else if (
		input.registerDescopeAih === true &&
		context.env.DESCOPE_PROJECT_ID &&
		context.env.DESCOPE_MANAGEMENT_KEY
	) {
		console.log(
			`[Tedis] Skipping AIH MCP server registration for ${tedi.name} — non-production environment (${context.env.ENVIRONMENT})`,
		);
	}

	// Emit audit event for tedi provisioning
	const { actorId, actorType } = auditActor(context);
	await emitAuditEvent(context.db, {
		organizationId: orgId,
		actorId,
		actorType,
		action: "tedi.provision",
		resourceType: "tedi",
		resourceId: tedi.id,
		metadata: { name: tedi.name, slug },
	}).catch((err) => {
		console.error(
			"[Tedis] Failed to emit audit event for tedi.provision:",
			err,
		);
	});

	return toTediDto(tedi, {
		overrides: {
			toolPolicy: null,
			selfImprovementPolicy: null,
			budgets: null,
			quietHours: null,
			channels: null,
			cronJobs: null,
		},
	});
}

/**
 * Fields that durably change what a tedi is allowed to do. Invariant: only a
 * caller whose `authType` proves a human or an operator-issued API key may
 * write them. Every other caller (`tedi`, `m2m`, `service-binding`, or an
 * unresolved identity) is refused, so the gate fails closed when identity
 * propagation is incomplete. `requireTediAccess` checks only organization
 * membership, so without this gate one tedi could raise another's tier.
 *
 * - `mcpCapabilityProfile`, `toolPolicy`: the MCP scope tier and the
 *   approve-vs-allow policy for bash/browser/github/deploy.
 * - `repoConfig`: a non-empty `repoUrl` makes a tedi `embodied`
 *   (`kernel/tedi-capabilities.ts`), which changes delegation dispatch and
 *   names the repository a coding tedi writes to.
 * - `cronJobs`: durable self-scheduling (defense in depth; no runtime reads
 *   this column yet).
 * - `budgets`, `runtimeProfileId`, `runtimeOverrides`: model and spend tier.
 */
export const AGENT_UNREACHABLE_CAPABILITY_FIELDS = [
	"mcpCapabilityProfile",
	"toolPolicy",
	"repoConfig",
	"cronJobs",
	"budgets",
	"runtimeProfileId",
	// `agents.defaults.model.primary` pins the model directly.
	"runtimeOverrides",
] as const;

/** `authType` values that cannot be an LLM's own in-turn tool selection. */
const CAPABILITY_MUTATION_TRUSTED_AUTH_TYPES = new Set(["user", "apikey"]);

/**
 * Pure predicate: which capability-tier fields (if any) does this update
 * touch, given the caller's resolved `authType`? Returns an empty array only
 * when `authType` affirmatively proves a human or operator-issued API key —
 * every other value (including `undefined`) is treated as untrusted for this
 * mutation class, regardless of that caller's own granted scopes.
 */
export function agentUnreachableCapabilityFieldsTouched(
	authType: string | undefined,
	data: Record<string, unknown>,
): string[] {
	if (authType && CAPABILITY_MUTATION_TRUSTED_AUTH_TYPES.has(authType)) {
		return [];
	}
	return AGENT_UNREACHABLE_CAPABILITY_FIELDS.filter(
		(field) => data[field] !== undefined,
	);
}

export const updateTediProcedure = authedTedisOs.update
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const { tediId, ...data } = input;
		const existingTedi = await requireTediAccess(context, tediId);

		// See AGENT_UNREACHABLE_CAPABILITY_FIELDS above. Checked before any
		// privilege/scope lookup so a tedi's own elevated scopes (platform:admin)
		// cannot bypass this — the gate is on the mutation, not the caller.
		// Allowlist, not denylist: only an affirmatively-verified human or
		// operator-issued API key may pass. This does not trust "not a known
		// tedi" as proof of safety (that signal has a demonstrated propagation
		// gap — see the comment above AGENT_UNREACHABLE_CAPABILITY_FIELDS).
		const touchedCapabilityFields = agentUnreachableCapabilityFieldsTouched(
			context.authType,
			data,
		);
		if (touchedCapabilityFields.length > 0) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				`Capability/policy field(s) [${touchedCapabilityFields.join(", ")}] require a human operator or an operator-issued API key — no other caller identity, including an agent-authenticated tedi, an M2M client, or an internal service binding, can durably change a capability tier, even its own or another tedi's, regardless of its own granted scopes.`,
			);
		}

		// Serialize JSON fields for D1 storage
		const updateData: Record<string, unknown> = {};
		let runtimeProfileRebind: string | undefined;
		if (data.name !== undefined) updateData.name = data.name;
		if (data.displayName !== undefined)
			updateData.displayName = data.displayName;
		if (data.externalRef !== undefined)
			updateData.externalRef = data.externalRef;
		if (data.tags !== undefined) {
			updateData.tags = data.tags ?? null;
		}
		if (data.personality !== undefined)
			updateData.personality = data.personality;
		if (data.avatar !== undefined) updateData.avatar = data.avatar;
		if (data.timezone !== undefined) updateData.timezone = data.timezone;
		if (data.language !== undefined) updateData.language = data.language;
		if (data.status !== undefined) updateData.status = data.status;
		if (data.billingState !== undefined)
			updateData.billingState = data.billingState;
		if (data.workerName !== undefined) updateData.workerName = data.workerName;
		if (data.r2BucketName !== undefined)
			updateData.r2BucketName = data.r2BucketName;
		if (data.toolPolicy !== undefined) updateData.toolPolicy = data.toolPolicy;
		if (data.selfImprovementPolicy !== undefined)
			updateData.selfImprovementPolicy = data.selfImprovementPolicy;
		if (data.budgets !== undefined) updateData.budgets = data.budgets;
		if (data.quietHours !== undefined) updateData.quietHours = data.quietHours;
		if (data.channels !== undefined) {
			// Extract bot tokens from channels and save as encrypted secrets.
			// Tokens are the single source of truth in tedi_secrets, not in the
			// channels column. Strip botToken/appToken before persisting to D1.
			const channelsObj = data.channels as Record<
				string,
				Record<string, unknown>
			> | null;
			const masterKey = context.env.SECRETS_MASTER_KEY;
			if (channelsObj && masterKey) {
				const tokenMappings: Array<{
					channel: string;
					field: string;
					secretName: string;
				}> = [
					{
						channel: "telegram",
						field: "botToken",
						secretName: "TELEGRAM_BOT_TOKEN",
					},
				];
				for (const { channel, field, secretName } of tokenMappings) {
					const channelConfig = channelsObj[channel];
					if (!channelConfig) continue;
					const tokenValue = channelConfig[field];
					if (
						typeof tokenValue === "string" &&
						tokenValue.length > 0 &&
						!tokenValue.includes("…")
					) {
						// Save as encrypted secret
						const encrypted = await encryptTediSecret(
							masterKey,
							tediId,
							tokenValue,
						);
						await upsertTediSecret(
							context.db,
							tediId,
							secretName,
							encrypted,
							null,
							null,
						);
						// Strip from channels object (don't store plaintext in D1)
						delete channelConfig[field];
					}
				}
			}
			updateData.channels = channelsObj;
		}
		if (data.cronJobs !== undefined) {
			const entitlement = await getRuntimeEntitlement(
				context.db,
				existingTedi.organizationId,
			);
			const maxCronJobs = entitlement?.limits.maxCronJobsPerTedi ?? 0;
			if (
				maxCronJobs >= 0 &&
				data.cronJobs !== null &&
				data.cronJobs.length > maxCronJobs
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`The ${entitlement?.profile.name ?? "current"} profile allows ${maxCronJobs} scheduled job(s) per tedi`,
				);
			}
			updateData.cronJobs = data.cronJobs;
		}
		if (data.installedSkills !== undefined)
			updateData.installedSkills = data.installedSkills;
		if (data.installedPlugins !== undefined)
			updateData.installedPlugins = data.installedPlugins;
		if (data.runtimeOverrides !== undefined)
			updateData.runtimeOverrides = data.runtimeOverrides ?? null;
		if (data.runtimeProfileId !== undefined) {
			// `null` resets to the system default; otherwise the profile must be a
			// system profile or one owned by this tedi's org (no cross-org binding).
			if (data.runtimeProfileId !== null) {
				const profile = await getRuntimeProfileById(
					context.db,
					data.runtimeProfileId,
				);
				if (
					!profile ||
					(profile.scope !== "system" &&
						profile.organizationId !== existingTedi.organizationId)
				) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`runtimeProfileId ${data.runtimeProfileId} is not a system profile or a runtime profile owned by this tedi's organization`,
					);
				}
			}
			runtimeProfileRebind =
				data.runtimeProfileId ??
				(await getSystemDefaultRuntimeProfile(context.db))?.id;
		}
		if (data.repoConfig !== undefined)
			updateData.repoConfig = data.repoConfig ?? null;
		if (data.mcpCapabilityProfile !== undefined)
			updateData.mcpCapabilityProfile = data.mcpCapabilityProfile;
		// NOTE: runtimeVersion is not stored on tedis — target version is set on
		// runtime_profiles, observed version flows via runtime_snapshots.

		const { actorId, actorType } = auditActor(context);
		if (
			runtimeProfileRebind !== undefined &&
			runtimeProfileRebind !== existingTedi.runtimeProfileId
		) {
			const rebound = await rebindTediControlPlaneRevision(context.db, {
				organizationId: existingTedi.organizationId,
				tediId,
				kind: "runtime_profile",
				expectedRevisionId: existingTedi.runtimeProfileId,
				revisionId: runtimeProfileRebind,
				changedBy: actorId,
				changeReason: "Tedi configuration update",
			});
			if (!rebound) {
				throw createError(
					ErrorCodes.CONFLICT,
					"The tedi runtime profile pin changed concurrently",
				);
			}
		}

		const tedi = await updateTedi(context.db, tediId, updateData);

		if (!tedi) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update tedi",
			);
		}

		// AI Gateway admission reads billing_inference_policies, not the tedi
		// configuration JSON. Keep an explicit per-tedi gateway policy authoritative
		// on the same operator mutation so displayed and enforced ceilings agree.
		if (data.budgets?.aiGatewayPolicy !== undefined) {
			await upsertTediInferencePolicy(context.db, {
				organizationId: existingTedi.organizationId,
				tediId,
				policy: data.budgets.aiGatewayPolicy,
			});
		}

		console.log(`[Tedis] Updated tedi: ${tedi.name} (${tediId})`);

		// Emit audit event for config change
		await emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.config_change",
			resourceType: "tedi",
			resourceId: tediId,
			metadata: { fields: Object.keys(data) },
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.config_change:",
				err,
			);
		});

		// Fire-and-forget: invalidate tedi Worker resolve cache
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (provConfig) {
			const p = invalidateConfig(provConfig).catch(() => {});
			if (context.waitUntil) context.waitUntil(p);
		}

		// A capability-profile change alters the scopes each managed AIH M2M
		// client should hold, but client scopes are only re-derived on
		// assignment create/updateRole — not on a bare profile edit. Without
		// this, existing clients keep the old profile's scopes until an
		// unrelated assignment mutation. Re-materialize managed assignments so
		// the change propagates.
		//
		// The propagation guarantee is directional (audit CC-2):
		//  - Downgrade (fewer scopes) is security-critical — the client must shed
		//    the removed scopes. Run the re-sync synchronously and fail closed:
		//    if it fails, surface the error rather than reporting a clean success
		//    that leaves the client holding the old, broader scopes.
		//  - Upgrade / lateral / no-op only adds scope (or none), and the live D1
		//    profile already governs the MCP edge, so its re-sync stays
		//    best-effort + non-blocking and never gates the response.
		if (data.mcpCapabilityProfile !== undefined) {
			const isDowngrade = isTediCapabilityDowngrade(
				existingTedi.mcpCapabilityProfile,
				tedi.mcpCapabilityProfile,
			);
			if (isDowngrade) {
				try {
					await materializeManagedAppAssignments(context, tedi);
				} catch (err) {
					console.error(
						`[Tedis] Fail-closed AIH client re-sync after capability DOWNGRADE failed for ${tedi.slug}:`,
						err instanceof Error ? err.message : err,
					);
					throw createError(
						ErrorCodes.INTERNAL_SERVER_ERROR,
						`The capability profile was reduced in D1, but propagating the reduced scopes to this tedi's Descope AIH client(s) failed — a managed client may still hold the previous, broader scopes. Retry the update to re-sync. (${err instanceof Error ? err.message : String(err)})`,
					);
				}
			} else {
				const resync = materializeManagedAppAssignments(context, tedi).catch(
					(err) =>
						console.warn(
							`[Tedis] AIH client re-sync after profile change failed for ${tedi.slug}:`,
							err instanceof Error ? err.message : err,
						),
				);
				if (context.waitUntil) context.waitUntil(resync);
			}
		}

		return toTediDto(tedi);
	});

/**
 * One structured outcome row from a tedi teardown sub-cleanup. `ok: false` never
 * aborts the cascade — purge is best-effort per external system and the caller
 * reports the failed steps rather than leaving the tedi half-deleted.
 */
interface TediCleanupResult {
	step: string;
	ok: boolean;
	detail?: string;
}

/**
 * Tear down a tedi's external identity footprint (Descope user, FGA app
 * relations, AIH MCP server registration). Shared by `deleteTediProcedure` and
 * the platform-admin `decommissionTediProcedure` hard-purge path so the supported
 * cleanup lives in exactly one place. Best-effort and fail-soft per system:
 * returns a structured result per step instead of throwing, so D1 deletion still
 * proceeds even if a remote call fails.
 */
async function purgeTediExternalIdentity(
	context: BaseContext,
	tedi: {
		name: string;
		slug: string | null;
		organizationId: string;
		descopeUserId: string | null;
		descopeMcpResourceId: string | null;
	},
): Promise<TediCleanupResult[]> {
	const results: TediCleanupResult[] = [];

	// Clean up Descope identity + FGA relations before D1 deletion
	if (tedi.descopeUserId && context.env.DESCOPE_MANAGEMENT_KEY) {
		try {
			const descopeClient = getManagementClient(context.env);

			// Revoke all FGA app relations for this tedi
			try {
				const orgApps = await getAppsByOrganization(
					context.db,
					tedi.organizationId,
				);
				const roles = await getAssignedAppRoles(
					descopeClient,
					tedi.descopeUserId,
					orgApps.map((a) => a.id),
				);
				const assignedAppIds = Object.keys(roles);
				for (const appId of assignedAppIds) {
					await revokeAppAccess(descopeClient, tedi.descopeUserId, appId);
				}
				console.log(
					`[Tedis] Revoked ${assignedAppIds.length} FGA relations for tedi ${tedi.name}`,
				);
				results.push({
					step: "descope_fga_revoke",
					ok: true,
					detail: `revoked ${assignedAppIds.length} app relations`,
				});
			} catch (fgaError) {
				console.warn(
					`[Tedis] Failed to revoke FGA relations for tedi ${tedi.name}:`,
					fgaError,
				);
				results.push({
					step: "descope_fga_revoke",
					ok: false,
					detail:
						fgaError instanceof Error ? fgaError.message : String(fgaError),
				});
			}

			// Delete the Descope user (cascades access keys)
			const loginId = `${TEDI_LOGIN_PREFIX}${tedi.slug}`;
			await deleteTediIdentity(descopeClient, loginId);
			console.log(
				`[Tedis] Deleted Descope identity for tedi ${tedi.name} (user: ${tedi.descopeUserId})`,
			);
			results.push({
				step: "descope_identity_delete",
				ok: true,
				detail: `deleted user ${tedi.descopeUserId}`,
			});
		} catch (error) {
			console.warn(
				`[Tedis] Failed to clean up Descope identity for tedi ${tedi.name}:`,
				error,
			);
			results.push({
				step: "descope_identity_delete",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	} else {
		results.push({
			step: "descope_identity_delete",
			ok: true,
			detail: "skipped — no Descope identity or management key configured",
		});
	}

	// Clean up Descope AIH MCP server registration
	if (tedi.descopeMcpResourceId && context.env.DESCOPE_MANAGEMENT_KEY) {
		try {
			await deleteDescopeMcpServer(context.env, tedi.descopeMcpResourceId);
			console.log(
				`[Tedis] Deleted AIH MCP server for tedi ${tedi.name} (serverId: ${tedi.descopeMcpResourceId})`,
			);
			results.push({ step: "descope_aih_mcp_delete", ok: true });
		} catch (error) {
			console.warn(
				`[Tedis] Failed to delete AIH MCP server for tedi ${tedi.name}:`,
				error,
			);
			results.push({
				step: "descope_aih_mcp_delete",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

/**
 * May the caller delete a tedi that lives in `tediOrgId`?
 *
 * Same-org delete is the ordinary case and is unchanged. Deleting a tedi in a
 * different org is a cross-org write and requires platform-admin authority —
 * that is what makes tenant OFFBOARDING automatable, mirroring the cross-org
 * `tedis.create` that made ONBOARDING automatable (`resolveTediCreateOrg`).
 * Without it a platform admin had to interactively `tedix login <customer>` to
 * tear a customer's tedis down, so offboarding could not be scripted at all.
 *
 * Authority is checked with `isPlatformPrincipal` (not `isPlatformAdmin`), so
 * API-key/M2M automation and the `platform:admin` CTO tedi count — a tedi's Descope
 * roles are not in its JWT, so a role-only check silently rejects them.
 *
 * Fail-closed: a non-platform caller is still confined to its own org.
 *
 * This deliberately does not relax the shared `requireTediAccess` guard, which
 * ~19 other routers (get/update/runtime/sessions/secrets/...) rely on for org
 * isolation. Only the delete path gains cross-org reach.
 */
export function resolveTediDeleteAccess(params: {
	callerOrgId: string;
	tediOrgId: string;
	isPlatformPrincipal: boolean;
	/**
	 * Only the internal `system` service-binding caller — not "any service
	 * binding". Mirrors the deliberately narrow `authType === "service-binding" &&
	 * orgId === "system"` bypass in `requireTediAccess`.
	 *
	 * Trusting the transport alone here would be a privilege escalation: every
	 * tenant tedi's tool call reaches apps/api as `authType: "service-binding"`
	 * (that is how the MCP→API hop works), carrying its own tenant's org id. So a
	 * bare service-binding check would let any `standard` tedi in any tenant
	 * delete any tedi in any org. Authority must come from the principal
	 * (`isPlatformPrincipal` — platform-admin role, `platform:admin` API key/M2M,
	 * or an `platform:admin` tedi), never from the binding.
	 */
	isSystemServiceBinding?: boolean;
}): { allowed: boolean; crossOrg: boolean } {
	const crossOrg = params.tediOrgId !== params.callerOrgId;
	if (!crossOrg) return { allowed: true, crossOrg: false };
	return {
		allowed:
			params.isPlatformPrincipal || params.isSystemServiceBinding === true,
		crossOrg: true,
	};
}

/**
 * Load the tedi targeted by a delete and enforce {@link resolveTediDeleteAccess}.
 *
 * Returns the TEDI's own row — every downstream cleanup step must key off
 * `tedi.organizationId`, never the caller's org, or a cross-org delete would
 * purge the wrong tenant's footprint.
 */
async function requireTediDeleteAccess(context: BaseContext, tediId: string) {
	const callerOrgId = requireOrganizationId(context);
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}

	const { allowed, crossOrg } = resolveTediDeleteAccess({
		callerOrgId,
		tediOrgId: tedi.organizationId,
		isPlatformPrincipal: isPlatformPrincipal(context),
		isSystemServiceBinding:
			context.authType === "service-binding" && callerOrgId === "system",
	});

	if (!allowed) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}

	if (crossOrg) {
		console.log(
			`[Auth] Cross-org tedi delete: actor=${context.user?.sub ?? context.tediId ?? context.authType} tedi=${tediId} (org=${tedi.organizationId}, caller-org=${callerOrgId})`,
		);
	}

	return tedi;
}

/**
 * Retire a tedi.
 *
 * `DELETE /tedis/{tediId}` deliberately does not delete the row. Every
 * tediId-scoped table is `ON DELETE CASCADE`, so the D1 delete used to destroy
 * memory_facts, tedi_rationale_records, tedi_artifacts, tedi_runtime_events,
 * skill_entries/skill_runs, tedi_expertise, tedi_growth_snapshots and
 * tedi_entrustment_grants — the customer-owned cognitive state
 * that must survive the worker. Retiring stops the worker
 * (external identity purged, runtime archived, slug freed for a replacement)
 * while leaving that memory in D1, queryable by the retired tedi's id.
 *
 * The irreversible cascade still exists as `tedis.decommission` with
 * `hardPurge` + a matching `confirmSlug`, which is platform-admin-only.
 */
export const deleteTediProcedure = authedTedisOs.delete
	.use(withAuthorization("tedis:delete", "apps:delete"))
	.handler(async ({ input, context }) => {
		// A tedi is the durable worker asset — identity, memory, ledger.
		// Confirm the retirement in the OS; this server gate still checks
		// caller authority and tenant ownership for every caller.
		const tedi = await requireTediDeleteAccess(context, input.tediId);

		// Already retired — report it honestly instead of purging the external
		// identity a second time or restamping the retirement.
		if (tedi.retiredAt) {
			return {
				success: true as const,
				message: `Tedi "${tedi.name}" was already retired at ${tedi.retiredAt}`,
			};
		}

		// Clean up Descope identity + FGA relations + AIH MCP server. The worker
		// must stop being able to authenticate immediately; all three are
		// re-creatable, unlike its memory. Keyed on `tedi.organizationId` inside —
		// the tedi's own org, which is not necessarily the caller's on a
		// platform-admin cross-org retire.
		await purgeTediExternalIdentity(context, tedi);

		// The TEDI's org — NOT the caller's. On a cross-org retire the caller's org
		// is a different tenant, and stamping it here would file the offboarding
		// audit event against the wrong organization and leave the owning tenant's
		// audit trail with no record that its tedi was retired.
		const orgId = tedi.organizationId;

		const retiredAt = new Date().toISOString();
		const retired = await retireTedi(context.db, {
			tediId: input.tediId,
			retiredAt,
		});
		if (!retired) {
			// The CAS lost: another caller retired this tedi between the read above
			// and this write. Do not claim a retirement this request did not make.
			throw createError(
				ErrorCodes.CONFLICT,
				`Tedi "${tedi.name}" was retired concurrently by another request`,
			);
		}

		console.log(
			`[Tedis] Retired tedi: ${tedi.name} (${input.tediId}); memory retained, slug ${tedi.slug} released`,
		);

		// Emit audit event for tedi retirement.
		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: orgId,
			actorId,
			actorType,
			action: "tedi.retire",
			resourceType: "tedi",
			resourceId: input.tediId,
			metadata: {
				name: tedi.name,
				slug: tedi.slug,
				retiredAt: retired.retiredAt,
				retiredSlug: retired.retiredSlug,
				memoryRetained: true,
			},
		}).catch((err) => {
			console.error("[Tedis] Failed to emit audit event for tedi.retire:", err);
		});

		return {
			success: true as const,
			message: `Tedi "${tedi.name}" has been retired. Its memory, rationale, skills and artifacts are retained; a platform-admin hard purge is required to destroy them.`,
		};
	});

/**
 * Rotate a tedi's Descope access key.
 *
 * Step-up gated. The rotation returns a live credential for the worker's own
 * identity, so a hijacked owner session can mint itself a tedi's key and keep
 * acting as that worker long after the session is cut off.
 */
export const rotateAccessKeyProcedure = authedTedisOs.rotateAccessKey
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		requireStepUp(context, "Rotating a tedi access key");
		const masterKey = context.env.SECRETS_MASTER_KEY;

		if (!masterKey) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"SECRETS_MASTER_KEY is not configured",
			);
		}

		if (
			!context.env.DESCOPE_MANAGEMENT_KEY ||
			!context.env.DESCOPE_PROJECT_ID
		) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Descope management is not configured",
			);
		}

		if (!tedi.descopeUserId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This tedi does not have a Descope identity yet",
			);
		}

		const existingKeyIdSecret = await getTediSecret(
			context.db,
			tedi.id,
			"DESCOPE_ACCESS_KEY_ID",
		);
		let oldKeyId: string | undefined;
		if (existingKeyIdSecret) {
			oldKeyId = await decryptTediSecret(
				masterKey,
				tedi.id,
				existingKeyIdSecret.encryptedValue,
			);
		}

		const descopeClient = getManagementClient(context.env);
		const rotation = await rotateTediAccessKey(descopeClient, {
			slug: tedi.slug ?? tedi.id,
			descopeUserId: tedi.descopeUserId,
			oldKeyId,
			tediId: tedi.id,
		});

		await storeEncryptedTediSecret(
			masterKey,
			context,
			tedi.id,
			"DESCOPE_ACCESS_KEY",
			rotation.cleartext,
		);
		await storeEncryptedTediSecret(
			masterKey,
			context,
			tedi.id,
			"DESCOPE_ACCESS_KEY_ID",
			rotation.descopeKeyId,
		);

		let runtimeRefreshed = false;
		try {
			runtimeRefreshed = await refreshTediRuntimeSecrets(context, tedi);
		} catch (error) {
			console.warn(
				`[Tedis] Failed to refresh runtime after access key rotation for ${tedi.id}:`,
				error,
			);
			const provConfig = getProvisioningConfig(tedi, context.env);
			if (provConfig) {
				const p = invalidateConfig(provConfig).catch(() => {});
				if (context.waitUntil) context.waitUntil(p);
			}
		}

		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.auth.rotate_access_key",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: {
				descopeUserId: tedi.descopeUserId,
				descopeKeyId: rotation.descopeKeyId,
				oldKeyIdPresent: Boolean(oldKeyId),
				oldKeyDeactivated: rotation.oldKeyDeactivated,
				runtimeRefreshed,
			},
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.auth.rotate_access_key:",
				err,
			);
		});

		return {
			success: true,
			message: rotation.oldKeyDeactivated
				? "Descope access key rotated and runtime refreshed"
				: "Descope access key rotated; previous key id was unavailable for automatic deactivation",
			descopeKeyId: rotation.descopeKeyId,
			oldKeyDeactivated: rotation.oldKeyDeactivated,
			runtimeRefreshed,
		};
	});

// =============================================================================
// governance override
// =============================================================================

/**
 * Set (or clear) a per-tedi `governanceOverride` so a delegated CTO can flip
 * a tedi between gated and autonomous without mutating shared policy packs.
 *
 * Auth: a tedi administrator plus organization-scoped ownership of the target.
 * This lets a tenant operate its own delegation posture without granting it
 * cross-tenant platform authority. The target lookup remains scoped to the
 * caller's organization, and dispatch retains its independent risk gates.
 *
 * The change flows into `deriveRequiresApproval` immediately on the next
 * capability card assembly — no cache invalidation needed (the capability
 * cards are assembled per-turn from D1).
 *
 * An `audit_events` row is written and awaited so the governance change is
 * reliably persisted to the audit trail. (Fire-and-forget dropped events under
 * concurrent writes — the Worker tore down before the promise resolved.) A
 * transient write failure is logged but does not roll back the already-applied
 * governance change.
 */
export const updateTediGovernanceProcedure = authedTedisOs.updateGovernance
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		// Capture before-state for the audit trail.
		const before = tedi.governanceOverride ?? null;

		const override =
			input.requiresApproval === null
				? null
				: { requiresApproval: input.requiresApproval };

		const updated = await updateTedi(context.db, tedi.id, {
			governanceOverride: override,
		});

		if (!updated) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update tedi governance override",
			);
		}

		const newOverride = updated.governanceOverride ?? null;
		const effectiveRequiresApproval =
			typeof newOverride?.requiresApproval === "boolean"
				? newOverride.requiresApproval
				: true; // fail-safe: unknown → gated

		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: tedi.organizationId,
			actorId,
			actorType,
			action: "tedi.governance.updated",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: {
				before,
				after: newOverride,
				requiresApproval: effectiveRequiresApproval,
				autonomy: effectiveRequiresApproval ? "gated" : "autonomous",
			},
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.governance.updated:",
				err,
			);
		});

		console.log(
			`[Tedis] Governance override set for ${tedi.name} (${tedi.id}): requiresApproval=${effectiveRequiresApproval}`,
		);

		return {
			tediId: tedi.id,
			slug: tedi.slug,
			governanceOverride: newOverride,
			requiresApproval: effectiveRequiresApproval,
			autonomy: (effectiveRequiresApproval ? "gated" : "autonomous") as
				| "gated"
				| "autonomous",
		};
	});

// =============================================================================
// self-healing (repair)
// =============================================================================

/** Secrets that every tedi needs for runtime and browser access */
const REQUIRED_SECRETS: Array<{
	name: string;
	generate: () => string;
}> = [
	{
		name: TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME,
		generate: () => crypto.randomUUID(),
	},
	{ name: "CDP_SECRET", generate: () => crypto.randomUUID() },
];

export const repairTediProcedure = authedTedisOs.repair
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const masterKey = context.env.SECRETS_MASTER_KEY;

		if (!masterKey) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"SECRETS_MASTER_KEY is not configured — cannot repair secrets",
			);
		}

		const existingSecrets = await getAllTediSecrets(context.db, tedi.id);
		const existingNames = new Set(existingSecrets.map((s) => s.name));

		const repaired: string[] = [];
		const alreadyPresent: string[] = [];
		const errors: string[] = [];

		for (const { name, generate } of REQUIRED_SECRETS) {
			if (existingNames.has(name)) {
				alreadyPresent.push(name);
				continue;
			}
			try {
				await storeEncryptedTediSecret(
					masterKey,
					context,
					tedi.id,
					name,
					generate(),
				);
				repaired.push(name);
				console.log(
					`[Tedis] Repair: auto-generated ${name} for ${tedi.name} (${tedi.id})`,
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				errors.push(`${name}: ${msg}`);
				console.error(
					`[Tedis] Repair: failed to generate ${name} for ${tedi.id}:`,
					error,
				);
			}
		}

		if (context.env.DESCOPE_PROJECT_ID && context.env.DESCOPE_MANAGEMENT_KEY) {
			try {
				const org = await getOrganizationById(context.db, tedi.organizationId);
				if (!org?.descopeTenantId) {
					alreadyPresent.push("descope:tenant-unavailable");
				} else {
					const descopeClient = getManagementClient(context.env);
					const identity = await repairTediIdentity(descopeClient, {
						tediId: tedi.id,
						slug: tedi.slug ?? tedi.id,
						displayName: tedi.displayName ?? tedi.name,
						tenantId: org.descopeTenantId,
						descopeUserId: tedi.descopeUserId,
						roles: [TEDI_DEFAULT_ROLE],
					});

					if (
						identity.descopeUserId &&
						identity.descopeUserId !== tedi.descopeUserId
					) {
						await updateTedi(context.db, tedi.id, {
							descopeUserId: identity.descopeUserId,
						});
						repaired.push("descope:user-id");
					}

					for (const item of identity.changed) {
						repaired.push(`descope:${item}`);
					}
					for (const item of identity.alreadyPresent) {
						alreadyPresent.push(`descope:${item}`);
					}

					if (identity.cleartext) {
						await storeEncryptedTediSecret(
							masterKey,
							context,
							tedi.id,
							"DESCOPE_ACCESS_KEY",
							identity.cleartext,
						);
						repaired.push("DESCOPE_ACCESS_KEY");
					}
					if (identity.descopeKeyId) {
						await storeEncryptedTediSecret(
							masterKey,
							context,
							tedi.id,
							"DESCOPE_ACCESS_KEY_ID",
							identity.descopeKeyId,
						);
						repaired.push("DESCOPE_ACCESS_KEY_ID");
					}
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				errors.push(`descope: ${msg}`);
				console.error(
					`[Tedis] Repair: failed to reconcile Descope identity for ${tedi.id}:`,
					error,
				);
			}
		} else {
			alreadyPresent.push("descope:management-unavailable");
		}

		if (input.registerDescopeAih === true) {
			if (tedi.descopeMcpResourceId) {
				alreadyPresent.push("descope:mcp-server");
			} else if (
				!context.env.DESCOPE_PROJECT_ID ||
				!context.env.DESCOPE_MANAGEMENT_KEY
			) {
				errors.push("descope:mcp-server: management unavailable");
			} else if (context.env.ENVIRONMENT !== "production") {
				errors.push(
					`descope:mcp-server: skipped outside production (${context.env.ENVIRONMENT})`,
				);
			} else {
				try {
					await registerTediAihMcpServer(context, tedi);
					repaired.push("descope:mcp-server");
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					errors.push(`descope:mcp-server: ${msg}`);
					console.error(
						`[Tedis] Repair: failed to register AIH MCP server for ${tedi.id}:`,
						error,
					);
				}
			}
		}

		// Emit audit event
		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.repair",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: { repaired, alreadyPresent, errors },
		}).catch((err) => {
			console.error("[Tedis] Failed to emit audit event for tedi.repair:", err);
		});

		return { repaired, alreadyPresent, errors };
	});

// =============================================================================
// process logs
// =============================================================================

export const getLogsProcedure = authedTedisOs.getLogs
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Container process logs have been removed. Use Agent-runtime status, runtime events, or workstation diagnostics instead.",
		);
	});

// =============================================================================
// agent RUNTIME recovery
// =============================================================================

/**
 * Compute a fresh `isolate_agent_id` for a rebind.
 *
 * Convention: `{slug}-rebind-{epochMs}`. Guarantees the result differs from the
 * current value (guards the astronomically unlikely same-millisecond collision
 * by appending a short random suffix). Pure — no DB/auth — so it is unit
 * testable.
 */
export function computeRebindAgentId(args: {
	slug: string | null;
	id: string;
	currentIsolateAgentId: string | null;
	now?: number;
	randomSuffix?: () => string;
}): { isolateAgentId: string; previous: string } {
	const slugPart = args.slug ?? args.id;
	const previous = args.currentIsolateAgentId ?? slugPart;
	const epochMs = args.now ?? Date.now();
	let isolateAgentId = `${slugPart}-rebind-${epochMs}`;
	if (isolateAgentId === previous) {
		const suffix = (
			args.randomSuffix ?? (() => crypto.randomUUID().slice(0, 8))
		)();
		isolateAgentId = `${slugPart}-rebind-${epochMs}-${suffix}`;
	}
	return { isolateAgentId, previous };
}

/**
 * Assert the caller holds platform-admin authority or is a trusted service
 * binding. `` lets user JWTs bypass scope checks (RBAC
 * path), so Agent-runtime recovery procedures must re-check explicitly.
 * Fail-closed for ordinary org users.
 */
export function assertPlatformAdminOrServiceBinding(
	context: BaseContext,
): void {
	const isTrustedServiceBinding = context.authType === "service-binding";
	if (!isTrustedServiceBinding && !isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Platform admin authority required (user role 'platform-admin' or API key scope 'platform:admin')",
		);
	}
}

/**
 * Rebind core — repoint a wedged Agent-runtime tedi's `isolate_agent_id` to a
 * fresh Durable Object name and invalidate the edge resolve cache.
 *
 * The Agent runtime Worker addresses a tedi's DO via
 * `idFromName(tedis.isolate_agent_id)`. When that DO wedges (e.g. a poison
 * queued job persisted in its SQLite, which survives deploys), repointing
 * `isolate_agent_id` to a brand-new name routes future requests to a pristine
 * empty DO.
 *
 * This explicitly redirects future requests. The previous DO's persisted native
 * sessions, receipts, schedules and recovery state remain in that object and are
 * not transferred to the new name. A rebind does not recover that native state.
 * Caller must already hold platform-admin authority or a trusted service binding.
 */
async function performRebindIsolate(
	context: BaseContext,
	tedi: Awaited<ReturnType<typeof requireTediAccess>>,
): Promise<{ isolateAgentId: string; previous: string }> {
	// Fresh-name convention: `{slug}-rebind-{epochMs}`. Date.now() is fine in
	// apps/api Workers.
	const { isolateAgentId, previous } = computeRebindAgentId({
		slug: tedi.slug,
		id: tedi.id,
		currentIsolateAgentId: tedi.isolateAgentId,
	});

	const updated = await updateTedi(context.db, tedi.id, { isolateAgentId });
	if (!updated) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Failed to rebind Agent-runtime tedi",
		);
	}

	console.log(
		`[Tedis] Rebound Agent-runtime tedi ${tedi.name} (${tedi.id}): ${previous} -> ${isolateAgentId}`,
	);

	const { actorId, actorType } = auditActor(context);
	await emitAuditEvent(context.db, {
		organizationId: tedi.organizationId,
		actorId,
		actorType,
		action: "tedi.rebind",
		resourceType: "tedi",
		resourceId: tedi.id,
		metadata: { previous, isolateAgentId },
	}).catch((err) => {
		console.error("[Tedis] Failed to emit audit event for tedi.rebind:", err);
	});

	// Fire-and-forget: invalidate the tedi edge Worker resolve cache so the
	// new isolate_agent_id takes effect immediately.
	const provConfig = getProvisioningConfig(updated, context.env);
	if (provConfig) {
		const p = invalidateConfig(provConfig).catch(() => {});
		if (context.waitUntil) context.waitUntil(p);
	}

	return { isolateAgentId, previous };
}

/**
 * Rebind a wedged Agent-runtime tedi to a fresh Durable Object name.
 *
 * Auth: platform-admin authority (user role `platform-admin`, or API-key/M2M
 * scope `platform:admin`) or a trusted service binding only. This is a
 * destructive-ish recovery operation, so it is fail-closed for normal users.
 */
export const rebindProcedure = authedTedisOs.rebind
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);

		const tedi = await requireTediAccess(context, input.tediId);

		const { isolateAgentId, previous } = await performRebindIsolate(
			context,
			tedi,
		);

		return { ok: true as const, isolateAgentId, previous };
	});

// =============================================================================
// Runtime admin transport
// =============================================================================

/** Retained decommission admin cleanup requests keep their original 10-second bound. */
const DECOMMISSION_ADMIN_TIMEOUT_MS = 10_000;

/**
 * Fetch the isolate DO admin endpoint through the tedi edge Worker.
 *
 * Reachability: apps/api → `TEDI_SERVICE` service binding → apps/tedi edge
 * Worker → (isolate branch) forwards the raw request to apps/tedi-runtime. We
 * reuse `getProvisioningConfig`, which already carries the `TEDI_SERVICE`
 * fetcher + the canonical `{slug}.tedi.{domain}` workerUrl. Auth: the isolate
 * DO admin guard accepts `X-Tedix-Admin-Token == env.SECRETS_MASTER_KEY` (and
 * the service-binding trust shape the provisioning client already sets).
 */
export type AgentAdminFetchFailure =
	| "no_provisioning_config"
	| "secrets_master_key_unavailable"
	| "timeout"
	| "transport_failure";

export async function agentAdminFetch(
	context: BaseContext,
	tedi: { slug: string | null },
	path:
		| "/__admin/agent-diag"
		| "/__admin/pi-recovery"
		| "/__admin/dequeue"
		| "/__admin/schedules"
		| "/__admin/agent-memory/inspect"
		| "/__admin/agent-memory/delete-profile",
	options: {
		method: "GET" | "POST";
		body?: unknown;
		query?: Record<string, string | undefined>;
		timeoutMs: number;
	},
): Promise<
	| { ok: boolean; status: number; json: unknown }
	| { error: string; failure: AgentAdminFetchFailure }
> {
	const provConfig = getProvisioningConfig(tedi, context.env);
	if (!provConfig)
		return {
			error: "no_provisioning_config",
			failure: "no_provisioning_config",
		};

	const masterKey = context.env.SECRETS_MASTER_KEY;
	if (!masterKey)
		return {
			error: "secrets_master_key_unavailable",
			failure: "secrets_master_key_unavailable",
		};

	const url = new URL(`${provConfig.workerUrl.replace(/\/+$/, "")}${path}`);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Tedix-Admin-Token": masterKey,
	};
	if (provConfig.fetcher || provConfig.isDev) {
		headers["X-Service-Binding"] = "true";
	}
	if (provConfig.hostOverride) {
		headers["X-Tedix-Host"] = provConfig.hostOverride;
	}

	const fetchFn = provConfig.fetcher?.fetch.bind(provConfig.fetcher) ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await fetchFn(url.toString(), {
			method: options.method,
			headers,
			body:
				options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: controller.signal,
		});
		controller.signal.throwIfAborted();
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			json = null;
		}
		// Body parsing can swallow an abort; the original owned deadline still wins.
		controller.signal.throwIfAborted();
		return { ok: response.ok, status: response.status, json };
	} catch (error) {
		return {
			error: controller.signal.aborted
				? `timeout_after_${options.timeoutMs}ms`
				: error instanceof Error
					? error.message
					: String(error),
			failure: controller.signal.aborted ? "timeout" : "transport_failure",
		};
	} finally {
		clearTimeout(timeout);
	}
}

function requireSuccessfulAgentMemoryResponse(
	result: Awaited<ReturnType<typeof agentAdminFetch>>,
): Record<string, unknown> {
	if ("error" in result) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Agent Memory runtime unavailable: ${result.error}`,
		);
	}
	if (!result.ok || !result.json || typeof result.json !== "object") {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Agent Memory runtime returned status ${result.status}`,
		);
	}
	return result.json as Record<string, unknown>;
}

export const inspectAgentMemoryProcedure = authedTedisOs.inspectAgentMemory
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);
		const tedi = await requireTediDeleteAccess(context, input.tediId);
		return requireSuccessfulAgentMemoryResponse(
			await agentAdminFetch(context, tedi, "/__admin/agent-memory/inspect", {
				method: "GET",
				query: { sessionId: input.sessionId, query: input.query },
				timeoutMs: 30_000,
			}),
		) as {
			ok: true;
			sessionId: string;
			memories: Record<string, unknown>[];
			recall?: Record<string, unknown>;
		};
	});

// =============================================================================
// decommission / hard-purge
// =============================================================================

/** Outcome of the isolate DO armed-schedule cancellation (Stage 2). */
interface SchedulesStoppedResult {
	attempted: boolean;
	ok: boolean;
	canceledScheduleIds?: string[];
	detail?: string;
}

/** Manual residual step the operator must perform — no programmatic path. */
interface ResidualManualStep {
	step: string;
	reason: string;
	scope: string;
}

/** Structured body of a decommission/purge run (minus the caller-stamped id). */
interface TediDecommissionResult {
	decommissioned: boolean;
	schedulesStopped: SchedulesStoppedResult;
	purged: boolean;
	programmaticCleanups: TediCleanupResult[];
	residualManualSteps: ResidualManualStep[];
}

/**
 * Always-emitted audit payload for a decommission/purge run. `status: "failed"`
 * carries the partial stage outcomes captured up to the throwing stage so a
 * mid-orchestration destructive failure (e.g. identity teardown succeeded, then
 * the D1 delete threw) is never silently un-audited.
 */
interface TediDecommissionAudit {
	status: "completed" | "failed";
	/** Stage outcomes accumulated so far (complete on success, partial on failure). */
	result: TediDecommissionResult;
	/** The stage that threw, on `status: "failed"` only. */
	failedStage?: TediDecommissionStage;
	/** The thrown error's message, on `status: "failed"` only. */
	error?: string;
}

/** Ordered destructive stages, used to label a partial-failure audit. */
type TediDecommissionStage =
	| "decommission"
	| "stop_schedules"
	| "purge_external_identity"
	| "purge_agent_memory"
	| "d1_delete";

/**
 * Side-effecting dependencies of the decommission orchestration, injected so the
 * staged policy (decommission → stop-schedules → optional hard-purge) is unit
 * testable without a live D1/Descope/isolate-runtime context.
 */
interface TediDecommissionDeps {
	/** Stage 1: persist status='paused' + runtime_state='archived'. */
	decommission: () => Promise<boolean>;
	/** Whether this tedi has an isolate DO whose schedules can be cancelled. */
	isIsolateBody: boolean;
	/** Stage 2: invoke the isolate admin dequeue with cancelSchedules. */
	stopSchedules: () => Promise<SchedulesStoppedResult>;
	/** Stage 3: tear down the external identity footprint (Descope/FGA/AIH). */
	purgeExternalIdentity: () => Promise<TediCleanupResult[]>;
	/** Stage 3: delete the supplemental managed-memory profile. */
	purgeAgentMemoryProfile: () => Promise<TediCleanupResult>;
	/** Stage 3: delete the D1 tedis row (cascades tediId-scoped child rows). */
	deleteRow: () => Promise<void>;
	/**
	 * Write the audit record. Invoked exactly once per run — on success with the
	 * full result, and on a thrown failure with the partial stage outcomes — so a
	 * partial destructive teardown is always audited. Must not throw (fail-soft).
	 */
	emitAudit: (audit: TediDecommissionAudit) => void;
}

/**
 * Residual sub-cleanups that have no programmatic path today. We do not fake
 * them — the purge reports them so the operator (or a follow-up automation) can
 * complete the teardown with the scope each requires.
 */
function purgeResidualManualSteps(
	tediId: string,
	orgId: string,
	agentMemoryDeleted: boolean,
): ResidualManualStep[] {
	const steps: ResidualManualStep[] = [
		{
			// Verified against the runtime R2 writers: the runtime keys per-tedi data
			// under `${tediId}/...` directly (not a `tedis/` wrapper). Each prefix
			// below is an actual write path; following the old `tedis/${tediId}/*`
			// instruction would leave all of this data behind.
			step:
				`Delete R2 objects for this tedi in the bucket configured by the TEDI_STORAGE binding. The runtime writes per-tedi data under the bare \`${tediId}/\` key prefix — delete every object under these prefixes: ` +
				[
					`${tediId}/objects/*  (object store)`,
					`${tediId}/tedi_shell_workspace/*  (shell/think workspace spillover)`,
					`${tediId}/harness/runs/*  (redacted trace bundles)`,
					`${tediId}/artifacts/turn_summary/*  (turn-summary artifacts)`,
					`${tediId}/SOUL.md, ${tediId}/IDENTITY.md, ${tediId}/USER.md, ${tediId}/AGENTS.md, ${tediId}/TOOLS.md, ${tediId}/memory/*  (R2 identity fallback)`,
				].join("; ") +
				`. Browser captures are the one exception and use a \`tedis/\` prefix: delete tedis/${tediId}/browser-* AND, for any org that ran this tedi, orgs/<orgId>/tedis/${tediId}/browser-* (browser-captures / browser-sessions / browser-actions).`,
			reason:
				"No programmatic delete-by-prefix exists for the per-tedi storage namespace; the D1 cascade does not touch R2. Runtime R2 keys are `<tediId>/...`, not `tedis/<tediId>/...` — only browser captures use the `tedis/`/`orgs/` prefix.",
			scope:
				"Cloudflare R2 object write/delete on the configured TEDI_STORAGE bucket",
		},
		{
			step: `Delete the tedi's artifacts repository in the namespace configured by the ARTIFACTS binding (one repo named after the tedi UUID ${tediId})`,
			reason:
				"No programmatic per-tedi artifact-repo teardown exists; the git-backed repo (SOUL/IDENTITY/MEMORY, daily logs, skills) is independent of R2 and D1.",
			scope: "Cloudflare Workers/Artifacts namespace admin",
		},
	];
	if (!agentMemoryDeleted) {
		steps.push({
			step: `Delete this tedi's Cloudflare Agent Memory profile \`org:${orgId}:tedi:${tediId}\` from the runtime AGENT_MEMORY namespace`,
			reason:
				"The authenticated programmatic profile deletion failed; Agent Memory is external to D1 and R2, so the hard purge cannot erase it through either storage cascade.",
			scope: "Cloudflare Agent Memory profile delete (account-level binding)",
		});
	}
	return steps;
}

/**
 * Pure-ish staged orchestration for decommission and optional hard-purge.
 *
 * Stage 1 (always, reversible): decommission to status='paused' +
 * runtime_state='archived'.
 * Stage 2 (`stopSchedules`, default true): cancel the isolate DO's armed
 * schedules so its self-perpetuating maintenance alarms actually stop. Skipped
 * (reported, not failed) for container/legacy bodies that have no isolate DO.
 * Stage 3 (`hardPurge`, irreversible): requires `confirmSlug === slug`; runs the
 * external-identity teardown + D1 cascade delete and reports residual manual
 * steps for R2/artifacts.
 *
 * Throws (fail-closed) on a hard-purge confirmSlug mismatch and on a failed
 * Stage-1 write. All injected side effects come from `deps`.
 */
export async function orchestrateTediDecommission(args: {
	tediId: string;
	orgId: string;
	slug: string | null;
	input: { stopSchedules?: boolean; hardPurge?: boolean; confirmSlug?: string };
	deps: TediDecommissionDeps;
}): Promise<TediDecommissionResult> {
	const { tediId, orgId, slug, input, deps } = args;

	// Fail-closed before any mutation if a hard-purge is requested without a
	// matching slug confirmation.
	if (input.hardPurge && input.confirmSlug !== slug) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`hardPurge requires confirmSlug to exactly match the tedi slug "${slug ?? ""}"`,
		);
	}

	// Accumulate stage outcomes as we go so a mid-orchestration throw can still
	// be audited with the completed-vs-failed stages (blocking: audit on partial
	// failure). The audit fires exactly once — on success below, or in `catch`.
	const result: TediDecommissionResult = {
		decommissioned: false,
		schedulesStopped: { attempted: false, ok: true, detail: "not started" },
		purged: false,
		programmaticCleanups: [],
		residualManualSteps: [],
	};
	let stage: TediDecommissionStage = "decommission";

	try {
		// Stage 1 — decommission (reversible).
		result.decommissioned = await deps.decommission();
		if (!result.decommissioned) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to decommission tedi (status/runtime_state update returned no row)",
			);
		}

		// Stage 2 — stop the isolate DO's armed schedules.
		stage = "stop_schedules";
		const wantStopSchedules = input.stopSchedules ?? true;
		if (!wantStopSchedules) {
			result.schedulesStopped = {
				attempted: false,
				ok: true,
				detail: "not requested",
			};
		} else if (!deps.isIsolateBody) {
			result.schedulesStopped = {
				attempted: false,
				ok: true,
				detail:
					"skipped — container/legacy body has no isolate Durable Object schedules",
			};
		} else {
			result.schedulesStopped = await deps.stopSchedules();
		}

		// Stage 3 — hard purge (irreversible).
		if (input.hardPurge) {
			stage = "purge_external_identity";
			result.programmaticCleanups.push(...(await deps.purgeExternalIdentity()));
			stage = "purge_agent_memory";
			const agentMemoryCleanup = await deps.purgeAgentMemoryProfile();
			result.programmaticCleanups.push(agentMemoryCleanup);
			stage = "d1_delete";
			await deps.deleteRow();
			result.programmaticCleanups.push({
				step: "d1_cascade_delete",
				ok: true,
				detail:
					"deleted tedis row; FK ON DELETE CASCADE DESTROYED this worker's customer-owned cognitive state — memory_facts (and their memory_edges), tedi_expertise, knowledge_entries, skill_entries, skill_runs (and skill_run_artifacts), tedi_muscle_memory, tedi_rationale_records, tedi_artifacts, tedi_runtime_events, tedi_growth_snapshots, tedi_entrustment_grants and competency_observations — alongside tedi_secrets, tedi_session_states, tedi_objectives/tasks, tedi_email_* and every other tediId-scoped child row. This is irreversible and is NOT what `tedis.delete` does; that path retires the tedi and keeps all of the above.",
			});
			result.purged = true;
			result.residualManualSteps.push(
				...purgeResidualManualSteps(tediId, orgId, agentMemoryCleanup.ok),
			);
		}

		deps.emitAudit({ status: "completed", result });
		return result;
	} catch (err) {
		// Always audit the partial destructive outcome before re-throwing.
		deps.emitAudit({
			status: "failed",
			result,
			failedStage: stage,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

/**
 * Decommission (and optionally hard-purge) a tedi — the supported, audited,
 * platform-admin-gated encapsulation of the manual multi-system removal cascade
 * (D1 row + tedi_secrets + runtime events + sessions, isolate DO armed
 * schedules, Descope identity, FGA grants, AIH MCP server). R2/artifacts have no
 * programmatic path and are returned as residual manual steps.
 *
 * Auth: platform-admin authority (user role `platform-admin`, or API-key/M2M
 * scope `platform:admin`) or a trusted service binding only. Fail-closed for
 * ordinary org users. Safe by default: omitting `hardPurge` only decommissions.
 */
export const decommissionTediProcedure = authedTedisOs.decommission
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);

		// Decommission (hard purge) is the teardown half of offboarding, so it needs
		// the same cross-org reach as delete. It used `requireTediAccess`, whose only
		// cross-org escape hatch is `isPlatformAdmin(context.user)` — a user-JWT
		// role check. API-key/M2M automation and the `platform:admin` CTO tedi carry
		// scopes, not roles, so they passed the platform assertion on the line above
		// and were then 403'd here. `requireTediDeleteAccess` checks the principal
		// (`isPlatformPrincipal`) instead, and still refuses a `standard` tedi — its
		// service-binding transport confers no authority.
		const tedi = await requireTediDeleteAccess(context, input.tediId);
		const orgId = tedi.organizationId;
		const { actorId, actorType } = auditActor(context);

		const result = await orchestrateTediDecommission({
			tediId: tedi.id,
			orgId,
			slug: tedi.slug,
			input,
			deps: {
				decommission: async () => {
					const updated = await updateTedi(context.db, tedi.id, {
						status: "paused",
						runtimeState: "archived",
					});
					return Boolean(updated);
				},
				isIsolateBody: true,
				stopSchedules: async () => {
					const res = await agentAdminFetch(context, tedi, "/__admin/dequeue", {
						method: "POST",
						body: { cancelSchedules: true },
						timeoutMs: DECOMMISSION_ADMIN_TIMEOUT_MS,
					});
					if ("error" in res) {
						return { attempted: true, ok: false, detail: res.error };
					}
					const json = res.json as {
						canceledScheduleIds?: string[];
					} | null;
					return {
						attempted: true,
						ok: res.ok,
						canceledScheduleIds: json?.canceledScheduleIds ?? [],
						detail: res.ok
							? undefined
							: `dequeue returned status ${res.status}`,
					};
				},
				purgeExternalIdentity: () => purgeTediExternalIdentity(context, tedi),
				purgeAgentMemoryProfile: async () => {
					const res = await agentAdminFetch(
						context,
						tedi,
						"/__admin/agent-memory/delete-profile",
						{ method: "POST", timeoutMs: DECOMMISSION_ADMIN_TIMEOUT_MS },
					);
					if ("error" in res) {
						return {
							step: "agent_memory_profile_delete",
							ok: false,
							detail: res.error,
						};
					}
					const json = res.json as { profile?: string } | null;
					return {
						step: "agent_memory_profile_delete",
						ok: res.ok,
						detail: json?.profile ?? `runtime returned status ${res.status}`,
					};
				},
				deleteRow: () => deleteTedi(context.db, tedi.id),
				// Always-emit audit hook: fires on success and on a mid-orchestration
				// thrown failure (with the partial stage outcomes) before the throw
				// propagates. Fail-soft — never let audit I/O mask the real outcome.
				emitAudit: ({ status, result: outcome, failedStage, error }) => {
					emitAuditEvent(context.db, {
						organizationId: orgId,
						actorId,
						actorType,
						action: input.hardPurge ? "tedi.purge" : "tedi.decommission",
						resourceType: "tedi",
						resourceId: tedi.id,
						metadata: {
							name: tedi.name,
							slug: tedi.slug,
							status,
							...(failedStage ? { failedStage } : {}),
							...(error ? { error } : {}),
							stopSchedules: input.stopSchedules ?? true,
							schedulesStopped: outcome.schedulesStopped,
							hardPurge: Boolean(input.hardPurge),
							decommissioned: outcome.decommissioned,
							purged: outcome.purged,
							programmaticCleanups: outcome.programmaticCleanups,
							residualManualSteps: outcome.residualManualSteps,
						},
					}).catch((err) => {
						console.error(
							`[Tedis] Failed to emit audit event for tedi.${input.hardPurge ? "purge" : "decommission"}:`,
							err,
						);
					});
				},
			},
		});

		console.log(
			`[Tedis] ${input.hardPurge ? "Hard-purged" : "Decommissioned"} tedi ${tedi.name} (${tedi.id})`,
		);

		return {
			ok: true as const,
			tediId: tedi.id,
			slug: tedi.slug,
			...result,
		};
	});
