const CLI_OAUTH_CALLBACK_PATH = "/cli/oauth/callback";
import { encodeTedixCliOAuthRelayState } from "@tedix/auth/oauth-client-registration";

const STATE_NONCE_RE = /^[A-Za-z0-9_-]{1,180}$/;
const FORWARDED_OAUTH_PARAMS = [
	"code",
	"error",
	"error_description",
	"error_uri",
	"iss",
	"state",
] as const;

export function buildCliOAuthRelayTarget(requestUrl: string): string | null {
	const source = new URL(requestUrl);
	if (source.pathname !== CLI_OAUTH_CALLBACK_PATH) return null;

	const state = source.searchParams.get("state") ?? "";
	const separator = state.lastIndexOf(".");
	if (separator <= 0) return null;
	const nonce = state.slice(0, separator);
	const rawPort = state.slice(separator + 1);
	const port = Number(rawPort);
	if (
		!STATE_NONCE_RE.test(nonce) ||
		!/^[0-9]{1,5}$/.test(rawPort) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	) {
		return null;
	}

	const target = new URL(`http://127.0.0.1:${port}/callback`);
	for (const key of FORWARDED_OAUTH_PARAMS) {
		const value = source.searchParams.get(key);
		if (value !== null) target.searchParams.set(key, value);
	}
	return target.toString();
}

export function handleCliOAuthRelay(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== CLI_OAUTH_CALLBACK_PATH) return null;
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed\n", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}
	const target = buildCliOAuthRelayTarget(request.url);
	return target
		? Response.redirect(target, 302)
		: new Response("Invalid CLI OAuth callback state.\n", { status: 400 });
}
