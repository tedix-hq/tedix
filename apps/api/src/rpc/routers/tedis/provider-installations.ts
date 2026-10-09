import { providerWidgetTediSelection } from "@tedix/api-contract/schemas/embedded-widget-access";
import { resolveEmbeddedTediSelection } from "../../../services/embedded-tedi-selection";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { RouterContractClient } from "@tedix/api-contract/types";
import type { tedisContract } from "@tedix/api-contract/contracts/tedis";
import type { BaseContext } from "../../orpc";
import {
	evaluateEmbeddedWidgetAccess,
	readEmbeddedTurnQuota,
	readEmbeddedWidgetAccess,
} from "@tedix/api-contract/schemas/embedded-widget-access";
import { getApiKeyById } from "@tedix/db/queries/api-keys";
import { ORPCError } from "@orpc/server";
import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import { getPortableWebMcpToolAdmissions } from "@tedix/db/queries/app-gating";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import {
	countSponsoredCapacityTransfers,
	getInferenceCapacityDailyOverview,
	transferSponsoredCapacity,
} from "@tedix/db/queries/billing/capacity-allocations";
import { getBillingBalanceSnapshot } from "@tedix/db/queries/billing/credits";
import { getEffectiveInferencePolicies } from "@tedix/db/queries/billing/inference-policies";
import { usesMonthlyInferenceCapacity } from "@tedix/db/queries/billing/reservations";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { trackWidgetEvent } from "@tedix/db/queries/analytics";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import {
	getProviderInstallation,
	createProviderInstallationIfAbsent,
	getProviderInstallationById,
	listProviderPortableWebMcpConfigurations,
	publishProviderPortableWebMcpProfile,
	provisionProviderInstallation,
	resolveActiveProviderInstallation,
	setProviderInstallationPaused,
} from "@tedix/db/queries/provider-installations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { withExactApiKeyScope } from "../../orpc";
import { resolveStripeEnvironment } from "../../../lib/stripe-environment";
import { issueEmbeddedSession } from "./gateway";
import {
	admitPortableWebMcpProfile,
	publicPortableWebMcpInputSchema,
	resolveProviderRouteAssertion,
} from "../../../services/portable-webmcp-profile";
import { AUTHZ, authedTedisOs, createError, ErrorCodes } from "./helpers";

const exchangeEmbeddedInstallation =
	authedTedisOs.createEmbeddedProviderSession.use(
		withExactApiKeyScope("embedded:session"),
	);

interface SponsoredCapacityPolicy {
	budgetRevision: number;
	maxTransfersPerBudgetDay: number;
	lowWatermarkTokens: number;
	lowWatermarkSpendMicros: number;
	transferTokens: number;
	transferSpendMicros: number;
}

function sponsoredCapacityPolicy(
	provenance: Record<string, unknown> | null | undefined,
): SponsoredCapacityPolicy | null {
	const value = provenance?.sponsoredCapacity;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const policy = value as Record<string, unknown>;
	if (policy.enabled !== true) return null;
	const budgetRevision = policy.budgetRevision ?? 1;
	const maxTransfersPerBudgetDay = policy.maxTransfersPerBudgetDay ?? 1;
	const integers = [
		budgetRevision,
		maxTransfersPerBudgetDay,
		policy.lowWatermarkTokens,
		policy.lowWatermarkSpendMicros,
		policy.transferTokens,
		policy.transferSpendMicros,
	];
	if (
		!integers.every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
	)
		throw new Error(
			"Provider installation sponsored-capacity policy is invalid",
		);
	if (
		Number(budgetRevision) < 1 ||
		Number(maxTransfersPerBudgetDay) < 1 ||
		(Number(policy.transferTokens) === 0 &&
			Number(policy.transferSpendMicros) === 0)
	)
		throw new Error(
			"Provider installation sponsored-capacity transfer is empty",
		);
	return {
		budgetRevision: Number(budgetRevision),
		maxTransfersPerBudgetDay: Number(maxTransfersPerBudgetDay),
		lowWatermarkTokens: Number(policy.lowWatermarkTokens),
		lowWatermarkSpendMicros: Number(policy.lowWatermarkSpendMicros),
		transferTokens: Number(policy.transferTokens),
		transferSpendMicros: Number(policy.transferSpendMicros),
	};
}

