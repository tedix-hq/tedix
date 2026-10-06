/**
 * The /oauth/callback route is intentionally presentation-only. Descope writes
 * the grant at its native user or tenant level before returning here.
 */

import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const callbackState = vi.hoisted(() => ({
	connectError: undefined as string | undefined,
	status: undefined as string | undefined,
	reason: undefined as string | undefined,
	provider: undefined as string | undefined,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: { component: () => unknown }) => ({
		options,
		useSearch: () => callbackState,
	}),
}));

import { Route } from "./_session/_chrome-free/oauth.callback";
import {
	CONNECT_FLOW_KEY,
	CONNECTION_COMPLETE_MESSAGE,
	CONNECTION_FAILED_MESSAGE,
} from "@/lib/connections-actions";

describe("oauth callback guards", () => {
	it("keeps connectError through search validation, even beside bad fields", () => {
		const validate = Route.options.validateSearch as (
			search: Record<string, unknown>,
		) => Record<string, unknown>;
		expect(validate({ connectError: "reauth_required" }).connectError).toBe(
			"reauth_required",
		);
		// A malformed sibling must not reset the whole search (and with it the
		// failed-connect guard).
		expect(
			validate({ connectError: "reauth_required", status: 42 }).connectError,
		).toBe("reauth_required");
		expect(validate({ connectError: 42 }).connectError).toBeUndefined();
	});
});

describe("oauth callback correlation", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		callbackState.connectError = undefined;
		callbackState.status = undefined;
		callbackState.reason = undefined;
		callbackState.provider = undefined;
		window.sessionStorage.clear();
	});

	it.each([false, true])(
		"only sends its stored flow and closes through StrictMode (error=%s)",
		async (failed) => {
			vi.useFakeTimers();
			(
				globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
			).IS_REACT_ACT_ENVIRONMENT = true;
			const postMessage = vi.fn();
			const close = vi.fn();
			// Descope already wrote the grant: the callback itself makes no
			// request, so it cannot promote a credential to the tenant.
			const fetchSpy = vi.fn();
			vi.stubGlobal("fetch", fetchSpy);
			vi.stubGlobal("opener", { postMessage });
			vi.stubGlobal("close", close);
			const flow = {
				nonce: "unique",
				appId: "provider",
				effectiveScope: "tenant",
			};
			window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
			callbackState.connectError = failed ? "reauth_required" : undefined;
			const container = document.createElement("div");
			const root = createRoot(container);
			try {
				await (
					Route.options.component as { preload?: () => Promise<unknown> }
				).preload?.();
				await act(async () =>
					root.render(
						createElement(
							StrictMode,
							null,
							createElement(Route.options.component!),
						),
					),
				);
				if (failed) {
					expect(container.querySelector('[role="alert"]')).not.toBeNull();
					expect(
						container.querySelector('a[href="/admin/connections"]')
							?.textContent,
					).toContain("Return to connections");
					expect(postMessage).toHaveBeenCalledWith(
						{
							type: CONNECTION_FAILED_MESSAGE,
							...flow,
							reason: "reauth_required",
						},
						window.location.origin,
					);
				} else {
					expect(container.querySelector('[role="status"]')).not.toBeNull();
					expect(container.textContent).toContain("Authorization returned");
					expect(container.textContent).toContain(
						"refreshing the provider status",
					);
					expect(container.textContent).not.toContain("Connected");
					expect(postMessage).toHaveBeenCalledWith(
						{ type: CONNECTION_COMPLETE_MESSAGE, ...flow },
						window.location.origin,
					);
					expect(window.sessionStorage.getItem(CONNECT_FLOW_KEY)).toBeNull();
				}
				act(() => vi.advanceTimersByTime(2000));
				expect(close).toHaveBeenCalledTimes(failed ? 0 : 1);
				expect(fetchSpy).not.toHaveBeenCalled();
			} finally {
				act(() => root.unmount());
			}
		},
	);

	it("keeps a native CIMD failure visible and reports its reason", async () => {
		vi.useFakeTimers();
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		const postMessage = vi.fn();
		const close = vi.fn();
		vi.stubGlobal("opener", { postMessage });
		vi.stubGlobal("close", close);
		callbackState.status = "error";
		callbackState.reason = "vault_upload_failed";
		callbackState.provider = "cloudflare";
		const flow = {
			nonce: "cloudflare-flow",
			appId: "cloudflare",
			effectiveScope: "tenant",
		};
		window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await (
				Route.options.component as { preload?: () => Promise<unknown> }
			).preload?.();
			await act(async () =>
				root.render(createElement(Route.options.component!)),
			);

			expect(container.textContent).toContain("Not connected");
			expect(container.textContent).toContain("credential vault");
			expect(postMessage).toHaveBeenCalledWith(
				{
					type: CONNECTION_FAILED_MESSAGE,
					...flow,
					reason: "vault_upload_failed",
				},
				window.location.origin,
			);
			act(() => vi.advanceTimersByTime(2000));
			expect(close).not.toHaveBeenCalled();
		} finally {
			act(() => root.unmount());
		}
	});
});
