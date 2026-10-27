import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { compactTimelineReceipt } from "../src/artifact-timeline";
import { DISPATCH_SHIM } from "../src/runner";
import {
	WORKFLOW_FETCH_GATE_MODULE,
	WORKFLOW_FETCH_GATE_FACTORY_SOURCE,
} from "../src/runner-sandbox";

class PermanentError extends Error {}
const context = new AsyncLocalStorage<Record<string, unknown>>();
const imports = DISPATCH_SHIM.match(
	/import \{([\s\S]*?)\} from "\.\/workflow-fetch-gate\.js";/,
)![1]!
	.replace(/^[\s\S]*import \{/, "")
	.split(",")
	.map((name) => name.trim())
	.filter(Boolean);
const strip = (source: string) =>
	source
		.replace(/import [\s\S]*? from [^;]+;/g, "")
		.replace(/export default TenantSkillWorkflow;/g, "")
		.replace(/export \{[^}]+\};/g, "")
		.replace(/export /g, "");
const helpers = new Function(
	"NonRetryableError",
	"workflowCallContext",
	`${strip(WORKFLOW_FETCH_GATE_MODULE)}; return {${imports.join(",")}, createWorkflowOperation};`,
)(PermanentError, context);
const runtime = new Function(
	"WorkflowEntrypoint",
	"NonRetryableError",
	"workflowCallContext",
	"userMod",
	...imports,
	`${strip(DISPATCH_SHIM)}; return {wrapStep, buildMcpProxy, makeTimeline};`,
)(
	class {},
	PermanentError,
	context,
	{},
	...imports.map((name) => helpers[name]),
);
const gateFactory = new Function(
	`${WORKFLOW_FETCH_GATE_FACTORY_SOURCE}; return createWorkflowFetchGate;`,
)();

function harness() {
	const rows = new Map<string, ReturnType<typeof compactTimelineReceipt>>();
	let failStore = false;
	let fetches = 0;
	let attempt = 1;
	const env = {
		__ARTIFACT_BRIDGE__: {
			record: async (input: Parameters<typeof compactTimelineReceipt>[0]) => {
				if (failStore && input.path.includes("/network/"))
					throw new Error("store unavailable");
				const compact = compactTimelineReceipt(input);
				if (compact) rows.set(input.path, JSON.parse(JSON.stringify(compact)));
			},
		},
		__MCP_BRIDGE__: {
			call: async ({ method }: { method: string }) => {
				if (method === "fail") throw new Error("provider unavailable");
				return { value: "sensitive body" };
			},
		},
	};
	const run = { runId: "run", executionEpoch: 2 };
	const mcp = runtime.buildMcpProxy(env, run);
	const native = {
		do: async (name: string, fn: (ctx: unknown) => unknown) =>
			fn({ step: { name, count: 1 }, attempt, config: {} }),
		sleep: async () => {},
		sleepUntil: async () => {},
		waitForEvent: async () => ({ payload: "secret event" }),
	};
	const step = runtime.wrapStep(native, env, runtime.makeTimeline(), run);
	const fetch = gateFactory(
		() => context.getStore(),
		async (request: Request) => {
			fetches++;
			expect(
				[...rows.values()].some(
					(row) => row?.kind === "network" && row.outcome === "pending",
				),
			).toBe(true);
			if (request.url.includes("disconnect")) throw new Error("socket reset");
			return new Response("body", {
				status: request.url.includes("limited") ? 429 : 200,
			});
		},
		() => new Error("outside step"),
		helpers.createWorkflowOperation,
		helpers.trackWorkflowOperation,
		Promise.reject.bind(Promise),
		(args: [string]) => [new Request(args[0])],
	);
	return {
		rows,
		step,
		mcp,
		fetch,
		failStore: () => {
			failStore = true;
		},
		fetches: () => fetches,
		retry: () => {
			attempt++;
		},
	};
}

describe("compact workflow recording", () => {
	test("records concurrent MCP and fetch calls, including HTTP and transport failures", async () => {
		const h = harness();
		await h.step.do("collect", async () => {
			await Promise.all([
				h.mcp.tools.read({}),
				h.fetch("https://example.test/ok?token=secret"),
				h.fetch("https://example.test/limited"),
			]);
			await expect(
				Promise.resolve(h.fetch("https://example.test/disconnect")),
			).rejects.toThrow("socket reset");
			await expect(Promise.resolve(h.mcp.tools.fail({}))).rejects.toThrow(
				"provider unavailable",
			);
		});
		const records = [...h.rows.values()].filter((row) => row !== null);
		expect(records).toHaveLength(6);
		expect(records.filter((row) => row.kind === "network")).toHaveLength(3);
		expect(records.find((row) => row.httpStatus === 429)?.outcome).toBe(
			"failure",
		);
		expect(records.find((row) => row.kind === "step")?.outcome).toBe("success");
		expect(records.filter((row) => row.outcome === "failure")).toHaveLength(3);
		for (const row of records) {
			expect(row.startedAt).toBeString();
			expect(row.endedAt).toBeString();
			expect(row.durationMs).toBeGreaterThanOrEqual(0);
		}
		expect(JSON.stringify(records)).not.toContain("token");
		expect(JSON.stringify(records)).not.toContain("sensitive body");
	});

	test("stops fetch when recording fails", async () => {
		const h = harness();
		h.failStore();
		await expect(
			h.step.do("read", () => h.fetch("https://example.test/ok")),
		).rejects.toThrow("store unavailable");
		expect(h.fetches()).toBe(0);
		expect(
			[...h.rows.values()].find((row) => row?.kind === "step")?.outcome,
		).toBe("failure");
	});

	test("records sleep, sleepUntil and wait timing without event payloads", async () => {
		const h = harness();
		await h.step.sleep("pause", "1 second");
		await h.step.sleepUntil("wake", Date.now());
		await h.step.waitForEvent("approval", { type: "approved" });
		for (const row of h.rows.values()) {
			expect(row?.outcome).toBe("success");
			expect(row?.startedAt).toBeString();
			expect(row?.durationMs).toBeGreaterThanOrEqual(0);
		}
		expect(JSON.stringify([...h.rows.values()])).not.toContain("secret event");
	});

	test("keeps failed and succeeded retry receipts", async () => {
		const h = harness();
		await expect(h.step.do("read", () => h.mcp.tools.fail({}))).rejects.toThrow(
			"provider unavailable",
		);
		h.retry();
		await h.step.do("read", () => h.mcp.tools.read({}));
		const steps = [...h.rows.values()].filter((row) => row?.kind === "step");
		expect(steps.map((row) => row?.attempt)).toEqual([1, 2]);
		expect(steps.map((row) => row?.outcome)).toEqual(["failure", "success"]);
	});
});