async function replenishSponsoredCapacity(
	context: Parameters<typeof issueEmbeddedSession>[0],
	installation: Awaited<
		ReturnType<typeof resolveActiveProviderInstallation>
	> & {},
): Promise<void> {
	const rawPolicy = installation.provenance?.sponsoredCapacity;
	if (
		!rawPolicy ||
		typeof rawPolicy !== "object" ||
		Array.isArray(rawPolicy) ||
		(rawPolicy as Record<string, unknown>).enabled !== true
	)
		return;
	const now = new Date().toISOString();
	const stripeEnvironment = resolveStripeEnvironment(context.env);
	const balance = await getBillingBalanceSnapshot(
		context.db,
		installation.customerOrganizationId,
		now,
	);
	// An existing customer may embed a provider's tedi while funding its own
	// monthly inference. Skip even stale sponsorship policies before parsing
	// them, so they cannot consume provider funds or block a session.
	if (
		balance &&
		usesMonthlyInferenceCapacity({
			status: balance.status,
			allowOverage: balance.allowOverage,
			billingMode: balance.billingMode,
			isSponsoredCustomer: balance.isSponsoredCustomer,
			stripeCustomerId:
				balance.stripeEnvironment === stripeEnvironment
					? balance.stripeCustomerId
					: null,
		})
	)
		return;
	const policy = sponsoredCapacityPolicy(installation.provenance);
	if (!policy) return;
	const [overview, sponsorPolicies] = await Promise.all([
		getInferenceCapacityDailyOverview(context.db, {
			organizationId: installation.customerOrganizationId,
			stripeEnvironment,
			now,
		}),
		getEffectiveInferencePolicies(
			context.db,
			installation.providerOrganizationId,
		),
	]);
	if (!sponsorPolicies)
		throw new Error("Provider billing account is unavailable");
	const remainingTokens = overview.allocatedTokens - overview.usedTokens;
	const remainingSpendMicros =
		overview.allocatedSpendMicros - overview.usedSpendMicros;
	if (
		remainingTokens > 0 &&
		remainingSpendMicros > 0 &&
		remainingTokens >= policy.lowWatermarkTokens &&
		remainingSpendMicros >= policy.lowWatermarkSpendMicros
	)
		return;
	const expiresAt = new Date(
		Date.parse(`${overview.budgetDay}T00:00:00.000Z`) + 86_400_000,
	).toISOString();
	const priorTransfers = await countSponsoredCapacityTransfers(context.db, {
		customerOrganizationId: installation.customerOrganizationId,
		providerInstallationId: installation.id,
		budgetRevision: policy.budgetRevision,
		budgetDay: overview.budgetDay,
		stripeEnvironment,
	});
	// Watermarks trigger an optional refill, not session admission. Existing
	// credit remains usable; runtime reservations enforce each turn's cost.
	if (priorTransfers >= policy.maxTransfersPerBudgetDay) {
		const refreshed = await getInferenceCapacityDailyOverview(context.db, {
			organizationId: installation.customerOrganizationId,
			stripeEnvironment,
			now: new Date().toISOString(),
		});
		if (
			refreshed.allocatedTokens - refreshed.usedTokens > 0 &&
			refreshed.allocatedSpendMicros - refreshed.usedSpendMicros > 0
		)
			return;
		throw new Error("Provider-sponsored inference allowance is exhausted");
	}
	try {
		await transferSponsoredCapacity(context.db, {
			transferId: `${installation.id}:${overview.budgetDay}:r${policy.budgetRevision}:${priorTransfers + 1}`,
			sponsorOrganizationId: installation.providerOrganizationId,
			customerOrganizationId: installation.customerOrganizationId,
			providerInstallationId: installation.id,
			budgetRevision: policy.budgetRevision,
			budgetDay: overview.budgetDay,
			tokenAmount: policy.transferTokens,
			spendAmountMicros: policy.transferSpendMicros,
			customerLowWatermarkTokens: policy.lowWatermarkTokens,
			customerLowWatermarkSpendMicros: policy.lowWatermarkSpendMicros,
			sponsorDailyTokenLimit:
				sponsorPolicies.organization.dailyTokenLimit ?? null,
			sponsorDailySpendLimitMicros:
				sponsorPolicies.organization.dailySpendLimitMicros ?? null,
			stripeEnvironment,
			expiresAt,
			createdAt: now,
		});
	} catch (error) {
		console.error("Embedded sponsored-capacity transfer failed", {
			installationId: installation.id,
			error: error instanceof Error ? error.message : String(error),
		});
		const refreshed = await getInferenceCapacityDailyOverview(context.db, {
			organizationId: installation.customerOrganizationId,
			stripeEnvironment,
			now: new Date().toISOString(),
		});
		if (
			refreshed.allocatedTokens - refreshed.usedTokens > 0 &&
			refreshed.allocatedSpendMicros - refreshed.usedSpendMicros > 0
		)
			return;
		throw error;
	}
}

