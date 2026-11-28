import { baseErrorConstructors } from "@tedix/api-contract/errors";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
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
import { getApiKeyAuthorityById } from "@tedix/db/queries/api-keys";
import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import { getPortableWebMcpToolAdmissions } from "@tedix/db/queries/app-gating";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
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

// Read-only host bootstrap: no session or usage event.
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
			throw baseErrorConstructors.SERVICE_UNAVAILABLE({
				message: "Embedded Tedi installation workspace is unavailable",
				data: { reason: "workspace_unavailable", retryable: true },
			});
		}
		if (!tedi || tedi.status !== "active" || tedi.retiredAt) {
			throw baseErrorConstructors.SERVICE_UNAVAILABLE({
				message: "Embedded Tedi installation worker is unavailable",
				data: { reason: "worker_unavailable", retryable: true },
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
				exception: safeExceptionTopology(error),
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
		getApiKeyAuthorityById(context.db, input.providerApiKeyId),
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
		provenance: input.provenance ?? null,
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
