/**
 * Step-up re-authentication for destructive operations.
 *
 * Runs Descope's step-up flow before sensitive actions (delete org, delete
 * tedi, rotate secrets, ...) and hands the caller the **stepped-up session
 * token** it produced.
 *
 * Requires a "step-up" flow in Descope Console → Flows. The Tedix project ships
 * one (id `step-up`, enabled), built on the `step-up` flow action.
 *
 * HOW THE GUARANTEE WORKS — this is a real boundary only because both halves
 * exist. Descope re-issues the session token with `su: true` when the step-up
 * flow succeeds, and bounds that token's life by the project's Step Up Token
 * Timeout (docs.descope.com/mfa-and-step-up/step-up). The caller must send
 * *that* token with the mutation, and the API must reject the mutation when the
 * claim is absent — see `hasStepUpClaim` in @tedix/auth/types and the
 * organization delete procedure. Dropping the token on the client silently
 * turns this back into decoration, so `requireStepUp` only ever calls back with
 * a token in hand. In the OS, forward the token through
 * `getAuthenticatedOsApi(token)` (@/lib/api) — the same-origin `/api` proxy
 * strips Authorization, so the su-JWT must travel directly to the API origin.
 *
 * FAILS CLOSED. A step-up that errors does not run the action. There is no
 * confirm() fallback: a security control a user can click past is not one.
 * The zero-account local lane has no Descope, so step-up fails closed there
 * too — `requireStepUp` refuses before the dialog opens (and the boundary
 * would render nothing even if it did).
 *
 * SURVIVES A NAVIGATION. A step-up execution that reaches a redirect step
 * leaves the SPA and returns with Descope's continuation parameters on the URL.
 * The in-memory callback below cannot survive that, so a caller whose operation
 * must complete afterwards passes an `intentKey` plus a non-secret intent
 * payload; `@/lib/step-up-continuation` persists it for the round trip, this
 * hook re-opens on return, restores the continuation parameters the router
 * would otherwise normalize away, and replays through `onResume`. The intent is
 * strictly one-shot. A caller with no `intentKey` still gets a visible failure
 * on such a return rather than the silence this replaced.
 *
 * The Descope flow component reads projectId/baseUrl from the SDK context, so
 * the dialog wraps it in the scoped `DescopeSdkBoundary` (broker-safe props;
 * the OS session broker stays the single credential/refresh owner). The flow
 * hydrates its session from the broker's Descope-readable `DSR` twin on
 * auth.tedix.dev — the SDK itself persists and rotates nothing.
 */

import { Descope } from "@descope/react-sdk/flows";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { DescopeSdkBoundary, isLocalOsHost } from "@/shared/descope-provider";
import {
	applyDescopeContinuation,
	capturedDescopeContinuation,
	capturedStepUpContinuation,
	clearStepUpIntent,
	consumeStepUpIntentRecord,
	isOrphanedStepUpReturn,
	resolveStepUpResume,
	STEP_UP_FLOW_ID,
	STEP_UP_RESUME_INCOMPLETE_MESSAGE,
	STEP_UP_RESUME_LOST_MESSAGE,
	writeStepUpIntent,
} from "@/lib/step-up-continuation";
import { DescopeWidgetSurface } from "@/components/descope/theme-bridge";
import { TedixByosOtpScreen } from "@/shared/descope-byos-otp-screen";
import {
	DESCOPE_OTP_SCREEN_NAME,
	STEP_UP_OTP_INTERACTIONS,
	type DescopeByosContext,
	type DescopeFlowNext,
} from "@/shared/descope-byos-contract";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { useDescopeTheme } from "@/hooks/use-descope-theme";
import {
	descopeStyleProps,
	installTedixDescopeSurfaceTokens,
	TEDIX_DESCOPE_THEME_OVERRIDE_JSON,
} from "@/shared/descope-theme";

// =============================================================================
// TYPES
// =============================================================================

