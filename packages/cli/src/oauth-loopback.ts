import * as http from "node:http";
import {
	AuthorizationResponseIssError,
	type AuthorizationResponseIssWarning,
	assertAuthorizationResponseIss,
} from "@tedix/auth/oauth-iss";
import { OAuthError } from "./oauth-error.js";
import { renderLoopbackPage } from "./loopback-page";

export interface LoopbackResult {
	code: string;
	callbackParams: URLSearchParams;
	/** Finish the browser response only after token exchange and tenant validation. */
	completeBrowser?: (result: { ok: boolean; message?: string }) => void;
	/**
	 * RFC 9207 warning when the response carried no `iss` and the AS does not
	 * advertise `authorization_response_iss_parameter_supported` — the mix-up
	 * check could not run. Absent when `iss` validated (or when no
	 * `expectedIssuer` was provided, e.g. the manual env-override login path).
	 */
	issWarning?: AuthorizationResponseIssWarning;
}

const SUCCESS_HTML = renderLoopbackPage({
	title: "Tedix Login",
	heading: "You're signed in",
	body: "You can close this tab and return to your terminal.",
});

const ERROR_HTML = (msg: string) =>
	renderLoopbackPage({
		title: "Tedix Login Error",
		heading: "Login failed",
		body: msg,
		tone: "error",
	});

interface RunLoopbackCaptureDeps {
	createServer?: typeof http.createServer;
	setTimeout?: typeof setTimeout;
}

