import { describe, expect, it } from "vite-plus/test";
import { cardSourceOptions, matchesCardSource } from "./card-source-filter";

const HOME = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";
const names = new Map([[HOME, "Home"]]);

describe("cardSourceOptions", () => {
	it("offers nothing without a factory", () => {
		expect(cardSourceOptions([], (id) => names.get(id))).toEqual([]);
	});

	it("lists Work, each factory once and each workspace once", () => {
		expect(
			cardSourceOptions(
				[
					{ label: "Inbox", workspaceId: HOME },
					{ label: "Social", workspaceId: HOME },
					{ label: "Inbox", workspaceId: SHARED },
				],
				(id) => names.get(id),
			),
		).toEqual([
			{ value: "all", label: "All sources" },
			{ value: "app:work", label: "Work" },
			{ value: "factory:Inbox", label: "Inbox" },
			{ value: "factory:Social", label: "Social" },
			{ value: `workspace:${HOME}`, label: "In Home" },
			{ value: `workspace:${SHARED}`, label: "In a workspace" },
		]);
	});
});

describe("matchesCardSource", () => {
	const inbox = { factory: "Inbox", workspaceId: HOME };
	it("matches by factory label, workspace and the Work app", () => {
		expect(matchesCardSource("all", null)).toBe(true);
		expect(matchesCardSource("all", inbox)).toBe(true);
		expect(matchesCardSource("app:work", null)).toBe(true);
		expect(matchesCardSource("app:work", inbox)).toBe(false);
		expect(matchesCardSource("factory:Inbox", inbox)).toBe(true);
		expect(matchesCardSource("factory:Social", inbox)).toBe(false);
		expect(matchesCardSource("factory:Inbox", null)).toBe(false);
		expect(matchesCardSource(`workspace:${HOME}`, inbox)).toBe(true);
		expect(matchesCardSource(`workspace:${SHARED}`, inbox)).toBe(false);
		expect(matchesCardSource(`workspace:${HOME}`, null)).toBe(false);
	});
});
