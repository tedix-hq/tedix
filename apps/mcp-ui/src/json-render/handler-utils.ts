/**
 * Shared action handler utilities for json-render renderers.
 *
 * Extracted from TedixRenderer and PreviewRenderer to avoid duplication.
 */

import type { StateStore } from "@json-render/core";
import { tedixHandlers } from "./registry";

/**
 * Build the base tedix action handlers wired to the given StateStore.
 * The returned handlers close over the store so setState/getState always
 * read the current snapshot via a single batched `store.update()` call.
 */
export function buildTedixActionHandlers(
	stateStore: StateStore,
): Record<string, (params: Record<string, unknown>) => Promise<void>> {
	return tedixHandlers(
		() => (updater) => {
			const prev = stateStore.getSnapshot();
			const next = updater(prev);
			const updates: Record<string, unknown> = {};
			for (const key of Object.keys(next)) {
				updates[`/${key}`] = next[key];
			}
			stateStore.update(updates);
		},
		() => stateStore.getSnapshot(),
	);
}
