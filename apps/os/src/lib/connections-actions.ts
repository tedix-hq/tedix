/**
 * Shared connect/disconnect logic for the two connections surfaces — the Apps
 * page panel (daily work) and /admin/connections (governance). One module so
 * the OAuth handoff, the disconnect path, the completion listener, and the
 * scope computation cannot drift between them.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConnectionProvider } from "@tedix/api-contract/schemas/connections";
import { useEffect } from "react";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

/** The message the /oauth/callback popup posts back to its opener. */
export const CONNECTION_COMPLETE_MESSAGE = "tedix:connection-complete";

/** The message a failed /oauth/callback popup posts back to its opener. */
export const CONNECTION_FAILED_MESSAGE = "tedix:connection-failed";

/** Convert callback reason codes into actionable, user-safe copy. */
export function connectionFailureMessage(reason?: string): string {
	switch (reason) {
		case "reauth_required":
			return "Your sign-in needs refreshing before this provider can be connected.";
		case "account_mismatch":
			return "Your central Tedix sign-in is a different person. Sign in there as the account shown in this workspace, then retry.";
		case "identity_required":
			return "We could not confirm your workspace identity. Refresh, sign in again, and retry.";
		case "issuer_validation_failed":
			return "The provider returned an authorization-server identity that did not match its registered metadata.";
		case "token_exchange_failed":
			return "The provider returned authorization, but Tedix could not exchange it for a token.";
		case "vault_upload_failed":
			return "The provider token could not be saved to this organization's credential vault.";
		case "consent_denied":
			return "The provider authorization was cancelled or denied.";
		default:
			return "The provider could not be connected.";
	}
}

/** Popup-local correlation survives provider navigation without entering URLs. */
export const CONNECT_FLOW_KEY = "tedix:oauth-flow";

interface ConnectionFlow {
	nonce: string;
	appId: string;
	effectiveScope: "tenant" | "user";
	connectionInstanceId?: string;
}

/** Consume only the correlation written before this popup left our origin. */
export function takeConnectionFlow(): ConnectionFlow | null {
	try {
		const stored = window.sessionStorage.getItem(CONNECT_FLOW_KEY);
		window.sessionStorage.removeItem(CONNECT_FLOW_KEY);
		if (!stored) return null;
		const flow = JSON.parse(stored) as Partial<ConnectionFlow> | null;
		if (
			typeof flow?.nonce === "string" &&
			flow.nonce.length > 0 &&
			typeof flow.appId === "string" &&
			flow.appId.length > 0 &&
			(flow.effectiveScope === "tenant" || flow.effectiveScope === "user")
		)
			return flow as ConnectionFlow;
	} catch {
		// An absent or unreadable flow cannot complete another caller's request.
	}
	return null;
}

const CONNECT_POPUP_FEATURES = "popup=yes,width=560,height=760";

/** How often the opener checks whether the consent window was abandoned. */
const CONNECT_POPUP_POLL_MS = 250;

export const CONNECT_POPUP_ABANDONED_REASON =
	"The connection window closed before the provider finished connecting.";

/**
 * Where the callback route should return to when consent had to run as a
 * top-level navigation (popup blocked). Session-scoped so a stale entry cannot
 * outlive the tab that wrote it.
 */
export const CONNECT_RETURN_TO_KEY = "tedix:oauth-return-to";

/** Remember the page the connect started from before leaving it. */
function rememberConnectReturnTo(): void {
	try {
		window.sessionStorage.setItem(
			CONNECT_RETURN_TO_KEY,
			`${window.location.pathname}${window.location.search}`,
		);
	} catch {
		// Private-mode storage denial only costs the return trip.
	}
}

/**
 * Whether the caller may actually connect or disconnect.
 *
 * Shared credentials and API keys are organization resources, so they require
 * `integrations:manage`. A user-scoped OAuth credential belongs only to the
 * signed-in person; the API permits it with `apps:read` plus that human's
 * subject-bound session.
 */
export function useCanManageConnections(): boolean {
	const context = useOsOperationalContext();
	return (
		context.data?.authority.permissions.includes("integrations:manage") ?? false
	);
}

/** Whether the signed-in human may connect or remove their own OAuth grant. */
export function useCanManagePersonalOauthConnections(): boolean {
	const context = useOsOperationalContext();
	return context.data?.authority.permissions.includes("apps:read") ?? false;
}

export function useCanBindPersonalAccounts(): boolean {
	const context = useOsOperationalContext();
	return context.data?.authority.permissions.includes("apps:update") ?? false;
}

export const CONNECTIONS_MANAGE_DENIED_REASON =
	"Organization connections and API keys require the Manage integrations permission.";