export interface StepUpOptions {
	/**
	 * Descope flow ID to use for step-up auth.
	 * Must be configured in Descope Console → Flows.
	 * Defaults to "step-up".
	 */
	flowId?: string;
	/**
	 * Canonical Descope tenant for the resource being authorized. Without this,
	 * Descope reuses whichever tenant the shared auth cookie selected most
	 * recently, which can mint a valid step-up token for the wrong organization.
	 */
	tenantId?: string;
	/** Title shown in the step-up dialog. Defaults to "Confirm your identity". */
	title?: string;
	/** Description shown below the title. */
	description?: string;
	/**
	 * Called when step-up could not complete (flow error, or a flow that
	 * returned no session token). The guarded action is NOT run. Use this to
	 * surface the failure — without it the dialog just closes.
	 */
	onFailure?: (message: string) => void;
	/**
	 * Operation discriminator (e.g. `admin-api-keys:create`). Supplying it opts
	 * the caller into surviving a redirecting step-up flow: the intent handed to
	 * `requireStepUp` is persisted under this key for the round trip.
	 */
	intentKey?: string;
	/**
	 * Re-open on mount and resume the returned Descope execution. The page
	 * decides this from `useStepUpResume`, which is what restored the caller's
	 * UI state in the first place.
	 */
	autoResume?: boolean;
	/**
	 * Called with the stepped-up token when an auto-resumed challenge succeeds.
	 * Re-issue the guarded mutation here.
	 */
	onResume?: StepUpCallback;
}

/**
 * Receives the session JWT minted by the step-up flow. Send it with the
 * guarded mutation — it is the only token that carries `su: true`. Nothing
 * ambient can stand in for it: the non-persisting SDK writes no `DS` cookie
 * on the OS origin at all.
 */
export type StepUpCallback = (steppedUpToken: string) => void;

export interface StepUpAuthResult {
	/**
	 * Call this before executing a destructive action. Opens the re-auth dialog
	 * and invokes `onSuccess` with the stepped-up session token — only after the
	 * flow actually succeeds.
	 *
	 * `intent` is the non-secret input of the guarded operation. It is persisted
	 * only when the hook was given an `intentKey`, and only so the operation can
	 * be replayed if the flow navigates away. Never pass a credential.
	 */
	requireStepUp: (onSuccess: StepUpCallback, intent?: unknown) => void;
	/**
	 * Render this component somewhere in your component tree.
	 * It mounts the step-up dialog when requireStepUp() is active.
	 */
	StepUpDialog: React.FC;
}

/**
 * A step-up return that nothing could replay is reported once per document —
 * several guarded sections may be mounted at the same time, and one error is
 * information while five are noise.
 */
let orphanReturnReported = false;

/** Test seam: forget that this document already reported an orphaned return. */
/** @internal */
export function resetStepUpOrphanReportForTest(): void {
	orphanReturnReported = false;
}

