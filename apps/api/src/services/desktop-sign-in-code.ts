import { getManagementClient } from "@tedix/auth/client";
import {
	DESKTOP_SIGN_IN_KEY_PATTERN,
	sealDesktopSignInCode,
} from "@tedix/auth/desktop-sign-in-code";
import {
	decodeTokenUnsafe,
	isOAuthClientToken,
	validateToken,
} from "@tedix/auth/jwt";
import { TEDIX_CLI_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import { z } from "zod";

const inputSchema = z.union([
	z
		.object({
			session: z.string().min(1).max(16_384),
			key: z.string().regex(DESKTOP_SIGN_IN_KEY_PATTERN),
		})
		.strict(),
	z
		.object({
			cliToken: z.string().min(1).max(16_384),
			key: z.string().regex(DESKTOP_SIGN_IN_KEY_PATTERN),
		})
		.strict(),
]);

/**
 * The Tedix command-line tool's own login token: issued by a Descope app
 * (`/v1/apps/` issuer) to the Tedix CLI client, and at most an hour old.
 * The desktop app signs in with the login the command-line tool already has,
 * so the person consents once (RFC 8252 §8.6: the consent was given to this
 * client; nothing here skips one).
 */
export function isFreshCliToken(token: string): boolean {
	const claims = decodeTokenUnsafe(token);
	const issuedAt = typeof claims?.iat === "number" ? claims.iat : 0;
	return (
		claims?.azp === TEDIX_CLI_OAUTH_CLIENT_ID &&
		isOAuthClientToken(claims) &&
		Date.now() / 1000 - issuedAt < 60 * 60
	);
}

/** How long the desktop app has to use the code after the browser makes it. */
const CODE_LIFETIME_SECONDS = 120;

/**
 * Lets a person who is signed in to Tedix OS in their browser sign in to the
 * desktop app on the same computer. Returns a one-time Descope sign-in token
 * for the person who owns `session`, sealed to the key the desktop app made.
 * Descope accepts the token once and only for two minutes.
 *
 * The person does not sign in a second time. What protects the hand-over is
 * that the code is readable only by the app instance that made the key, works
 * once, and is made only when the person clicks Continue on the confirm page.
 *
 * Only InternalEntrypoint routes here. Tedix OS calls it from that click, a
 * same-origin request, and passes the browser's own session, which is checked
 * again here; nothing is logged.
 */
export async function desktopSignInCode(
	request: Request,
	env: Pick<
		CloudflareEnv,
		"DESCOPE_PROJECT_ID" | "DESCOPE_MANAGEMENT_KEY" | "DESCOPE_BASE_URL"
	>,
): Promise<Response> {
	const headers = { "Cache-Control": "no-store" };
	if (request.method !== "POST")
		return new Response(null, { status: 405, headers });
	const parsed = inputSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return new Response(null, { status: 400, headers });
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY)
		return new Response(null, { status: 503, headers });
	const input = parsed.data;
	const cli = "cliToken" in input;
	const token = cli ? input.cliToken : input.session;
	if (cli && !isFreshCliToken(token))
		return new Response(null, { status: 401, headers });
	const payload = await validateToken(token, {
		baseUrl: env.DESCOPE_BASE_URL,
		projectId: env.DESCOPE_PROJECT_ID,
		...(cli ? { audience: TEDIX_CLI_OAUTH_CLIENT_ID } : {}),
		auditClaims: {
			surface: cli ? "api:desktop-cli-sign-in" : "api:desktop-sign-in",
			expected: [env.DESCOPE_PROJECT_ID],
		},
	}).catch(() => undefined);
	const userId = typeof payload?.sub === "string" ? payload.sub : undefined;
	if (!userId) return new Response(null, { status: 401, headers });
	const descope = getManagementClient(env).management.user;
	const user = await descope.loadByUserId(userId);
	const loginId = user.ok ? user.data?.loginIds?.[0] : undefined;
	if (!loginId) return new Response(null, { status: 403, headers });
	const link = await descope.generateEmbeddedLink(
		loginId,
		undefined,
		CODE_LIFETIME_SECONDS,
	);
	if (!link.ok || !link.data?.token)
		return new Response(null, { status: 503, headers });
	return Response.json(
		{ code: await sealDesktopSignInCode(input.key, link.data.token) },
		{ headers },
	);
}
