import {
	serviceBindingFetch,
	type FetcherLike,
} from "@tedix/api-client/internal";
import { DESKTOP_SIGN_IN_KEY_PATTERN } from "@tedix/auth/desktop-sign-in-code";
import { validateToken } from "@tedix/auth/jwt";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import { hasStepUpClaim } from "@tedix/auth/types";
import { OS_BROKER_SESSION_COOKIE } from "./session-broker";

export const DESKTOP_SIGN_IN_PATH = "/auth/desktop/sign-in";
/** The Tedix OS page that asks the person to confirm. */
export const DESKTOP_SIGN_IN_CONFIRM_PATH = "/desktop-sign-in";

function json(body: Record<string, string>, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

function page(body: string, status = 200): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in to the Tedix app</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: light-dark(#fbfbfb, #171320); color: light-dark(#171717, #f5f3ff); }
main { display: grid; min-height: 100dvh; grid-template-columns: minmax(0, 28rem); align-content: safe center; justify-content: center; justify-items: center; gap: 16px; padding: 24px; text-align: center; overflow-wrap: anywhere; }
p { margin: 0; line-height: 1.5; }
a { color: inherit; text-underline-offset: 3px; }
</style>
</head>
<body>
<main>
<strong>Tedix</strong>
${body}
</main>
</body>
</html>
`,
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy":
					"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
				"Referrer-Policy": "no-referrer",
			},
		},
	);
}

/**
 * The browser side of desktop app sign-in. Google and Apple refuse to sign
 * people in inside an app window, so the desktop app opens this page in the
 * person's normal browser with a key it just made. Once the person is signed
 * in here and confirms, the page hands the app a one-time code that only that
 * app instance can read (`tedix://sign-in?code=…`).
 *
 * The code starts a lasting desktop session, so being signed in here is not
 * enough. Continue on the confirm page first asks the person to sign in again
 * (Descope's step-up flow) and posts the token that flow returns. This handler
 * and the API both refuse a token without the step-up claim, and this one also
 * refuses a token for anyone but the person signed in here. Loading the page
 * makes nothing. The code works once, for two minutes, and only the app that
 * made the key can read it.
 */
export async function handleDesktopSignIn(
	request: Request,
	env: { API_SERVICE?: FetcherLike; DESCOPE_PROJECT_ID?: string },
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== DESKTOP_SIGN_IN_PATH) return null;
	const posting = request.method === "POST";
	if (!posting && request.method !== "GET")
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: { Allow: "GET, POST", "Cache-Control": "no-store" },
		});
	// Only this page's own confirm button may ask for a code.
	if (posting && request.headers.get("Origin") !== url.origin)
		return new Response("Forbidden\n", {
			status: 403,
			headers: { "Cache-Control": "no-store" },
		});
	const body = posting
		? ((await request.json().catch(() => null)) as {
				key?: unknown;
				steppedUpToken?: unknown;
			} | null)
		: null;
	const key = posting ? body?.key : url.searchParams.get("key");
	if (typeof key !== "string" || !DESKTOP_SIGN_IN_KEY_PATTERN.test(key))
		return posting
			? json({ error: "This sign-in link is incomplete." }, 400)
			: page(
					"<p>This sign-in link is incomplete. Start again from the Tedix app.</p>",
					400,
				);
	if (!env.API_SERVICE || !env.DESCOPE_PROJECT_ID)
		return posting
			? json({ error: "Sign-in is not available right now." }, 503)
			: page("<p>Sign-in is not available right now.</p>", 503);

	const session = resolveProductSession(
		request.headers.get("Cookie"),
		OS_BROKER_SESSION_COOKIE,
	);
	const payload = session
		? await validateToken(session, {
				projectId: env.DESCOPE_PROJECT_ID,
				auditClaims: {
					surface: "os:desktop-sign-in",
					expected: [env.DESCOPE_PROJECT_ID],
				},
			}).catch(() => null)
		: null;
	if (posting) {
		if (!session || !payload?.sub)
			return json({ error: "Sign in to Tedix OS again, then retry." }, 401);
		const steppedUpToken =
			typeof body?.steppedUpToken === "string" &&
			body.steppedUpToken.length <= 16_384
				? body.steppedUpToken
				: null;
		const steppedUp = steppedUpToken
			? await validateToken(steppedUpToken, {
					projectId: env.DESCOPE_PROJECT_ID,
					auditClaims: {
						surface: "os:desktop-sign-in",
						expected: [env.DESCOPE_PROJECT_ID],
					},
				}).catch(() => null)
			: null;
		if (
			!hasStepUpClaim(steppedUp ?? undefined) ||
			steppedUp?.sub !== payload.sub
		)
			return json(
				{
					error: "Confirm it is you by signing in again, then press Continue.",
				},
				403,
			);
		const response = await serviceBindingFetch(env.API_SERVICE)(
			"https://api/__internal/desktop-sign-in-code",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session: steppedUpToken, key }),
				signal: AbortSignal.timeout(10_000),
			},
		).catch(() => null);
		const code = response?.ok
			? ((await response.json().catch(() => null)) as { code?: unknown } | null)
					?.code
			: undefined;
		if (typeof code !== "string" || !/^[A-Za-z0-9_-]+$/.test(code))
			return json({ error: "We could not prepare the sign-in." }, 503);
		return json({ code });
	}
	// Not signed in in this browser yet: sign in the usual way, then return.
	// Signed in: Tedix OS asks the person to confirm with one click.
	return new Response(null, {
		status: 302,
		headers: {
			"Cache-Control": "no-store",
			Location:
				session && payload?.sub
					? `${DESKTOP_SIGN_IN_CONFIRM_PATH}?key=${key}`
					: `/auth/session-broker/continue?redirect_to=${encodeURIComponent(`${DESKTOP_SIGN_IN_PATH}?key=${key}`)}`,
		},
	});
}