/** Shape of the Descope flow success event we depend on. */
interface StepUpSuccessDetail {
	sessionJwt?: string;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * useStepUpAuth — gate destructive actions behind re-authentication.
 *
 * @example
 * ```tsx
 * const { requireStepUp, StepUpDialog } = useStepUpAuth({
 *   onFailure: (message) => toast.error(message),
 * });
 *
 * const handleDelete = () => {
 *   requireStepUp((steppedUpToken) => {
 *     // Only called after a successful step-up. Forward the token — the
 *     // server rejects the mutation without the `su` claim it carries.
 *     performDelete(steppedUpToken);
 *   });
 * };
 *
 * return (
 *   <>
 *     <Button onClick={handleDelete}>Delete</Button>
 *     <StepUpDialog />
 *   </>
 * );
 * ```
 */
export function useStepUpAuth(options: StepUpOptions = {}): StepUpAuthResult {
	const {
		flowId = STEP_UP_FLOW_ID,
		tenantId,
		title = "Confirm your identity",
		description = "This action requires re-authentication to proceed.",
		onFailure,
		intentKey,
		autoResume = false,
		onResume,
	} = options;

	const [isOpen, setIsOpen] = useState(false);
	// Descope's step-up flow reaches a "Verify OTP" screen whose default render
	// is a magic-link-sent screen (its screenId's registered type), so the OS
	// renders its own code input over it — the same interception the consent
	// flow uses. Null until that screen appears.
	const [otpScreen, setOtpScreen] = useState<{
		context: DescopeByosContext;
		next: DescopeFlowNext;
	} | null>(null);
	const theme = useDescopeTheme();
	const pendingCallbackRef = useRef<StepUpCallback | null>(null);

	const requireStepUp = useCallback(
		(onSuccess: StepUpCallback, intent?: unknown) => {
			// Zero-account local lane: no Descope may mount, so no step-up proof
			// can exist. Fail closed instead of opening an empty dialog.
			if (isLocalOsHost()) {
				onFailure?.(
					"Re-authentication is not available in the local workspace.",
				);
				return;
			}
			// Persisted BEFORE the dialog opens: a redirecting flow can leave the
			// document on its first frame, so there is no later safe moment.
			if (intentKey !== undefined && intent !== undefined) {
				writeStepUpIntent(window.sessionStorage, {
					key: intentKey,
					payload: intent,
					createdAt: Date.now(),
				});
			}
			pendingCallbackRef.current = onSuccess;
			setIsOpen(true);
		},
		[intentKey, onFailure],
	);

	const fail = useCallback(
		(message: string) => {
			// An abandoned round trip must not leave an intent behind for a later
			// load to find and mistake for a live one.
			clearStepUpIntent(window.sessionStorage);
			pendingCallbackRef.current = null;
			setIsOpen(false);
			setOtpScreen(null);
			onFailure?.(message);
		},
		[onFailure],
	);

	const handleSuccess = useCallback(
		(event: CustomEvent<StepUpSuccessDetail>) => {
			const steppedUpToken = event.detail?.sessionJwt;
			if (!steppedUpToken) {
				// A step-up flow that ends without issuing a session cannot prove
				// anything to the server. Treat it as a failure rather than running
				// the action against whatever token happens to be in the cookie.
				fail("Re-authentication did not return a session. Please try again.");
				return;
			}

			const callback = pendingCallbackRef.current;
			if (!callback) {
				// The proof arrived with nothing to spend it on. Never silent.
				fail(STEP_UP_RESUME_LOST_MESSAGE);
				return;
			}
			// The intent has done its job; drop it before the mutation runs so a
			// reload mid-flight cannot find it and replay.
			clearStepUpIntent(window.sessionStorage);
			pendingCallbackRef.current = null;
			setIsOpen(false);
			setOtpScreen(null);
			callback(steppedUpToken);
		},
		[fail],
	);

	const handleError = useCallback(
		(event: CustomEvent<{ errorDescription?: string }>) => {
			fail(
				event.detail?.errorDescription ??
					"Re-authentication failed. Please try again.",
			);
		},
		[fail],
	);

	const handleOpenChange = useCallback((open: boolean) => {
		// Dismissing the dialog abandons the guarded action — and its intent.
		if (!open) {
			clearStepUpIntent(window.sessionStorage);
			pendingCallbackRef.current = null;
		}
		setIsOpen(open);
		if (!open) setOtpScreen(null);
	}, []);

	// Keep the caller's latest handlers reachable from the resume effects
	// without making the effects re-run on every render.
	const onFailureRef = useRef(onFailure);
	const onResumeRef = useRef(onResume);
	useEffect(() => {
		onFailureRef.current = onFailure;
		onResumeRef.current = onResume;
	});

	// Auto-resume: this document IS the return leg of a redirecting step-up.
	// Re-open the dialog so the Descope web component mounts and finishes the
	// pending execution, after putting back the continuation parameters the
	// route's search schema does not model.
	const resumeStartedRef = useRef(false);
	useEffect(() => {
		if (!autoResume || resumeStartedRef.current) return;
		if (isLocalOsHost()) return;
		resumeStartedRef.current = true;
		const continuation = capturedStepUpContinuation();
		if (!continuation) {
			onFailureRef.current?.(STEP_UP_RESUME_INCOMPLETE_MESSAGE);
			return;
		}
		const restored = applyDescopeContinuation(
			window.location.href,
			continuation.params,
		);
		if (restored !== window.location.href) {
			window.history.replaceState({}, "", restored);
		}
		pendingCallbackRef.current = (token) => onResumeRef.current?.(token);
		setIsOpen(true);
	}, [autoResume]);

	// Anti-silence net for every step-up caller that does NOT persist an intent
	// (org delete, app delete, tedi retire/rotate): a challenge that came back
	// with nothing to replay reports once per document instead of rendering an
	// unchanged page.
	useEffect(() => {
		if (autoResume || orphanReturnReported) return;
		if (isLocalOsHost()) return;
		const continuation = capturedStepUpContinuation();
		if (!continuation) return;
		const record = consumeStepUpIntentRecord(window.sessionStorage);
		if (!isOrphanedStepUpReturn(continuation, record)) return;
		orphanReturnReported = true;
		onFailureRef.current?.(STEP_UP_RESUME_LOST_MESSAGE);
	}, [autoResume]);

	const handleFlowReady = useCallback(
		(event: { currentTarget: EventTarget | null }) => {
			installTedixDescopeSurfaceTokens(event.currentTarget as HTMLElement);
		},
		[],
	);

	// Intercept the flow's Verify OTP screen so the OS renders its own code
	// input; every other screen (identity entry, Google/passkey) stays
	// Descope-rendered. Returning true tells Descope the screen is handled.
	const handleScreenUpdate = useCallback(
		(
			screenName: string,
			context: Record<string, unknown>,
			next: DescopeFlowNext,
		): boolean => {
			if (screenName === DESCOPE_OTP_SCREEN_NAME) {
				setOtpScreen({ context: context as DescopeByosContext, next });
				return true;
			}
			setOtpScreen(null);
			return false;
		},
		[],
	);

	// The returned component type must never change while a challenge is open.
	// Descope advances screens through `onScreenUpdate`; that updates otpScreen
	// and re-renders this hook. A component callback that depends on otpScreen (or
	// isOpen) gets a new identity on that render, so React unmounts the active
	// Kumo/Base UI dialog. Its cleanup closes the challenge before the OTP screen
	// can appear — the email is sent successfully, but the user sees nothing.
	//
	// Keep one stable component type and update only the renderer it delegates to.
	// The parent re-renders for every state change, so the stable component reads
	// the current renderer during the same React pass without persisting auth data.
	const dialogRendererRef = useRef<() => React.ReactElement>(() =>
		createElement("div"),
	);
	dialogRendererRef.current = () =>
		createElement(
			Dialog,
			{ open: isOpen, onOpenChange: handleOpenChange },
			createElement(
				DialogContent,
				{ className: "sm:max-w-md" },
				createElement(
					DialogHeader,
					null,
					createElement(DialogTitle, null, title),
					createElement(DialogDescription, null, description),
				),
				createElement(
					DescopeSdkBoundary,
					null,
					createElement(
						DescopeWidgetSurface,
						{ minHeightClassName: "min-h-[280px]" },
						// Hide (not unmount) the Descope flow while our OTP screen is
						// up, so its flow state and the `next` callback stay live.
						createElement(
							"div",
							otpScreen ? { hidden: true } : null,
							createElement(Descope, {
								flowId,
								tenant: tenantId,
								onSuccess: handleSuccess,
								onError: handleError,
								onReady: handleFlowReady,
								onScreenUpdate: handleScreenUpdate,
								theme,
								// Same brand override + surface tokens as the login flow —
								// the step-up dialog is the same Descope shadow-DOM surface.
								themeOverride: TEDIX_DESCOPE_THEME_OVERRIDE_JSON as never,
								...descopeStyleProps(),
							}),
						),
						otpScreen
							? createElement(TedixByosOtpScreen, {
									context: otpScreen.context,
									interactions: STEP_UP_OTP_INTERACTIONS,
									next: otpScreen.next,
								})
							: null,
					),
				),
			),
		);
	const StepUpDialog = useCallback<React.FC>(
		() => dialogRendererRef.current(),
		[],
	);

	return { requireStepUp, StepUpDialog };
}

// =============================================================================
// RESUME
// =============================================================================

export interface StepUpResumeResult<T> {
	/** The restored operation input, or null when there is nothing to resume. */
	intent: T | null;
	/** A message to render when the round trip could not be completed. */
	failure: string | null;
}

/**
 * useStepUpResume — restore a guarded operation after a redirecting step-up.
 *
 * Call it at the level that OWNS the operation's UI (the page, not a dialog
 * that only exists while it is open): it decides once, during the first render,
 * whether this load is the return leg of a step-up belonging to `key`. On
 * `intent`, re-open the operation's UI seeded with the returned input and pass
 * `autoResume` to its `useStepUpAuth`. On `failure`, render the message — the
 * whole point is that a user never sees an unchanged page after a successful
 * identity challenge.
 *
 * The intent is consumed here, out of `sessionStorage`, exactly once per
 * document. A reload cannot resume it a second time, so a replay cannot
 * double-create.
 */
export function useStepUpResume<T>(options: {
	key: string;
	/** Validate the stored payload. Return null to reject a stale shape. */
	parse: (payload: unknown) => T | null;
}): StepUpResumeResult<T> {
	const { key, parse } = options;
	const [result] = useState<StepUpResumeResult<T>>(() => {
		if (isLocalOsHost()) return { intent: null, failure: null };
		const decision = resolveStepUpResume({
			key,
			record: consumeStepUpIntentRecord(window.sessionStorage),
			continuation: capturedDescopeContinuation(),
			now: Date.now(),
		});
		if (decision.kind === "failed") {
			// This hook is reporting the return, so the generic net must not
			// report it a second time from a sibling section.
			orphanReturnReported = true;
			return { intent: null, failure: decision.message };
		}
		if (decision.kind === "idle") return { intent: null, failure: null };
		const intent = parse(decision.payload);
		if (intent === null) {
			orphanReturnReported = true;
			return { intent: null, failure: STEP_UP_RESUME_LOST_MESSAGE };
		}
		return { intent, failure: null };
	});
	return result;
}