export const PERSONAL_OAUTH_MANAGE_DENIED_REASON =
	"Managing your personal OAuth connection requires workspace access.";

/**
 * The credential scope an OAuth connect should request when the caller did not
 * pick one: the provider's recommendation when supported, else the widest
 * supported scope, defaulting to tenant.
 */
export function effectiveConnectionScope(
	provider: ConnectionProvider | undefined,
	tokenScope?: "tenant" | "user",
): "tenant" | "user" {
	return (
		tokenScope ??
		(provider?.supportedScopes?.includes(provider.recommendedScope)
			? provider.recommendedScope
			: provider?.supportedScopes?.includes("user")
				? "user"
				: "tenant")
	);
}

/**
 * Open the consent window. It must be opened synchronously inside the click
 * that started the connect — the session-broker check and the bridge request
 * both happen after this point, and a `window.open` past those awaits is
 * outside the user-gesture window every browser requires.
 */
function openConnectPopup(flow: ConnectionFlow): Window | null {
	let popup: Window | null = null;
	try {
		popup = window.open(
			"",
			`tedix-oauth-connect-${flow.nonce}`,
			CONNECT_POPUP_FEATURES,
		);
		popup?.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
		return popup;
	} catch {
		popup?.close();
		return null;
	}
}

/**
 * Resolve when the callback route posts its completion message from our own
 * origin; reject when the person closes the consent window instead. A popup
 * navigated to the provider is cross-origin, so `closed` polling is the only
 * abandonment signal available to the opener.
 */
function awaitConnectionComplete(
	popup: Window,
	flow: ConnectionFlow,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const settle = () => {
			window.removeEventListener("message", onMessage);
			clearInterval(poll);
		};
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) return;
			if (event.source !== popup) return;
			const message = event.data as
				| (Partial<ConnectionFlow> & { type?: string; reason?: string })
				| null;
			if (
				(message?.type !== CONNECTION_COMPLETE_MESSAGE &&
					message?.type !== CONNECTION_FAILED_MESSAGE) ||
				message.nonce !== flow.nonce ||
				message.appId !== flow.appId ||
				message.effectiveScope !== flow.effectiveScope ||
				message.connectionInstanceId !== flow.connectionInstanceId
			)
				return;
			settle();
			if (message.type === CONNECTION_FAILED_MESSAGE) {
				reject(new Error(connectionFailureMessage(message.reason)));
				return;
			}
			resolve();
		};
		const poll = setInterval(() => {
			if (!popup.closed) return;
			settle();
			reject(new Error(CONNECT_POPUP_ABANDONED_REASON));
		}, CONNECT_POPUP_POLL_MS);
		window.addEventListener("message", onMessage);
	});
}

/**
 * Start an OAuth connection through the same-origin Worker bridge.
 *
 * Browser JavaScript sends only provider and callback metadata; the Worker
 * resolves the verified HttpOnly product session and creates the authorization-host handoff.
 * This keeps the product broker as the sole session owner while using
 * Descope's native user/tenant ownership semantics.
 *
 * Consent runs in a popup so the caller keeps the page — and the conversation —
 * it started from, and resolves only once `/oauth/callback` posts back. When
 * the browser blocks the popup the flow degrades to a top-level navigation,
 * which the callback route still handles.
 */
export async function startOauthConnect(input: {
	appId: string;
	effectiveScope: "tenant" | "user";
	registrationMode?: ConnectionProvider["registrationMode"];
	connectionInstanceId?: string;
}): Promise<void> {
	const flow: ConnectionFlow = { ...input, nonce: crypto.randomUUID() };
	const popup = openConnectPopup(flow);
	try {
		const authorizeUrl = await resolveAuthorizeUrl(input);
		if (!popup || popup.closed) {
			rememberConnectReturnTo();
			window.location.href = authorizeUrl;
			return;
		}
		try {
			popup.location.href = authorizeUrl;
		} catch {
			popup.close();
			rememberConnectReturnTo();
			window.location.href = authorizeUrl;
			return;
		}
		await awaitConnectionComplete(popup, flow);
	} catch (error) {
		popup?.close();
		throw error;
	}
}

/**
 * Start sign-in directly from an Add account click, without a naming step.
 * Open before creating the slot to retain the browser's user gesture. The slot
 * survives cancellation: a provider may already have written its grant, so
 * cleanup must never delete it based only on a popup result. Inventory, not
 * this callback, determines whether the account is actually connected.
 */