// Read-only host bootstrap: no session, capacity transfer, or usage event.
export const getEmbeddedProviderAvailabilityProcedure =
	authedTedisOs.getEmbeddedProviderAvailability
		.use(withExactApiKeyScope("embedded:session"))
		.handler(async ({ input, context }) => {
			if (!context.organizationId || !context.apiKey?.id)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Authenticated provider identity is required",
				);
			const installation = await resolveActiveProviderInstallation(context.db, {
				providerOrganizationId: context.organizationId,
				providerApiKeyId: context.apiKey.id,
				externalTenantId: input.externalTenantId,
			});
			if (!installation) return { enabled: false };
			return {
				enabled: evaluateEmbeddedWidgetAccess(
					{
						status: installation.status,
						...readEmbeddedWidgetAccess(installation.provenance),
					},
					input.hostUserId,
				).allowed,
			};
		});

export const createEmbeddedProviderSessionProcedure =
	exchangeEmbeddedInstallation.handler(async ({ input, context }) => {
		const providerOrganizationId = context.organizationId;
		const providerApiKeyId = context.apiKey?.id;
		if (!providerOrganizationId || !providerApiKeyId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Authenticated provider installation identity is required",
			);
		}
		const installation = await resolveActiveProviderInstallation(context.db, {
			providerOrganizationId,
			providerApiKeyId,
			externalTenantId: input.externalTenantId,
		});
		if (!installation) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"No active embedded Tedi installation exists for this provider tenant",
			);
		}
		// This is persisted provider-installation policy, never a browser/session
		// request toggle. Existing hosts keep their current session contract until
		// their authenticated backend is migrated to route assertions.
		if (
			installation.provenance?.portableRouteAssertionRequired === true &&
			!input.portableRouteAssertion
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This installation requires a provider route assertion",
			);

		const access = evaluateEmbeddedWidgetAccess(
			{
				status: installation.status,
				...readEmbeddedWidgetAccess(installation.provenance),
			},
			input.hostUserId,
		);
		if (!access.allowed)
			throw createError(
				ErrorCodes.FORBIDDEN,
				`Embedded assistant access denied: ${access.reason}`,
			);

		const organizationId = installation.customerOrganizationId;
		const { tedi, tediSelection } = await resolveEmbeddedTediSelection(
			context,
			organizationId,
			providerWidgetTediSelection(installation),
			input.selectedTediId,
		);

		if (tedi.organizationId !== organizationId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Worker does not belong to this installation organization",
			);

		const [workspace, providerOrganization] = await Promise.all([
			getOsWorkspace(context.db, {
				organizationId: installation.customerOrganizationId,
				workspaceId: installation.primaryWorkspaceId,
			}),
			getOrganizationById(context.db, installation.providerOrganizationId),
		]);
		const webMcpProfile =
			(
				installation.provenance?.portableWebMcp as
					| { profile?: PortableWebMcpProfile }
					| undefined
			)?.profile ?? providerOrganization?.metadata?.tediWidget?.webMcpProfile;
		const portableAdmission = admitPortableWebMcpProfile({
			profile: webMcpProfile,
			hostTenantNamespace: installation.hostTenantNamespace,
			catalogTools: webMcpProfile
				? await getPortableWebMcpToolAdmissions(
						context.db,
						installation.providerAppId,
					)
				: [],
		});
		const rejectedPortableTools = portableAdmission.diagnostics.filter(
			(item) => item.status === "rejected",
		);
		const selectedPortableRoute = input.portableRouteAssertion
			? resolveProviderRouteAssertion(
					portableAdmission.profile,
					input.portableRouteAssertion,
				)
			: null;
		if (input.portableRouteAssertion && !selectedPortableRoute)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Provider route assertion does not match an admitted route and target",
			);
		if (rejectedPortableTools.length > 0) {
			console.error("Portable WebMCP profile tools were rejected", {
				installationId: installation.id,
				rejected: rejectedPortableTools.map((item) => ({
					callable: item.callable,
					reason: item.reason,
				})),
			});
		}
		if (!workspace || workspace.status !== "active") {
			throw new ORPCError(ErrorCodes.SERVICE_UNAVAILABLE, {
				message: "Embedded Tedi installation workspace is unavailable",
				data: { reason: "workspace_unavailable", retryable: true },
			});
		}
		if (!tedi || tedi.status !== "active" || tedi.retiredAt) {
			throw new ORPCError(ErrorCodes.SERVICE_UNAVAILABLE, {
				message: "Embedded Tedi installation worker is unavailable",
				data: { reason: "worker_unavailable", retryable: true },
			});
		}
		try {
			await replenishSponsoredCapacity(context, installation);
		} catch (error) {
			console.error("Embedded sponsored-capacity replenishment failed", {
				installationId: installation.id,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new ORPCError(ErrorCodes.SERVICE_UNAVAILABLE, {
				message: "Provider-sponsored inference capacity is unavailable",
				data: { reason: "capacity_unavailable", retryable: true },
			});
		}

		const session = await issueEmbeddedSession(context, tedi, {
			allowedOrigin: installation.allowedOrigin,
			conversationId: input.conversationId,
			hostOrganizationId: installation.externalTenantId,
			hostOrganizationLabel: input.hostOrganizationLabel,
			hostRole: input.hostRole,
			hostTenantArgument: installation.hostTenantArgument,
			hostTenantNamespace: installation.hostTenantNamespace,
			hostUserId: input.hostUserId,
			hostUserLabel: input.hostUserLabel,
			providerAppId: installation.providerAppId,
			providerInstallationId: installation.id,
			webMcpProfile:
				selectedPortableRoute?.profile ?? portableAdmission.profile,
			portableRoute: selectedPortableRoute?.signedRoute,
			hostDelegation: input.hostDelegation,
			turnQuota: readEmbeddedTurnQuota(installation.provenance),
		});
		try {
			await trackWidgetEvent(context.db, {
				id: crypto.randomUUID(),
				organizationId: installation.customerOrganizationId,
				appId: installation.providerAppId,
				sessionId: session.sessionKey,
				eventType: "embedded_session_started",
				displayMode: "inline",
				metadata: {
					installationId: installation.id,
					tediId: tedi.id,
					hostOrganizationId: installation.externalTenantId,
					hostOrganizationLabel: input.hostOrganizationLabel ?? null,
					hostUserId: input.hostUserId,
					hostUserLabel: input.hostUserLabel ?? null,
					hostRole: input.hostRole ?? null,
					origin: installation.allowedOrigin,
				},
			});
		} catch (error) {
			console.error("Embedded session activity tracking failed", {
				installationId: installation.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return {
			installationId: installation.id,
			tediSelection,
			analyticsEnabled:
				providerOrganization?.metadata?.tediWidget?.analyticsEnabled === true,
			workspaceId: installation.primaryWorkspaceId,
			...session,
		};
	});

export const validatePortableWebMcpProfileProcedure =
	authedTedisOs.validatePortableWebMcpProfile
		.use(AUTHZ.appsRead)
		.handler(async ({ input, context }) => {
			if (!context.organizationId) {
				throw createError(ErrorCodes.UNAUTHORIZED, "No organization");
			}
			const installation = await getProviderInstallationById(context.db, {
				organizationId: context.organizationId,
				installationId: input.installationId,
			});
			if (!installation) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			}
			const admission = admitPortableWebMcpProfile({
				profile: input.profile,
				hostTenantNamespace: installation.hostTenantNamespace,
				catalogTools: await getPortableWebMcpToolAdmissions(
					context.db,
					installation.providerAppId,
				),
			});
			return {
				valid: admission.diagnostics.every(
					(diagnostic) => diagnostic.status === "admitted",
				),
				admittedCallables: admission.diagnostics.flatMap((diagnostic) =>
					diagnostic.status === "admitted" ? [diagnostic.callable] : [],
				),
				diagnostics: admission.diagnostics,
			};
		});

export const listPortableWebMcpConfigurationsProcedure =
	authedTedisOs.listPortableWebMcpConfigurations
		.use(AUTHZ.appsRead)
		.handler(async ({ context }) => {
			if (!context.organizationId)
				throw createError(ErrorCodes.UNAUTHORIZED, "No organization");
			const configurations = await listProviderPortableWebMcpConfigurations(
				context.db,
				context.organizationId,
			);
			return await Promise.all(
				configurations.map(async (configuration) => {
					const catalogTools = await getPortableWebMcpToolAdmissions(
						context.db,
						configuration.providerAppId,
					);
					const admission = admitPortableWebMcpProfile({
						profile: configuration.profile ?? undefined,
						hostTenantNamespace: configuration.hostTenantNamespace,
						catalogTools,
					});
					const rejected = admission.diagnostics.filter(
						(item) => item.status === "rejected",
					);
					const admittedToolCount =
						admission.diagnostics.length - rejected.length;
					return {
						...configuration,
						activation: {
							status: !configuration.profile
								? ("unconfigured" as const)
								: rejected.length > 0 || !admission.profile
									? ("blocked" as const)
									: ("ready" as const),
							routeCount: admission.profile?.routes.length ?? 0,
							admittedToolCount,
							rejectedToolCount: rejected.length,
							reasonCodes: !configuration.profile
								? ["profile_missing" as const]
								: [...new Set(rejected.flatMap((item) => item.reason ?? []))],
						},
						eligibleTools: catalogTools
							.filter(
								(tool) =>
									tool.writeCapability === "read" ||
									tool.writeCapability === "write",
							)
							.map((tool) => ({
								toolId: tool.toolId,
								callable: `${configuration.hostTenantNamespace}.${tool.toolId}`,
								title: tool.title,
								description: tool.description,
								inputSchema: publicPortableWebMcpInputSchema(
									tool.inputSchema,
									configuration.hostTenantArgument,
								),
								writeCapability: tool.writeCapability as "read" | "write",
							})),
					};
				}),
			);
		});

export const publishPortableWebMcpProfileProcedure =
	authedTedisOs.publishPortableWebMcpProfile
		.use(AUTHZ.appsWrite)
		.handler(async ({ input, context }) => {
			if (!context.organizationId)
				throw createError(ErrorCodes.UNAUTHORIZED, "No organization");
			const installation = await getProviderInstallationById(context.db, {
				organizationId: context.organizationId,
				installationId: input.installationId,
			});
			if (!installation)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			const admission = admitPortableWebMcpProfile({
				profile: input.profile,
				hostTenantNamespace: installation.hostTenantNamespace,
				catalogTools: await getPortableWebMcpToolAdmissions(
					context.db,
					installation.providerAppId,
				),
			});
			if (admission.diagnostics.some((item) => item.status === "rejected"))
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Portable WebMCP profile contains tools that are not admitted",
				);
			const result = await publishProviderPortableWebMcpProfile(context.db, {
				providerOrganizationId: context.organizationId,
				installationId: input.installationId,
				expectedRevision: input.expectedRevision,
				profile: input.profile,
				changeSummary: input.changeSummary,
				publishedBy:
					context.user?.sub ??
					context.apiKey?.id ??
					context.authType ??
					"provider",
			});
			if (result === "conflict")
				throw createError(ErrorCodes.CONFLICT, "Profile revision changed");
			if (!result)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			// Publishing a tool is what a provider does to make it usable, so the
			// gateway converges here. Without this, admission and mounting drift
			// apart and a ticked, published tool is silently uncallable.
			const { ensureProviderInstallationGateway } =
				await import("../../../services/provider-installation-gateway");
			await ensureProviderInstallationGateway(context, installation);
			return {
				installationId: result.installationId,
				revision: result.revision,
				profile: result.profile!,
			};
		});

type ProvisionInstallationInput = Omit<
	Parameters<
		RouterContractClient<typeof tedisContract>["provisionProviderInstallation"]
	>[0],
	"provenance"
> & { provenance?: Record<string, JsonValue> };

export async function validateProviderInstallationIdentity(
	context: BaseContext,
	input: Pick<
		ProvisionInstallationInput,
		"providerOrganizationId" | "providerAppId" | "providerApiKeyId"
	>,
) {
	const [providerApp, providerApiKey] = await Promise.all([
		getAppByIdForOrganization(
			context.db,
			input.providerAppId,
			input.providerOrganizationId,
		),
		getApiKeyById(context.db, input.providerApiKeyId),
	]);
	if (!providerApp) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Provider app is not owned by provider organization",
		);
	}
	if (
		!providerApiKey ||
		providerApiKey.organizationId !== input.providerOrganizationId ||
		providerApiKey.status !== "active" ||
		providerApiKey.environment !== "live" ||
		(providerApiKey.expiresAt !== null &&
			providerApiKey.expiresAt !== undefined &&
			new Date(providerApiKey.expiresAt).getTime() <= Date.now()) ||
		!providerApiKey.scopes?.includes("embedded:session") ||
		providerApiKey.scopes.includes("*") ||
		providerApiKey.scopes.includes("platform:admin")
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Provider API key must be active, unexpired, live, provider-owned, and exactly eligible for embedded session exchange",
		);
	}
}

