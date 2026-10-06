import type {
	ToolSchemaSyncInput,
	ToolSchemaSyncResult,
} from "@tedix/api-contract/contracts/tool-schema-sync";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
}));

const mocks = vi.hoisted(() => ({
	createDb: vi.fn(() => ({}) as never),
	planProjection: vi.fn(),
	planRows: vi.fn(),
	run: vi.fn(),
	publish: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({
	createDbClient: mocks.createDb,
}));

vi.mock("../services/tool-schema-sync", () => ({
	planToolSchemaSyncProjection: mocks.planProjection,
	planToolSchemaSyncRows: mocks.planRows,
	resolveTedixAdminAppId: async () => "5eed0020-0000-4000-8000-000000000020",
	runToolSchemaSync: mocks.run,
	publishToolSchemaSyncEvents: mocks.publish,
}));

import { ToolSchemaSyncWorkflow } from "./tool-schema-sync-workflow";

/**
 * A step harness that behaves like the Workflows engine: a step's result is
 * persisted under its NAME and replayed on any later invocation, so a completed
 * step never re-runs. A failing step is not cached, which is exactly why a
 * retry resumes at the first incomplete batch.
 */
function engine() {
	const cache = new Map<string, unknown>();
	const executed: string[] = [];
	const step = {
		do: vi.fn(
			async (
				name: string,
				optionsOrCallback: unknown,
				maybeCallback?: () => Promise<unknown>,
			) => {
				if (cache.has(name)) return cache.get(name);
				const callback = (maybeCallback ??
					optionsOrCallback) as () => Promise<unknown>;
				executed.push(name);
				const value = await callback();
				cache.set(name, value);
				return value;
			},
		),
	};
	return { cache, executed, step };
}

function workflow(env: Partial<CloudflareEnv> = {}) {
	const instance = new ToolSchemaSyncWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	(instance as unknown as { env: CloudflareEnv }).env = {
		DB: {},
		...env,
	} as CloudflareEnv;
	return instance;
}

function endpoints(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `router${String(index).padStart(3, "0")}/proc`,
	);
}

function syncResult(
	overrides: Partial<ToolSchemaSyncResult> = {},
): ToolSchemaSyncResult {
	return {
		appId: "app-1",
		mode: "projection",
		source: "rpc",
		target: "both",
		apply: true,
		total: 50,
		planned: 0,
		created: 0,
		updated: 0,
		deleted: 0,
		inSync: 50,
		skipped: 0,
		failed: 0,
		items: [],
		...overrides,
	} as ToolSchemaSyncResult;
}

function batchOptions(): ToolSchemaSyncInput[] {
	return mocks.run.mock.calls.map((call) => call[1] as ToolSchemaSyncInput);
}

function purgeCalls(env: {
	MCP_SERVICE?: { fetch: ReturnType<typeof vi.fn> };
}) {
	return env.MCP_SERVICE?.fetch.mock.calls.length ?? 0;
}

function mcpService() {
	return {
		fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDb.mockReturnValue({} as never);
	mocks.run.mockImplementation(async () => syncResult());
	mocks.publish.mockResolvedValue(undefined);
	mocks.planProjection.mockReturnValue({
		appId: "app-1",
		endpoints: endpoints(120),
		toolIds: Object.fromEntries(
			endpoints(120).map((path, index) => [path, `tool_${index}`]),
		),
	});
	mocks.planRows.mockResolvedValue({
		appId: "app-1",
		toolIds: endpoints(120).map((_, index) => `tool_${index}`),
	});
});

describe("ToolSchemaSyncWorkflow batching", () => {
	it("plans once and splits the frozen work list into bounded batches", async () => {
		const { step, executed } = engine();
		await workflow().run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		expect(mocks.planProjection).toHaveBeenCalledTimes(1);
		expect(executed[0]).toBe("plan tool schema sync");
		const batchSteps = executed.filter((name) =>
			name.startsWith("project-batch-"),
		);
		expect(batchSteps).toHaveLength(3);

		const options = batchOptions();
		expect(options.map((option) => option.endpoints?.length)).toEqual([
			50, 50, 20,
		]);
		// Every endpoint is visited exactly once, in the frozen plan order.
		expect(options.flatMap((option) => option.endpoints ?? [])).toEqual(
			endpoints(120),
		);
	});

	it("gives every batch the same composition on a second run of the same plan", async () => {
		const first = engine();
		await workflow().run(
			{ payload: { mode: "projection" } } as never,
			first.step as never,
		);
		const firstNames = [...first.executed];
		const firstSlices = batchOptions().map((option) => option.endpoints);

		vi.clearAllMocks();
		mocks.run.mockImplementation(async () => syncResult());
		const second = engine();
		await workflow().run(
			{ payload: { mode: "projection" } } as never,
			second.step as never,
		);

		expect(second.executed).toEqual(firstNames);
		expect(batchOptions().map((option) => option.endpoints)).toEqual(
			firstSlices,
		);
	});

	it("hands each batch the plan-wide tool id map slice instead of letting it re-resolve ids", async () => {
		const { step } = engine();
		await workflow().run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		const options = batchOptions();
		expect(Object.keys(options[0]?.toolIdOverrides ?? {})).toHaveLength(50);
		expect(options[0]?.toolIdOverrides?.["router000/proc"]).toBe("tool_0");
		expect(options[2]?.toolIdOverrides?.["router100/proc"]).toBe("tool_100");
		// A batch must never receive another batch's endpoints in its map.
		expect(options[0]?.toolIdOverrides?.["router100/proc"]).toBeUndefined();
	});

	it("batches schema mode over stored tool ids", async () => {
		const { step, executed } = engine();
		await workflow().run(
			{ payload: { mode: "schema" } } as never,
			step as never,
		);

		expect(mocks.planRows).toHaveBeenCalledTimes(1);
		expect(mocks.planProjection).not.toHaveBeenCalled();
		expect(
			executed.filter((name) => name.startsWith("project-batch-")),
		).toHaveLength(3);
		expect(batchOptions().map((option) => option.toolIds?.length)).toEqual([
			50, 50, 20,
		]);
		expect(
			batchOptions().every((option) => option.endpoints === undefined),
		).toBe(true);
	});
});

describe("ToolSchemaSyncWorkflow resume", () => {
	it("resumes at the failed batch instead of repeating completed ones", async () => {
		const { step, executed, cache } = engine();
		let attempt = 0;
		mocks.run.mockImplementation(async () => {
			attempt++;
			if (attempt === 2) throw new Error("Worker exceeded memory limit");
			return syncResult();
		});

		await expect(
			workflow().run(
				{ payload: { mode: "projection" } } as never,
				step as never,
			),
		).rejects.toThrow(/memory limit/);

		const firstAttemptBatches = executed.filter((name) =>
			name.startsWith("project-batch-"),
		);
		expect(firstAttemptBatches).toHaveLength(2);
		const completedBatchName = firstAttemptBatches[0] as string;
		expect(cache.has(completedBatchName)).toBe(true);
		expect(cache.has(firstAttemptBatches[1] as string)).toBe(false);

		// The engine replays the instance against the same persisted step cache.
		executed.length = 0;
		mocks.run.mockImplementation(async () => syncResult());
		const aggregate = await workflow().run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		expect(executed).not.toContain("plan tool schema sync");
		expect(executed).not.toContain(completedBatchName);
		expect(
			executed.filter((name) => name.startsWith("project-batch-")),
		).toEqual(firstAttemptBatches.slice(1).concat(expect.any(String)));
		// The replay still folds the cached batch results into the aggregate.
		expect(aggregate.batchesCompleted).toBe(3);
		expect(aggregate.total).toBe(150);
	});

	it("re-runs only the failed batch's endpoints on the retry", async () => {
		const { step } = engine();
		let attempt = 0;
		mocks.run.mockImplementation(async () => {
			attempt++;
			if (attempt === 2) throw new Error("boom");
			return syncResult();
		});
		await expect(
			workflow().run(
				{ payload: { mode: "projection" } } as never,
				step as never,
			),
		).rejects.toThrow();

		mocks.run.mockClear();
		mocks.run.mockImplementation(async () => syncResult());
		await workflow().run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		const retried = batchOptions();
		expect(retried).toHaveLength(2);
		expect(retried[0]?.endpoints).toEqual(endpoints(120).slice(50, 100));
		expect(retried[1]?.endpoints).toEqual(endpoints(120).slice(100, 120));
	});
});

describe("ToolSchemaSyncWorkflow cache purge", () => {
	it("purges and notifies exactly once, after every batch succeeded", async () => {
		const env = { MCP_SERVICE: mcpService() };
		const { step, executed } = engine();
		mocks.run.mockImplementation(async () =>
			syncResult({ planned: 10, updated: 10, inSync: 40 }),
		);

		await workflow(env as never).run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		expect(purgeCalls(env)).toBe(1);
		expect(mocks.publish).toHaveBeenCalledTimes(1);
		const purgeIndex = executed.indexOf("purge aggregate tool cache");
		const lastBatchIndex = executed.reduce(
			(last, name, index) => (name.startsWith("project-batch-") ? index : last),
			-1,
		);
		expect(purgeIndex).toBeGreaterThan(lastBatchIndex);
	});

	it("never purges when a batch fails, so a half-projected surface is not published", async () => {
		const env = { MCP_SERVICE: mcpService() };
		const { step, executed } = engine();
		let attempt = 0;
		mocks.run.mockImplementation(async () => {
			attempt++;
			if (attempt === 3) throw new Error("Worker exceeded memory limit");
			return syncResult({ planned: 10, updated: 10, inSync: 40 });
		});

		await expect(
			workflow(env as never).run(
				{ payload: { mode: "projection" } } as never,
				step as never,
			),
		).rejects.toThrow(/memory limit/);

		expect(purgeCalls(env)).toBe(0);
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(executed).not.toContain("purge aggregate tool cache");
	});

	// The case the code comment used to claim was impossible. A per-endpoint
	// write failure is REPORTED, not raised, so the batch step returns normally
	// with `failed: N` and the instance never errors. Gating publish/purge on
	// `changed > 0` alone therefore announced a surface that was known to be
	// incomplete — and `stripUnknownTopLevelKeys` validates against that cached
	// schema, so publishing half a projection makes the gateway reject its own
	// successful responses.
	it("refuses to publish when a batch REPORTS failures without throwing", async () => {
		const env = { MCP_SERVICE: mcpService() };
		const { step, executed } = engine();
		let attempt = 0;
		mocks.run.mockImplementation(async () => {
			attempt++;
			// One batch writes successfully; another reports per-endpoint failures.
			return attempt === 2
				? syncResult({ planned: 50, failed: 50, inSync: 0 })
				: syncResult({ planned: 50, updated: 50, inSync: 0 });
		});

		// No throw — the run completes and reports.
		const result = await workflow(env as never).run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		expect(result.failed).toBeGreaterThan(0);
		// Changed rows exist, so the old `changed > 0` gate would have fired.
		expect(result.updated).toBeGreaterThan(0);
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(purgeCalls(env)).toBe(0);
		expect(executed).not.toContain("purge aggregate tool cache");
		expect(executed).not.toContain("publish tool list changed");
	});

	it("does not purge when nothing changed", async () => {
		const env = { MCP_SERVICE: mcpService() };
		const { step } = engine();
		await workflow(env as never).run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);
		expect(purgeCalls(env)).toBe(0);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("does not purge a preview run", async () => {
		const env = { MCP_SERVICE: mcpService() };
		const { step } = engine();
		mocks.run.mockImplementation(async () =>
			syncResult({ apply: false, planned: 10 }),
		);
		await workflow(env as never).run(
			{ payload: { mode: "projection", apply: false } } as never,
			step as never,
		);
		expect(purgeCalls(env)).toBe(0);
		expect(mocks.publish).not.toHaveBeenCalled();
	});
});

describe("ToolSchemaSyncWorkflow reporting", () => {
	it("bounds the aggregate report even when every endpoint fails loudly", async () => {
		const { step } = engine();
		mocks.run.mockImplementation(async (_db, options) => {
			const scoped = (options as ToolSchemaSyncInput).endpoints ?? [];
			return syncResult({
				total: scoped.length,
				planned: scoped.length,
				inSync: 0,
				failed: scoped.length,
				items: scoped.map((endpoint) => ({
					toolUuid: null,
					toolId: endpoint,
					endpoint,
					status: "failed" as const,
					changed: [],
					message: "D1_ERROR: ".repeat(400),
				})),
			});
		});

		const aggregate = await workflow().run(
			{ payload: { mode: "projection" } } as never,
			step as never,
		);

		expect(aggregate.failed).toBe(120);
		expect(aggregate.items.length).toBeLessThanOrEqual(100);
		expect(aggregate.itemsTruncated).toBe(20);
		for (const entry of aggregate.items) {
			expect(entry.message?.length ?? 0).toBeLessThanOrEqual(201);
		}
		expect(JSON.stringify(aggregate).length).toBeLessThan(64 * 1024);
	});

	it("spends one shared write budget across batches rather than one per batch", async () => {
		const { step } = engine();
		mocks.run.mockImplementation(async (_db, options) => {
			const limit = (options as ToolSchemaSyncInput).limit;
			const planned = Math.min(limit ?? 50, 50);
			return syncResult({ planned, updated: planned, inSync: 50 - planned });
		});

		await workflow().run(
			{ payload: { mode: "projection", limit: 60 } } as never,
			step as never,
		);

		expect(batchOptions().map((option) => option.limit)).toEqual([60, 10, 0]);
	});
});
