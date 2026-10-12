import type {
	ListCatalogAppsInput,
	ListCatalogAppsOutput,
} from "@tedix/api-contract/schemas/catalog";
import type { BaseContext } from "../rpc/context";

/** Only the global public browse projection is shared; search stays fresh. */
export function catalogListCache(
	context: Pick<BaseContext, "env" | "waitUntil">,
	input: ListCatalogAppsInput,
) {
	const version = context.env.CF_VERSION_METADATA?.id;
	const waitUntil = context.waitUntil;
	if (!version || !waitUntil || input.search?.trim()) return undefined;
	if (typeof caches === "undefined") return undefined;
	const edge = caches.default;
	const url = new URL("https://catalog-cache.invalid/list");
	url.searchParams.set("version", version);
	url.searchParams.set(
		"input",
		JSON.stringify(
			Object.fromEntries(
				Object.entries(input)
					.filter(([key, value]) => key !== "search" && value !== undefined)
					.sort(([a], [b]) => a.localeCompare(b)),
			),
		),
	);
	const request = new Request(url);
	return {
		async match(): Promise<ListCatalogAppsOutput | undefined> {
			try {
				const hit = await edge.match(request);
				return hit ? await hit.json<ListCatalogAppsOutput>() : undefined;
			} catch {
				// Cache availability must not prevent a catalog read.
				return undefined;
			}
		},
		put(page: ListCatalogAppsOutput) {
			// A minute bounds stale visibility/health after any catalog mutation.
			waitUntil(
				edge
					.put(
						request,
						Response.json(page, {
							headers: { "Cache-Control": "public, max-age=60" },
						}),
					)
					.catch(() => undefined),
			);
		},
	};
}