export function runLoopbackCapture(
	params: {
		authorizeUrl: string;
		/**
		 * RFC 9207 expected issuer, recorded from validated AS metadata before
		 * the redirect. When set, the authorization response's `iss` parameter is
		 * validated before the code is accepted. The SDK provider normally owns
		 * issuer validation through finishAuth, so this remains optional.
		 */
		expectedIssuer?: string;
		expectedState: string;
		/** RFC 8414 `authorization_response_iss_parameter_supported` from AS metadata. */
		issSupported?: boolean;
		openBrowser: (url: string) => void;
		/** Explicit callback port for tests/overrides; zero asks the OS for a free port. */
		port?: number;
		/** Receives the exact redirect URI before the browser is opened. */
		onRedirectUrl?: (url: URL) => void;
		prepareAuthorization?: (input: {
			authorizationUrl: URL;
			expectedState: string;
			loopbackRedirectUrl: URL;
		}) => { authorizationUrl: URL; expectedState: string };
		/** Keep the callback request open until the caller validates the exchanged token. */
		deferBrowserCompletion?: boolean;
		timeoutMs?: number;
	},
	deps: RunLoopbackCaptureDeps = {},
): Promise<LoopbackResult> {
	const {
		authorizeUrl,
		expectedIssuer,
		expectedState,
		issSupported = false,
		openBrowser,
		port = 0,
		onRedirectUrl,
		prepareAuthorization,
		deferBrowserCompletion = false,
		timeoutMs = 120_000,
	} = params;
	const createServer = deps.createServer ?? http.createServer;
	const setTimeoutFn = deps.setTimeout ?? setTimeout;

	return new Promise<LoopbackResult>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pendingBrowserCompletion:
			| ((result: { ok: boolean; message?: string }) => void)
			| undefined;

		function settle(
			result: LoopbackResult | OAuthError,
			closeServer = true,
		): void {
			if (settled) return;
			settled = true;
			if (closeServer) {
				if (timer) clearTimeout(timer);
				server.close();
			}
			if (result instanceof OAuthError) {
				reject(result);
			} else {
				resolve(result);
			}
		}

		let callbackPort = port;
		let callbackExpectedState = expectedState;
		const server = createServer(
			(req: http.IncomingMessage, res: http.ServerResponse) => {
				const rawUrl = req.url ?? "";
				if (!rawUrl.startsWith("/callback")) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}

				const parsedUrl = new URL(rawUrl, `http://localhost:${callbackPort}`);
				const callbackState = parsedUrl.searchParams.get("state");
				const code = parsedUrl.searchParams.get("code");
				const errorParam = parsedUrl.searchParams.get("error");
				const errorDescription =
					parsedUrl.searchParams.get("error_description") ?? "";

				if (callbackState !== callbackExpectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(ERROR_HTML("State mismatch — possible CSRF attempt"));
					settle(
						new OAuthError("state_mismatch", "OAuth state parameter mismatch"),
					);
					return;
				}

				// RFC 9207: validate the authorization response's `iss` against the
				// issuer this flow was initiated against BEFORE acting on the
				// response (error params included — mix-up responses can carry
				// either). Skipped when no expected issuer is known (manual
				// env-override login path, where no AS metadata was discovered).
				let issWarning: AuthorizationResponseIssWarning | undefined;
				if (expectedIssuer) {
					try {
						const issResult = assertAuthorizationResponseIss({
							expectedIssuer,
							issSupported,
							responseIss: parsedUrl.searchParams.get("iss"),
						});
						if (!issResult.validated) {
							issWarning = issResult.warning;
						}
					} catch (error) {
						const isIssError = error instanceof AuthorizationResponseIssError;
						const message = isIssError
							? error.message
							: "Issuer validation failed";
						res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
						res.end(
							ERROR_HTML("Issuer mismatch — possible mix-up attack (RFC 9207)"),
						);
						settle(
							new OAuthError(isIssError ? error.code : "iss_invalid", message),
						);
						return;
					}
				}

				if (errorParam) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(
						errorParam === "access_denied" || errorParam === "missing consent"
							? renderLoopbackPage({
									title: "Tedix Login",
									heading: "Access was not authorized",
									body: "You can close this tab and return to your terminal to try again.",
									tone: "error",
								})
							: ERROR_HTML(errorParam),
					);
					settle(new OAuthError(errorParam, errorDescription));
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(ERROR_HTML("No authorization code received"));
					settle(
						new OAuthError("no_code", "No authorization code in callback"),
					);
					return;
				}

				let browserCompleted = false;
				const completeBrowser = (result: { ok: boolean; message?: string }) => {
					if (browserCompleted) return;
					browserCompleted = true;
					pendingBrowserCompletion = undefined;
					if (timer) clearTimeout(timer);
					res.writeHead(result.ok ? 200 : 400, {
						"Cache-Control": "no-store",
						"Content-Type": "text/html; charset=utf-8",
					});
					res.end(
						result.ok
							? SUCCESS_HTML
							: ERROR_HTML(
									result.message ?? "The returned token was not valid.",
								),
					);
					server.close();
				};
				pendingBrowserCompletion = completeBrowser;
				if (!deferBrowserCompletion) completeBrowser({ ok: true });
				settle(
					{
						code,
						callbackParams: parsedUrl.searchParams,
						...(deferBrowserCompletion ? { completeBrowser } : {}),
						...(issWarning ? { issWarning } : {}),
					},
					!deferBrowserCompletion,
				);
			},
		);

		server.on("error", (err: Error) => {
			settle(new OAuthError("server_error", err.message));
		});

		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				settle(
					new OAuthError(
						"server_error",
						"Could not determine the OAuth callback port",
					),
				);
				return;
			}
			callbackPort = address.port;
			const redirectUrl = new URL(`http://localhost:${callbackPort}/callback`);
			let browserUrl = new URL(authorizeUrl);
			if (prepareAuthorization) {
				const prepared = prepareAuthorization({
					authorizationUrl: browserUrl,
					expectedState: callbackExpectedState,
					loopbackRedirectUrl: redirectUrl,
				});
				browserUrl = prepared.authorizationUrl;
				callbackExpectedState = prepared.expectedState;
			} else {
				browserUrl.searchParams.set("redirect_uri", redirectUrl.toString());
			}
			onRedirectUrl?.(redirectUrl);
			// Reserve the callback port before publishing it to the browser. Each
			// concurrent login therefore owns a distinct listener with no scan/bind race.
			openBrowser(browserUrl.toString());
		});

		timer = setTimeoutFn(() => {
			if (pendingBrowserCompletion) {
				pendingBrowserCompletion({
					ok: false,
					message:
						"Token validation did not finish before the login timed out.",
				});
				return;
			}
			settle(
				new OAuthError(
					"timeout",
					`No callback received within ${timeoutMs}ms — login timed out`,
				),
			);
		}, timeoutMs);

		// Don't let the timer keep the process alive
		if (typeof timer === "object" && timer !== null && "unref" in timer) {
			(timer as NodeJS.Timeout).unref();
		}
	});
}
