import { describe, expect, it } from "vite-plus/test";
import {
	LaneExecutorSchema,
	LaneExecutionPolicySchema,
	laneResourceKeys,
} from "./lane-execution";

const executor = {
	id: "codex",
	kind: "codex",
	principalType: "external_agent",
	principalId: "local-example",
	resourceKey: "executor:codex",
	costMicros: 100,
	capabilities: ["source.read"],
} as const;
const policy = {
	version: 1,
	role: "maker",
	sharedResourceKeys: ["org:lanes", "project:lanes"],
	makerResourceKey: "org:makers",
	reservedSlots: 2,
	budgetEnvelopeIds: ["execution-budget"],
	executors: [executor],
	maxAttempts: 3,
	maxDelegationDepth: 2,
	delegationDepth: 0,
};

describe("lane policy boundary", () => {
	it("keeps unknown pricing unavailable and rejects zero, negative and non-finite estimates", () => {
		expect(
			LaneExecutorSchema.parse({ ...executor, costMicros: null }).costMicros,
		).toBeNull();
		for (const costMicros of [
			0,
			-1,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
		])
			expect(
				LaneExecutorSchema.safeParse({ ...executor, costMicros }).success,
			).toBe(false);
	});
	it.each(["codex", "claude", "tedi", "skill"] as const)(
		"binds %s to the correct principal type",
		(kind) => {
			const principalType = ["codex", "claude"].includes(kind)
				? "external_agent"
				: "tedi";
			expect(
				LaneExecutorSchema.safeParse({ ...executor, kind, principalType })
					.success,
			).toBe(true);
			expect(
				LaneExecutorSchema.safeParse({
					...executor,
					kind,
					principalType: principalType === "tedi" ? "external_agent" : "tedi",
				}).success,
			).toBe(false);
		},
	);
	it("requires distinct shared/maker pools, bounded retries and explicit budget reservations", () => {
		for (const change of [
			{ sharedResourceKeys: ["org:makers"] },
			{ budgetEnvelopeIds: [] },
			{ reservedSlots: 0 },
			{ maxAttempts: 1000 },
			{ maxDelegationDepth: 1000 },
			{ executors: [executor, executor] },
		])
			expect(
				LaneExecutionPolicySchema.safeParse({ ...policy, ...change }).success,
			).toBe(false);
	});
	it("keeps all lane roles on shared org/project/executor capacity and gives only makers the maker claim", () => {
		for (const role of ["maker", "verification", "closure"] as const) {
			const parsed = LaneExecutionPolicySchema.parse({ ...policy, role });
			expect(laneResourceKeys(parsed, parsed.executors[0]!)).toEqual([
				"org:lanes",
				"project:lanes",
				...(role === "maker" ? ["org:makers"] : []),
				"executor:codex",
			]);
		}
	});
});
