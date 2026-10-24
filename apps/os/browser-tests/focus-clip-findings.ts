/**
 * Reporting helpers for the clipped-control audit. Each finding pairs a
 * stable route pattern (fixture ids normalized away) with a CSS selector
 * that resolves to exactly the element it names, so identical controls on
 * repeated cards report as separate, individually locatable hits instead of
 * one generic line.
 *
 * The page-side half of this reporting lives in focus-clip-page.ts, which
 * focus-clip.spec.ts serializes into its page.evaluate call.
 */

export type FocusClipHit = {
	control: string;
	selector: string;
	kind: "border" | "ring" | "column" | "focus";
	sides: string;
	overshoot: number;
	clipper: string;
	clipperSelector: string;
};

const KEPT_QUERY = ["view", "section", "tab"];

// Same id shapes the fixture pack uses: UUIDs, prefixed ids, long slugs with digits.
export function routePattern(href: string, origin: string) {
	const url = new URL(href, origin);
	const path = url.pathname
		.split("/")
		.map((segment) =>
			/^[0-9a-f-]{16,}$/i.test(segment) ||
			(/\d/.test(segment) && segment.length > 8) ||
			/^(tedi|wi|run|case|out|skill|app|proj|req|ws)[_-]/.test(segment)
				? ":id"
				: segment,
		)
		.join("/");
	const query = KEPT_QUERY.filter((key) => url.searchParams.has(key))
		.map((key) => `${key}=${url.searchParams.get(key)}`)
		.join("&");
	return query ? `${path}?${query}` : path;
}

// `at` is `path`, `path › expanded`, or `path › <dialog name>`; only the URL
// part carries per-run fixture ids.
export function findingRoute(at: string, origin: string) {
	const [path = "", ...context] = at.split(" › ");
	return [routePattern(path, origin), ...context].join(" › ");
}

// Two findings are the same regression only when they name the same element
// at the same route; identical controls on different cards stay distinct.
export function findingKey(finding: {
	route: string;
	selector: string;
	kind: string;
}) {
	return `${finding.route}|${finding.selector}|${finding.kind}`;
}
