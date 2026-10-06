/**
 * Surviving a step-up flow that navigates away.
 *
 * `useStepUpAuth` (@/lib/step-up-auth) mounts Descope's step-up flow inside a
 * dialog and hands the caller the stepped-up session JWT through an in-memory
 * callback. That contract holds only while the document survives — and it does
 * not always survive. A step-up execution that reaches a redirect step (SSO,
 * social, any provider bounce) leaves the SPA entirely and returns to the same
 * URL carrying Descope's continuation parameters:
 *
 *   /admin/api-keys?code=<hex>&descope-login-flow=step-up|#|<executionId>.end
 *
 * On that return the whole document is new. Two things are gone, and both must
 * come back or the user re-authenticates into silence:
 *
 * 1. **The pending intent.** `pendingCallbackRef` was a closure in a component
 *    that no longer exists, and so was the form the user filled in. Nothing
 *    re-issues the mutation. This module persists the non-secret INPUT of the
 *    guarded operation in `sessionStorage` for the round trip.
 * 2. **The flow execution.** Descope's web component resumes a pending
 *    execution only if it is MOUNTED while those parameters are still on the
 *    URL — it reads `window.location.search` at init and strips what it
 *    consumes. The step-up `<Descope>` mounts only when the dialog is open,
 *    which after a fresh load it is not. Worse, a route whose `validateSearch`
 *    schema does not model these keys (every OS route) may normalize them off
 *    the URL first. So we snapshot them at boot, before the router runs, and
 *    put them back immediately before the resumed dialog mounts.
 *
 * WHAT IS PERSISTED. Only what the caller passes as its intent payload, and
 * callers pass operation INPUT: an API-key name/description/environment/scope
 * list, a key id. Never a credential. Nothing minted by the flow is ever
 * written here — the stepped-up JWT stays an in-memory argument exactly as
 * before, and the raw API key never reaches this module at all.
 *
 * ONE-SHOT, NOT IDEMPOTENT. `consumeStepUpIntentRecord` removes the record
 * from storage on the FIRST read of the document and memoizes the result in
 * memory. A reload, a back-navigation, or a second component asking again
 * therefore cannot replay a create: storage is already empty, and Descope has
 * already stripped the continuation code it would need anyway. A replay that
 * cannot run is reported as a failure, never as a no-op.
 */

/** Descope flow id used for step-up. Keep in sync with `useStepUpAuth`. */
export const STEP_UP_FLOW_ID = "step-up";

/**
 * The query parameters Descope's web component reads at init to resume a
 * pending execution (`descope-login-flow` carries `<flowId>|#|<exec>.<step>`;
 * `code` is the SSO exchange code, `t` the magic-link token, `err` a flow
 * error, `redirect_mode` the popup marker). Mirrors the constant block in
 * @descope/web-component's `handleUrlParams`.
 */
export const DESCOPE_CONTINUATION_PARAMS = [
	"descope-login-flow",
	"code",
	"t",
	"err",
	"redirect_mode",
] as const;

export interface DescopeContinuation {
	/** Flow id parsed out of `descope-login-flow` (before the `|#|`). */
	flowId: string;
	/** Every continuation parameter present, verbatim, for restoration. */
	params: Readonly<Record<string, string>>;
	/** Descope's `err` parameter when the flow came back failed. */
	error: string | null;
}

/**
 * Parse Descope's continuation parameters out of a URL. Returns null when the
 * URL is not a flow continuation at all.
 */
export function readDescopeContinuation(
	href: string,
): DescopeContinuation | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const raw = url.searchParams.get("descope-login-flow");
	if (!raw) return null;
	// `<flowId>|#|<executionId>.<stepId>` — the flow id is everything before
	// the separator, and an execution-less value is still that flow's.
	const flowId = raw.split("|#|")[0] ?? "";
	if (!flowId) return null;
	const params: Record<string, string> = {};
	for (const name of DESCOPE_CONTINUATION_PARAMS) {
		const value = url.searchParams.get(name);
		if (value !== null) params[name] = value;
	}
	return { flowId, params, error: url.searchParams.get("err") };
}

/** Put continuation parameters back on a URL that lost them. Pure. */
export function applyDescopeContinuation(
	href: string,
	params: Readonly<Record<string, string>>,
): string {
	const url = new URL(href);
	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}
	return url.toString();
}

// ---------------------------------------------------------------------------
// Boot-time capture
// ---------------------------------------------------------------------------

let captured: DescopeContinuation | null = null;
let capturedOnce = false;

/**
 * Snapshot the continuation parameters of the URL the document loaded with.
 * Called from the app entry BEFORE the router mounts, because a route's
 * `validateSearch` schema models only its own keys and normalizing the search
 * string would drop Descope's.
 */
export function captureDescopeContinuation(href: string): void {
	if (capturedOnce) return;
	capturedOnce = true;
	captured = readDescopeContinuation(href);
}

/** The captured continuation, or null when this load was not one. */
export function capturedDescopeContinuation(): DescopeContinuation | null {
	return captured;
}

/** The captured continuation, but only when it belongs to the step-up flow. */
export function capturedStepUpContinuation(): DescopeContinuation | null {
	return captured?.flowId === STEP_UP_FLOW_ID ? captured : null;
}

// ---------------------------------------------------------------------------
// Pending intent storage
// ---------------------------------------------------------------------------

