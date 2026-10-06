import { describe, expect, test } from "bun:test";
import type * as http from "node:http";
import { runLoopbackCapture } from "./oauth-loopback.js";
import { OAuthError } from "./oauth-error.js";

// Minimal fake HTTP server that lets the test drive requests programmatically
function makeFakeServer(
	_onRequest: (
		req: { url: string },
		res: {
			writeHead: (s: number, h?: Record<string, string>) => void;
			end: (b: string) => void;
		},
	) => void,
): {
	createServer: typeof http.createServer;
	triggerRequest: (url: string) => void;
} {
	type ReqHandler = (
		req: http.IncomingMessage,
		res: http.ServerResponse,
	) => void;
	let handler: ReqHandler | null = null;
	let listenCallback: (() => void) | null = null;
	let boundPort = 0;

	const fakeServer = {
		address: () => ({ address: "127.0.0.1", family: "IPv4", port: boundPort }),
		close: () => {},
		listen: (port: number, _host: string, cb: () => void) => {
			boundPort = port === 0 ? 54321 : port;
			listenCallback = cb;
			// Call listen callback async so server is "ready"
			Promise.resolve().then(() => listenCallback?.());
		},
		on: (_event: string, _fn: unknown) => fakeServer,
	};

	const createServer = (h: ReqHandler): typeof fakeServer => {
		handler = h;
		return fakeServer;
	};

	const triggerRequest = (url: string) => {
		const fakeReq = {
			url,
		} as unknown as http.IncomingMessage;

		const responseState: {
			status: number;
			headers: Record<string, string>;
			body: string;
		} = {
			body: "",
			headers: {},
			status: 200,
		};
		const fakeRes = {
			end: (body: string) => {
				responseState.body = body;
			},
			writeHead: (status: number, headers?: Record<string, string>) => {
				responseState.status = status;
				if (headers) responseState.headers = headers;
			},
		} as unknown as http.ServerResponse;

		handler?.(fakeReq, fakeRes);
	};

	return {
		createServer: createServer as unknown as typeof http.createServer,
		triggerRequest,
	};
}

