import type { CreateTediInput } from "@tedix/api-contract/schemas/tedi";
import { getManagementClient } from "@tedix/auth/client";
import { createTediIdentity } from "@tedix/auth/tedi-identity";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import { isPlatformPrincipal } from "@tedix/auth/types";
import type { RuntimeEntitlement } from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import {
	getSystemDefaultRuntimeProfile,
	getSystemDefaultWorkspaceTemplateSet,
	listPolicyPacks,
} from "@tedix/db/queries/control-plane/definitions";
import { listPolicyPackRevisions } from "@tedix/db/queries/control-plane/revisions";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { bindPrincipalIdentity } from "@tedix/db/queries/principal-identities";
import {
	createTedi,
	getTediBySlug,
	getTedisByOrganization,
	updateTedi,
} from "@tedix/db/queries/tedis";
import { invalidateKernelContextCache } from "../../../kernel/context-cache";
import { TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME } from "@tedix/db/schema/tedi-secrets";
import type { McpCapabilityProfile } from "@tedix/db/schema/tedis";
import { toJsonRecord } from "@tedix/db/utils/json";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	withAuthorization,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	generateSlug,
	requireOrganizationId,
	toTediDto,
} from "./helpers";
import {
	storeEncryptedTediSecret,
	materializeManagedAppAssignments,
	registerTediAihMcpServer,
} from "./identity-provisioning";

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

	invalidateKernelContextCache(context, tedi.organizationId, "tedi.created");
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
