import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

/**
 * URL state for /admin/connections. The status tab and search text live in
 * the search string — shareable, back/forward-correct, prefetchable — never
 * in component state. `z.catch` keeps a hand-typed or stale value from
 * blocking the navigation.
 *
 * `connect` opens setup review on arrival. Capability and named-account
 * selectors retain the exact requirement and credential in server-minted
 * handoff links; scopes support tool requirements outside configured groups.
 *
 * `zod/mini`, deliberately: route config lives in the shared entry chunk
 * (see `admin-api-keys-search.ts`).
 */
export const CONNECTION_STATUS_FILTERS = [
	"used",
	"all",
	"connected",
	"not_connected",
	"attention",
	"unused",
] as const;

export type ConnectionStatusFilter = (typeof CONNECTION_STATUS_FILTERS)[number];

export const adminConnectionsSearchSchema = z.object({
	q: z.catch(z.string(), ""),
	status: z.catch(z.enum(CONNECTION_STATUS_FILTERS), "all"),
	connect: z.catch(z.optional(z.string()), undefined),
	capability: z.catch(z.optional(z.string()), undefined),
	connectionInstanceId: z.catch(z.optional(z.string()), undefined),
	scopes: z.catch(z.optional(z.string()), undefined),
});

export type AdminConnectionsSearch = z.infer<
	typeof adminConnectionsSearchSchema
>;

/**
 * Function form with the `SearchSchemaInput` marker so links may omit every
 * field (`<Link to="/admin/connections" />`) while readers still get the
 * fully-defaulted output type.
 */
export function validateAdminConnectionsSearch(
	search: {
		q?: string;
		status?: ConnectionStatusFilter;
		connect?: string;
		capability?: string;
		connectionInstanceId?: string;
		scopes?: string;
	} & SearchSchemaInput,
): AdminConnectionsSearch {
	return adminConnectionsSearchSchema.parse(search);
}
