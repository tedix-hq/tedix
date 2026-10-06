import { useCallback, useEffect, useRef, useState } from "react";
import { OS_BROKER_RENEWAL_WINDOW_SECONDS } from "@/auth/broker-session.shared";
import type { OsIdentity } from "@/lib/os-identity-context";

/**
 * Shared session-broker status plumbing for the OS. It owns nothing product- or
 * account-specific: it reads the server-owned broker status, decides when a
 * session must resume, and drives the resume/renewal navigation. Both the
 * product `SessionBoundary` and the account login surface build on top of it,
 * so it lives in `shared/` and imports neither zone.
 */

/** Broker-driven sign-out for any authenticated OS host. */
/**
 * Build a session-broker start path. Every surface that bounces through the
 * broker (resume, login handoff, invitation, CLI select, logout) constructs
 * this one shape; keep the parameter set here so the broker's query contract
 * has a single client-side author.
 */
export function buildBrokerStartPath(
	brokerPrefix: BrokerPrefix,
	options: {
		operation?: "logout";
		redirectTo?: string;
		tenantId?: string;
	} = {},
): string {
	const params = new URLSearchParams();
	if (options.operation) params.set("operation", options.operation);
	if (options.tenantId) params.set("tenant_id", options.tenantId);
	if (options.redirectTo !== undefined) {
		params.set("redirect_to", options.redirectTo);
	}
	const query = params.toString();
	return `${brokerPrefix}/start${query ? `?${query}` : ""}`;
}

export const OS_LOGOUT_PATH = buildBrokerStartPath("/auth/session-broker", {
	operation: "logout",
});

export type BrokerPrefix = "/auth/session-broker" | "/cli/session-broker";

/**
 * Bound on the broker `/status` read. While `status` is null the boundary
 * renders a spinner with no error path, so an unresolved fetch would hold that
 * spinner forever with zero console output. Timing out lands in the existing catch — `{ authenticated: false }`
 * — which renders login: a bounded, recoverable outcome instead of an eternal
 * spinner. 15s matches `OS_API_REQUEST_TIMEOUT_MS` for ordinary UI reads.
 */
export const OS_BROKER_STATUS_TIMEOUT_MS = 15_000;

export interface BrokerStatus {
	authenticated: boolean;
	expiresAt?: number | null;
	renewalRequired?: boolean;
	user?: OsIdentity;
}

/**
 * Whether this URL is a Descope flow continuation: a magic-link email lands
 * back on the app with `descope-login-flow` (and its one-time `t` token). Such
 * an arrival must mount the login flow immediately so the pending execution
 * verifies — any broker bounce first would strip the parameters and discard
 * the authentication.
 */
export function isDescopeFlowContinuation(href: string): boolean {
	try {
		return new URL(href).searchParams.has("descope-login-flow");
	} catch {
		return false;
	}
}

/**
 * Remove a stale broker failure — and any consumed magic-link continuation —
 * before starting or resuming authentication, so post-login returns and the
 * next emailed link never carry them forward.
 */
export function buildOsAuthReturnUrl(href: string): string {
	const destination = new URL(href);
	destination.searchParams.delete("error");
	if (destination.searchParams.has("descope-login-flow")) {
		destination.searchParams.delete("descope-login-flow");
		destination.searchParams.delete("t");
	}
	return destination.toString();
}

/**
 * Whether to bounce through the broker to get a fresh session.
 *
 * `renewalRequired` is the ONLY signal here, and it deliberately does not
 * consider `authenticated`. The broker emits renewal as a 401 carrying
 * `{ authenticated: false, renewalRequired: true }` (auth/session-broker.ts),
 * so gating on `authenticated` rejected the exact shape that asks for a resume:
 * the surface rendered its "Restoring your Tedix session…" spinner on
 * `renewalRequired`, this predicate declined to resume, and the pre-expiry timer
 * also required `authenticated` — leaving a permanent spinner with no login and
 * no error for anyone who loaded a page inside the renewal window.
 *
 * `hasBrokerError` stays and is the loop-breaker: if we have already come back
 * FROM the broker carrying `?error`, bouncing again would spin.
 */
export function shouldResumeOsBroker(
	status: BrokerStatus,
	hasBrokerError: boolean,
): boolean {
	if (hasBrokerError) return false;
	return status.renewalRequired === true;
}

