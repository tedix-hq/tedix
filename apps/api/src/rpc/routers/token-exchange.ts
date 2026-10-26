import { implement } from "@orpc/server";
import { tokenExchangeContract } from "@tedix/api-contract/contracts/token-exchange";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { revokeTokenExchangeLineage } from "@tedix/db/queries/token-exchange";
import {
	brokerInternalExchange,
	TokenExchangeDisabled,
	TokenExchangeRefused,
} from "../../services/token-exchange-broker";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const tokenExchangeOs = implement(
	tokenExchangeContract,
).$context<BaseContext>();

const exchange = tokenExchangeOs.exchange
	.use(withAuth)
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only the MCP edge service binding forwarding a tedi tool call may exchange; the broker verifies the tedi, organization and acting member",
			},
			"tedis:read",
		),
	)
	.handler(async ({ input, context }) => {
		try {
			const issued = await brokerInternalExchange(context, {
				endpoint: input.endpoint,
				scopes: input.scopes,
			});
			return {
				accessToken: issued.response.access_token,
				issuedTokenType: issued.response.issued_token_type,
				tokenType: issued.response.token_type,
				expiresIn: issued.response.expires_in,
				scope: issued.response.scope,
				jti: issued.claims.jti,
			};
		} catch (error) {
			if (error instanceof TokenExchangeDisabled)
				throw createError(ErrorCodes.NOT_FOUND, error.message);
			if (error instanceof TokenExchangeRefused)
				throw createError(ErrorCodes.FORBIDDEN, error.message);
			throw error;
		}
	});

const revoke = tokenExchangeOs.revoke
	.use(withAuth)
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const admin =
			context.authType === "user" &&
			(context.userRole === "admin" || context.userRole === "owner");
		if (!admin && !isPlatformPrincipal(context))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only admins and owners can revoke exchanged tokens",
			);
		const revokedBy =
			context.user?.sub ?? context.tediId ?? context.apiKey?.id ?? "platform";
		const revoked = await revokeTokenExchangeLineage(context.db, {
			organizationId,
			jti: input.jti,
			revokedBy,
			at: new Date().toISOString(),
		});
		if (revoked.length > 0)
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: revokedBy,
				actorType: context.authType === "user" ? "user" : "service",
				action: "token_exchange.revoked",
				resourceType: "exchanged_token",
				resourceId: input.jti,
				metadata: { revoked },
			});
		return { revoked };
	});

export const tokenExchangeContractRouter = tokenExchangeOs.router({
	exchange,
	revoke,
});