export async function startNamedOauthConnect(input: {
	appId: string;
	effectiveScope?: "user" | "tenant";
	label?: string;
}): Promise<{ connectionInstanceId: string } | undefined> {
	const flow: ConnectionFlow = {
		appId: input.appId,
		effectiveScope: input.effectiveScope ?? "user",
		nonce: crypto.randomUUID(),
	};
	let popup = openConnectPopup(flow);
	try {
		const instance = await osApi.connections.createConnectionInstance({
			appId: input.appId,
			label: input.label?.trim() || "Account",
			scope: flow.effectiveScope,
		});
		flow.connectionInstanceId = instance.id;
		if (popup?.closed) throw new Error(CONNECT_POPUP_ABANDONED_REASON);
		if (popup) {
			try {
				popup.sessionStorage.setItem(CONNECT_FLOW_KEY, JSON.stringify(flow));
			} catch {
				popup.close();
				popup = null;
			}
		}
		const authorizeUrl = await resolveAuthorizeUrl(flow);
		if (popup?.closed) throw new Error(CONNECT_POPUP_ABANDONED_REASON);
		if (!popup) {
			rememberConnectReturnTo();
			window.location.href = authorizeUrl;
			return undefined;
		}
		try {
			popup.location.href = authorizeUrl;
		} catch {
			popup.close();
			rememberConnectReturnTo();
			window.location.href = authorizeUrl;
			return undefined;
		}
		await awaitConnectionComplete(popup, flow);
		return { connectionInstanceId: instance.id };
	} catch (error) {
		popup?.close();
		throw error;
	}
}

/**
 * Exchange the verified product session for the provider's authorize URL.
 *
 * Call the narrow bridge directly instead of booting Descope's browser SDK.
 * The Worker resolves the verified HttpOnly product session and creates the
 * broker handoff. One ordinary fetch also keeps SDK initialization or
 * fingerprinting out of this user gesture.
 */
async function resolveAuthorizeUrl(input: {
	appId: string;
	effectiveScope: "tenant" | "user";
	registrationMode?: ConnectionProvider["registrationMode"];
	connectionInstanceId?: string;
}): Promise<string> {
	const callbackTarget = new URL(`${window.location.origin}/oauth/callback`);
	if (input.registrationMode === "cimd") {
		if (input.effectiveScope !== "tenant") {
			throw new Error(
				"This provider uses an organization OAuth connection and cannot be connected as a personal account.",
			);
		}
		const result = await osApi.connections.initiateConnection({
			appId: input.appId,
			redirectUri: callbackTarget.toString(),
		});
		return result.redirectUrl;
	}
	const response = await fetch("/auth/session-broker/status", {
		credentials: "same-origin",
	});
	const status = (await response.json()) as {
		authenticated?: boolean;
		tenantId?: unknown;
	};
	if (!response.ok || status.authenticated !== true) {
		throw new Error("Your Tedix sign-in must be refreshed before connecting.");
	}
	const tenantConnect = input.effectiveScope === "tenant";
	if (
		tenantConnect &&
		(typeof status.tenantId !== "string" || status.tenantId.length === 0)
	) {
		throw new Error("This workspace has no Descope tenant connection target.");
	}
	const connectResponse = await fetch(
		"/auth/descope/v1/outbound/oauth/connect",
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				appId: input.appId,
				...(input.connectionInstanceId
					? { connectionInstanceId: input.connectionInstanceId }
					: {}),
				...(tenantConnect
					? { tenantId: status.tenantId as string, tenantLevel: true }
					: {}),
				options: { redirectUrl: callbackTarget.toString() },
			}),
		},
	);
	const result = (await connectResponse.json()) as { url?: unknown };
	if (
		!connectResponse.ok ||
		typeof result.url !== "string" ||
		result.url.length === 0
	) {
		throw new Error("Descope could not start the provider connection.");
	}
	return result.url;
}

/**
 * Listen for the OAuth popup's completion message and refresh the domain.
 * Strictly same-origin: any other source is ignored.
 */
export function useConnectionCompleteListener(): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) return;
			if (event.data?.type === CONNECTION_COMPLETE_MESSAGE) {
				void queryClient.invalidateQueries({
					queryKey: osQueryKeys.connections(),
				});
			}
		};
		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [queryClient]);
}

/**
 * Disconnect a credential and refresh the domain. Errors stay in the mutation
 * for the surface to render — OS mounts no global toaster.
 */
export function useDisconnectConnection(handlers?: { onSuccess?: () => void }) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			appId: string;
			tokenScope: "tenant" | "user";
			connectionInstanceId?: string;
		}) =>
			osApi.connections.disconnectProvider({
				appId: params.appId,
				tokenScope: params.tokenScope,
				...(params.connectionInstanceId
					? { connectionInstanceId: params.connectionInstanceId }
					: {}),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.connections(),
			});
			handlers?.onSuccess?.();
		},
	});
}