export const STEP_UP_INTENT_STORAGE_KEY = "tedix-os-step-up-intent";

/**
 * How long a persisted intent may wait for its round trip. Descope's step-up
 * token timeout is minutes, so a record older than this cannot produce a
 * usable proof and is reported as expired rather than replayed.
 */
export const STEP_UP_INTENT_TTL_MS = 10 * 60_000;

export interface StepUpIntentRecord {
	/** Operation discriminator, e.g. `admin-api-keys:create`. */
	key: string;
	/** Non-secret operation input. Never a token, never a minted credential. */
	payload: unknown;
	createdAt: number;
}

type IntentStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

/** Persist the pending intent for the round trip. Storage may throw. */
export function writeStepUpIntent(
	storage: IntentStorage,
	record: StepUpIntentRecord,
): void {
	try {
		storage.setItem(STEP_UP_INTENT_STORAGE_KEY, JSON.stringify(record));
	} catch {
		// Unwritable storage degrades to today's behaviour for the redirect
		// lane, and the orphan report below still makes the failure visible.
	}
}

export function clearStepUpIntent(storage: IntentStorage): void {
	try {
		storage.removeItem(STEP_UP_INTENT_STORAGE_KEY);
	} catch {
		// Nothing to clear.
	}
}

/**
 * Remove and return the persisted intent. Removal happens BEFORE parsing, so a
 * malformed or hostile record cannot wedge the slot or be read twice.
 */
export function takeStepUpIntent(
	storage: IntentStorage,
): StepUpIntentRecord | null {
	let raw: string | null = null;
	try {
		raw = storage.getItem(STEP_UP_INTENT_STORAGE_KEY);
		storage.removeItem(STEP_UP_INTENT_STORAGE_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Partial<StepUpIntentRecord>;
		if (typeof record.key !== "string") return null;
		if (typeof record.createdAt !== "number") return null;
		return {
			key: record.key,
			payload: record.payload,
			createdAt: record.createdAt,
		};
	} catch {
		return null;
	}
}

let consumed: StepUpIntentRecord | null | undefined;

/**
 * The document's single pending intent. Takes it out of storage on first call
 * and memoizes it, so several hooks may ask without one starving the others —
 * and so a reload can never see it again.
 */
export function consumeStepUpIntentRecord(
	storage: IntentStorage,
): StepUpIntentRecord | null {
	if (consumed === undefined) consumed = takeStepUpIntent(storage);
	return consumed;
}

/** Test seam: forget the boot capture and the consumed record. */
/** @internal */
export function resetStepUpContinuationForTest(): void {
	captured = null;
	capturedOnce = false;
	consumed = undefined;
}

// ---------------------------------------------------------------------------
// Resume decision
// ---------------------------------------------------------------------------

export type StepUpResumeDecision =
	| { kind: "idle" }
	| { kind: "resume"; payload: unknown }
	| { kind: "failed"; message: string };

export const STEP_UP_RESUME_LOST_MESSAGE =
	"Re-authentication finished, but the action it was protecting was lost. Nothing was changed — please try again.";

export const STEP_UP_RESUME_INCOMPLETE_MESSAGE =
	"Re-authentication did not complete, so nothing was changed. Please try again.";

export const STEP_UP_RESUME_EXPIRED_MESSAGE =
	"Re-authentication took too long, so nothing was changed. Please try again.";

/**
 * What a component owning `key` should do on this load.
 *
 * Every branch that is not `idle` is either a replay or a visible failure.
 * There is deliberately no branch that returns to the user quietly: coming back
 * from a successful identity challenge to an unchanged page with no message is
 * the defect this module exists to remove.
 */
export function resolveStepUpResume(input: {
	key: string;
	record: StepUpIntentRecord | null;
	continuation: DescopeContinuation | null;
	now: number;
}): StepUpResumeDecision {
	const { key, record, continuation, now } = input;
	const stepUp = continuation?.flowId === STEP_UP_FLOW_ID ? continuation : null;

	if (!record) {
		// A step-up challenge came back with nothing to replay: the intent was
		// never written, storage was unavailable, or it has already been
		// consumed by an earlier load. Say so instead of rendering nothing.
		return stepUp
			? { kind: "failed", message: STEP_UP_RESUME_LOST_MESSAGE }
			: { kind: "idle" };
	}
	// Someone else's pending intent. Stay quiet; its owner reports.
	if (record.key !== key) return { kind: "idle" };

	if (now - record.createdAt > STEP_UP_INTENT_TTL_MS) {
		return { kind: "failed", message: STEP_UP_RESUME_EXPIRED_MESSAGE };
	}
	if (!stepUp) {
		return { kind: "failed", message: STEP_UP_RESUME_INCOMPLETE_MESSAGE };
	}
	if (stepUp.error) {
		return { kind: "failed", message: stepUp.error };
	}
	return { kind: "resume", payload: record.payload };
}

/**
 * Whether a step-up challenge came back with no owner at all. Every
 * `useStepUpAuth` mount checks this so an operation whose intent was never
 * persisted still shows an error rather than silence.
 */
export function isOrphanedStepUpReturn(
	continuation: DescopeContinuation | null,
	record: StepUpIntentRecord | null,
): boolean {
	return continuation?.flowId === STEP_UP_FLOW_ID && record === null;
}
