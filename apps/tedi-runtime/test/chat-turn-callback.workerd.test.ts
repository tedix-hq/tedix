import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { CallbackFixtureOptions } from "./pi-runtime/workflow-callback-fixture";

type Proof = {
	result?: { text: string };
	error?: string;
	sameFailure: boolean;
	callbacks: { route: string; callback: Record<string, unknown> }[];
	disposed: number[];
	names: string[];
	attempts: string[];
	forgedEqualityCalls: number;
	stats: {
		modelCalls: number;
		cachedAttempts: number;
		freshAttempts: number;
		gets: number;
	};
};
async function probe(params: CallbackFixtureOptions = {}) {
	const binding = (
		env as unknown as { WORKFLOW_CALLBACK: Workflow<CallbackFixtureOptions> }
	).WORKFLOW_CALLBACK;
	const instance = await binding.create({ id: crypto.randomUUID(), params });
	for (let attempt = 0; attempt < 100; attempt++) {
		const status = await instance.status();
		if (status.status === "complete") return status.output as Proof;
		if (status.status === "errored")
			throw new Error(JSON.stringify(status.error));
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await instance.terminate();
	throw new Error("Callback fixture did not complete");
}

it("reproduces the SDK cached callback rejection after a completed facet turn", async () => {
	const f = await probe({ cached: true, poisonCached: true });
	expect(f.error).toContain("memory limit");
	expect(f.sameFailure).toBe(true);
	expect(f.stats.modelCalls).toBe(1);
	expect(f.callbacks).toEqual([]);
});
it("delivers canonical completion through a fresh matching root without repeating the model", async () => {
	const f = await probe({ poisonCached: true });
	expect(f.result?.text).toBe("fixture response");
	expect(f.stats).toEqual({
		modelCalls: 1,
		cachedAttempts: 0,
		freshAttempts: 1,
		gets: 4,
	});
	expect(f.disposed).toEqual([1, 2, 3, 0]);
	expect(f.names.at(-1)).toBe("__agent_reportComplete_0");
	expect(f.callbacks).toEqual([
		{
			route: "root",
			callback: {
				workflowName: "CHAT_TURN_WORKFLOW",
				workflowId: "callback-fixture",
				type: "complete",
				result: f.result,
				timestamp: expect.any(Number),
			},
		},
	]);
});
it.each([
	{ agentName: "missing" },
	{ agentName: "different" },
	{ agentName: "missing", facet: true },
	{ facet: true },
	{ otherBinding: true },
	{ rpcShapedId: true },
])(
	"retains SDK callback routing for an unverified origin %s",
	async (options) => {
		const f = await probe(options);
		expect(f.error).toBeUndefined();
		expect(f.stats.cachedAttempts).toBe(1);
		expect(f.stats.freshAttempts).toBe(0);
		expect(f.forgedEqualityCalls).toBe(0);
		expect(f.callbacks[0]?.route).toBe(options.facet ? "facet" : "root");
	},
);
it("uses only existing one-shot deployment reset recovery for callback delivery", async () => {
	const f = await probe({
		freshCallbackError: "Durable Object reset because its code was updated.",
	});
	expect(f.error).toBeUndefined();
	expect(f.stats.modelCalls).toBe(1);
	expect(f.stats.freshAttempts).toBe(2);
	expect(f.callbacks).toHaveLength(1);
	expect(f.disposed).toEqual([1, 2, 3, 4, 0]);
});
it("preserves the error callback payload without retrying the failed turn", async () => {
	const failure = "fixture deterministic failure";
	const f = await probe({ turnError: failure });
	expect(f.error).toBe(failure);
	expect(f.sameFailure).toBe(true);
	expect(f.stats.modelCalls).toBe(1);
	expect(f.callbacks).toEqual([
		{
			route: "root",
			callback: {
				workflowName: "CHAT_TURN_WORKFLOW",
				workflowId: "callback-fixture",
				type: "error",
				error: failure,
				timestamp: expect.any(Number),
			},
		},
	]);
	expect(f.disposed).toEqual([1, 2, 3, 0]);
});

it("does not immediately retry a memory-reset callback or replace its original error", async () => {
	const failure =
		"Durable Object's isolate exceeded its memory limit and was reset.";
	const f = await probe({ freshCallbackError: failure });
	expect(f.error).toBe(failure);
	expect(f.sameFailure).toBe(true);
	expect(f.attempts).toEqual(["complete", "error"]);
	expect(f.stats.modelCalls).toBe(1);
	expect(f.callbacks[0]?.callback.type).toBe("error");
});
