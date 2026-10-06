import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

/**
 * URL state for the /team surface. Tabs and roster/member paging live in the search
 * string — shareable, back/forward-correct, prefetchable — never in component
 * state. `z.catch` defaults keep an unrecognized or hand-typed value from
 * blocking the navigation: it lands on the roster instead of an error page.
 *
 * `zod/mini`, deliberately: this schema is reachable from the route config,
 * which lives in the shared entry chunk, and classic `zod` costs ~50 KiB
 * minified there. The functional mini API tree-shakes to a few KiB with
 * identical parse semantics.
 */
export const TEAM_TAB_IDS = ["tedis", "members", "roles"] as const;

export type TeamTab = (typeof TEAM_TAB_IDS)[number];

export const TEAM_TABS: readonly { id: TeamTab; label: string }[] = [
	{ id: "tedis", label: "Tedis" },
	{ id: "members", label: "Members" },
	{ id: "roles", label: "Roles" },
];

export const teamSearchSchema = z.object({
	tab: z.catch(z.enum(TEAM_TAB_IDS), "tedis"),
	/** 1-based page for the Tedis and Members tabs. */
	page: z.catch(z.int().check(z.minimum(1)), 1),
});

export type TeamSearch = z.infer<typeof teamSearchSchema>;

/**
 * Function form with the `SearchSchemaInput` marker so links may omit any
 * field (`<Link to="/team" />`, `search={{ tab: "members" }}`) while readers
 * still get the fully-defaulted output type.
 */
export function validateTeamSearch(
	search: { tab?: TeamTab; page?: number } & SearchSchemaInput,
): TeamSearch {
	return teamSearchSchema.parse(search);
}
