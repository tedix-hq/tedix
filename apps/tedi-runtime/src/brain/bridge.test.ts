import type {
	Observation,
	ObservationPriority,
} from "@tedix/context-core/types";
import { describe, expect, it, vi } from "bun:test";
import {
	bridgeObservations,
	observationHash,
	type BridgeMetrics,
} from "./bridge";
import type { DedupStore } from "./dedup-types";
import type { PlatformClient } from "./platform-client";

function observation(overrides: Partial<Observation>): Observation {
	return {
		type: "procedural",
		priority: "high",
		content: "The active Acme brain-quality baseline was retrieved.",
		details: [],
		date: "2026-06-28",
		time: "17:15:00",
		...overrides,
	} as Observation;
}

function makeDedupStore(): DedupStore {
	const seen = new Set<string>();
	return {
		has: async (key: string) => seen.has(key),
		add: async (key: string) => {
			seen.add(key);
		},
		flush: async () => {},
	};
}

describe("bridgeObservations", () => {
	it("forwards only supplied user-turn evidence with each observed fact", async () => {
		const memoryLearn = vi.fn(async () => ({}));
		await bridgeObservations({
			observations: [
				observation({
					content: "The operator prefers concise deployment reports.",
					type: "preference",
				}),
			],
			minPriority: "medium",
			platform: { memoryLearn } as unknown as PlatformClient,
			dedup: makeDedupStore(),
			userSourceEvidence: "Please keep deployment reports concise.",
			logger: { log: vi.fn(), error: vi.fn() },
		});
		expect(memoryLearn).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					sourceEvidence: "Please keep deployment reports concise.",
				}),
			}),
		);
	});
	it.each([
		["high", ["high"]],
		["medium", ["high", "medium"]],
		["low", ["high", "medium", "low"]],
	] as const)(
		"learns priorities at or above %s and deduplicates repeated observations",
		async (minPriority, expected) => {
			const memoryLearn = vi.fn(async (_input: { summary: string }) => ({}));
			const platform = { memoryLearn } as unknown as PlatformClient;
			const dedup = makeDedupStore();
			const observations = (
				["high", "medium", "low"] satisfies ObservationPriority[]
			).map((priority) =>
				observation({
					type: "preference",
					priority,
					content: `Preferred language for ${priority} priority`,
				}),
			);
			const options = {
				observations,
				minPriority,
				platform,
				dedup,
				logger: { log: vi.fn(), error: vi.fn() },
			};
			expect(await bridgeObservations(options)).toBe(expected.length);
			expect(memoryLearn.mock.calls.map((call) => call[0].summary)).toEqual(
				expected.map(
					(priority) => `Preferred language for ${priority} priority`,
				),
			);
			expect(await bridgeObservations(options)).toBe(0);
			expect(memoryLearn).toHaveBeenCalledTimes(expected.length);
		},
	);

	it("does not learn controlled-turn procedure observations", async () => {
		const platform = {
			memoryLearn: vi.fn(async () => ({})),
		} as unknown as PlatformClient;

		const bridged = await bridgeObservations({
			observations: [
				observation({}),
				observation({
					content:
						"Executed tedix.complete_rationale_records for the requested rationale update.",
				}),
				observation({
					content:
						"The baseline memory lookup for topic key acme.brain-quality.baseline.current returned one confirmed fact id.",
				}),
				observation({
					content: "The read-only CMS site overview check succeeded.",
					details: [
						"cms_pvp.get_site_overview returned ok=true",
						"no mutation was performed",
					],
				}),
				observation({
					content:
						"For this harness, the agent preserved read-only behavior by limiting execution to lookup and verification calls.",
				}),
				observation({
					content:
						"Home delegated a Tedix memory cleanup request to the agent and required a compact JSON result with attempted, updated, failed, firstFailures, and status.",
					details: [
						"Use Tedix memory tools only",
						"Do not create new memory facts or rationale records",
					],
				}),
				observation({
					content:
						"The cleanup request was reported as completed successfully with all three facts updated and no failures.",
				}),
				observation({
					content:
						"Home delegated a memory cleanup request to the assistant to update four specific procedural memory facts using Tedix memory tools only.",
				}),
				observation({
					content:
						"The assistant completed the requested cleanup by updating all four targeted memory facts and reported success.",
				}),
				observation({
					content:
						"The requested cleanup state was to mark each fact as superseded, background, do_not_inject_automatically, or the closest supported non-injecting inactive cleanup state.",
					details: [
						"No new memory facts or rationale records were to be created",
					],
				}),
				observation({
					content:
						"The request was to use Tedix memory tools only to mark three procedural memory facts as inactive cleanup states without creating new memory facts or rationale records.",
					details: [
						"Mutation limits explicitly forbade new memory facts and rationale records",
					],
				}),
				observation({
					content:
						"The work item was owned directly and required durable progress comments with proof refs, ending with a clear disposition.",
				}),
				observation({
					content:
						"Write exactly one explicit tedi-scoped evidence memory fact for the workflow.",
				}),
			],
			minPriority: "medium",
			platform,
			dedup: makeDedupStore(),
			logger: { log: vi.fn(), error: vi.fn() },
		});

		expect(bridged).toBe(0);
		expect(platform.memoryLearn).not.toHaveBeenCalled();
	});

	it("still learns substantive observations", async () => {
		const platform = {
			memoryLearn: vi.fn(async () => ({})),
		} as unknown as PlatformClient;

		const bridged = await bridgeObservations({
			observations: [
				observation({
					type: "technical",
					content:
						"PromptWatch has no Acme projects configured for marketing observability.",
				}),
			],
			minPriority: "medium",
			platform,
			dedup: makeDedupStore(),
			logger: { log: vi.fn(), error: vi.fn() },
		});

		expect(bridged).toBe(1);
		expect(platform.memoryLearn).toHaveBeenCalledOnce();
	});
});

