/**
 * Per-surface model policy resolution for the tedi runtime.
 *
 * A tedi's model choice used to be ONE field
 * (`runtime_profiles.config.modelPolicy.chatModelRef`), so cheapening a tedi's
 * scheduled background work also cheapened its interactive turns. Scheduled
 * work (cognitive crons + the post-turn observer) is a large share of org token
 * spend and runs on the same frontier models the interactive turns use, but it
 * is exactly the work that tolerates a smaller model.
 *
 * This module owns the ADDITIVE per-surface refs and the strict fallback chain
 * the runtime resolves per turn. Everything here is pure so it can be asserted
 * without booting a Durable Object.
 *
 * Fallback chains (`cloudflare/auto` is the canonical default; a `null` ref is
 * reserved for a deliberate fixed-runtime fallback):
 *
 * | surface    | chain                                             |
 * | ---------- | ------------------------------------------------- |
 * | `chat`     | `chatModelRef` → env default                      |
 * | `cron`     | `cronModelRef` → `chatModelRef` → env default     |
 * | `observer` | `observerModelRef` → env default                  |
 *
 * The observer deliberately does NOT fall through to `chatModelRef`. The
 * observer path has always had its OWN env default deployment
 * (`AZURE_OBSERVER_DEPLOYMENT`) which `chatModelRef` has never steered; routing
 * it through the chat ref would silently move every existing tedi that only
 * sets `chatModelRef` onto a different observer model. Backward compatibility
 * is the acceptance criterion, so the observer only moves when an operator sets
 * `observerModelRef` explicitly.
 *
 * `cloudflare/auto` is NOT an explicit observer choice. The default policy and
 * the D1 backfill both carry it, and the Auto Router cannot answer the
 * observer's JSON-mode call inside the post-turn bridge budget (every call
 * timed out, so no facts were written). The observer surface therefore treats
 * `cloudflare/auto` (and a missing policy) as unset → `AZURE_OBSERVER_DEPLOYMENT`.
 * Chat and cron are unaffected.
 */

import { CLOUDFLARE_AUTO_MODEL_REF } from "@tedix/api-contract/schemas/model-catalog";
import {
	TediModelPolicyResponseSchema,
	type TediModelPolicyResponse,
} from "@tedix/api-contract/schemas/tedi";
import {
	ModelGenerationPolicySchema,
	type ModelGenerationPolicy,
	type ModelGenerationSettings,
} from "@tedix/api-contract/schemas/model-generation";
/** Runtime surface a turn belongs to, for model selection only. */
export type ModelPolicySurface = "chat" | "cron" | "observer";

/**
 * Resolved per-tedi model policy. Every field is normalized to `string | null`
 * (`null` = unset → fall back), so callers never re-handle `undefined`/`""`.
 */
export interface TediModelPolicy {
	generation?: ModelGenerationPolicy;
	/** Interactive/default chat ref. The pre-existing, only field. */
	chatModelRef: string | null;
	/** Scheduled (cron / trusted-scheduler) turns. Falls back to chat. */
	cronModelRef: string | null;
	/**
	 * Post-turn observer + reflector. Falls back to the observer env default;
	 * `cloudflare/auto` here also resolves to that env default.
	 */
	observerModelRef: string | null;
}

/** Canonical policy when no control-plane response is available. */
export const DEFAULT_TEDI_MODEL_POLICY: TediModelPolicy = Object.freeze({
	chatModelRef: CLOUDFLARE_AUTO_MODEL_REF,
	cronModelRef: CLOUDFLARE_AUTO_MODEL_REF,
	observerModelRef: CLOUDFLARE_AUTO_MODEL_REF,
});

/**
 * Non-empty string, else `null`. Matches the pre-existing
 * `typeof ref === "string" && ref.length > 0` check exactly (no trim), so a ref
 * that used to be accepted still is.
 */
function refOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalize the canonical API response or cached record. Missing surface refs
 * are rejected now that the D1 backfill has made the stored shape complete.
 */
export function normalizeModelPolicy(
	raw: TediModelPolicyResponse | null | undefined,
): TediModelPolicy {
	if (!raw) return DEFAULT_TEDI_MODEL_POLICY;
	const parsed = TediModelPolicyResponseSchema.parse(raw);
	return {
		...(parsed.generation === undefined
			? {}
			: { generation: ModelGenerationPolicySchema.parse(parsed.generation) }),
		chatModelRef: refOrNull(parsed.chatModelRef),
		cronModelRef: refOrNull(parsed.cronModelRef),
		observerModelRef: refOrNull(parsed.observerModelRef),
	};
}

/**
 * The model ref this surface should run on, or `null` for the env default.
 * See the table in the module docblock for the exact chain.
 */
export function resolveSurfaceModelRef(
	policy: TediModelPolicy | null | undefined,
	surface: ModelPolicySurface,
): string | null {
	if (surface === "observer") {
		// Observer-only by design, and never the Auto Router — see the module
		// docblock. `null` selects the observer's env default deployment.
		const ref = policy?.observerModelRef ?? null;
		return ref === CLOUDFLARE_AUTO_MODEL_REF ? null : ref;
	}
	if (!policy) return CLOUDFLARE_AUTO_MODEL_REF;
	switch (surface) {
		case "cron":
			return policy.cronModelRef ?? policy.chatModelRef;
		default:
			return policy.chatModelRef;
	}
}

/**
 * The `{ modelRef }` override shape the shared cognition catalog validates
 * (`selectAzureDeployment` / `selectChatModelForTurn`), or `undefined` when the
 * surface has no policy and must use the env default.
 */
export function modelOverrideForSurface(
	policy: TediModelPolicy | null | undefined,
	surface: ModelPolicySurface,
): { modelRef: string } | undefined {
	const ref = resolveSurfaceModelRef(policy, surface);
	return ref === null ? undefined : { modelRef: ref };
}

/** Scheduled settings inherit chat fields individually; observers use their own path. */
export function generationForSurface(
	policy: TediModelPolicy | undefined,
	surface: ModelPolicySurface,
): ModelGenerationSettings {
	if (surface === "observer") return {};
	return {
		...policy?.generation?.chat,
		...(surface === "cron" ? policy?.generation?.cron : {}),
	};
}
