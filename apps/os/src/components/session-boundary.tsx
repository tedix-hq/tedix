import { resolveOsTenant } from "@/shared/os-tenant";
import type { ReactNode } from "react";
import { useEffect } from "react";
import {
	disposeOsCapabilities,
	installOsCapabilityPageLifecycle,
	installOsRealtimeWakeProbes,
} from "@/lib/capability-lifecycle";
import { OsIdentityContext } from "@/lib/os-identity-context";
import {
	type BrokerPrefix,
	clearSilentOsResumeAttempt,
	hasAttemptedSilentOsResume,
	isDescopeFlowContinuation,
	markSilentOsResumeAttempted,
	shouldAttemptSilentOsResume,
	useOsBrokerSessionStatus,
} from "@/shared/session-status";
import { TedixBrandMark } from "@/shared/tedix-brand";

function OsCapabilityLifecycleBoundary({ children }: { children: ReactNode }) {
	useEffect(() => {
		const removePageLifecycle = installOsCapabilityPageLifecycle(window);
		const removeWakeProbes = installOsRealtimeWakeProbes(
			window,
			() => document.visibilityState,
		);
		return () => {
			removeWakeProbes();
			removePageLifecycle();
			disposeOsCapabilities();
		};
	}, []);
	return children;
}

function BrokerSessionBoundary({
	children,
	brokerPrefix,
	renderLogin,
}: {
	children: ReactNode;
	brokerPrefix: BrokerPrefix;
	renderLogin: (brokerPrefix: BrokerPrefix) => ReactNode;
}) {
	const { status, redirectStarted, resumeThroughBroker } =
		useOsBrokerSessionStatus(brokerPrefix);
	// Silent session resume: a browser holding a valid central Descope refresh
	// cookie but no host product session gets ONE unattended pass through the
	// broker before any login form renders. Loop safety is structural, not
	// hopeful: a failed pass lands on the central login page or returns with
	// `?error` (which shouldAttemptSilentOsResume rejects), and the
	// sessionStorage guard caps the attempt at once per tab session regardless.
	const hasBrokerError = new URL(window.location.href).searchParams.has(
		"error",
	);
	// A magic-link continuation must mount the login flow immediately: the
	// pending Descope execution verifies only once the flow web component
	// resumes it, and its one-time token is minutes-lived. Any broker bounce
	// first would strip the parameters and discard the authentication.
	const flowContinuation = isDescopeFlowContinuation(window.location.href);
	const silentResume =
		status !== null &&
		shouldAttemptSilentOsResume(
			status,
			hasBrokerError || flowContinuation,
			hasAttemptedSilentOsResume(window.sessionStorage),
		);

	useEffect(() => {
		if (!status) return;
		if (status.authenticated) {
			// A working session re-arms the guard so the NEXT signed-out visit in
			// this tab (e.g. after logout) gets its own single silent attempt.
			clearSilentOsResumeAttempt(window.sessionStorage);
			return;
		}
		if (!silentResume) return;
		markSilentOsResumeAttempted(window.sessionStorage);
		resumeThroughBroker();
	}, [resumeThroughBroker, silentResume, status]);

	if (flowContinuation && !status?.authenticated) {
		return renderLogin(brokerPrefix);
	}
	if (!status || status.renewalRequired || redirectStarted || silentResume) {
		return (
			<main className="centered-state" aria-busy="true">
				<TedixBrandMark />
				<p>Restoring your Tedix session…</p>
			</main>
		);
	}
	if (!status.authenticated) {
		return renderLogin(brokerPrefix);
	}
	return (
		<OsIdentityContext.Provider
			value={status.user ?? { name: "Tedix member", email: "" }}
		>
			{children}
		</OsIdentityContext.Provider>
	);
}

export function SessionBoundary({
	children,
	broker = "product",
	renderLogin,
}: {
	children: ReactNode;
	broker?: "product" | "cli";
	renderLogin: (brokerPrefix: BrokerPrefix) => ReactNode;
}) {
	// Zero-account local lane: a local host mounts no Descope at all — the
	// Vite dev middleware answers /api/* from fixtures and identity is
	// synthetic, so the boundary is a pass-through. (Session-lifecycle work
	// for deployed hosts builds on top of this guard; keep it first.)
	const host = resolveOsTenant(window.location.hostname);
	if (host.kind === "local") {
		return (
			<OsCapabilityLifecycleBoundary>{children}</OsCapabilityLifecycleBoundary>
		);
	}
	const brokerPrefix =
		broker === "cli" ? "/cli/session-broker" : "/auth/session-broker";
	return (
		<OsCapabilityLifecycleBoundary>
			<BrokerSessionBoundary
				brokerPrefix={brokerPrefix}
				renderLogin={renderLogin}
			>
				{children}
			</BrokerSessionBoundary>
		</OsCapabilityLifecycleBoundary>
	);
}
