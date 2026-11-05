/**
 * Deterministic version of the full-suite interleaving that made
 * -oauth-callback.test.ts flaky: the staged-ticket redemption resolves only
 * once the faked setTimeout queue delivers — exactly what an empty
 * `await act(async () => {})` never waits for. Polling the observable
 * postMessage while advancing the clock inside one act scope lands it.
 */

import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const callbackState = vi.hoisted(() => ({
	connectError: undefined as string | undefined,
	status: undefined as string | undefined,
	reason: undefined as string | undefined,
	provider: undefined as string | undefined,
}));
const redeem = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: { component: () => unknown }) => ({
		options,
		useSearch: () => callbackState,
	}),
}));
vi.mock("@/lib/api", () => ({
	osApi: { connections: { redeemConnectTicket: redeem } },
}));

import { Route } from "./_session/_chrome-free/oauth.callback";
import {
	CONNECT_FLOW_KEY,
	CONNECTION_COMPLETE_MESSAGE,
} from "@/lib/connections-actions";

await (
	Route.options.component as { preload?: () => Promise<unknown> }
).preload?.();

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	redeem.mockReset();
	callbackState.connectError = undefined;
	callbackState.status = undefined;
	callbackState.reason = undefined;
	callbackState.provider = undefined;
	window.sessionStorage.clear();
});

it("delivers the completion even when redemption resolves only after the fake clock delivers it", async () => {
	vi.useFakeTimers();
	const postMessage = vi.fn();
	const close = vi.fn();
	vi.stubGlobal("opener", { postMessage });
	vi.stubGlobal("close", close);
	// A redemption held back by a faked timer stands in for the slow delivery
	// the suite sees under load: the old empty act flush returned before the
	// notification could exist.
	redeem.mockImplementation(
		() =>
			new Promise((resolve) => {
				setTimeout(() => resolve({ appId: "provider", recorded: false }), 80);
			}),
	);
	const flow = {
		nonce: "unique",
		appId: "provider",
		effectiveScope: "tenant",
		ticket: "raw-ticket",
	};
	window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				createElement(
					StrictMode,
					null,
					createElement(Route.options.component!),
				),
			),
		);
		expect(postMessage).not.toHaveBeenCalled();
		await act(async () => {
			for (
				let round = 0;
				round < 200 && postMessage.mock.calls.length === 0;
				round++
			)
				await vi.advanceTimersByTimeAsync(1);
		});
		expect(postMessage).toHaveBeenCalledWith(
			{
				type: CONNECTION_COMPLETE_MESSAGE,
				nonce: "unique",
				appId: "provider",
				effectiveScope: "tenant",
			},
			window.location.origin,
		);
		expect(container.textContent).toContain("Authorization returned");
		act(() => vi.advanceTimersByTime(2000));
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		act(() => root.unmount());
	}
});
