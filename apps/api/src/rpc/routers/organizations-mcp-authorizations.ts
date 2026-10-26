/** Human MCP authorizations, multi-org consent and CLI workspace bootstrap procedures. */
import { createDbSession } from "@tedix/db/client";
import { getOrganizationAggregatorGateways } from "@tedix/db/queries/organization-members";
import {
	getMcpConsentResource,
	listMcpConsentGrantClientsForTenant,
	listMcpInboundClientAttempts,
} from "@tedix/db/queries/mcp-consent";
import {
	getOrganizationById,
	getOrganizationBySlug,
} from "@tedix/db/queries/organizations";
import {
	isClientIdMetadataDocumentUrl,
	McpInboundClientPolicySchema,
	type InboundClientInventoryItem,
} from "@tedix/api-contract/schemas/mcp-grant";
import { evaluateInboundClientPolicy } from "../../lib/mcp-inbound-client-policy";
import {
	listHumanMcpAuthorizations,
	disableHumanMcpAuthorization,
	revokeHumanMcpConsent,
	stageHumanMcpConsent,
	verifyHumanMcpGrant,
} from "../../lib/mcp-grant";
import {
	AUTHZ,
	createError,
	ErrorCodes,
	withAuthorization,
	withServiceAuth,
} from "../orpc";
import {
	gatewayUrl,
	requireAdminOrOwner,
	requireOrganizationAccess,
} from "./organizations-base";
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
/**
 * The admin inventory behind the inbound client policy editor: active Connect
 * grants selecting this organization plus recorded policy decisions, each
 * judged against the policy stored now. Both reads are bound to the caller's
 * own organization; no person is named.
 */
export const listInboundClientInventoryContract =
	authedOrganizationsOs.listInboundClientInventory
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			requireOrganizationAccess(context, input.organizationId);
			requireAdminOrOwner(context);
			const organization = await getOrganizationById(
				context.db,
				input.organizationId,
			);
			if (!organization)
				throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
			const [grants, attempts] = await Promise.all([
				organization.descopeTenantId
					? listMcpConsentGrantClientsForTenant(
							context.db,
							organization.descopeTenantId,
						)
					: Promise.resolve([]),
				listMcpInboundClientAttempts(context.db, organization.id),
			]);
			const stored = organization.metadata?.mcpInboundClientPolicy;
			const parsed =
				stored === undefined || stored === null
					? null
					: McpInboundClientPolicySchema.safeParse(stored);
			const items = new Map<string, InboundClientInventoryItem>();
			const item = (mcpServerId: string, clientId: string) => {
				const key = JSON.stringify([mcpServerId, clientId]);
				let found = items.get(key);
				if (!found) {
					const verdict = evaluateInboundClientPolicy(stored, {
						mcpServerId,
						clientId,
					});
					found = {
						mcpServerId,
						serverSlug: null,
						clientId,
						clientName: null,
						clientKind: isClientIdMetadataDocumentUrl(clientId)
							? "cimd"
							: "opaque",
						connectedPeople: 0,
						lastGrantedAt: null,
						lastAttempt: null,
						listed: verdict.listed,
						allowedNow: verdict.allowed,
					};
					items.set(key, found);
				}
				return found;
			};
			for (const row of grants) {
				const found = item(row.mcpServerId, row.clientId);
				found.connectedPeople = Number(row.people);
				// SQLite CURRENT_TIMESTAMP is UTC without a zone; report it as ISO.
				found.lastGrantedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
					row.lastGrantedAt,
				)
					? `${row.lastGrantedAt.replace(" ", "T")}.000Z`
					: row.lastGrantedAt;
			}
			for (const row of attempts) {
				const found = item(row.mcpServerId, row.clientId);
				found.clientName = row.clientName;
				found.lastAttempt = {
					stage: row.lastStage,
					mode: row.lastMode,
					allowed: row.lastAllowed,
					at: row.lastSeenAt,
					attempts: row.attemptCount,
					denied: row.deniedCount,
				};
			}
			const servers = [
				...new Set([...items.values()].map((i) => i.mcpServerId)),
			];
			const slugs = new Map(
				await Promise.all(
					servers.map(
						async (id) =>
							[
								id,
								(await getMcpConsentResource(context.db, { mcpServerId: id }))
									?.slug ?? null,
							] as const,
					),
				),
			);
			for (const found of items.values())
				found.serverSlug = slugs.get(found.mcpServerId) ?? null;
			return {
				policy: parsed?.success ? parsed.data : null,
				policyInvalid: parsed !== null && !parsed.success,
				items: [...items.values()].sort((a, b) =>
					(b.lastAttempt?.at ?? b.lastGrantedAt ?? "").localeCompare(
						a.lastAttempt?.at ?? a.lastGrantedAt ?? "",
					),
				),
			};
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
			// Inventory rows for clients the allowlist does not admit are written
			// after the response; the decision never waits on them.
			const options = { defer: context.waitUntil };
			const decision = await verifyHumanMcpGrant(
				context.db,
				context.env,
				input,
				options,
			);
			// Positive replica answers can still reflect a revoke within the lag window.
			if (decision.allowed) return decision;
			// Consent may have just finished on the primary while this session still
			// sees a missing grant or an older pending decision. Retry once there.
			const primary = createDbSession(context.env.DB, null, "first-primary");
			return verifyHumanMcpGrant(primary.db, context.env, input, options);
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
