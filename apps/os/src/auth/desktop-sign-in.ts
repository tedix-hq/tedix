import {
	serviceBindingFetch,
	type FetcherLike,
} from "@tedix/api-client/internal";
import { DESKTOP_SIGN_IN_KEY_PATTERN } from "@tedix/auth/desktop-sign-in-code";
import { validateToken } from "@tedix/auth/jwt";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
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

/** Asks the API for a desktop sign-in code; the API checks the credential. */
async function requestCode(
	api: FetcherLike,
	body: Record<string, string>,
): Promise<string | undefined> {
	const response = await serviceBindingFetch(api)(
		"https://api/__internal/desktop-sign-in-code",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		},
	).catch(() => null);
	const code = response?.ok
		? ((await response.json().catch(() => null)) as { code?: unknown } | null)
				?.code
		: undefined;
	return typeof code === "string" && /^[A-Za-z0-9_-]+$/.test(code)
		? code
		: undefined;
}

/**
 * The desktop app signs in with the login its command-line tool already has,
 * so the person signs in and consents once. `tedix auth app-sign-in` posts its
 * own token as the bearer with the key the app made; the answer is a one-time
 * code only that app can read, the same as the browser sign-in below.
 */
export async function handleDesktopCliSignIn(
	request: Request,
	env: { API_SERVICE?: FetcherLike },
): Promise<Response> {
	if (request.method !== "POST")
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: { Allow: "POST", "Cache-Control": "no-store" },
		});
	const cliToken = /^Bearer (\S+)$/.exec(
		request.headers.get("Authorization") ?? "",
	)?.[1];
	const key = (
		(await request.json().catch(() => null)) as {
			key?: unknown;
		} | null
	)?.key;
	if (
		!cliToken ||
		typeof key !== "string" ||
		!DESKTOP_SIGN_IN_KEY_PATTERN.test(key)
	)
		return json({ error: "This sign-in request is incomplete." }, 400);
	if (!env.API_SERVICE)
		return json({ error: "Sign-in is not available right now." }, 503);
	const code = await requestCode(env.API_SERVICE, { cliToken, key });
	return code
		? json({ code })
		: json({ error: "Sign in on this Mac again, then retry." }, 401);
}

/**
 * The browser side of desktop app sign-in. Google and Apple refuse to sign
 * people in inside an app window, so the desktop app opens this page in the
 * person's normal browser with a key it just made. Once the person is signed
 * in here and confirms, the page hands the app a one-time code that only that
 * app instance can read (`tedix://sign-in?code=…`).
 *
 * A person already signed in here does not sign in again. Loading the page
 * makes nothing: the code is made only when the person clicks Continue on the
 * confirm page, which posts from this origin. The code works once, for two
 * minutes, and only the app that made the key can read it.
 *
 * Decided 20 Nov 2026: no second sign-in or fresh identity check here. It was
 * added twice and taken out twice; do not add it again.
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
		const code = await requestCode(env.API_SERVICE, { session, key });
		if (!code) return json({ error: "We could not prepare the sign-in." }, 503);
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
