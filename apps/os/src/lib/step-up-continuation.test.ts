/**
 * The step-up round trip.
 *
 * A step-up flow that redirects returns to the app URL with Descope's
 * continuation parameters and a brand-new document. These pin the two
 * properties that keep that from becoming silence: the pending intent survives
 * the navigation, and it survives exactly once.
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
	applyDescopeContinuation,
	captureDescopeContinuation,
	capturedStepUpContinuation,
	clearStepUpIntent,
	consumeStepUpIntentRecord,
	isOrphanedStepUpReturn,
	readDescopeContinuation,
	resetStepUpContinuationForTest,
	resolveStepUpResume,
	STEP_UP_INTENT_STORAGE_KEY,
	STEP_UP_INTENT_TTL_MS,
	STEP_UP_RESUME_EXPIRED_MESSAGE,
	STEP_UP_RESUME_INCOMPLETE_MESSAGE,
	STEP_UP_RESUME_LOST_MESSAGE,
	takeStepUpIntent,
	writeStepUpIntent,
} from "./step-up-continuation";

/** The exact shape observed in production, twice. */
const RETURN_URL =
	"https://acme.os.tedix.dev/admin/api-keys?code=bcff601d&descope-login-flow=step-up%7C%23%7C3IRCjtEodoh1Hvpl8dxBv15VKf7_11.end";

function memoryStorage(): Storage & { size: () => number } {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		size: () => map.size,
		clear: () => map.clear(),
		key: (index: number) => [...map.keys()][index] ?? null,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	} as Storage & { size: () => number };
}

beforeEach(() => {
	resetStepUpContinuationForTest();
});

describe("readDescopeContinuation", () => {
	it("recognises the step-up return leg and keeps every resume parameter", () => {
		const continuation = readDescopeContinuation(RETURN_URL);
		expect(continuation).not.toBeNull();
		expect(continuation?.flowId).toBe("step-up");
		expect(continuation?.params.code).toBe("bcff601d");
		expect(continuation?.params["descope-login-flow"]).toBe(
			"step-up|#|3IRCjtEodoh1Hvpl8dxBv15VKf7_11.end",
		);
		expect(continuation?.error).toBeNull();
	});

	it("does not mistake a login-flow continuation for a step-up one", () => {
		const continuation = readDescopeContinuation(
			"https://acme.os.tedix.dev/?t=abc&descope-login-flow=sign-up-or-in%7C%23%7Cx.end",
		);
		expect(continuation?.flowId).toBe("sign-up-or-in");
	});

	it("returns null for an ordinary URL and for a non-URL", () => {
		expect(
			readDescopeContinuation("https://acme.os.tedix.dev/admin"),
		).toBeNull();
		expect(readDescopeContinuation("not a url")).toBeNull();
	});

	it("carries the flow's own error back", () => {
		expect(
			readDescopeContinuation(
				"https://x.test/?descope-login-flow=step-up%7C%23%7Cy.end&err=denied",
			)?.error,
		).toBe("denied");
	});
});

describe("continuation capture", () => {
	it("snapshots the boot URL so a later search normalization cannot lose it", () => {
		captureDescopeContinuation(RETURN_URL);
		// A route's validateSearch models only its own keys; the URL can lose
		// Descope's before the guarded dialog ever mounts.
		captureDescopeContinuation("https://acme.os.tedix.dev/admin/api-keys");
		expect(capturedStepUpContinuation()?.params.code).toBe("bcff601d");
	});

	it("reports no step-up continuation for a login continuation", () => {
		captureDescopeContinuation(
			"https://x.test/?descope-login-flow=sign-up-or-in%7C%23%7Cx.end",
		);
		expect(capturedStepUpContinuation()).toBeNull();
	});

	it("puts the parameters back on a URL that lost them", () => {
		const restored = applyDescopeContinuation(
			"https://acme.os.tedix.dev/admin/api-keys?page=2",
			{ code: "bcff601d", "descope-login-flow": "step-up|#|abc.end" },
		);
		const url = new URL(restored);
		expect(url.searchParams.get("page")).toBe("2");
		expect(url.searchParams.get("code")).toBe("bcff601d");
		expect(url.searchParams.get("descope-login-flow")).toBe(
			"step-up|#|abc.end",
		);
	});
});

