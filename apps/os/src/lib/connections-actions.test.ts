import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

import {
	CONNECT_POPUP_ABANDONED_REASON,
	CONNECT_RETURN_TO_KEY,
	CONNECT_FLOW_KEY,
	CONNECTION_COMPLETE_MESSAGE,
	CONNECTION_FAILED_MESSAGE,
	startOauthConnect,
	startNamedOauthConnect,
	useConnectionCompleteListener,
	takeConnectionFlow,
} from "./connections-actions";
import { osQueryKeys } from "./os-query-options";

const { disconnectProviderMock, initiateConnectionMock, createInstanceMock } =
	vi.hoisted(() => ({
		disconnectProviderMock: vi.fn(),
		initiateConnectionMock: vi.fn(),
		createInstanceMock: vi.fn(),
	}));

vi.mock("@/lib/api", () => ({
	osApi: {
		connections: {
			disconnectProvider: disconnectProviderMock,
			initiateConnection: initiateConnectionMock,
			createConnectionInstance: createInstanceMock,
		},
	},
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "https://acme.os.tedix.dev";
const CONSENT_URL = `${ORIGIN}/provider-consent`;

/** A stand-in for the consent window the browser hands back from `open`. */
function fakePopup() {
	const storage = new Map<string, string>();
	const popup = {
		sessionStorage: {
			setItem: (key: string, value: string) => storage.set(key, value),
			getItem: (key: string) => storage.get(key) ?? null,
		},
		closed: false,
		location: { href: "" },
		close: () => {
			popup.closed = true;
		},
	};
	return popup;
}

/** The completion message the callback route posts to its opener. */
function postCompletion(
	origin: string,
	popup?: ReturnType<typeof fakePopup>,
	overrides: Record<string, unknown> = {},
) {
	const flow = popup
		? JSON.parse(popup.sessionStorage.getItem(CONNECT_FLOW_KEY) ?? "{}")
		: {};
	window.dispatchEvent(
		new MessageEvent("message", {
			data: { type: CONNECTION_COMPLETE_MESSAGE, ...flow, ...overrides },
			origin,
			source: popup as unknown as Window,
		}),
	);
}

function postFailure(
	origin: string,
	popup: ReturnType<typeof fakePopup>,
	reason: string,
) {
	const flow = JSON.parse(
		popup.sessionStorage.getItem(CONNECT_FLOW_KEY) ?? "{}",
	);
	window.dispatchEvent(
		new MessageEvent("message", {
			data: { type: CONNECTION_FAILED_MESSAGE, ...flow, reason },
			origin,
			source: popup as unknown as Window,
		}),
	);
}

/** Let the broker fetch and the Descope SDK call settle. */
async function flush() {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

describe("startOauthConnect", () => {
	let popup: ReturnType<typeof fakePopup> | null;
	let open: ReturnType<typeof vi.fn>;
	let location: {
		origin: string;
		href: string;
		pathname: string;
		search: string;
	};

	beforeEach(() => {
		createInstanceMock.mockReset();
		createInstanceMock.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			appId: "acme-api",
			label: "Account",
			scope: "user",
		});
		initiateConnectionMock.mockReset();
		initiateConnectionMock.mockResolvedValue({
			redirectUrl: CONSENT_URL,
			state: "sealed-state",
		});
		popup = fakePopup();
		open = vi.fn(() => popup);
		vi.stubGlobal("open", open);
		location = {
			origin: ORIGIN,
			href: `${ORIGIN}/apps`,
			pathname: "/apps",
			search: "?panel=connections",
		};
		vi.stubGlobal("location", location);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				return url.endsWith("/auth/session-broker/status")
					? Response.json({ authenticated: true, tenantId: "T-acme" })
					: Response.json({ url: CONSENT_URL });
			}),
		);
		window.sessionStorage.clear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("starts a user-owned connection through the same-origin bridge", async () => {
		const started = startOauthConnect({
			appId: "acme-api",
			effectiveScope: "user",
		});
		await flush();
		postCompletion(ORIGIN, popup!);
		await started;

		const bridgeCall = vi.mocked(fetch).mock.calls[1];
		expect(bridgeCall?.[0]).toBe("/auth/descope/v1/outbound/oauth/connect");
		expect(bridgeCall?.[1]).toMatchObject({
			method: "POST",
			credentials: "same-origin",
		});
		expect(JSON.parse(String(bridgeCall?.[1]?.body))).toEqual({
			appId: "acme-api",
			options: { redirectUrl: `${ORIGIN}/oauth/callback` },
		});
	});

	it("opens Add account synchronously before creating its slot and routes the exact result", async () => {
		createInstanceMock.mockImplementationOnce(async () => {
			expect(open).toHaveBeenCalledOnce();
			return { id: "11111111-1111-4111-8111-111111111111" };
		});
		const started = startNamedOauthConnect({ appId: "acme-api" });
		expect(open).toHaveBeenCalledOnce();
		expect(createInstanceMock).toHaveBeenCalledWith({
			appId: "acme-api",
			label: "Account",
			scope: "user",
		});
		await flush();
		const flow = JSON.parse(popup!.sessionStorage.getItem(CONNECT_FLOW_KEY)!);
		expect(flow.connectionInstanceId).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
		expect(
			JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)),
		).toMatchObject({
			appId: "acme-api",
			connectionInstanceId: flow.connectionInstanceId,
		});
		const settled = vi.fn();
		started.then(settled);
		postCompletion(ORIGIN, popup!, { connectionInstanceId: "wrong-slot" });
		postCompletion(ORIGIN, popup!, { connectionInstanceId: undefined });
		await flush();
		expect(settled).not.toHaveBeenCalled();
		postCompletion(ORIGIN, popup!);
		await expect(started).resolves.toEqual({
			connectionInstanceId: flow.connectionInstanceId,
		});
	});

	it("does not report blocked-popup navigation as completed sign-in", async () => {
		popup = null;
		await expect(
			startNamedOauthConnect({ appId: "acme-api", label: " Work " }),
		).resolves.toBeUndefined();
		expect(createInstanceMock).toHaveBeenCalledWith({
			appId: "acme-api",
			label: "Work",
			scope: "user",
		});
		expect(location.href).toBe(CONSENT_URL);
	});

	it("closes the blank popup when slot creation fails without starting OAuth", async () => {
		createInstanceMock.mockRejectedValueOnce(new Error("No slot available"));
		await expect(startNamedOauthConnect({ appId: "acme-api" })).rejects.toThrow(
			"No slot available",
		);
		expect(popup!.closed).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
		expect(disconnectProviderMock).not.toHaveBeenCalled();
	});

	it("retains a cancelled slot for retry without deleting a possibly written grant", async () => {
		const started = startNamedOauthConnect({ appId: "acme-api" });
		await flush();
		postFailure(ORIGIN, popup!, "consent_denied");
		await expect(started).rejects.toThrow("cancelled or denied");
		expect(createInstanceMock).toHaveBeenCalledOnce();
		expect(disconnectProviderMock).not.toHaveBeenCalled();
	});

	it("does not force navigation after the person closes the blank Add account popup", async () => {
		const started = startNamedOauthConnect({ appId: "acme-api" });
		popup!.close();
		await expect(started).rejects.toThrow(CONNECT_POPUP_ABANDONED_REASON);
		expect(fetch).not.toHaveBeenCalled();
		expect(location.href).toBe(`${ORIGIN}/apps`);
	});

	it("falls back without completion if the named slot cannot be saved in popup storage", async () => {
		const initialSet = popup!.sessionStorage.setItem;
		let writes = 0;
		popup!.sessionStorage.setItem = (key, value) => {
			if (++writes > 1) throw new Error("Storage denied");
			return initialSet(key, value);
		};
		await expect(
			startNamedOauthConnect({ appId: "acme-api" }),
		).resolves.toBeUndefined();
		expect(popup!.closed).toBe(true);
		expect(location.href).toBe(CONSENT_URL);
	});
	it("keeps a named account selector in its independent popup and Worker request", async () => {
		const connectionInstanceId = "11111111-1111-4111-8111-111111111111";
		const started = startOauthConnect({
			appId: "acme-api",
			effectiveScope: "user",
			connectionInstanceId,
		});
		await flush();
		expect(
			JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)),
		).toEqual({
			appId: "acme-api",
			connectionInstanceId,
			options: { redirectUrl: `${ORIGIN}/oauth/callback` },
		});
		expect(
			JSON.parse(popup!.sessionStorage.getItem(CONNECT_FLOW_KEY)!),
		).toMatchObject({ connectionInstanceId });
		postCompletion(ORIGIN, popup!);
		await started;
	});

	it("pins a tenant-owned connection to the selected Descope tenant", async () => {
		const started = startOauthConnect({
			appId: "acme-api",
			effectiveScope: "tenant",
		});
		await flush();
		postCompletion(ORIGIN, popup!);
		await started;

		const bridgeCall = vi.mocked(fetch).mock.calls[1];
		expect(JSON.parse(String(bridgeCall?.[1]?.body))).toEqual({
			appId: "acme-api",
			tenantId: "T-acme",
			tenantLevel: true,
			options: { redirectUrl: `${ORIGIN}/oauth/callback` },
		});
	});

	it("routes CIMD providers through the API-native callback", async () => {
		const started = startOauthConnect({
			appId: "firecrawl",
			effectiveScope: "tenant",
			registrationMode: "cimd",
		});
		await flush();
		postCompletion(ORIGIN, popup!);
		await started;

		expect(initiateConnectionMock).toHaveBeenCalledWith({
			appId: "firecrawl",
			redirectUri: `${ORIGIN}/oauth/callback`,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(popup?.location.href).toBe(CONSENT_URL);
	});

	it("does not silently turn a personal CIMD request into an organization grant", async () => {
		await expect(
			startOauthConnect({
				appId: "firecrawl",
				effectiveScope: "user",
				registrationMode: "cimd",
			}),
		).rejects.toThrow("organization OAuth connection");

		expect(initiateConnectionMock).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(popup?.closed).toBe(true);
	});

	it("fails closed before Descope when the workspace session is absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ authenticated: false })),
		);

		await expect(
			startOauthConnect({ appId: "acme-api", effectiveScope: "user" }),
		).rejects.toThrow("sign-in must be refreshed");
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
		// The placeholder consent window must not be left orphaned on the desktop.
		expect(popup?.closed).toBe(true);
	});

	it("drives the consent URL into a popup and keeps the caller's page", async () => {
		const started = startOauthConnect({
			appId: "acme-api",
			effectiveScope: "user",
		});
		await flush();

		// Opened synchronously inside the click, before any await.
		expect(open).toHaveBeenCalledWith(
			"",
			expect.stringMatching(/^tedix-oauth-connect-/),
			"popup=yes,width=560,height=760",
		);
		expect(popup?.location.href).toBe(CONSENT_URL);
		expect(location.href).toBe(`${ORIGIN}/apps`);

		postCompletion(ORIGIN, popup!);
		await expect(started).resolves.toBeUndefined();
	});

	it("falls back to a top-level redirect when the browser blocks the popup", async () => {
		popup = null;

		await startOauthConnect({ appId: "acme-api", effectiveScope: "user" });

		expect(location.href).toBe(CONSENT_URL);
		expect(window.sessionStorage.getItem(CONNECT_RETURN_TO_KEY)).toBe(
			"/apps?panel=connections",
		);
	});

	it("ignores a completion message from a foreign origin and reports abandonment", async () => {
		const started = startOauthConnect({
			appId: "acme-api",
			effectiveScope: "user",
		});
		const settled = vi.fn();
		started.then(settled, settled);
		await flush();

		postCompletion("https://evil.example.com", popup!);
		await flush();
		expect(settled).not.toHaveBeenCalled();

		popup?.close();
		await expect(started).rejects.toThrow(CONNECT_POPUP_ABANDONED_REASON);
	});

	it("reports a correlated provider failure instead of popup abandonment", async () => {
		const started = startOauthConnect({
			appId: "cloudflare",
			effectiveScope: "tenant",
			registrationMode: "cimd",
		});
		await flush();

		postFailure(ORIGIN, popup!, "issuer_validation_failed");

		await expect(started).rejects.toThrow("authorization-server identity");
		expect(popup?.closed).toBe(true);
	});

	it("settles concurrent flows only for their exact popup and correlation", async () => {
		const first = popup!;
		const second = fakePopup();
		open.mockReturnValueOnce(first).mockReturnValueOnce(second);
		const one = startOauthConnect({ appId: "one", effectiveScope: "user" });
		const two = startOauthConnect({ appId: "two", effectiveScope: "tenant" });
		const firstDone = vi.fn();
		const secondDone = vi.fn();
		one.then(firstDone);
		two.then(secondDone);
		await flush();
		expect(open.mock.calls[0]?.[1]).not.toBe(open.mock.calls[1]?.[1]);
		postCompletion(ORIGIN, first, { nonce: "wrong" });
		postCompletion(ORIGIN, first, { appId: "two" });
		postCompletion(ORIGIN, first, { effectiveScope: "tenant" });
		postCompletion(
			ORIGIN,
			second,
			JSON.parse(first.sessionStorage.getItem(CONNECT_FLOW_KEY)!),
		);
		await flush();
		expect(firstDone).not.toHaveBeenCalled();
		expect(secondDone).not.toHaveBeenCalled();
		postCompletion(ORIGIN, first);
		await one;
		expect(secondDone).not.toHaveBeenCalled();
		postCompletion(ORIGIN, second);
		await two;
	});

	it("uses top-level consent if popup correlation cannot be stored", async () => {
		popup!.sessionStorage.setItem = () => {
			throw new Error("Storage denied");
		};
		await startOauthConnect({ appId: "one", effectiveScope: "user" });
		expect(popup!.closed).toBe(true);
		expect(location.href).toBe(CONSENT_URL);
	});
});

