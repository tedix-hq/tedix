import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

/**
 * URL state for /audit. The facet/filter selection and paging live in the
 * search string — shareable, back/forward-correct, prefetchable — never in
 * component state. Catch-style defaults keep a hand-typed or stale value from
 * blocking the navigation: it lands on the unfiltered trail instead of an
 * error page.
 *
 * `zod/mini` for the int (already in the entry chunk via `team-tabs.ts`); the
 * two string filters are hand-guarded like `canvas-search.ts`, deliberately —
 * this module is reachable from the route config in the shared entry chunk,
 * and `z.string()` would be the first string schema there (~8 KiB minified of
 * new machinery for what one typeof covers).
 */

/**
 * Page size for the audit trail — one contract read per URL-backed page.
 * Twenty keeps the mobile record projection scannable while retaining a dense
 * desktop table and deterministic server-side offsets.
 */
export const AUDIT_PAGE_SIZE = 20;

/** The unfiltered facet-tab value; never sent to the contract. */
export const AUDIT_ALL_RESOURCES = "all";

const pageSchema = z.catch(z.int().check(z.minimum(1)), 1);

/**
 * Server-side exact-match filter values (the query filters with `eq`, not a
 * substring match). Both are open strings in the contract, so any value is
 * accepted — the facet tabs and the free-text escape hatch write the same
 * param. The 255 cap only bounds the URL, mirroring the inputs.
 */
function filterParam(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length <= 255 ? value : fallback;
}

export type AuditSearch = {
	resourceType: string;
	action: string;
	page: number;
};

export const AUDIT_DEFAULT_SEARCH: AuditSearch = {
	resourceType: AUDIT_ALL_RESOURCES,
	action: "",
	page: 1,
};

/**
 * Function form with the `SearchSchemaInput` marker so links may omit any
 * field (`<Link to="/audit" />`, `search={{ resourceType: "skill" }}`) while
 * readers still get the fully-defaulted output type.
 */
export function validateAuditSearch(
	search: {
		resourceType?: string;
		action?: string;
		page?: number;
	} & SearchSchemaInput,
): AuditSearch {
	const raw = search as Record<string, unknown>;
	return {
		resourceType: filterParam(raw.resourceType, AUDIT_ALL_RESOURCES),
		action: filterParam(raw.action, ""),
		page: pageSchema.parse(raw.page),
	};
}

/**
 * True when the URL names the default view — the unfiltered first page. The
 * default view reads through the SAME query as the facet source (see
 * `audit-page.tsx`), so this decides which of the page's two queries is
 * active.
 */
export function isDefaultAuditSearch(search: AuditSearch): boolean {
	return (
		(search.resourceType === AUDIT_ALL_RESOURCES ||
			search.resourceType.trim() === "") &&
		search.action.trim() === "" &&
		search.page === 1
	);
}

/**
 * The `audit.search` contract input for a non-default view. Filters are
 * trimmed and dropped when empty so the generated query key never encodes a
 * meaningless `action: ""` variant of the same read.
 */
export function auditSearchInput(search: AuditSearch): {
	limit: number;
	offset: number;
	resourceType?: string;
	action?: string;
} {
	const resourceType =
		search.resourceType === AUDIT_ALL_RESOURCES
			? ""
			: search.resourceType.trim();
	const action = search.action.trim();
	return {
		limit: AUDIT_PAGE_SIZE,
		offset: (search.page - 1) * AUDIT_PAGE_SIZE,
		...(resourceType ? { resourceType } : {}),
		...(action ? { action } : {}),
	};
}
