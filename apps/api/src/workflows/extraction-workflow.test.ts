import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parseConfiguredExtractResult } from "../services/configured-extract-result";

describe("parseConfiguredExtractResult", () => {
	it("reads only the configured array key", () => {
		expect(
			parseConfiguredExtractResult(
				{ vehicles: [{ title: "Configured vehicle" }] },
				"vehicles",
			),
		).toMatchObject([{ title: "Configured vehicle" }]);
		expect(
			parseConfiguredExtractResult(
				{ items: [{ title: "Wrong shape" }] },
				"vehicles",
			),
		).toEqual([]);
	});

	it("rejects a raw top-level array", () => {
		expect(
			parseConfiguredExtractResult([{ title: "Unconfigured shape" }], "items"),
		).toEqual([]);
	});
});

const storage = vi.hoisted(() => ({
	app: {
		id: "test-app",
		name: "Example",
		metadata: {} as Record<string, unknown>,
	},
	upsert: vi.fn(async (_db: unknown, _appId: string, items: unknown[]) => ({
		inserted: items.length,
		updated: 0,
	})),
	update: vi.fn(async () => undefined),
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: async () => storage.app,
	getAppMetadataJson: (app: typeof storage.app) => app.metadata,
	updateApp: storage.update,
}));
vi.mock("@tedix/db/queries/items", () => ({ upsertItems: storage.upsert }));
vi.mock("../services/extraction-validator", () => ({
	validateExtraction: () => ({
		valid: true,
		score: 0.8,
		warnings: ["Detailed warning"],
		errors: ["Visible error"],
		coverage: { missing: ["description"] },
	}),
}));
import { ExtractionWorkflow } from "./extraction-workflow";
import { ExtractionConfigExpandedSchema } from "@tedix/api-contract/schemas/extraction-config";

