import { describe, expect, test } from "bun:test";
import { fixture } from "./fixture.mjs";
import { productionComparison } from "./production.mjs";
import {
	graphRecommendations,
	markdown,
	measure,
	sample,
	sweepCard,
} from "./measure.mjs";
import {
	assertStoredDeckSchema,
	deploymentContains,
	readWithRetry,
} from "./run.mjs";

describe("decision graph measurement", () => {
	test("transient read checks retry with bounded backoff", async () => {
		let calls = 0;
		const delays: number[] = [];
		const result = await readWithRetry(
			async () => {
				if (++calls < 3) throw new Error("human_mcp_grant_unavailable");
				return "read";
			},
			async (ms) => {
				delays.push(ms);
			},
		);
		expect(result).toBe("read");
		expect(calls).toBe(3);
		expect(delays).toEqual([1000, 2000]);
	});
	test("permission and capacity gates are returned without retrying", async () => {
		for (const message of ["FORBIDDEN", "HTTP 429 Retry-After: 120"]) {
			let calls = 0;
			await expect(
				readWithRetry(async () => {
					calls++;
					throw new Error(message);
				}),
			).rejects.toThrow(message);
			expect(calls).toBe(1);
		}
	});
	test("read outages stop after five attempts", async () => {
		let calls = 0;
		await expect(
			readWithRetry(
				async () => {
					calls++;
					throw new Error("human_mcp_grant_unavailable");
				},
				async () => {},
			),
		).rejects.toThrow("human_mcp_grant_unavailable");
		expect(calls).toBe(5);
	});
	test("stale discovery cannot silently drop the stored-only request", () => {
		expect(() => assertStoredDeckSchema({ properties: {} })).toThrow(
			"Stored-only Deck read",
		);
		expect(() =>
			assertStoredDeckSchema({
				properties: { presentation: { enum: ["generate"] } },
			}),
		).toThrow("Stored-only Deck read");
		expect(() =>
			assertStoredDeckSchema({
				properties: { presentation: { enum: ["generate", "stored"] } },
			}),
		).not.toThrow();
	});
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
	test("production ranking uses blocked counts only for actionable survivors", () => {
		const { snapshot } = fixture();
		const rows = [snapshot.rows[2]!, snapshot.rows[6]!];
		const now = new Date(snapshot.observedAt);
		const run = () =>
			productionComparison(
				rows.map(sweepCard),
				snapshot.contexts,
				now,
				{},
				"UTC",
			);
		snapshot.contexts[rows[0]!.request.id]!.blocksCount = 0;
		snapshot.contexts[rows[1]!.request.id]!.blocksCount = 0;
		expect(run().ranking.moved).toBe(0);
		snapshot.contexts[rows[1]!.request.id]!.blocksCount = 5;
		expect(run().ranking.moved).toBe(2);
		rows[1]!.request.prompt = "Please sign in.";
		expect(run().ranking.before).toHaveLength(1);
	});
	test("production precision excludes a card's own historical answer", () => {
		const { snapshot } = fixture();
		const row = snapshot.rows[0]!;
		snapshot.contexts[row.request.id]!.priorDecision!.edge.kind =
			"card_answers";
		const r = productionComparison(
			[sweepCard(row)],
			snapshot.contexts,
			new Date(snapshot.observedAt),
			{},
			"UTC",
		);
		expect(r.candidates).toEqual([]);
	});
	test("production comparison preserves text duplicates and measures stale withdrawal", () => {
		const { snapshot } = fixture();
		const rows = snapshot.rows.slice(0, 4);
		rows[2]!.request.subject = rows[1]!.request.subject;
		rows[2]!.request.workItemId = rows[1]!.request.workItemId;
		rows[3]!.request.dueAt = "2026-10-19T12:00:00.000Z";
		rows[3]!.request.prompt = "Deadline has passed; check the source.";
		const r = productionComparison(
			rows.map(sweepCard),
			snapshot.contexts,
			new Date(snapshot.observedAt),
			{},
			"UTC",
		);
		expect(r.text.actions.some((a) => a.reason === "duplicate")).toBe(true);
		expect(
			r.actions.some(
				(a) => a.cardId === rows[3]!.request.id && a.reason === "expired",
			),
		).toBe(true);
		expect(
			r.candidates.some(
				(a) => a.cardId === rows[0]!.request.id && a.rule === "already_decided",
			),
		).toBe(true);
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
