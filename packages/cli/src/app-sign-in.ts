import { resolveStoredLoginAuth } from "./auth-resolve";

/** The public key the desktop app made for this sign-in (base64url P-256). */
const KEY = /^[A-Za-z0-9_-]{87}$/;

/** Tedix OS hosts the code may come from; the login token goes nowhere else. */
function tedixOsOrigin(value: string): string {
	const url = URL.parse(value);
	const local =
		url?.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1");
	const hosted =
		url?.protocol === "https:" &&
		(url.hostname === "os.tedix.dev" || url.hostname.endsWith(".os.tedix.dev"));
	if (!url || !(local || hosted))
		throw new Error(`Not a Tedix OS address: ${value}`);
	return url.origin;
}

/**
 * `tedix auth app-sign-in <os origin> <app key>`: signs the Tedix desktop app
 * in with this login, so the person does not sign in a second time. Tedix OS
 * checks this login's token and answers with a one-time code sealed to the
 * app's key; only that code is printed, never the token.
 */
export async function appSignIn(
	workspace: string,
	args: string[],
): Promise<string> {
	const [originArg = "", key = ""] = args;
	const origin = tedixOsOrigin(originArg);
	if (!KEY.test(key))
		throw new Error("Usage: tedix auth app-sign-in <origin> <key>");
	const { auth, loginError } = await resolveStoredLoginAuth(workspace, {
		consentPrompt: false,
	});
	const token =
		auth?.headers.Authorization?.replace(/^Bearer /, "") ||
		(await auth?.oauthProvider?.tokens())?.access_token;
	if (!token)
		throw new Error(loginError ?? "This Mac is not signed in to Tedix.");
	const response = await fetch(`${origin}/auth/desktop/cli-sign-in`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ key }),
		signal: AbortSignal.timeout(20_000),
	});
	const body = (await response.json().catch(() => null)) as {
		code?: unknown;
		error?: unknown;
	} | null;
	if (!response.ok || typeof body?.code !== "string")
		throw new Error(
			typeof body?.error === "string"
				? body.error
				: `Tedix OS answered ${response.status}.`,
		);
	return body.code;
}
