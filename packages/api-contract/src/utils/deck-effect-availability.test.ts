import { expect, it } from "vite-plus/test";
import { classifyDeckCard } from "../schemas/os-decision-deck";

it("keeps noncritical cards with unknown effects in Feed even for valuable classes", () => {
	expect(
		classifyDeckCard({
			kind: "question",
			classId: "relationship.follow_up",
			needsPerson: true,
			effectKnown: false,
		}),
	).toMatchObject({ destination: "feed", reason: "missing_effect" });
	expect(
		classifyDeckCard({
			kind: "question",
			classId: "relationship.follow_up",
			needsPerson: true,
		}),
	).toMatchObject({ destination: "deck", reason: "valuable" });
});
it("never hides critical approvals because generated copy lacks effect evidence", () => {
	expect(
		classifyDeckCard({
			kind: "approval",
			classId: "approval.permissions",
			needsPerson: true,
			effectKnown: false,
		}),
	).toMatchObject({ destination: "deck", reason: "critical" });
	expect(
		classifyDeckCard({
			kind: "question",
			classId: "relationship.follow_up",
			needsPerson: true,
			effectKnown: false,
			protectedEffects: ["money"],
		}),
	).toMatchObject({ destination: "deck", reason: "critical" });
});
