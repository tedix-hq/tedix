import { expect, test } from "bun:test";
import {
	findingKey,
	findingRoute,
	routePattern,
} from "../../apps/os/browser-tests/focus-clip-findings";

test("routePattern normalizes fixture ids out of the reported route", () => {
	expect(
		routePattern(
			"/work/items/wi_7f3d2a1b9c4e5f6a?view=feed",
			"http://fixture.local",
		),
	).toBe("/work/items/:id?view=feed");
	expect(
		routePattern("/workspaces/proj_7f3d2a1b9c4e5f6a", "http://fixture.local"),
	).toBe("/workspaces/:id");
});

test("findingRoute keeps expanded and dialog context on the normalized route", () => {
	expect(
		findingRoute(
			"/outputs/out_4f3d2a1b9c4e5f6a › expanded",
			"http://fixture.local",
		),
	).toBe("/outputs/:id › expanded");
	expect(
		findingRoute(
			"/work/wi_7f3d2a1b9c4e5f6a › Delete output",
			"http://fixture.local",
		),
	).toBe("/work/:id › Delete output");
});

test("findingKey keeps identical controls on different elements as separate hits", () => {
	const base = {
		route: "/outputs/:id",
		control: 'button.card-action "Open"',
		kind: "ring",
	};
	expect(
		findingKey({ ...base, selector: "article:nth-of-type(1) > button" }),
	).not.toBe(
		findingKey({ ...base, selector: "article:nth-of-type(2) > button" }),
	);
});
