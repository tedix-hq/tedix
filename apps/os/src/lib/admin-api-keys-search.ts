import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

/**
 * URL state for /admin/api-keys. Paging lives in the search string —
 * shareable, back/forward-correct, prefetchable — never in component state.
 * `z.catch` keeps a hand-typed or stale value from blocking the navigation.
 *
 * `zod/mini`, deliberately: route config lives in the shared entry chunk, and
 * classic `zod` costs ~50 KiB minified there (see `team-tabs.ts`).
 */
export const adminApiKeysSearchSchema = z.object({
	/** 1-based key-list page. */
	page: z.catch(z.int().check(z.minimum(1)), 1),
});

export type AdminApiKeysSearch = z.infer<typeof adminApiKeysSearchSchema>;

/**
 * Function form with the `SearchSchemaInput` marker so links may omit the
 * field (`<Link to="/admin/api-keys" />`) while readers still get the
 * fully-defaulted output type.
 */
export function validateAdminApiKeysSearch(
	search: { page?: number } & SearchSchemaInput,
): AdminApiKeysSearch {
	return adminApiKeysSearchSchema.parse(search);
}
