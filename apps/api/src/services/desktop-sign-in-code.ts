import { getManagementClient } from "@tedix/auth/client";
import {
	DESKTOP_SIGN_IN_KEY_PATTERN,
	sealDesktopSignInCode,
} from "@tedix/auth/desktop-sign-in-code";
import { validateToken } from "@tedix/auth/jwt";
import { hasStepUpClaim } from "@tedix/auth/types";
import { z } from "zod";

const inputSchema = z
	.object({
		session: z.string().min(1).max(16_384),
		proof: z.string().min(1).max(16_384),
		key: z.string().regex(DESKTOP_SIGN_IN_KEY_PATTERN),
	})
	.strict();

/** How long the desktop app has to use the code after the browser makes it. */
const CODE_LIFETIME_SECONDS = 120;

/**
 * Lets a person who is signed in to Tedix OS in their browser sign in to the
 * desktop app on the same computer. Returns a one-time Descope sign-in token
 * for the person who owns `session`, sealed to the key the desktop app made.
 * Descope accepts the token once and only for two minutes.
 *
 * A signed-in browser is not enough: the code becomes a lasting session in
 * the app, so `proof` must be the token the person just got by confirming who
 * they are again (the step-up claim, see `hasStepUpClaim`), for the same
 * person as `session`.
 *
 * Only InternalEntrypoint routes here. Tedix OS calls it from a confirmed,
 * same-origin request and passes the browser's own session, which is checked
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
	const validate = (token: string) =>
		validateToken(token, {
			baseUrl: env.DESCOPE_BASE_URL,
			projectId: env.DESCOPE_PROJECT_ID,
			auditClaims: {
				surface: "api:desktop-sign-in",
				expected: [env.DESCOPE_PROJECT_ID as string],
			},
		}).catch(() => undefined);
	const [payload, proof] = await Promise.all([
		validate(parsed.data.session),
		validate(parsed.data.proof),
	]);
	const userId = typeof payload?.sub === "string" ? payload.sub : undefined;
	if (!userId) return new Response(null, { status: 401, headers });
	if (!hasStepUpClaim(proof) || proof?.sub !== userId)
		return new Response(null, { status: 403, headers });
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
		{ code: await sealDesktopSignInCode(parsed.data.key, link.data.token) },
		{ headers },
	);
}