describe("runLoopbackCapture", () => {
	test("runs concurrent OAuth captures on distinct OS-assigned ports", async () => {
		const openedPorts: number[] = [];
		const capture = (state: string, code: string) =>
			runLoopbackCapture({
				authorizeUrl:
					"https://example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcallback",
				expectedState: state,
				openBrowser: (authorizationUrl) => {
					const redirect = new URL(
						new URL(authorizationUrl).searchParams.get("redirect_uri")!,
					);
					openedPorts.push(Number(redirect.port));
					redirect.searchParams.set("code", code);
					redirect.searchParams.set("state", state);
					void fetch(redirect);
				},
				timeoutMs: 5000,
			});

		const [first, second] = await Promise.all([
			capture("state-one", "CODE_ONE"),
			capture("state-two", "CODE_TWO"),
		]);

		expect([first.code, second.code]).toEqual(["CODE_ONE", "CODE_TWO"]);
		expect(openedPorts).toHaveLength(2);
		expect(new Set(openedPorts).size).toBe(2);
		expect(openedPorts).not.toContain(8976);
	});

	test("does not render browser success until the exchanged token is validated", async () => {
		let browserResponse: Promise<Response> | undefined;
		const result = await runLoopbackCapture({
			authorizeUrl: "https://example.com/auth",
			deferBrowserCompletion: true,
			expectedState: "tenant-bound",
			openBrowser: (authorizationUrl) => {
				const callback = new URL(
					new URL(authorizationUrl).searchParams.get("redirect_uri")!,
				);
				callback.searchParams.set("code", "CODE");
				callback.searchParams.set("state", "tenant-bound");
				browserResponse = fetch(callback);
			},
			timeoutMs: 5_000,
		});

		expect(result.completeBrowser).toBeFunction();
		result.completeBrowser?.({
			ok: false,
			message: "The access token did not contain the selected tenant.",
		});
		const response = await browserResponse!;
		expect(response.status).toBe(400);
		expect(await response.text()).toContain(
			"The access token did not contain the selected tenant.",
		);
	});

	test("reserves a free port and rewrites the redirect before opening the browser", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});
		let openedUrl = "";
		let redirectUrl = "";

		const result = await runLoopbackCapture(
			{
				authorizeUrl:
					"https://example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcallback",
				expectedState: "dynamic-state",
				onRedirectUrl: (url) => {
					redirectUrl = url.toString();
				},
				openBrowser: (url) => {
					openedUrl = url;
					triggerRequest("/callback?code=DYNAMIC&state=dynamic-state");
				},
				timeoutMs: 5000,
			},
			{ createServer },
		);

		expect(result.code).toBe("DYNAMIC");
		expect(redirectUrl).toBe("http://localhost:54321/callback");
		expect(new URL(openedUrl).searchParams.get("redirect_uri")).toBe(
			"http://localhost:54321/callback",
		);
	});

	test("resolves with code on correct state", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const capturePromise = runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedState: "abc123",
				openBrowser: (_url) => {
					// Simulate callback arrival
					triggerRequest("/callback?code=MYCODE&state=abc123");
				},
				port: 19876,
				timeoutMs: 5000,
			},
			{ createServer },
		);

		const result = await capturePromise;
		expect(result.code).toBe("MYCODE");
	});

	test("rejects with OAuthError on state mismatch", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const capturePromise = runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedState: "correct-state",
				openBrowser: (_url) => {
					triggerRequest("/callback?code=X&state=wrong-state");
				},
				port: 19877,
				timeoutMs: 5000,
			},
			{ createServer },
		);

		await expect(capturePromise).rejects.toBeInstanceOf(OAuthError);
		try {
			await runLoopbackCapture(
				{
					authorizeUrl: "https://example.com/auth",
					expectedState: "correct-state",
					openBrowser: (_url) => {
						triggerRequest("/callback?code=X&state=wrong-state");
					},
					port: 19877,
					timeoutMs: 5000,
				},
				{ createServer },
			);
		} catch (err) {
			expect((err as OAuthError).errorCode).toBe("state_mismatch");
		}
	});

	test("rejects with OAuthError when provider returns error param", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const capturePromise = runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedState: "s1",
				openBrowser: (_url) => {
					triggerRequest(
						"/callback?error=access_denied&error_description=User+denied&state=s1",
					);
				},
				port: 19878,
				timeoutMs: 5000,
			},
			{ createServer },
		);

		await expect(capturePromise).rejects.toBeInstanceOf(OAuthError);
		try {
			await runLoopbackCapture(
				{
					authorizeUrl: "https://example.com/auth",
					expectedState: "s1",
					openBrowser: (_url) => {
						triggerRequest(
							"/callback?error=access_denied&error_description=User+denied&state=s1",
						);
					},
					port: 19878,
					timeoutMs: 5000,
				},
				{ createServer },
			);
		} catch (err) {
			expect((err as OAuthError).errorCode).toBe("access_denied");
		}
	});

	test("rejects with timeout OAuthError when no callback arrives", async () => {
		type ReqHandler = (
			req: http.IncomingMessage,
			res: http.ServerResponse,
		) => void;
		const fakeServer = {
			address: () => ({
				address: "127.0.0.1",
				family: "IPv4",
				port: 19879,
			}),
			close: () => {},
			listen: (_port: number, _host: string, cb: () => void) => {
				// Open the browser (openBrowser in params), but never trigger a request
				Promise.resolve().then(() => cb());
			},
			on: (_event: string, _fn: unknown) => fakeServer,
		};
		const createServer = (_h: ReqHandler) => fakeServer;

		// Use a real short timeout — inject a fast setTimeout
		let timerCallback: (() => void) | null = null;
		const fakeSetTimeout = (fn: () => void, _ms: number) => {
			timerCallback = fn;
			return {} as ReturnType<typeof setTimeout>;
		};

		const capturePromise = runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedState: "s2",
				openBrowser: (_url) => {
					// Fire the timeout immediately after the browser would open
					Promise.resolve().then(() => timerCallback?.());
				},
				port: 19879,
				timeoutMs: 50,
			},
			{
				createServer: createServer as unknown as typeof http.createServer,
				setTimeout: fakeSetTimeout as unknown as typeof setTimeout,
			},
		);

		await expect(capturePromise).rejects.toBeInstanceOf(OAuthError);
		try {
			// re-run to check errorCode
		} catch (_err) {
			// skip
		}

		const err = await capturePromise.catch((e) => e);
		expect((err as OAuthError).errorCode).toBe("timeout");
	});

	test("resolves when iss matches the expected issuer (RFC 9207)", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const result = await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedIssuer: "https://as.example.com",
				expectedState: "s-iss-1",
				issSupported: true,
				openBrowser: (_url) => {
					triggerRequest(
						"/callback?code=CODE&state=s-iss-1&iss=" +
							encodeURIComponent("https://as.example.com"),
					);
				},
				port: 19881,
				timeoutMs: 5000,
			},
			{ createServer },
		);
		expect(result.code).toBe("CODE");
		expect(result.issWarning).toBeUndefined();
	});

	test("rejects with iss_mismatch when iss differs from the expected issuer", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const err = await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedIssuer: "https://as.example.com",
				expectedState: "s-iss-2",
				openBrowser: (_url) => {
					triggerRequest(
						"/callback?code=CODE&state=s-iss-2&iss=" +
							encodeURIComponent("https://evil.example.com"),
					);
				},
				port: 19882,
				timeoutMs: 5000,
			},
			{ createServer },
		).catch((e) => e);
		expect(err).toBeInstanceOf(OAuthError);
		expect((err as OAuthError).errorCode).toBe("iss_mismatch");
	});

	test("rejects with iss_missing when iss is absent and the AS advertises support", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const err = await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedIssuer: "https://as.example.com",
				expectedState: "s-iss-3",
				issSupported: true,
				openBrowser: (_url) => {
					triggerRequest("/callback?code=CODE&state=s-iss-3");
				},
				port: 19883,
				timeoutMs: 5000,
			},
			{ createServer },
		).catch((e) => e);
		expect(err).toBeInstanceOf(OAuthError);
		expect((err as OAuthError).errorCode).toBe("iss_missing");
	});

	test("resolves with a structured warning when iss is absent and the AS does not advertise support", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const result = await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedIssuer: "https://as.example.com",
				expectedState: "s-iss-4",
				issSupported: false,
				openBrowser: (_url) => {
					triggerRequest("/callback?code=CODE&state=s-iss-4");
				},
				port: 19884,
				timeoutMs: 5000,
			},
			{ createServer },
		);
		expect(result.code).toBe("CODE");
		expect(result.issWarning?.code).toBe("iss_absent_as_unsupported");
	});

	test("skips iss validation when no expectedIssuer is provided (manual override path)", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const result = await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedState: "s-iss-5",
				issSupported: true,
				openBrowser: (_url) => {
					triggerRequest("/callback?code=CODE&state=s-iss-5");
				},
				port: 19885,
				timeoutMs: 5000,
			},
			{ createServer },
		);
		expect(result.code).toBe("CODE");
		expect(result.issWarning).toBeUndefined();
	});

	test("validates iss before honoring an error response (mix-up defense)", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});

		const err = await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth",
				expectedIssuer: "https://as.example.com",
				expectedState: "s-iss-6",
				openBrowser: (_url) => {
					triggerRequest(
						"/callback?error=access_denied&state=s-iss-6&iss=" +
							encodeURIComponent("https://evil.example.com"),
					);
				},
				port: 19886,
				timeoutMs: 5000,
			},
			{ createServer },
		).catch((e) => e);
		expect(err).toBeInstanceOf(OAuthError);
		expect((err as OAuthError).errorCode).toBe("iss_mismatch");
	});

	test("openBrowser is called with the authorizeUrl", async () => {
		const { createServer, triggerRequest } = makeFakeServer(() => {});
		const openedUrls: string[] = [];

		await runLoopbackCapture(
			{
				authorizeUrl: "https://example.com/auth?foo=bar",
				expectedState: "state99",
				openBrowser: (url) => {
					openedUrls.push(url);
					triggerRequest("/callback?code=CODE&state=state99");
				},
				port: 19880,
				timeoutMs: 5000,
			},
			{ createServer },
		);

		expect(openedUrls).toEqual([
			"https://example.com/auth?foo=bar&redirect_uri=http%3A%2F%2Flocalhost%3A19880%2Fcallback",
		]);
	});
});
