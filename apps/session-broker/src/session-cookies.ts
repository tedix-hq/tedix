import {
	DESCOPE_AUTH_HINT_MAX_AGE_SECONDS,
	DESCOPE_REFRESH_COOKIE,
	DESCOPE_SESSION_COOKIE,
	decodeUnverifiedJwtClaims,
	serializeCookie,
} from "@tedix/auth/web";

export const BROKER_REFRESH_COOKIE = "TEDIX_DSR";

/** The caller supplies the hostname only after the Worker's route check. */
export function expireRefreshAndSessionCookies(
	headers: Headers,
	brokerHostname: string,
): void {
	// Only the managed host has historical parent-domain cookies. Never
	// invent a parent-domain scope for another installation.
	const domains = [undefined, brokerHostname];
	if (brokerHostname === "auth.tedix.dev") domains.push(".tedix.dev");
	for (const name of [
		DESCOPE_REFRESH_COOKIE,
		BROKER_REFRESH_COOKIE,
		DESCOPE_SESSION_COOKIE,
	]) {
		for (const domain of domains) {
			headers.append(
				"Set-Cookie",
				serializeCookie(name, "", {
					httpOnly: true,
					maxAge: 0,
					path: "/",
					sameSite: "Lax",
					secure: true,
					...(domain ? { domain } : {}),
				}),
			);
		}
	}
}

export function appendRotatedRefreshCookie(
	headers: Headers,
	result: {
		refreshToken: string;
		sessionToken: string;
		refreshCookieMaxAge?: number;
	},
	brokerHostname: string,
): void {
	const options = {
		httpOnly: true,
		maxAge: result.refreshCookieMaxAge ?? DESCOPE_AUTH_HINT_MAX_AGE_SECONDS,
		path: "/",
		sameSite: "Lax" as const,
		secure: true,
	};
	expireRefreshAndSessionCookies(headers, brokerHostname);
	headers.append(
		"Set-Cookie",
		serializeCookie(BROKER_REFRESH_COOKIE, result.refreshToken, options),
	);
	// Match Descope's exact cookie identity on the shared auth host. A
	// flow-side rotation must replace the DSR twin, not leave a stale host-only
	// sibling: replaying that sibling invalidated the family with E064006.
	headers.append(
		"Set-Cookie",
		serializeCookie(DESCOPE_REFRESH_COOKIE, result.refreshToken, {
			...options,
			domain: brokerHostname,
		}),
	);
	const expiry = decodeUnverifiedJwtClaims(result.sessionToken)?.exp;
	const sessionExpiresAt =
		typeof expiry === "number" && Number.isFinite(expiry) ? expiry : 0;
	headers.append(
		"Set-Cookie",
		serializeCookie(DESCOPE_SESSION_COOKIE, result.sessionToken, {
			httpOnly: true,
			maxAge: Math.max(1, sessionExpiresAt - Math.floor(Date.now() / 1000)),
			path: "/",
			sameSite: "Lax",
			secure: true,
		}),
	);
}