describe("pending intent storage", () => {
	it("round-trips a non-secret intent", () => {
		const storage = memoryStorage();
		writeStepUpIntent(storage, {
			key: "admin-api-keys:create",
			payload: { name: "CI", scopes: ["apps:read"] },
			createdAt: 1_000,
		});
		expect(takeStepUpIntent(storage)).toEqual({
			key: "admin-api-keys:create",
			payload: { name: "CI", scopes: ["apps:read"] },
			createdAt: 1_000,
		});
	});

	it("is one-shot: the slot is emptied by the read, so a reload cannot replay", () => {
		const storage = memoryStorage();
		writeStepUpIntent(storage, {
			key: "admin-api-keys:create",
			payload: { name: "CI" },
			createdAt: 1_000,
		});
		expect(consumeStepUpIntentRecord(storage)?.key).toBe(
			"admin-api-keys:create",
		);
		expect(storage.getItem(STEP_UP_INTENT_STORAGE_KEY)).toBeNull();
		// Same document: siblings share the memoized record...
		expect(consumeStepUpIntentRecord(storage)?.key).toBe(
			"admin-api-keys:create",
		);
		// ...but a new document (reload) finds nothing left to create with.
		resetStepUpContinuationForTest();
		expect(consumeStepUpIntentRecord(storage)).toBeNull();
	});

	it("removes a malformed record instead of wedging the slot", () => {
		const storage = memoryStorage();
		storage.setItem(STEP_UP_INTENT_STORAGE_KEY, "{not json");
		expect(takeStepUpIntent(storage)).toBeNull();
		expect(storage.size()).toBe(0);
	});

	it("clears on abandonment", () => {
		const storage = memoryStorage();
		writeStepUpIntent(storage, { key: "k", payload: 1, createdAt: 1 });
		clearStepUpIntent(storage);
		expect(storage.size()).toBe(0);
	});

	it("survives storage that throws", () => {
		const hostile = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		expect(() =>
			writeStepUpIntent(hostile, { key: "k", payload: 1, createdAt: 1 }),
		).not.toThrow();
		expect(takeStepUpIntent(hostile)).toBeNull();
		expect(() => clearStepUpIntent(hostile)).not.toThrow();
	});
});

describe("resolveStepUpResume", () => {
	const continuation = readDescopeContinuation(RETURN_URL);
	const record = {
		key: "admin-api-keys:create",
		payload: { name: "CI" },
		createdAt: 1_000,
	};

	it("replays the operation when the challenge came back for it", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record,
				continuation,
				now: 1_500,
			}),
		).toEqual({ kind: "resume", payload: { name: "CI" } });
	});

	it("reports rather than silently doing nothing when the intent is gone", () => {
		// This is the production defect: a successful challenge returns and the
		// page is unchanged. It must be an error, never silence.
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record: null,
				continuation,
				now: 1_500,
			}),
		).toEqual({ kind: "failed", message: STEP_UP_RESUME_LOST_MESSAGE });
	});

	it("reports an intent whose challenge never came back", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record,
				continuation: null,
				now: 1_500,
			}),
		).toEqual({ kind: "failed", message: STEP_UP_RESUME_INCOMPLETE_MESSAGE });
	});

	it("refuses a stale intent instead of replaying it", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record,
				continuation,
				now: 1_000 + STEP_UP_INTENT_TTL_MS + 1,
			}),
		).toEqual({ kind: "failed", message: STEP_UP_RESUME_EXPIRED_MESSAGE });
	});

	it("surfaces the flow's own error", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record,
				continuation: readDescopeContinuation(
					"https://x.test/?descope-login-flow=step-up%7C%23%7Cy.end&err=denied",
				),
				now: 1_500,
			}),
		).toEqual({ kind: "failed", message: "denied" });
	});

	it("stays quiet for another operation's intent", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:rotate",
				record,
				continuation,
				now: 1_500,
			}),
		).toEqual({ kind: "idle" });
	});

	it("stays quiet on an ordinary load", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record: null,
				continuation: null,
				now: 1_500,
			}),
		).toEqual({ kind: "idle" });
	});

	it("ignores a login-flow continuation entirely", () => {
		expect(
			resolveStepUpResume({
				key: "admin-api-keys:create",
				record: null,
				continuation: readDescopeContinuation(
					"https://x.test/?t=abc&descope-login-flow=sign-up-or-in%7C%23%7Cx.end",
				),
				now: 1_500,
			}),
		).toEqual({ kind: "idle" });
	});
});

describe("isOrphanedStepUpReturn", () => {
	it("is true only for a step-up return with nothing to replay", () => {
		const stepUp = readDescopeContinuation(RETURN_URL);
		expect(isOrphanedStepUpReturn(stepUp, null)).toBe(true);
		expect(
			isOrphanedStepUpReturn(stepUp, { key: "k", payload: 1, createdAt: 1 }),
		).toBe(false);
		expect(isOrphanedStepUpReturn(null, null)).toBe(false);
		expect(
			isOrphanedStepUpReturn(
				readDescopeContinuation(
					"https://x.test/?descope-login-flow=sign-up-or-in%7C%23%7Cx.end",
				),
				null,
			),
		).toBe(false);
	});
});
