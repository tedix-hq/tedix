import { expect, it } from "vite-plus/test";
import { legacyWorkRedirect } from "./work-redirects";
import { workHomeSearch } from "@/lib/work-home-search";

it.each([
	["attention", "view=feed&filter=attention"],
	["needs-you", "view=deck"],
	["portfolio", "app=portfolio"],
	["agents", "app=agents"],
	["office", "app=office"],
	["outbound", "app=outbound"],
	["attempts", "view=feed&filter=history"],
	["history", "view=feed&filter=history"],
	["recovery", "view=feed&filter=stalled"],
	["stalled", "view=feed&filter=stalled"],
	["queue", "view=feed&filter=queue"],
	["queue?disposition=completed", "view=feed&filter=history"],
])("redirects legacy %s within the same organization host", (path, search) => {
	for (const host of ["cedar.os.example.test", "pine.os.example.test"])
		expect(legacyWorkRedirect(new URL(`https://${host}/work/${path}`))).toBe(
			`https://${host}/work?${search}`,
		);
});
it("keeps record links and current Work URLs direct", () => {
	for (const path of [
		"/work",
		"/work?view=deck",
		"/work/items/cedar",
		"/work/projects/pine",
		"/work/interactions/request",
		"/work/runs/run",
		"/work/executions/run",
	])
		expect(
			legacyWorkRedirect(new URL(path, "https://cedar.os.example.test")),
		).toBeNull();
});
it("validates shareable filters and retains old completed links", () => {
	expect(workHomeSearch({ disposition: "completed" })).toEqual({
		filter: "history",
	});
	expect(
		workHomeSearch({ view: "deck", filter: "stalled", app: "portfolio" }),
	).toEqual({ view: "deck", filter: "stalled", app: "portfolio" });
	expect(
		workHomeSearch({ view: "other-org", filter: "admin", app: "__proto__" }),
	).toEqual({});
});

it.each(["app:work", "factory:Inbox & Social", "workspace:fictional-home"])(
	"retains a Source filter in Work URLs: %s",
	(source) => {
		expect(workHomeSearch({ view: "deck", source })).toEqual({
			view: "deck",
			source,
		});
	},
);
it.each([
	"unknown",
	"factory:",
	"workspace:",
	"factory:" + "x".repeat(256),
	["app:work"],
])("drops an invalid Source filter: %s", (source) => {
	expect(workHomeSearch({ source })).toEqual({});
});
