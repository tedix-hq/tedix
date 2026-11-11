import { resolveCorsOrigin } from "../../../lib/cors-origins";
import { settleOutboundMcpOAuth } from "../../../oauth-cimd-callback";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedOs, requireUserId } from "./policy-resolution";

/** The one product path a connect may return to. */
const CONNECT_RETURN_PATH = "/oauth/callback";

/**
 * Where a connect returns to after consent. The provider response is relayed
 * there, so it must be this installation's own callback page: never a URL the
 * caller chose freely.
 */
export function assertConnectReturnUrl(
	env: BaseContext["env"],
	value: string,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw createError(ErrorCodes.BAD_REQUEST, "redirectUri is not a URL");
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== CONNECT_RETURN_PATH ||
		!resolveCorsOrigin(url.origin, env)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`redirectUri must be ${CONNECT_RETURN_PATH} on this installation's own origin`,
		);
	return url.toString();
}

export const settleOutboundOAuth = authedOs.settleOutboundOAuth
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const result = await settleOutboundMcpOAuth(
			input,
			{
				userId: requireUserId(context),
				organizationId: requireOrgId(context),
			},
			context.env,
			context.db,
		);
		if (result.status !== "rejected") return result;
		throw result.reason === "state_invalid"
			? createError(
					ErrorCodes.BAD_REQUEST,
					"This connection took too long or was not started here; start it again",
				)
			: createError(
					ErrorCodes.FORBIDDEN,
					"This connection was started by a different person. Only the person who started it can complete it from their own sign-in.",
				);
	});
