import { base64UrlEncode } from "@tedix/auth/utils";
import {
	getConnectionConnectTicketByHash,
	redeemConnectionConnectTicket,
	stageConnectionConnectTicket,
} from "@tedix/db/queries/connection-connect-tickets";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	userHoldsPermission,
} from "../../orpc";
import { requireOrgId } from "../../org-scope";
import {
	authedOs,
	fetchNamedConnection,
	requireUserId,
} from "./policy-resolution";

/** Long enough for a provider consent round trip, short enough to bound replay. */
export const CONNECT_TICKET_TTL_MS = 10 * 60 * 1000;

function connectOwner(context: BaseContext, scope: "user" | "tenant") {
	const userId = requireUserId(context);
	const organizationId = requireOrgId(context);
	if (scope === "tenant") {
		if (!userHoldsPermission(context, "integrations:manage"))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Organization accounts require integrations:manage",
			);
		return { organizationId };
	}
	return { userId };
}

export const stageConnectTicket = authedOs.stageConnectTicket
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const organizationId = requireOrgId(context);
		const userId = requireUserId(context);
		const owner = connectOwner(context, input.scope);
		if (input.connectionInstanceId) {
			const instance = await getConnectionInstance(
				context.db,
				owner,
				input.connectionInstanceId,
				input.appId,
			);
			if (!instance)
				throw createError(ErrorCodes.NOT_FOUND, "Account not found");
		}
		const raw = new Uint8Array(32);
		crypto.getRandomValues(raw);
		const ticket = base64UrlEncode(raw);
		const now = Date.now();
		const expiresAt = new Date(now + CONNECT_TICKET_TTL_MS).toISOString();
		await stageConnectionConnectTicket(context.db, {
			id: crypto.randomUUID(),
			organizationId,
			userId,
			providerId: input.appId,
			scope: input.scope,
			connectionInstanceId: input.connectionInstanceId ?? null,
			ticketHash: await sha256Hex(ticket),
			status: "staged",
			expiresAt,
			createdAt: new Date(now).toISOString(),
		});
		return { ticket, expiresAt };
	});

export const redeemConnectTicket = authedOs.redeemConnectTicket
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const organizationId = requireOrgId(context);
		const userId = requireUserId(context);
		const staged = await getConnectionConnectTicketByHash(
			context.db,
			await sha256Hex(input.ticket),
		);
		if (!staged || staged.organizationId !== organizationId)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"This connection was not started in this workspace",
			);
		if (staged.userId !== userId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This connection was started by a different person. Only the person who started it can complete it from their own sign-in.",
			);
		const now = new Date().toISOString();
		if (staged.status !== "staged")
			throw createError(
				ErrorCodes.CONFLICT,
				"This connection was already completed",
			);
		if (staged.expiresAt <= now)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This connection took too long; start it again",
			);
		const redeemed = await redeemConnectionConnectTicket(context.db, {
			id: staged.id,
			organizationId,
			userId,
			now,
		});
		if (!redeemed)
			throw createError(
				ErrorCodes.CONFLICT,
				"This connection was already completed",
			);
		let recorded = false;
		if (redeemed.connectionInstanceId) {
			// Record the fresh grant on the named slot now, under this person's
			// own session, instead of leaving it to a later resolution.
			const owner =
				redeemed.scope === "user"
					? { userId }
					: await (async () => {
							const organization = await getOrganizationById(
								context.db,
								organizationId,
							);
							if (!organization?.descopeTenantId)
								throw createError(
									ErrorCodes.NOT_FOUND,
									"Organization connection target unavailable",
								);
							return {
								organizationId,
								tenantId: organization.descopeTenantId,
							};
						})();
			recorded = Boolean(
				await fetchNamedConnection(
					context,
					owner,
					redeemed.providerId,
					redeemed.connectionInstanceId,
				),
			);
		}
		return {
			appId: redeemed.providerId,
			scope: redeemed.scope,
			connectionInstanceId: redeemed.connectionInstanceId,
			recorded,
		};
	});
