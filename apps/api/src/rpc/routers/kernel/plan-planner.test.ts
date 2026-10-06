import type { SelectedKernelModel } from "./llm";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vite-plus/test";
import {
	type PlanDependencyEdge,
	type PlanPlannerTarget,
	planTediAssignments,
	pruneDependencyCycles,
} from "./plan-planner";

function objectModel(object: unknown): SelectedKernelModel {
	return {
		model: new MockLanguageModelV3({
			doGenerate: async () => ({
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
				content: [{ type: "text", text: JSON.stringify(object) }],
			}),
		}),
		pricingIdentity: null,
		attempts: [],
		forOperation() {
			return { ...this, attempts: [] };
		},
	};
}

const throwingModel: SelectedKernelModel = {
	model: new MockLanguageModelV3({
		doGenerate: async () => {
			throw new Error("boom");
		},
	}),
	pricingIdentity: null,
	attempts: [],
	forOperation() {
		return { ...this, attempts: [] };
	},
};

const TARGETS: PlanPlannerTarget[] = [
	{ id: "tedi-cto", label: "CTO", slug: "cto" },
	{ id: "tedi-cpo", label: "CPO", slug: "cpo" },
];

describe("planTediAssignments", () => {
	it("maps each owner to its specific objective + captures usage (happy path)", async () => {
		const result = await planTediAssignments({
			content:
				"have CTO review the deploy pipeline and CPO outline the roadmap",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{
						ownerId: "tedi-cto",
						objective: "Review the deploy pipeline and flag release risks.",
					},
					{
						ownerId: "tedi-cpo",
						objective: "Outline the product roadmap for next quarter.",
					},
				],
				dependencies: [],
			}),
		});
		expect(result.objectives).not.toBeNull();
		expect(result.objectives?.get("tedi-cto")).toBe(
			"Review the deploy pipeline and flag release risks.",
		);
		expect(result.objectives?.get("tedi-cpo")).toBe(
			"Outline the product roadmap for next quarter.",
		);
		// The objectives are owner-specific — NOT the v0 generic template.
		expect(result.objectives?.get("tedi-cto")).not.toContain("Own CTO's slice");
		// Cost telemetry: the decomposition call's usage object is captured. The mock
		// doesn't surface token VALUES through generateObject, so assert the SHAPE
		// (matching route-planner.test); real provider usage carries the counts.
		expect(result.usage).not.toBeNull();
		expect(result.usage).toHaveProperty("model");
		expect("outputTokens" in (result.usage ?? {})).toBe(true);
	});

	it("keeps explicitly labelled branches with their named owners when the model transposes them", async () => {
		const result = await planTediAssignments({
			content: [
				"Branch 1 — CPO (brain-only): Analyze launch risk using supplied facts.",
				"Branch 2 — CTO (hands): Verify the existing workstation marker.",
			].join("\n"),
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{
						ownerId: "tedi-cto",
						objective: "Analyze launch risk using supplied facts.",
					},
					{
						ownerId: "tedi-cpo",
						objective: "Verify the existing workstation marker.",
					},
				],
				dependencies: [],
			}),
		});

		expect(result.objectives?.get("tedi-cpo")).toBe(
			"Analyze launch risk using supplied facts.",
		);
		expect(result.objectives?.get("tedi-cto")).toBe(
			"Verify the existing workstation marker.",
		);
	});

	it("keeps explicitly labelled branches when model planning fails", async () => {
		const result = await planTediAssignments({
			content: [
				"Branch 1 — CPO (brain-only): Analyze launch risk using supplied facts.",
				"Branch 2 — CTO (hands): Verify the existing workstation marker.",
			].join("\n"),
			targets: TARGETS,
			model: throwingModel,
		});

		expect(result.objectives?.get("tedi-cpo")).toBe(
			"Analyze launch risk using supplied facts.",
		);
		expect(result.objectives?.get("tedi-cto")).toBe(
			"Verify the existing workstation marker.",
		);
		expect(result.dependencies).toEqual([]);
	});

	it("drops owner ids not in the provided roster (roster-grounding)", async () => {
		const result = await planTediAssignments({
			content: "split this across CTO and CPO",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "Do the CTO part." },
					{
						ownerId: "tedi-ghost",
						objective: "Invented owner not on the roster.",
					},
				],
				dependencies: [],
			}),
		});
		expect(result.objectives?.has("tedi-cto")).toBe(true);
		expect(result.objectives?.has("tedi-ghost")).toBe(false);
		expect(result.objectives?.size).toBe(1);
	});

	it("skips empty / whitespace-only objectives (caller falls back to template)", async () => {
		const result = await planTediAssignments({
			content: "split this across CTO and CPO",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "Real objective." },
					{ ownerId: "tedi-cpo", objective: "   " },
				],
				dependencies: [],
			}),
		});
		expect(result.objectives?.get("tedi-cto")).toBe("Real objective.");
		expect(result.objectives?.has("tedi-cpo")).toBe(false);
	});

	it("keeps the first objective when an owner is duplicated", async () => {
		const result = await planTediAssignments({
			content: "split this across CTO and CPO",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "First." },
					{ ownerId: "tedi-cto", objective: "Second." },
				],
				dependencies: [],
			}),
		});
		expect(result.objectives?.get("tedi-cto")).toBe("First.");
	});

	it("null objectives + null usage when the model is unavailable (fail-soft)", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: null,
		});
		expect(result.objectives).toBeNull();
		expect(result.usage).toBeNull();
	});

	it("null objectives for an empty roster (model never called)", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: [],
			model: objectModel({ assignments: [] }),
		});
		expect(result.objectives).toBeNull();
	});

	it("null objectives + null usage when generation throws (fail-soft to v0 template)", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: throwingModel,
		});
		expect(result.objectives).toBeNull();
		expect(result.usage).toBeNull();
	});

	it("null objectives when no assignment survives roster validation", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: objectModel({
				assignments: [{ ownerId: "ghost", objective: "off-roster" }],
				dependencies: [],
			}),
		});
		expect(result.objectives).toBeNull();
	});
});

