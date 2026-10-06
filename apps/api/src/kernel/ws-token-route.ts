/** Mint the short-lived kernel token used by authenticated voice clients. */
import {
	authenticateKernelSessionJwt,
	extractKernelEdgeToken,
	jsonError,
	readPlatformServiceToken,
} from "./edge-auth";
import { mintKernelWsToken } from "./ws-token";

export async function handleKernelWsToken(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	const token = extractKernelEdgeToken(request);
	if (!token) {
		return jsonError(401, "Unauthorized", "Missing token");
	}

	const auth = await authenticateKernelSessionJwt(
		token,
		new URL(request.url).searchParams.get("organization"),
		env,
	);
	if (!auth.ok) return auth.response;

	const platformServiceToken = readPlatformServiceToken(env);
	if (!platformServiceToken) {
		return jsonError(
			503,
			"Service Unavailable",
			"Kernel WS token signing is not configured",
		);
	}

	const minted = await mintKernelWsToken({
		organizationId: auth.identity.organizationId,
		descopeUserId: auth.identity.descopeUserId,
		platformServiceToken,
	});
	return Response.json(
		{
			token: minted.token,
			expiresAt: minted.expiresAt,
			organizationId: auth.identity.organizationId,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
