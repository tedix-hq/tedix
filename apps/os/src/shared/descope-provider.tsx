/**
 * Scoped in-OS Descope SDK mount — the ONE canonical broker-safe provider.
 *
 * The Descope React SDK components (flows and end-user widgets) read their
 * projectId/baseUrl from the SDK's React context, so every mount needs an
 * `AuthProvider` ancestor. The OS mounts that provider LOCALLY around each
 * Descope surface — never app-wide — and always through this module, so the
 * broker-safe prop set cannot drift between surfaces.
 *
 * Broker-safe means exactly two pinned props:
 *
 * - `persistTokens={false}`: the SDK stores nothing and rotates nothing.
 *   Descope's server sets the refresh token as an HttpOnly `DSR` cookie on
 *   auth.tedix.dev (project setting "Manage in cookies" + custom domain), the
 *   SDK's fetches carry it automatically (`credentials: "include"` is the
 *   core-sdk default and os→auth is same-site), and the Tedix session broker
 *   is the single refresh/rotation owner under its own `TEDIX_DSR` cookie.
 *   With `persistTokens` false the SDK ignores `refreshTokenViaCookie` and
 *   `sessionTokenViaCookie` entirely, so never add those props here — they
 *   are dead config that misleads readers into thinking the client owns
 *   token transport.
 * - `autoRefresh={false}`: only the broker rotates; a second client-side
 *   rotator would trip Descope refresh-family replay protection (E064006).
 *
 * The zero-account local lane never mounts Descope at all (same guard as
 * apps/os/src/components/session-boundary.tsx).
 */

import { AuthProvider } from "@descope/react-sdk/flows";
import { resolveOsTenant } from "@/shared/os-tenant";
import type { ReactNode } from "react";

/** Zero-account local lane: a local host mounts no Descope at all. */
export function isLocalOsHost(): boolean {
	return resolveOsTenant(window.location.hostname).kind === "local";
}

/**
 * The canonical broker-safe Descope provider. Every OS Descope surface
 * (login, consent, invitation, step-up, end-user widgets) mounts this —
 * never a hand-rolled `AuthProvider`.
 */
export function TedixDescopeProvider({ children }: { children: ReactNode }) {
	const baseStaticUrl = __DESCOPE_BASE_URL__
		? `${__DESCOPE_BASE_URL__.replace(/\/+$/, "")}/pages`
		: undefined;
	return (
		<AuthProvider
			projectId={__DESCOPE_PROJECT_ID__}
			baseUrl={__DESCOPE_BASE_URL__ || undefined}
			baseStaticUrl={baseStaticUrl}
			autoRefresh={false}
			persistTokens={false}
		>
			{children}
		</AuthProvider>
	);
}

export function DescopeSdkBoundary({
	children,
	fallback = null,
}: {
	children: ReactNode;
	fallback?: ReactNode;
}) {
	if (isLocalOsHost()) return <>{fallback}</>;
	return <TedixDescopeProvider>{children}</TedixDescopeProvider>;
}
