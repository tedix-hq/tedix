import { describe, expect, it } from "vite-plus/test";
import { classifyDeckCard, DEFAULT_DECK_ROUTING } from "./os-decision-deck";
const now = new Date("2026-10-19T15:00:00Z");
const base = { kind: "question", classId: "question", needsPerson: true };
describe("Deck value routing", () => {
	it.each([
		"Replace the stored API key on the existing connection",
		"Update the profile’s organization consent to include the new organization",
		"Allow the status board to read your requests",
		"Let the worker read my private session activity",
	])("preserves legacy credential and consent request: %s", (action) => {
		expect(classifyDeckCard({ ...base, action }).reason).toBe("critical");
	});
	it("uses learned usefulness to withhold repetitive value classes, preserving critical boundaries", () => {
		const card = {
			...base,
			classId: "opportunity.lead",
			learnedUsefulness: { value: -3, examples: 3 },
		};
		expect(classifyDeckCard(card).reason).toBe("learned_feed");
		expect(
			classifyDeckCard({ ...card, protectedEffects: ["money"] }).reason,
		).toBe("critical");
	});
	it("recognizes critical actions inside routine tool approvals", () => {
		expect(
			classifyDeckCard({
				...base,
				kind: "approval",
				classId: "tool_write",
				action: "gmail_send",
			}).reason,
		).toBe("critical");
		expect(
			classifyDeckCard({
				...base,
				kind: "approval",
				classId: "tool_write",
				action: "notion_update_page",
			}).destination,
		).toBe("feed");
	});
	it.each([
		"filing.project",
		"delegation.research",
		"tool_write",
		"ops.ship",
		"wording",
	])("keeps %s in Feed even when marked as taste", (classId) => {
		expect(
			classifyDeckCard(
				{ ...base, classId, tasteOrStrategy: true },
				undefined,
				now,
			).destination,
		).toBe("feed");
	});
	it.each(["money", "message", "production", "consent", "contract"])(
		"retains the critical %s boundary",
		(effect) => {
			expect(
				classifyDeckCard({ ...base, protectedEffects: [effect] }).reason,
			).toBe("critical");
		},
	);
	it.each(["opportunity.lead", "relationship.followup", "instinct.proposal"])(
		"admits %s without needing risky effects",
		(classId) => {
			expect(
				classifyDeckCard({ ...base, kind: "proposal", classId }).reason,
			).toBe("valuable");
		},
	);
	it("uses explicit ownership and a bounded deadline, not generic approval or irreversibility", () => {
		expect(classifyDeckCard({ ...base, kind: "approval" }).destination).toBe(
			"feed",
		);
		expect(
			classifyDeckCard(
				{ ...base, dueAt: "2026-10-20T10:00:00Z" },
				undefined,
				now,
			).reason,
		).toBe("owner_deadline");
		expect(
			classifyDeckCard(
				{ ...base, dueAt: "2026-10-28T10:00:00Z" },
				undefined,
				now,
			).destination,
		).toBe("feed");
		expect(
			classifyDeckCard({ ...base, needsPerson: false, risk: "critical" })
				.destination,
		).toBe("feed");
	});
	it("supports D1 app policy overrides without changing code", () => {
		expect(
			classifyDeckCard(
				{ ...base, classId: "new.value" },
				{ ...DEFAULT_DECK_ROUTING, valuableClasses: ["new.value"] },
			).destination,
		).toBe("deck");
	});
});