/** Internal orchestration; callers establish either platform or protected provider authority. */
export async function provisionInstallation(
	context: BaseContext,
	input: ProvisionInstallationInput,
	providerAuthorized = false,
) {
	await validateProviderInstallationIdentity(context, input);
	let resources;
	if (input.customer) {
		const existing = await getProviderInstallation(context.db, input);
		if (existing) {
			const { ensureProviderInstallationGateway } =
				await import("../../../services/provider-installation-gateway");
			await ensureProviderInstallationGateway(context, existing);
			return existing;
		}
		const { ensureProviderCustomer, ensureProviderCustomerForProvider } =
			await import("../../../services/provider-customer-provisioning");
		resources = await (
			providerAuthorized
				? ensureProviderCustomerForProvider
				: ensureProviderCustomer
		)(context, {
			...input,
			customer: input.customer,
		});
	} else {
		resources = {
			customerOrganizationId: input.customerOrganizationId!,
			primaryWorkspaceId: input.primaryWorkspaceId!,
			primaryTediId: input.primaryTediId!,
		};
	}
	const [customerOrganization, workspace, tedi] = await Promise.all([
		getOrganizationById(context.db, resources.customerOrganizationId),
		getOsWorkspace(context.db, {
			organizationId: resources.customerOrganizationId,
			workspaceId: resources.primaryWorkspaceId,
		}),
		getTediByIdForOrganization(
			context.db,
			resources.primaryTediId,
			resources.customerOrganizationId,
		),
	]);

	if (!customerOrganization) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Customer organization does not exist",
		);
	}
	if (!workspace || workspace.status !== "active") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Primary workspace is not active in customer organization",
		);
	}
	if (!tedi || tedi.status !== "active" || tedi.retiredAt) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Primary Tedi is not active in customer organization",
		);
	}

	const installation = await (
		input.customer
			? createProviderInstallationIfAbsent
			: provisionProviderInstallation
	)(context.db, {
		id: crypto.randomUUID(),
		...input,
		...resources,
		provisionedBy: principalLabel(context),
		provenance: input.customer
			? {
					...input.provenance,
					sponsoredCapacity: input.customer.sponsoredCapacity,
				}
			: (input.provenance ?? null),
	});
	const { ensureProviderInstallationGateway } =
		await import("../../../services/provider-installation-gateway");
	await ensureProviderInstallationGateway(context, installation);
	return installation;
}

export const provisionProviderInstallationProcedure =
	authedTedisOs.provisionProviderInstallation
		.use(AUTHZ.platformAdmin)
		.handler(({ input, context }) => provisionInstallation(context, input));

export const getProviderInstallationProcedure =
	authedTedisOs.getProviderInstallation
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			const row = await getProviderInstallation(context.db, input);
			if (!row)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			return row;
		});

export const setProviderInstallationPausedProcedure =
	authedTedisOs.setProviderInstallationPaused
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			if (
				!(await getProviderInstallationById(context.db, {
					organizationId: input.providerOrganizationId,
					installationId: input.installationId,
				}))
			) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			}
			const row = await setProviderInstallationPaused(context.db, {
				organizationId: input.providerOrganizationId,
				installationId: input.installationId,
				paused: input.paused,
			});
			if (!row)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			return row;
		});

function principalLabel(context: {
	user?: { sub?: string };
	apiKey?: { id: string };
	authType?: string;
}): string {
	if (context.user?.sub) return `user:${context.user.sub}`;
	if (context.apiKey?.id) return `api_key:${context.apiKey.id}`;
	return `principal:${context.authType ?? "unknown"}`;
}
