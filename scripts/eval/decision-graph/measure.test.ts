import { describe, expect, test } from "bun:test";
import { fixture } from "./fixture.mjs";
import {
	graphRecommendations,
	markdown,
	measure,
	sample,
	sweepCard,
} from "./measure.mjs";
import { deploymentContains } from "./run.mjs";

describe("decision graph measurement", () => {
	test("zero blocks preserve the observed order, missing contexts stay unmeasured", () => {
		const { snapshot } = fixture();
		for (const context of Object.values(snapshot.contexts))
			context.blocksCount = 0;
		snapshot.currentIds.reverse();
		const r = measure(snapshot);
		expect(r.cohorts.current.ranking.moved).toBe(0);
		snapshot.contexts = {};
		const incomplete = measure(snapshot);
		expect(incomplete.cohorts.current.contextRead).toBe(0);
		expect(incomplete.cohorts.current.ranking.before).toEqual([]);
		expect(incomplete.precision.duplicate.precision).toBeNull();
	});
	test("baseline text duplicates are not claimed as incremental graph value", () => {
		const { snapshot } = fixture();
		const older = snapshot.rows[1]!.request,
			newer = snapshot.rows[2]!.request;
		newer.subject = older.subject;
		newer.workItemId = older.workItemId;
		const r = measure(snapshot);
		expect(r.cohorts.current.baseline.byReason.duplicate).toBe(1);
		expect(r.cohorts.current.incrementalRemovals).toBe(59);
	});
	test("twenty per rule, counterexamples retained, graph lift and ranking measured", () => {
		const { snapshot, labels } = fixture();
		const r = measure(snapshot, labels);
		expect(r.cohorts.current.cards).toBe(80);
		expect(r.cohorts.last30Days.cards).toBe(80);
		expect(r.cohorts.current.graph).toEqual({
			already_decided: 20,
			duplicate: 20,
			stale: 20,
		});
		expect(r.cohorts.current.graphUniqueRemovals).toBe(60);
		expect(r.cohorts.current.incrementalRemovals).toBe(60);
		expect(r.cohorts.current.baseline.actions).toBe(0);
		expect(r.cohorts.current.ranking.moved).toBeGreaterThan(0);
		for (const p of Object.values(r.precision)) {
			expect(p.sampled).toBe(20);
			expect(p.checked).toBe(20);
			expect(p.correct).toBe(19);
			expect(p.contradicted).toBe(1);
			expect(p.precision).toBe(0.95);
		}
		expect(markdown(r)).toContain("95.0%");
	});
	test("unknown labels are not counted as correct or as zero precision", () => {
		const r = measure(fixture().snapshot);
		expect(r.precision.duplicate.unknown).toBe(20);
		expect(r.precision.duplicate.precision).toBeNull();
		expect(markdown(r)).toContain("unmeasured");
	});
	test("sampling is deterministic and label-independent", () => {
		const candidates = Array.from({ length: 40 }, (_, i) => ({
			rule: "duplicate",
			cardId: String(i),
		}));
		expect(sample(candidates, "duplicate")).toEqual(
			sample([...candidates].reverse(), "duplicate"),
		);
		expect(sample(candidates, "duplicate")).toHaveLength(20);
	});
	test("protected, owner-authored and self-answered cards are not retired", () => {
		const { snapshot } = fixture();
		const row = snapshot.rows[0]!,
			id = row.request.id;
		row.request.metadata = { riskLevel: "critical" };
		expect(graphRecommendations([sweepCard(row)], snapshot.contexts)).toEqual(
			[],
		);
		row.request.metadata = {};
		row.request.creatorType = "user";
		expect(graphRecommendations([sweepCard(row)], snapshot.contexts)).toEqual(
			[],
		);
		row.request.creatorType = "external_agent";
		snapshot.contexts[id]!.priorDecision!.edge.kind = "card_answers";
		expect(graphRecommendations([sweepCard(row)], snapshot.contexts)).toEqual(
			[],
		);
	});
	test("API requestedAt bounds the thirty-day cohort; current older cards stay visible", () => {
		const { snapshot } = fixture();
		snapshot.rows[0]!.request.requestedAt = "2026-09-01T00:00:00.000Z";
		const r = measure(snapshot);
		expect(r.cohorts.current.cards).toBe(80);
		expect(r.cohorts.last30Days.cards).toBe(79);
	});
	test("context mismatch and undocumented ground-truth labels fail", () => {
		const { snapshot, labels } = fixture();
		expect(() =>
			measure(snapshot, [{ ...labels[0], evidenceRef: null }]),
		).toThrow("independent dated evidence");
		snapshot.contexts[snapshot.currentIds[0]]!.cardId = "wrong";
		expect(() => measure(snapshot)).toThrow("Context/card mismatch");
	});
	test("counts overlapping rules once in unique removals", () => {
		const { snapshot } = fixture();
		const [a, b] = snapshot.currentIds;
		snapshot.contexts[a]!.supersededBy =
			snapshot.contexts[b]!.supersededBy ??
			snapshot.contexts[snapshot.currentIds[3]]!.supersededBy;
		const r = measure(snapshot);
		expect(r.cohorts.current.graph.stale).toBe(21);
		expect(r.cohorts.current.graphUniqueRemovals).toBe(60);
	});
	test("live deployment gate requires exact full SHAs and both ancestors", () => {
		const deployed = "a".repeat(40),
			writers = "b".repeat(40),
			backfill = "c".repeat(40);
		expect(() =>
			deploymentContains(deployed, [writers, backfill], () => true),
		).not.toThrow();
		expect(() =>
			deploymentContains(deployed, [writers, backfill], (a) => a === writers),
		).toThrow("does not contain");
		expect(() => deploymentContains("unknown", [writers], () => true)).toThrow(
			"Full deployment",
		);
	});
});
