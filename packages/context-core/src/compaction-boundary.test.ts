/**
 * Boundary selection is the one piece of compaction logic that two independent
 * surfaces (the kernel replay projection and the tedi session repo) share, so
 * these pin it directly: the retained suffix always meets the budget, the cut
 * always lands on a turn start, and every degenerate case reports "cannot
 * advance" rather than folding nothing or splitting a pair.
 */
import { describe, expect, it } from "vite-plus/test";
import { selectRetainIndex, type WeightedTurn } from "./compaction-boundary.js";

/** Alternating user/assistant turns, oldest → newest, each costing `weight`. */
function alternating(count: number, weight = 10): WeightedTurn[] {
	return Array.from({ length: count }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		weight,
	}));
}

describe("selectRetainIndex", () => {
	it("returns undefined for empty input", () => {
		expect(selectRetainIndex([], 100)).toBeUndefined();
		expect(selectRetainIndex([], 0)).toBeUndefined();
	});

	it("returns undefined for a single turn — folding it would fold nothing", () => {
		expect(
			selectRetainIndex([{ role: "user", weight: 10 }], 5),
		).toBeUndefined();
		expect(
			selectRetainIndex([{ role: "assistant", weight: 10 }], 5),
		).toBeUndefined();
	});

	it("returns undefined when everything fits under the budget", () => {
		// 8 turns × 10 = 80 total, budget 1_000 ⇒ the walk runs off the front.
		expect(selectRetainIndex(alternating(8), 1_000)).toBeUndefined();
	});

	it("returns undefined when the tail is exactly one unit under budget", () => {
		// Total is exactly 80; a budget of 81 can never be met.
		expect(selectRetainIndex(alternating(8), 81)).toBeUndefined();
	});

	it("keeps the whole tail when the budget is exactly the total weight", () => {
		// Budget 80 is met only at index 0, which snaps/degenerates to no-op.
		expect(selectRetainIndex(alternating(8), 80)).toBeUndefined();
	});

	it("cuts where the tail first meets the budget, snapping to a turn start", () => {
		// indexes 0..7, roles u,a,u,a,u,a,u,a; each weight 10.
		// budget 25 ⇒ tail walk: i7=10, i6=20, i5=30 ≥ 25 ⇒ cut at 5 (assistant)
		// ⇒ snap back to 4 (user).
		expect(selectRetainIndex(alternating(8), 25)).toEqual({
			retainFrom: 4,
			snapped: true,
		});
	});

	it("does not mark a cut that already landed on a turn start as snapped", () => {
		// budget 35 ⇒ i7,i6,i5,i4 = 40 ≥ 35 ⇒ cut at 4, already a user turn.
		expect(selectRetainIndex(alternating(8), 35)).toEqual({
			retainFrom: 4,
			snapped: false,
		});
	});

	it("retains the newest turn when the budget is zero or negative", () => {
		// Budget 0 is met by the last entry alone: index 7 (assistant) → snap to 6.
		expect(selectRetainIndex(alternating(8), 0)).toEqual({
			retainFrom: 6,
			snapped: true,
		});
		expect(selectRetainIndex(alternating(8), -5)).toEqual({
			retainFrom: 6,
			snapped: true,
		});
	});

	it("returns undefined when snapping lands on index 0", () => {
		// user, assistant, assistant — budget forces the cut onto index 1 or 2,
		// and the only turn start is index 0, so nothing can be folded.
		const turns: WeightedTurn[] = [
			{ role: "user", weight: 10 },
			{ role: "assistant", weight: 10 },
			{ role: "assistant", weight: 10 },
		];
		expect(selectRetainIndex(turns, 15)).toBeUndefined();
		expect(selectRetainIndex(turns, 25)).toBeUndefined();
	});

	it("returns undefined when no user turn is present at all", () => {
		const turns: WeightedTurn[] = [
			{ role: "assistant", weight: 10 },
			{ role: "assistant", weight: 10 },
			{ role: "tool", weight: 10 },
		];
		expect(selectRetainIndex(turns, 5)).toBeUndefined();
		expect(selectRetainIndex(turns, 15)).toBeUndefined();
	});

	it("honours uneven weights — one heavy turn can fill the budget alone", () => {
		const turns: WeightedTurn[] = [
			{ role: "user", weight: 10 },
			{ role: "assistant", weight: 10 },
			{ role: "user", weight: 10 },
			{ role: "assistant", weight: 5_000 },
		];
		// i3 alone (5_000) meets a 100 budget ⇒ cut at 3 ⇒ snap back to 2.
		expect(selectRetainIndex(turns, 100)).toEqual({
			retainFrom: 2,
			snapped: true,
		});
	});

	it("retains a suffix that actually meets the budget", () => {
		const turns = alternating(20, 7);
		for (const budget of [1, 14, 30, 61, 99]) {
			const selected = selectRetainIndex(turns, budget);
			expect(selected).toBeDefined();
			const { retainFrom } = selected as { retainFrom: number };
			expect(turns[retainFrom]?.role).toBe("user");
			expect(retainFrom).toBeGreaterThan(0);
			expect(retainFrom).toBeLessThan(turns.length);
			const retained = turns
				.slice(retainFrom)
				.reduce((sum, turn) => sum + turn.weight, 0);
			expect(retained).toBeGreaterThanOrEqual(budget);
		}
	});

	// ── never split a tool call from its result ──────────────────────────────
	//
	// A retained suffix that opens on a `tool` result whose `assistant` tool-call
	// was folded away is a transcript the model cannot interpret, and some
	// providers reject it outright. The guarantee here is structural rather than
	// tool-aware: `selectRetainIndex` only ever returns an index whose role is
	// `user`, and a tool call and its result always live inside the turn that the
	// preceding `user` entry opened — so a cut on a turn start cannot fall
	// between them. These pin that property directly, because both callers
	// (kernel replay, tedi session repo) rely on it and neither passes tool roles
	// today — the day one does, this must still hold.

	/** user → assistant(tool_call) → tool(result) → assistant(text), repeated. */
	function withToolPairs(turns: number, weight = 10): WeightedTurn[] {
		return Array.from({ length: turns }, (_, i) => [
			{ role: "user", weight },
			{ role: "assistant", weight },
			{ role: "tool", weight },
			{ role: "assistant", weight },
		]).flat();
	}

	it("never returns a boundary that lands on a tool result", () => {
		const turns = withToolPairs(8);
		for (let budget = 1; budget <= turns.length * 10; budget += 1) {
			const selected = selectRetainIndex(turns, budget);
			if (!selected) continue;
			expect(turns[selected.retainFrom]?.role).toBe("user");
			expect(turns[selected.retainFrom]?.role).not.toBe("tool");
		}
	});

	it("never orphans a tool result from the assistant tool-call above it", () => {
		const turns = withToolPairs(8);
		for (let budget = 1; budget <= turns.length * 10; budget += 1) {
			const selected = selectRetainIndex(turns, budget);
			if (!selected) continue;
			// Every retained `tool` entry must still have its `assistant`
			// tool-call inside the retained suffix.
			const retained = turns.slice(selected.retainFrom);
			retained.forEach((turn, index) => {
				if (turn.role !== "tool") return;
				expect(retained[index - 1]?.role).toBe("assistant");
			});
		}
	});

	it("snaps past a whole tool group rather than cutting into it", () => {
		// 8 entries: u,a,tool,a, u,a,tool,a — each weight 10.
		// budget 25 ⇒ tail walk i7=10, i6=20, i5=30 ≥ 25 ⇒ cut at 5 (assistant,
		// a tool CALL) ⇒ must snap back to 4 (user), taking the tool group whole.
		expect(selectRetainIndex(withToolPairs(2), 25)).toEqual({
			retainFrom: 4,
			snapped: true,
		});
	});

	it("cannot advance when a tool group is all that precedes the only turn start", () => {
		// The only user entry is index 0, so every cut snaps to 0 → no-op, rather
		// than retaining a bare tool result.
		const turns: WeightedTurn[] = [
			{ role: "user", weight: 10 },
			{ role: "assistant", weight: 10 },
			{ role: "tool", weight: 10 },
		];
		expect(selectRetainIndex(turns, 15)).toBeUndefined();
		expect(selectRetainIndex(turns, 25)).toBeUndefined();
	});

	it("never mutates the input", () => {
		const turns = alternating(6);
		const before = JSON.stringify(turns);
		selectRetainIndex(turns, 25);
		expect(JSON.stringify(turns)).toBe(before);
	});
});
