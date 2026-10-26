/**
 * The /oauth/callback route never promotes a credential by itself. Descope
 * writes the grant at its native user or tenant level before returning here;
 * the connection counts as complete only once this page redeems the staged
 * ticket over the signed-in person's own session.
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

async function render(strict = true) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	const root = createRoot(container);
	await (
		Route.options.component as { preload?: () => Promise<unknown> }
	).preload?.();
	await act(async () =>
		root.render(
			strict
				? createElement(
						StrictMode,
						null,
						createElement(Route.options.component!),
					)
				: createElement(Route.options.component!),
		),
	);
	return { container, root };
}

describe("oauth callback correlation", () => {
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

	it("redeems the staged ticket once over the signed-in session, then reports its flow and closes", async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const close = vi.fn();
		vi.stubGlobal("opener", { postMessage });
		vi.stubGlobal("close", close);
		redeem.mockResolvedValue({ appId: "provider", recorded: false });
		const flow = {
			nonce: "unique",
			appId: "provider",
			effectiveScope: "tenant",
			ticket: "raw-ticket",
		};
		window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		const { container, root } = await render();
		try {
			await act(async () => {});
			expect(redeem).toHaveBeenCalledTimes(1);
			expect(redeem).toHaveBeenCalledWith({ ticket: "raw-ticket" });
			expect(container.querySelector('[role="status"]')).not.toBeNull();
			expect(container.textContent).toContain("Authorization returned");
			expect(postMessage).toHaveBeenCalledTimes(1);
			expect(postMessage).toHaveBeenCalledWith(
				{
					type: CONNECTION_COMPLETE_MESSAGE,
					nonce: "unique",
					appId: "provider",
					effectiveScope: "tenant",
				},
				window.location.origin,
			);
			expect(window.sessionStorage.getItem(CONNECT_FLOW_KEY)).toBeNull();
			act(() => vi.advanceTimersByTime(2000));
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			act(() => root.unmount());
		}
	});

	it("reports a provider failure without redeeming anything", async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const close = vi.fn();
		vi.stubGlobal("opener", { postMessage });
		vi.stubGlobal("close", close);
		const flow = {
			nonce: "unique",
			appId: "provider",
			effectiveScope: "tenant",
			ticket: "raw-ticket",
		};
		window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		callbackState.connectError = "reauth_required";
		const { container, root } = await render();
		try {
			expect(redeem).not.toHaveBeenCalled();
			expect(container.querySelector('[role="alert"]')).not.toBeNull();
			expect(
				container.querySelector('a[href="/admin/connections"]')?.textContent,
			).toContain("Return to connections");
			expect(postMessage).toHaveBeenCalledWith(
				{
					type: CONNECTION_FAILED_MESSAGE,
					nonce: "unique",
					appId: "provider",
					effectiveScope: "tenant",
					reason: "reauth_required",
				},
				window.location.origin,
			);
			act(() => vi.advanceTimersByTime(2000));
			expect(close).not.toHaveBeenCalled();
		} finally {
			act(() => root.unmount());
		}
	});

	it("never completes a return that carries no staged ticket", async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const close = vi.fn();
		vi.stubGlobal("opener", { postMessage });
		vi.stubGlobal("close", close);
		const flow = { nonce: "unique", appId: "provider", effectiveScope: "user" };
		window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		const { container, root } = await render();
		try {
			await act(async () => {});
			expect(redeem).not.toHaveBeenCalled();
			expect(container.querySelector('[role="alert"]')).not.toBeNull();
			expect(container.textContent).toContain(
				"not started from your own sign-in",
			);
			expect(postMessage).toHaveBeenCalledWith(
				{ type: CONNECTION_FAILED_MESSAGE, ...flow, reason: "ticket_missing" },
				window.location.origin,
			);
			act(() => vi.advanceTimersByTime(2000));
			expect(close).not.toHaveBeenCalled();
		} finally {
			act(() => root.unmount());
		}
	});

	it("keeps a rejected ticket visible and tells the opener", async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const close = vi.fn();
		vi.stubGlobal("opener", { postMessage });
		vi.stubGlobal("close", close);
		redeem.mockRejectedValue(new Error("FORBIDDEN"));
		const flow = {
			nonce: "unique",
			appId: "provider",
			effectiveScope: "user",
			ticket: "someone-elses-ticket",
		};
		window.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		const { container, root } = await render();
		try {
			await act(async () => {});
			expect(container.textContent).toContain("Not connected");
			expect(container.textContent).toContain("started by someone else");
			expect(postMessage).toHaveBeenCalledWith(
				{
					type: CONNECTION_FAILED_MESSAGE,
					nonce: "unique",
					appId: "provider",
					effectiveScope: "user",
					reason: "ticket_rejected",
				},
				window.location.origin,
			);
			act(() => vi.advanceTimersByTime(2000));
			expect(close).not.toHaveBeenCalled();
		} finally {
			act(() => root.unmount());
		}
	});

	it("keeps a native CIMD failure visible and reports its reason", async () => {
		vi.useFakeTimers();
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
		const { container, root } = await render(false);
		try {
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