describe("bridge metrics conservation", () => {
	const logger = { log: vi.fn(), error: vi.fn() };

	it("accounts for every observation and keeps graph writes separate", async () => {
		const duplicate = observation({ content: "Previously learned preference" });
		const dedup = makeDedupStore();
		await dedup.add(observationHash(duplicate));
		const onMetrics = vi.fn();
		const platform = {
			memoryLearn: vi.fn(async (input: { summary: string }) => {
				if (input.summary === "Failed fact") throw new Error("unavailable");
				return {};
			}),
		} as unknown as PlatformClient;
		await bridgeObservations({
			observations: [
				observation({ priority: "low", content: "Low priority" }),
				observation({}),
				duplicate,
				observation({ priority: "medium", content: "Unrelated bananas" }),
				observation({
					type: "preference",
					content: "Use Spanish",
					entities: [{ type: "organization", name: "Customer" }],
				}),
				observation({ content: "Failed fact" }),
			],
			minPriority: "medium",
			platform,
			dedup,
			logger,
			onMetrics,
			currentTask: "vehicle authorization",
		});
		expect(onMetrics).toHaveBeenCalledOnce();
		const metrics: BridgeMetrics = onMetrics.mock.calls[0]![0];
		expect(metrics).toEqual({
			total: 6,
			apiDeduplicated: 0,
			bridged: 1,
			failed: 1,
			deduped: 1,
			gated: 2,
			prioritySkipped: 1,
			procedureSkipped: 1,
			offTopicSkipped: 1,
			entitiesBridged: 1,
		});
		expect(metrics.total).toBe(
			metrics.bridged +
				metrics.failed +
				metrics.deduped +
				metrics.prioritySkipped +
				metrics.procedureSkipped +
				metrics.offTopicSkipped,
		);
	});

	it.each([
		{ observations: [] },
		{
			observations: [
				observation({ priority: "low", content: "Acknowledgment" }),
			],
		},
	])(
		"emits an explicit zero-write result when nothing is eligible: %j",
		async ({ observations }) => {
			const onMetrics = vi.fn();
			const platform = { memoryLearn: vi.fn() } as unknown as PlatformClient;
			await bridgeObservations({
				observations,
				minPriority: "medium",
				platform,
				dedup: makeDedupStore(),
				logger,
				onMetrics,
			});
			expect(onMetrics).toHaveBeenCalledOnce();
			expect(onMetrics.mock.calls[0]![0]).toMatchObject({
				total: observations.length,
				bridged: 0,
				prioritySkipped: observations.length,
			});
			expect(platform.memoryLearn).not.toHaveBeenCalled();
		},
	);

	it("measures new versus repeated short preferences without suppressing learning", async () => {
		const platform = {
			memoryLearn: vi.fn(async () => ({})),
		} as unknown as PlatformClient;
		const dedup = makeDedupStore();
		const results: BridgeMetrics[] = [];
		for (const content of ["Use Spanish", "Use Spanish", "Use English"]) {
			await bridgeObservations({
				observations: [observation({ type: "preference", content })],
				minPriority: "medium",
				platform,
				dedup,
				logger,
				onMetrics: (result) => results.push(result),
			});
		}
		expect(
			results.map(({ bridged, deduped }) => ({ bridged, deduped })),
		).toEqual([
			{ bridged: 1, deduped: 0 },
			{ bridged: 0, deduped: 1 },
			{ bridged: 1, deduped: 0 },
		]);
	});
});

it("reports server deduplication separately from local skips and accepted writes", async () => {
	const metrics = vi.fn();
	const platform = {
		memoryLearn: vi.fn(async () => ({ deduplicated: true })),
	} as unknown as PlatformClient;
	await bridgeObservations({
		observations: [observation({ content: "Use Spanish", type: "preference" })],
		minPriority: "medium",
		platform,
		dedup: makeDedupStore(),
		onMetrics: metrics,
		logger: { log: vi.fn(), error: vi.fn() },
	});
	expect(metrics.mock.calls[0]![0]).toMatchObject({
		bridged: 1,
		apiDeduplicated: 1,
		deduped: 0,
	});
});