const instructions = {
	method: "agent",
	siteName: "Example",
	siteSearchInstructions: "Browse the Example catalog",
	prompt: "Extract catalog items",
	arrayKey: "items",
	schema: { type: "object" },
};
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const staleJobId = "33333333-3333-4333-8333-333333333333";
async function execute(
	config: Record<string, unknown>,
	options: {
		startId?: unknown;
		status?: "completed" | "failed" | "cancelled";
		mismatch?: boolean;
	} = {},
) {
	storage.app.metadata = { extractionConfig: config };
	storage.upsert.mockClear();
	storage.update.mockClear();
	const fetchMock = vi.fn(async () =>
		Response.json({ success: true, id: options.startId ?? jobId }),
	);
	vi.stubGlobal("fetch", fetchMock);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const workflow = new ExtractionWorkflow(
		{} as never,
		{
			DB: {},
			FIRECRAWL_API_KEY: "test",
			API_URL: "https://api.example.com",
		} as never,
	);
	const rollbacks: Array<
		(args: { error: Error; output: unknown }) => Promise<void>
	> = [];
	const stepConfigs = new Map<string, unknown>();
	const buffered = [
		{
			type: `firecrawl-agent-${staleJobId}`,
			payload: {
				success: true,
				status: "completed",
				firecrawlJobId: staleJobId,
				data: { items: [{ title: "Stale", url: "https://example.com/stale" }] },
			},
		},
		{
			type: `firecrawl-agent-${jobId}`,
			payload: {
				success: !options.status || options.status === "completed",
				status: options.status ?? "completed",
				firecrawlJobId: options.mismatch ? staleJobId : jobId,
				error:
					options.status === "cancelled"
						? "Firecrawl agent cancelled"
						: undefined,
				data: {
					items: [
						{
							title: "Complete",
							description: "Required detail",
							url: "https://example.com/one",
							price: 10,
						},
						{ title: "Incomplete", url: "https://example.com/two", price: 20 },
					],
				},
			},
		},
	];
	const step = {
		do: async (
			name: string,
			options: unknown,
			callback: () => Promise<unknown>,
			compensation?: {
				rollback: (args: { error: Error; output: unknown }) => Promise<void>;
			},
		) => {
			stepConfigs.set(name, options);
			const output = await callback();
			if (compensation)
				rollbacks.push((args) => compensation.rollback({ ...args, output }));
			return output;
		},
		waitForEvent: async (_name: string, options: { type: string }) => {
			const event = buffered.find((event) => event.type === options.type);
			if (!event) throw new Error(`No buffered event for ${options.type}`);
			return event;
		},
	};
	const result = await workflow
		.run(
			{
				instanceId: "workflow",
				payload: {
					appId: "test-app",
					siteName: "Example",
					vertical: "ecommerce",
				},
			} as never,
			step as never,
		)
		.catch(async (error: Error) => {
			for (const rollback of rollbacks.reverse())
				await rollback({ error, output: undefined });
			throw error;
		});
	const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	return {
		request: JSON.parse(String(init.body)),
		result,
		warn,
		error,
		stepConfigs,
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("stored extraction controls through workflow", () => {
	it("uses configured agent bounds, prompt limits and required-field filtering", async () => {
		const config = ExtractionConfigExpandedSchema.parse({
			...instructions,
			agent: {
				model: "spark-1-pro",
				maxCredits: 8,
				urls: ["https://example.com/catalog"],
				strictConstrainToURLs: true,
			},
			stopConditions: {
				maxClicks: 3,
				maxScrolls: 2,
				maxDetailPages: 4,
				maxListingPages: 1,
			},
			quality: {
				minScore: 0.9,
				logWarnings: false,
				rejectIncomplete: true,
				requiredFields: ["description"],
			},
		});
		const { request, result, warn, error } = await execute(config);
		expect(request).toMatchObject({
			model: "spark-1-pro",
			maxCredits: 8,
			urls: ["https://example.com/catalog"],
			strictConstrainToURLs: true,
			schema: instructions.schema,
			webhook: {
				url: "https://api.example.com/webhooks/firecrawl",
				metadata: { workflowInstanceId: "workflow", appId: "test-app" },
				events: ["completed", "failed", "cancelled"],
			},
		});
		expect(request.prompt).toContain("Maximum click actions: 3");
		expect(request.prompt).toContain("Maximum scroll actions: 2");
		expect(request.prompt).toContain("Maximum detail pages to visit: 4");
		expect(result.itemsExtracted).toBe(1);
		expect(storage.upsert.mock.calls[0]?.[2]).toHaveLength(1);
		expect(
			warn.mock.calls.some((call) => String(call[0]).includes("LOW QUALITY")),
		).toBe(true);
		expect(
			warn.mock.calls.some((call) => String(call[0]).includes("Warnings:")),
		).toBe(false);
		expect(error).toHaveBeenCalledWith("[Workflow] Errors:", ["Visible error"]);
	});
	it("keeps absent controls at existing request and quality defaults", async () => {
		const { request, result, warn } = await execute(instructions);
		expect(request).not.toHaveProperty("urls");
		expect(request).not.toHaveProperty("maxCredits");
		expect(request).not.toHaveProperty("model");
		expect(result.itemsExtracted).toBe(2);
		expect(
			warn.mock.calls.some((call) => String(call[0]).includes("LOW QUALITY")),
		).toBe(false);
		expect(warn).toHaveBeenCalledWith("[Workflow] Warnings:", [
			"Detailed warning",
		]);
	});
	it("starts at most one paid provider job on an ambiguous response", async () => {
		const { stepConfigs } = await execute(instructions);
		expect(stepConfigs.get("start-agent-job")).toMatchObject({
			retries: { limit: 0 },
		});
	});
	it("caps over-returned items at the resolved configured limit before upsert", async () => {
		const { result, warn } = await execute({ ...instructions, limit: 1 });
		expect(result.itemsExtracted).toBe(1);
		expect(storage.upsert.mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({ title: "Complete" }),
		]);
		expect(warn).toHaveBeenCalledWith(
			"[Workflow] Capped 2 extracted items to configured limit 1",
		);
		expect(storage.update).toHaveBeenCalledWith(
			expect.anything(),
			"test-app",
			expect.objectContaining({
				metadata: expect.objectContaining({
					itemExtraction: expect.objectContaining({ itemsExtracted: 1 }),
				}),
			}),
		);
	});
	it("rejects retired or unknown D1 settings before a provider call", async () => {
		await expect(execute({ ...instructions, enabled: true })).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
		await expect(
			execute({ ...instructions, agent: { timeout: 1 } }),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("provider job correlation", () => {
	it("selects the current pre-wait callback after a stale job callback", async () => {
		await execute(instructions);
		expect(storage.upsert.mock.calls[0]?.[2]).toEqual(
			expect.arrayContaining([expect.objectContaining({ title: "Complete" })]),
		);
		expect(storage.upsert.mock.calls[0]?.[2]).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ title: "Stale" })]),
		);
	});
	it("normalizes a valid uppercase start UUID to the callback event type", async () => {
		const { result } = await execute(instructions, {
			startId: jobId.toUpperCase(),
		});
		expect(result.itemsExtracted).toBe(2);
	});
	it("rejects a mismatched payload before persistence", async () => {
		await expect(execute(instructions, { mismatch: true })).rejects.toThrow(
			/job/i,
		);
		expect(storage.upsert).not.toHaveBeenCalled();
	});
	it("records cancellation failure through registered compensation", async () => {
		await expect(
			execute(instructions, { status: "cancelled" }),
		).rejects.toThrow(/cancelled/);
		expect(storage.upsert).not.toHaveBeenCalled();
		expect(storage.update).toHaveBeenCalledWith(
			expect.anything(),
			"test-app",
			expect.objectContaining({
				metadata: expect.objectContaining({
					itemExtractionError: expect.stringContaining("cancelled"),
				}),
			}),
		);
	});
	it.each(["job", {}, "x".repeat(200)])(
		"rejects invalid successful start ID",
		async (startId) => {
			await expect(execute(instructions, { startId })).rejects.toThrow(
				/Firecrawl agent start failed/,
			);
			expect(storage.upsert).not.toHaveBeenCalled();
		},
	);
});
