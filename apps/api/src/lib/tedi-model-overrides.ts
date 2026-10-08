/**
 * Per-tedi chat-model override normalization.
 *
 * Lives in `lib/` (not beside the tedis router) because two callers need it and
 * only one of them is a router: `tedis.getModelPolicy` — the contract the Agent
 * runtime DO reads to pick its model — and the model-catalog projection, which
 * must report the tedi's EXPLICIT selection from the same parse the enforcer
 * uses. A projection with its own copy of this normalization would drift from
 * what actually steers the runtime.
 */

import {
	type TurnModelSelection,
	TurnModelSelectionSchema,
} from "@tedix/api-contract/schemas/automation-events";
import {
	findCatalogEntry,
	parseModelRef,
} from "@tedix/api-contract/schemas/model-catalog";
import type { DbClient } from "@tedix/db/client";
import { getRuntimeProfileById } from "@tedix/db/queries/control-plane/definitions";
import type { ModelPolicy } from "@tedix/db/schema/control-plane";
import type { Tedi } from "@tedix/db/schema/tedis";

/**
 * Extract + normalize the per-tedi chat model override from
 * `runtimeOverrides.agents.defaults.model.primary` (the ref the dashboard
 * ModelSection and `tedis.update` write). Returns a canonical catalog ref, or
 * `null` when the override is absent or does not name a known catalog model —
 * an invalid override falls back to the profile policy instead of steering
 * the runtime at a deployment the environment can't serve.
 */
export function chatModelRefFromRuntimeOverrides(
	runtimeOverrides: Record<string, unknown> | null | undefined,
): string | null {
	const primary = (
		runtimeOverrides as {
			agents?: { defaults?: { model?: { primary?: unknown } } };
		} | null
	)?.agents?.defaults?.model?.primary;
	if (typeof primary !== "string") return null;
	const slash = primary.indexOf("/");
	if (slash <= 0 || slash === primary.length - 1) return null;
	if (!parseModelRef(primary)) return null;
	if (!findCatalogEntry(primary)) return null;
	return primary;
}

/**
 * The Stored `runtimeOverrides.agents.defaults.model.primary` string, before catalog validation. The projection reports this so an
 * operator whose pin was silently discarded (e.g. a `google/gemini-*` ref the
 * catalog has never carried) can see the value that is actually stored, not
 * just the `null` it normalizes to.
 */
export function rawChatModelOverride(
	runtimeOverrides: Record<string, unknown> | null | undefined,
): string | null {
	const primary = (
		runtimeOverrides as {
			agents?: { defaults?: { model?: { primary?: unknown } } };
		} | null
	)?.agents?.defaults?.model?.primary;
	return typeof primary === "string" && primary.length > 0 ? primary : null;
}

/**
 * The model a tedi's own chat turns run on, as a selection another tedi's
 * single turn can borrow (a reply draft routed to its owner runs on the
 * Drafter's fast model). Same precedence as `tedis.getModelPolicy`: the
 * per-tedi pin, then the runtime profile's `chatModelRef` with its chat
 * generation settings. Null when neither names a model.
 */
export async function tediChatTurnModel(
	db: DbClient,
	tedi: Pick<Tedi, "runtimeOverrides" | "runtimeProfileId">,
): Promise<TurnModelSelection | null> {
	const profile = tedi.runtimeProfileId
		? await getRuntimeProfileById(db, tedi.runtimeProfileId)
		: null;
	const policy = profile?.config?.modelPolicy as ModelPolicy | undefined;
	const modelRef =
		chatModelRefFromRuntimeOverrides(tedi.runtimeOverrides) ??
		(typeof policy?.chatModelRef === "string" && policy.chatModelRef
			? policy.chatModelRef
			: null);
	if (!modelRef) return null;
	const parsed = TurnModelSelectionSchema.safeParse({
		modelRef,
		generation: policy?.generation?.chat,
	});
	return parsed.success ? parsed.data : null;
}