/**
 * STEP 3 (a)/(b)/(c) at the INFERENCE layer: planTediAssignments must surface a
 * roster-validated, cycle-pruned DAG of blocking edges keyed by owner id. Direction
 * is BLOCKER → DEPENDENT (`fromOwner` finishes first, `toOwner` waits). The
 * relation/gate end-to-end (mapping these edges to work_item_relations and the
 * Phase-1 dispatch gate) is exercised against real SQLite in plan-dependencies.test.ts.
 */
describe("planTediAssignments — inferred dependencies", () => {
	it("(a) infers a directed blocking edge (blocker → dependent), preserving direction", async () => {
		const result = await planTediAssignments({
			content: "CTO provisions the database before CPO runs the migration",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "Provision the database." },
					{ ownerId: "tedi-cpo", objective: "Run the migration." },
				],
				dependencies: [
					{
						fromOwner: "tedi-cto",
						toOwner: "tedi-cpo",
						reason: "the database must exist before the migration runs",
					},
				],
			}),
		});
		expect(result.dependencies).toEqual([
			{
				fromOwner: "tedi-cto",
				toOwner: "tedi-cpo",
				reason: "the database must exist before the migration runs",
			},
		]);
	});

	it("drops edges whose endpoints are off-roster (roster-grounding)", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "A." },
					{ ownerId: "tedi-cpo", objective: "B." },
				],
				dependencies: [
					{
						fromOwner: "tedi-cto",
						toOwner: "tedi-ghost",
						reason: "off-roster",
					},
					{
						fromOwner: "tedi-ghost",
						toOwner: "tedi-cpo",
						reason: "off-roster",
					},
				],
			}),
		});
		expect(result.dependencies).toEqual([]);
	});

	it("drops self-edges and de-duplicates repeated edges", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "A." },
					{ ownerId: "tedi-cpo", objective: "B." },
				],
				dependencies: [
					{ fromOwner: "tedi-cto", toOwner: "tedi-cto", reason: "self-edge" },
					{ fromOwner: "tedi-cto", toOwner: "tedi-cpo", reason: "real" },
					{ fromOwner: "tedi-cto", toOwner: "tedi-cpo", reason: "duplicate" },
				],
			}),
		});
		expect(result.dependencies).toEqual([
			{ fromOwner: "tedi-cto", toOwner: "tedi-cpo", reason: "real" },
		]);
	});

	it("(b) CYCLE SAFETY: breaks a 2-cycle the model emits — at most one edge survives", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "A." },
					{ ownerId: "tedi-cpo", objective: "B." },
				],
				dependencies: [
					{ fromOwner: "tedi-cto", toOwner: "tedi-cpo", reason: "forward" },
					{
						fromOwner: "tedi-cpo",
						toOwner: "tedi-cto",
						reason: "back edge — closes the cycle",
					},
				],
			}),
		});
		// The cycle is broken to a DAG: the back edge is dropped, the forward kept.
		expect(result.dependencies).toEqual([
			{ fromOwner: "tedi-cto", toOwner: "tedi-cpo", reason: "forward" },
		]);
	});

	it("(c) FAIL-SOFT: empty dependencies when generation throws", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: throwingModel,
		});
		expect(result.objectives).toBeNull();
		expect(result.dependencies).toEqual([]);
	});

	it("(c) FAIL-SOFT: empty dependencies when the model is unavailable", async () => {
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: null,
		});
		expect(result.dependencies).toEqual([]);
	});

	it("keeps independent objectives edge-free (no invented dependencies)", async () => {
		const result = await planTediAssignments({
			content: "two unrelated asks",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "A." },
					{ ownerId: "tedi-cpo", objective: "B." },
				],
				dependencies: [],
			}),
		});
		expect(result.dependencies).toEqual([]);
	});
});

/**
 * STEP 3 (b) CYCLE SAFETY at the pure-function layer: pruneDependencyCycles must
 * return a DAG (drop back edges) while preserving every forward/cross edge of a
 * legitimate dependency graph, deterministically and in input order.
 */
describe("pruneDependencyCycles", () => {
	const edge = (from: string, to: string): PlanDependencyEdge => ({
		fromOwner: from,
		toOwner: to,
		reason: `${from}->${to}`,
	});

	it("returns [] for no edges", () => {
		expect(pruneDependencyCycles([])).toEqual([]);
	});

	it("breaks a 2-cycle to a single surviving edge", () => {
		const out = pruneDependencyCycles([edge("a", "b"), edge("b", "a")]);
		expect(out).toEqual([edge("a", "b")]);
	});

	it("breaks a 3-cycle by dropping the single back edge", () => {
		const out = pruneDependencyCycles([
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "a"),
		]);
		// c->a is the back edge into the active DFS stack → dropped; the chain remains.
		expect(out).toEqual([edge("a", "b"), edge("b", "c")]);
	});

	it("drops a self-edge (a self-loop is a back edge)", () => {
		const out = pruneDependencyCycles([edge("a", "a"), edge("a", "b")]);
		expect(out).toEqual([edge("a", "b")]);
	});

	it("preserves a legitimate diamond DAG (no cycle, nothing dropped)", () => {
		const diamond = [
			edge("a", "b"),
			edge("a", "c"),
			edge("b", "d"),
			edge("c", "d"),
		];
		expect(pruneDependencyCycles(diamond)).toEqual(diamond);
	});
});
