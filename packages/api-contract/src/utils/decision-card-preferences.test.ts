import { expect, it } from "vite-plus/test";
import { DecisionCardPreferencesSchema } from "../schemas/user-settings";
import {
	decideForMeMode,
	decisionCardContextItems,
	recordDecisionCardContextUse,
} from "./decision-card-preferences";

const ALL = ["source", "due", "asker", "stakes"] as const;

it("shows at most three items in the card's own order by default", () => {
	expect(decisionCardContextItems(undefined, "decision", ALL)).toEqual([
		"source",
		"due",
		"asker",
	]);
	expect(decisionCardContextItems(undefined, "decision", ["due"])).toEqual([
		"due",
	]);
});

it("follows the person's own choice for that card type only", () => {
	const preferences = { contextItems: { outbound: ["stakes" as const] } };
	expect(decisionCardContextItems(preferences, "outbound", ALL)).toEqual([
		"stakes",
	]);
	expect(decisionCardContextItems(preferences, "decision", ALL)).toEqual([
		"source",
		"due",
		"asker",
	]);
});

it("hides an item the person never opens and leads with one they always open", () => {
	let preferences = {};
	for (let card = 0; card < 10; card++)
		preferences = recordDecisionCardContextUse(
			preferences,
			"decision",
			["source", "due", "asker"],
			["asker"],
		);
	// Source and due were shown ten times and never opened; asker always was.
	expect(decisionCardContextItems(preferences, "decision", ALL)).toEqual([
		"asker",
		"stakes",
	]);
	expect(decisionCardContextItems(preferences, "outbound", ALL)).toEqual([
		"source",
		"due",
		"asker",
	]);
});

it("keeps learned counts bounded and the stored preferences valid", () => {
	let preferences = {};
	for (let card = 0; card < 450; card++)
		preferences = recordDecisionCardContextUse(
			preferences,
			"decision",
			["due"],
			card % 2 ? ["due"] : [],
		);
	const parsed = DecisionCardPreferencesSchema.parse(preferences);
	expect(parsed.contextStats?.decision?.due?.shown).toBeLessThanOrEqual(200);
	expect(parsed.contextStats?.decision?.due?.opened).toBeGreaterThan(0);
});

it("always asks unless the person chose otherwise for the card type", () => {
	expect(decideForMeMode(undefined, "decision")).toBe("ask");
	expect(
		decideForMeMode({ decideForMe: { decision: "auto" } }, "decision"),
	).toBe("auto");
	expect(
		decideForMeMode({ decideForMe: { decision: "auto" } }, "outbound"),
	).toBe("ask");
});

it("refuses an unknown context item or more than three per card type", () => {
	expect(
		DecisionCardPreferencesSchema.safeParse({
			contextItems: { decision: ["source", "due", "asker", "stakes"] },
		}).success,
	).toBe(false);
	expect(
		DecisionCardPreferencesSchema.safeParse({
			contextItems: { decision: ["budget"] },
		}).success,
	).toBe(false);
});