describe("takeConnectionFlow", () => {
	it("consumes popup correlation once and rejects malformed records", () => {
		const flow = { nonce: "one", appId: "app", effectiveScope: "user" };
		window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		expect(takeConnectionFlow()).toEqual(flow);
		expect(takeConnectionFlow()).toBeNull();
		for (const value of ["broken", "null", '{"nonce":"one"}']) {
			window.sessionStorage.setItem(CONNECT_FLOW_KEY, value);
			expect(takeConnectionFlow()).toBeNull();
			expect(window.sessionStorage.getItem(CONNECT_FLOW_KEY)).toBeNull();
		}
	});
});

function ListenerHarness() {
	useConnectionCompleteListener();
	return null;
}

describe("useConnectionCompleteListener", () => {
	let container: HTMLDivElement;
	let root: Root;
	let queryClient: QueryClient;
	let invalidate: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubGlobal("location", { origin: ORIGIN });
		queryClient = new QueryClient();
		invalidate = vi.spyOn(queryClient, "invalidateQueries");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(
				createElement(
					QueryClientProvider,
					{ client: queryClient },
					createElement(ListenerHarness),
				),
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("invalidates the connections domain when the popup reports completion", () => {
		act(() => postCompletion(ORIGIN));

		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQueryKeys.connections(),
		});
	});

	it("ignores a completion message from a foreign origin", () => {
		act(() => postCompletion("https://evil.example.com"));

		expect(invalidate).not.toHaveBeenCalled();
	});
});