/**
 * Silent-resume guard: at most ONE unattended pass through the broker per tab
 * session. A user with a valid central Descope refresh cookie (server-set on a
 * previous login in this browser) but no host product session should not see a
 * login form — one navigation through `${brokerPrefix}/start` mints the session
 * with no interaction. When that pass cannot succeed, the broker lands the user
 * on a login surface, never back here unauthenticated without either the guard
 * set (sessionStorage) or a `?error` callback param — both of which render the
 * form. The guard, not politeness, is what makes a redirect loop impossible.
 */
export const OS_SILENT_RESUME_GUARD_KEY = "tedix-os-silent-resume-attempted";

type SilentResumeGuardStorage = Pick<
	Storage,
	"getItem" | "removeItem" | "setItem"
>;

/** Storage can throw (privacy modes); an unreadable guard counts as attempted. */
export function hasAttemptedSilentOsResume(
	storage: SilentResumeGuardStorage,
): boolean {
	try {
		return storage.getItem(OS_SILENT_RESUME_GUARD_KEY) !== null;
	} catch {
		return true;
	}
}

export function markSilentOsResumeAttempted(
	storage: SilentResumeGuardStorage,
): void {
	try {
		storage.setItem(OS_SILENT_RESUME_GUARD_KEY, "1");
	} catch {
		// Unwritable storage: the ?error loop-breaker still prevents a loop.
	}
}

export function clearSilentOsResumeAttempt(
	storage: SilentResumeGuardStorage,
): void {
	try {
		storage.removeItem(OS_SILENT_RESUME_GUARD_KEY);
	} catch {
		// Nothing to clear when storage is unavailable.
	}
}

/**
 * Whether an unauthenticated status should get one silent broker pass before
 * the login form renders. Renewal (`renewalRequired`) is deliberately excluded:
 * that shape already resumes through `shouldResumeOsBroker`.
 */
export function shouldAttemptSilentOsResume(
	status: BrokerStatus,
	hasBrokerError: boolean,
	alreadyAttempted: boolean,
): boolean {
	if (hasBrokerError || alreadyAttempted) return false;
	if (status.authenticated) return false;
	if (status.renewalRequired === true) return false;
	return true;
}

/**
 * Fetch the broker session status, resume through the broker when required, and
 * pre-renew inside the server-owned window. Returns the raw status plus the
 * resume action and whether a redirect has already been kicked off, so the
 * caller renders the loading/login/authenticated states.
 */
export function useOsBrokerSessionStatus(brokerPrefix: BrokerPrefix): {
	status: BrokerStatus | null;
	resumeThroughBroker: () => void;
	redirectStarted: boolean;
} {
	const [status, setStatus] = useState<BrokerStatus | null>(null);
	const redirectStarted = useRef(false);
	// A flow continuation suppresses the automatic broker bounce exactly like a
	// broker error: the login surface must mount first so the magic-link
	// execution can verify.
	const hasBrokerError =
		new URL(window.location.href).searchParams.has("error") ||
		isDescopeFlowContinuation(window.location.href);

	useEffect(() => {
		let active = true;
		void fetch(`${brokerPrefix}/status`, {
			credentials: "include",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(OS_BROKER_STATUS_TIMEOUT_MS),
		})
			.then((response) => response.json() as Promise<BrokerStatus>)
			.then((value) => {
				if (active) setStatus(value);
			})
			.catch(() => {
				if (active) setStatus({ authenticated: false });
			});
		return () => {
			active = false;
		};
	}, [brokerPrefix]);

	const resumeThroughBroker = useCallback(() => {
		if (redirectStarted.current) return;
		redirectStarted.current = true;
		const destination = new URL(buildOsAuthReturnUrl(window.location.href));
		window.location.replace(
			buildBrokerStartPath(brokerPrefix, {
				redirectTo: `${destination.pathname}${destination.search}`,
			}),
		);
	}, [brokerPrefix]);

	useEffect(() => {
		if (!status || !shouldResumeOsBroker(status, hasBrokerError)) return;
		resumeThroughBroker();
	}, [hasBrokerError, resumeThroughBroker, status]);

	useEffect(() => {
		if (!status?.authenticated || !status.expiresAt) return;
		const renewAt =
			status.expiresAt * 1000 - OS_BROKER_RENEWAL_WINDOW_SECONDS * 1000;
		const timer = window.setTimeout(
			resumeThroughBroker,
			Math.max(0, renewAt - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [resumeThroughBroker, status]);

	return {
		status,
		resumeThroughBroker,
		redirectStarted: redirectStarted.current,
	};
}
