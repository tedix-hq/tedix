import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

/**
 * URL state for /admin/connections. The status tab and search text live in
 * the search string — shareable, back/forward-correct, prefetchable — never
 * in component state. `z.catch` keeps a hand-typed or stale value from
 * blocking the navigation.
 *
 * `connect` is the auto-connect landing param minted by apps/api
 * (`?connect=<appId>` fires the connect flow once on arrival). It is a plain
 * optional passthrough — a catch that defaulted it away would break the
 * server-minted handoff links.
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
	} & SearchSchemaInput,
): AdminConnectionsSearch {
	return adminConnectionsSearchSchema.parse(search);
}
