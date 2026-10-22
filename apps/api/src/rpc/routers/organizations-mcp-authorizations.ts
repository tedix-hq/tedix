/** Human MCP authorizations, multi-org consent and CLI workspace bootstrap procedures. */
import { createDbSession } from "@tedix/db/client";
import { getOrganizationAggregatorGateways } from "@tedix/db/queries/organization-members";
import { getOrganizationBySlug } from "@tedix/db/queries/organizations";
import {
	listHumanMcpAuthorizations,
	disableHumanMcpAuthorization,
	revokeHumanMcpConsent,
	stageHumanMcpConsent,
	verifyHumanMcpGrant,
} from "../../lib/mcp-grant";
import {
	createError,
	ErrorCodes,
	withAuthorization,
	withServiceAuth,
} from "../orpc";
import { gatewayUrl } from "./organizations-base";
import { organizationsOs, authedOrganizationsOs } from "./organizations-base";

export const listMcpAuthorizationsContract =
	authedOrganizationsOs.listMcpAuthorizations
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Lists only the authenticated human subject's Connect authorizations.",
				},
				"mcp:apps.read",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub)
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			return listHumanMcpAuthorizations(
				context.db,
				context.env,
				context.user.sub,
				input,
			);
		});
export const disableMcpAuthorizationContract =
	authedOrganizationsOs.disableMcpAuthorization
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Disables only the authenticated human subject's exact stored Connect revision.",
				},
				"mcp:apps.write",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub)
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			const revision = await disableHumanMcpAuthorization(
				context.db,
				context.env,
				context.user.sub,
				input,
			);
			if (!revision)
				throw createError(
					ErrorCodes.CONFLICT,
					"Authorization changed or unavailable. Refresh and try again.",
				);
			return { revision };
		});

export const stageHumanMcpConsentContract =
	authedOrganizationsOs.stageMultiOrgMcpConsent
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"The handler binds this consent decision to the authenticated human subject and verified Connect client.",
				},
				"mcp:apps.write",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub) {
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			}
			let revision: string | null;
			try {
				revision = await stageHumanMcpConsent(
					context.db,
					context.env,
					context.user.sub,
					input,
				);
			} catch {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Consent verification is temporarily unavailable",
				);
			}
			if (!revision)
				throw createError(ErrorCodes.FORBIDDEN, "Consent selection invalid");
			return { revision };
		});

export const revokeHumanMcpConsentContract =
	authedOrganizationsOs.revokeMultiOrgMcpConsent
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"The handler revokes only the authenticated human subject's current Connect consent selection.",
				},
				"mcp:apps.write",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub) {
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			}
			let revision: string | null;
			try {
				revision = await revokeHumanMcpConsent(
					context.db,
					context.env,
					context.user.sub,
					input,
				);
			} catch {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Consent revocation is temporarily unavailable",
				);
			}
			if (!revision)
				throw createError(ErrorCodes.FORBIDDEN, "Connect client invalid");
			return { revision };
		});

/** Internal authorization read used only after the MCP edge validates OAuth. */
export const verifyHumanMcpGrantContract =
	organizationsOs.verifyMultiOrgMcpGrant
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const decision = await verifyHumanMcpGrant(
				context.db,
				context.env,
				input,
			);
			// Positive replica answers can still reflect a revoke within the lag window.
			if (decision.allowed) return decision;
			// Consent may have just finished on the primary while this session still
			// sees a missing grant or an older pending decision. Retry once there.
			const primary = createDbSession(context.env.DB, null, "first-primary");
			return verifyHumanMcpGrant(primary.db, context.env, input);
		});

/**
 * Public, exact-slug bootstrap for CLI OAuth.
 *
 * The response is deliberately limited to the organization's public name/slug
 * and public MCP resource URL. It does not reveal membership, internal ids, or
 * the Descope tenant id, and OAuth plus the gateway still enforce membership.
 */
export const resolveCliWorkspaceContract =
	organizationsOs.resolveCliWorkspace.handler(async ({ input, context }) => {
		const org = await getOrganizationBySlug(context.db, input.slug);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}
		const gateways = await getOrganizationAggregatorGateways(context.db, [
			org.id,
		]);
		const gateway = gateways.get(org.id);
		if (!gateway) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Organization MCP gateway is not provisioned",
			);
		}
		return {
			slug: org.slug,
			name: org.name,
			gatewayUrl: gatewayUrl(
				gateway,
				context.env.ENVIRONMENT,
				context.env.MCP_URL,
			),
		};
	});
