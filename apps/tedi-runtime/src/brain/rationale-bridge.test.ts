import type { Observation } from "@tedix/context-core/types";
import { describe, expect, it, vi } from "bun:test";
import type { PlatformClient } from "./platform-client";
import {
	type RationaleBridgeState,
	runRationaleBridge,
} from "./rationale-bridge";

function observation(overrides: Partial<Observation>): Observation {
	return {
		type: "decision",
		priority: "high",
		content: "Install Firecrawl app for acme org config",
		details: [],
		date: "2026-06-28",
		time: "16:00:00",
		...overrides,
	} as Observation;
}

function makeStateStore() {
	let state: RationaleBridgeState = { records: [] };
	return {
		load: async () => state,
		save: async (next: RationaleBridgeState) => {
			state = next;
		},
	};
}

describe("runRationaleBridge", () => {
	it("does not create recursive records for rationale lifecycle observations", async () => {
		const stateStore = makeStateStore();
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
			completeRationaleRecord: vi.fn(async () => ({})),
		} as unknown as PlatformClient;

		const result = await runRationaleBridge({
			newObservations: [
				observation({
					content:
						"The assistant returned a successful completion payload for the requested rationale record mutation.",
				}),
				observation({
					content:
						"Executed tedix.complete_rationale_records for the Acme cleanup.",
				}),
			],
			platform,
			stateStore,
			correlation: { traceId: "cleanup-run", sourceSessionId: "session-a" },
		});

		expect(platform.createRationaleRecord).not.toHaveBeenCalled();
		expect(result.recordIds).toEqual([]);
	});

	it("only completes rationale records from the matching run correlation", async () => {
		const stateStore = makeStateStore();
		const completeRationaleRecord = vi.fn(async () => ({}));
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
			completeRationaleRecord,
		} as unknown as PlatformClient;

		await runRationaleBridge({
			newObservations: [observation({})],
			platform,
			stateStore,
			correlation: { traceId: "run-a", sourceSessionId: "session-a" },
		});

		await runRationaleBridge({
			newObservations: [
				observation({
					type: "error",
					content: "Firecrawl install failed for acme org config",
				}),
			],
			platform,
			stateStore,
			correlation: { traceId: "run-b", sourceSessionId: "session-a" },
		});

		expect(completeRationaleRecord).not.toHaveBeenCalled();

		await runRationaleBridge({
			newObservations: [
				observation({
					type: "error",
					content: "Firecrawl install failed for acme org config",
				}),
			],
			platform,
			stateStore,
			correlation: { traceId: "run-a", sourceSessionId: "session-a" },
		});

		expect(completeRationaleRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "rationale-1",
				outcomeStatus: "failure",
			}),
		);
	});

	it("does not create deployment rationales for read-only publish guardrails", async () => {
		const stateStore = makeStateStore();
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
			completeRationaleRecord: vi.fn(async () => ({})),
		} as unknown as PlatformClient;

		const result = await runRationaleBridge({
			newObservations: [
				observation({
					type: "decision",
					content:
						"For this workflow, the next safe action is to stay read-only and do not publish or mutate public CMS content without a separate approval.",
				}),
			],
			platform,
			stateStore,
			correlation: { traceId: "read-only-run", sourceSessionId: "session-a" },
		});

		expect(platform.createRationaleRecord).not.toHaveBeenCalled();
		expect(result.recordIds).toEqual([]);
	});

	it("WS1: auto-attaches runId + toolCallRefs to created records", async () => {
		const stateStore = makeStateStore();
		const createRationaleRecord = vi.fn(async () => ({ id: "rationale-1" }));
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord,
			completeRationaleRecord: vi.fn(async () => ({})),
		} as unknown as PlatformClient;

		await runRationaleBridge({
			newObservations: [observation({})],
			platform,
			stateStore,
			correlation: {
				traceId: "tedi-1:mcp:42",
				runId: "tedi-1:mcp:42",
				toolCallRefs: ["tedi-1:mcp:42:step:0:0:install_app"],
				sourceSessionId: "session-a",
			},
		});

		expect(createRationaleRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "tedi-1:mcp:42",
				toolCallRefs: ["tedi-1:mcp:42:step:0:0:install_app"],
				evidence: expect.objectContaining({
					runId: "tedi-1:mcp:42",
					traceId: "tedi-1:mcp:42",
				}),
			}),
		);
	});

	it("B3: completes a run-matched record same-turn with the run proofRef (no age gate)", async () => {
		const stateStore = makeStateStore();
		const completeRationaleRecord = vi.fn(async () => ({}));
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
			completeRationaleRecord,
		} as unknown as PlatformClient;

		// One turn: the decision opens the record and the procedural success
		// observation settles in the SAME run — the shared runId is the
		// span-checkable proof, so completion must not wait for SUCCESS_AGE_MS
		// (per-turn runId rotation would otherwise make it unreachable).
		const result = await runRationaleBridge({
			newObservations: [
				observation({}),
				observation({
					type: "procedural",
					priority: "medium",
					content: "Firecrawl install completed for acme org config",
				}),
			],
			platform,
			stateStore,
			correlation: { runId: "run-same-turn", sourceSessionId: "session-a" },
		});

		expect(completeRationaleRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "rationale-1",
				outcomeStatus: "success",
				proofRef: { kind: "run", ref: "run-same-turn" },
			}),
		);
		expect(result.created).toEqual(["rationale-1"]);
		expect(result.completed).toEqual(["rationale-1"]);
	});

	it("certifies a same-turn recovered tool error once, as success", async () => {
		const stateStore = makeStateStore();
		const completeRationaleRecord = vi.fn(async () => ({}));
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
			completeRationaleRecord,
		} as unknown as PlatformClient;

		await runRationaleBridge({
			newObservations: [
				observation({}),
				observation({
					type: "error",
					content: "Firecrawl install initially failed for acme org config",
				}),
				observation({
					type: "procedural",
					priority: "medium",
					content:
						"Firecrawl install completed for acme org config after retry",
				}),
			],
			platform,
			stateStore,
			correlation: { runId: "run-recovered", sourceSessionId: "session-a" },
		});

		expect(completeRationaleRecord).toHaveBeenCalledTimes(1);
		expect(completeRationaleRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "rationale-1",
				outcomeStatus: "success",
				proofRef: { kind: "run", ref: "run-recovered" },
			}),
		);
	});

	it("B3: non-run-matched records stay age-gated for heuristic success completion", async () => {
		vi.useFakeTimers();
		try {
			const stateStore = makeStateStore();
			const completeRationaleRecord = vi.fn(async () => ({}));
			const platform = {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
				completeRationaleRecord,
			} as unknown as PlatformClient;

			// Record created WITHOUT a runId correlation → success completion is
			// heuristic and must keep the monitoring-window age gate.
			await runRationaleBridge({
				newObservations: [
					observation({}),
					observation({
						type: "procedural",
						priority: "medium",
						content: "Firecrawl install completed for acme org config",
					}),
				],
				platform,
				stateStore,
				correlation: { traceId: "trace-1", sourceSessionId: "session-a" },
			});
			expect(completeRationaleRecord).not.toHaveBeenCalled();

			vi.advanceTimersByTime(6 * 60_000);
			await runRationaleBridge({
				newObservations: [
					observation({
						type: "procedural",
						priority: "medium",
						content: "Firecrawl install completed for acme org config",
					}),
				],
				platform,
				stateStore,
				correlation: { traceId: "trace-1", sourceSessionId: "session-a" },
			});
			expect(completeRationaleRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "rationale-1",
					outcomeStatus: "success",
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("WS1: success completion carries a span-checkable run proofRef", async () => {
		vi.useFakeTimers();
		try {
			const stateStore = makeStateStore();
			const completeRationaleRecord = vi.fn(async () => ({}));
			const platform = {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord: vi.fn(async () => ({ id: "rationale-1" })),
				completeRationaleRecord,
			} as unknown as PlatformClient;

			await runRationaleBridge({
				newObservations: [observation({})],
				platform,
				stateStore,
				correlation: { runId: "run-a", sourceSessionId: "session-a" },
			});

			// Success completion requires the record to be >5min old.
			vi.advanceTimersByTime(6 * 60_000);

			await runRationaleBridge({
				newObservations: [
					observation({
						type: "procedural",
						content: "Firecrawl install completed for acme org config",
					}),
				],
				platform,
				stateStore,
				correlation: { runId: "run-a", sourceSessionId: "session-a" },
			});

			expect(completeRationaleRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "rationale-1",
					outcomeStatus: "success",
					proofRef: { kind: "run", ref: "run-a" },
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("projects one low-priority terminal episode with retry-safe execution links", async () => {
		const stateStore = makeStateStore();
		const createRationaleRecord = vi.fn(async () => ({ id: "episode-1" }));
		const platform = {
			memorySearch: vi.fn(async () => ({ results: [] })),
			createRationaleRecord,
			completeRationaleRecord: vi.fn(async () => ({})),
		} as unknown as PlatformClient;
		const input = {
			newObservations: [
				observation({
					type: "episode",
					priority: "low",
					content: "Cron health read completed for all six schedules",
					outcomeStatus: "success",
				}),
			],
			platform,
			stateStore,
			correlation: {
				runId: "run-episode",
				workItemId: "work-1",
				toolCallRefs: ["run-episode:step:0:0:tedix_mcp_code"],
				sourceSessionId: "session-a",
			},
		};

		const first = await runRationaleBridge(input);
		const second = await runRationaleBridge(input);

		expect(first.created).toEqual(["episode-1"]);
		expect(first.completed).toEqual(["episode-1"]);
		expect(second.recordIds).toEqual(["episode-1"]);
		expect(createRationaleRecord).toHaveBeenCalledTimes(2);
		const firstCall = createRationaleRecord.mock.calls[0]?.[0];
		const secondCall = createRationaleRecord.mock.calls[1]?.[0];
		expect(firstCall).toEqual(
			expect.objectContaining({
				idempotencyKey: expect.stringMatching(/^turn-episode:/),
				runId: "run-episode",
				workItemId: "work-1",
				toolCallRefs: ["run-episode:step:0:0:tedix_mcp_code"],
				outcomeStatus: "success",
				evidence: expect.objectContaining({
					kind: "turn_execution_episode",
					taskType: "health_check",
				}),
			}),
		);
		expect(secondCall?.idempotencyKey).toBe(firstCall?.idempotencyKey);
	});

	it("defaults an unclassified episode to partial and skips it after normal completion", async () => {
		const partialCreate = vi.fn(async () => ({ id: "episode-partial" }));
		await runRationaleBridge({
			newObservations: [
				observation({
					type: "episode",
					priority: "medium",
					content: "Delegated inspection reached a terminal response",
					outcomeStatus: undefined,
				}),
			],
			platform: {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord: partialCreate,
				completeRationaleRecord: vi.fn(async () => ({})),
			} as unknown as PlatformClient,
			stateStore: makeStateStore(),
			correlation: { runId: "run-partial" },
		});
		expect(partialCreate).toHaveBeenCalledWith(
			expect.objectContaining({ outcomeStatus: "partial" }),
		);

		const normalCreate = vi.fn(async () => ({ id: "decision-1" }));
		const normalComplete = vi.fn(async () => ({}));
		await runRationaleBridge({
			newObservations: [
				observation({}),
				observation({
					type: "procedural",
					priority: "medium",
					content: "Firecrawl install completed for acme org config",
				}),
				observation({
					type: "episode",
					priority: "high",
					content: "Firecrawl installation episode completed",
					outcomeStatus: "success",
				}),
			],
			platform: {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord: normalCreate,
				completeRationaleRecord: normalComplete,
			} as unknown as PlatformClient,
			stateStore: makeStateStore(),
			correlation: { runId: "run-normal" },
		});
		expect(normalCreate).toHaveBeenCalledTimes(1);
		expect(normalComplete).toHaveBeenCalledTimes(1);
	});

	it("does not double-count an episode when the turn opens a normal rationale", async () => {
		const createRationaleRecord = vi.fn(async () => ({ id: "decision-open" }));
		const completeRationaleRecord = vi.fn(async () => ({}));
		const result = await runRationaleBridge({
			newObservations: [
				observation({
					type: "decision",
					priority: "medium",
					content: "Use a bounded graph projection sample for health",
				}),
				observation({
					type: "episode",
					priority: "high",
					content: "Graph projection inspection completed",
					outcomeStatus: "success",
				}),
			],
			platform: {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord,
				completeRationaleRecord,
			} as unknown as PlatformClient,
			stateStore: makeStateStore(),
			correlation: { runId: "run-open-decision" },
		});

		expect(createRationaleRecord).toHaveBeenCalledTimes(1);
		expect(createRationaleRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: expect.stringMatching(/^turn-episode:/),
			}),
		);
		expect(completeRationaleRecord).toHaveBeenCalledOnce();
		expect(completeRationaleRecord).toHaveBeenCalledWith({
			id: "decision-open",
			outcome: "Graph projection inspection completed",
			outcomeStatus: "success",
			proofRef: { kind: "run", ref: "run-open-decision" },
		});
		expect(result.completed).toEqual(["decision-open"]);
	});

	it("creates at most one rationale for a run with a terminal episode", async () => {
		const createRationaleRecord = vi.fn(async () => ({ id: "decision-one" }));
		const completeRationaleRecord = vi.fn(async () => ({}));

		await runRationaleBridge({
			newObservations: [
				observation({ content: "Use the D1 ledger as canonical evidence" }),
				observation({ content: "Sample Neo4j only for retrieval health" }),
				observation({
					type: "episode",
					content: "Evidence audit reached a bounded terminal result",
					outcomeStatus: "partial",
				}),
			],
			platform: {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord,
				completeRationaleRecord,
			} as unknown as PlatformClient,
			stateStore: makeStateStore(),
			correlation: { runId: "run-one-row" },
		});

		expect(createRationaleRecord).toHaveBeenCalledOnce();
		expect(completeRationaleRecord).toHaveBeenCalledOnce();
		expect(completeRationaleRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "decision-one",
				outcomeStatus: "partial",
				proofRef: { kind: "run", ref: "run-one-row" },
			}),
		);
	});
});

describe("canonical rationale terminal reconciliation", () => {
	function agedState() {
		return {
			records: [
				{
					id: "stale-rationale",
					actionHash: "old",
					action: "Old unrelated deployment decision",
					category: "custom",
					createdAt: Date.now() - 9 * 60 * 60 * 1000,
				},
			],
		};
	}
	async function runAged(status: string | Error) {
		let state: RationaleBridgeState = agedState();
		const complete = vi.fn(async () => ({}));
		const read = vi.fn(async () => {
			if (status instanceof Error) throw status;
			return { id: "stale-rationale", outcomeStatus: status };
		});
		const options = {
			newObservations: [
				observation({
					type: "preference",
					priority: "low",
					content: "Prefer concise responses",
				}),
			],
			platform: {
				getRationaleRecord: read,
				completeRationaleRecord: complete,
			} as unknown as PlatformClient,
			stateStore: {
				load: async () => state,
				save: async (next: RationaleBridgeState) => {
					state = next;
				},
			},
			logger: { log: vi.fn() },
		};
		const result = await runRationaleBridge(options);
		return { state, complete, read, result, options };
	}
	it.each(["failure", "success", "partial", "unverified"])(
		"preserves canonical %s and evicts stale monitoring state without another close",
		async (status) => {
			const run = await runAged(status);
			expect(run.complete).not.toHaveBeenCalled();
			expect(run.state.records).toEqual([]);
			expect(run.result.recordIds).toEqual([]);
			await runRationaleBridge(run.options);
			expect(run.read).toHaveBeenCalledTimes(1);
		},
	);
	it("auto-closes only a record still pending in D1", async () => {
		const run = await runAged("pending");
		expect(run.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "stale-rationale",
				outcomeStatus: "partial",
			}),
		);
		expect(run.state.records).toEqual([]);
	});
	it("retains monitoring state on unavailable reads and never guesses the outcome", async () => {
		const run = await runAged(new Error("service unavailable"));
		expect(run.complete).not.toHaveBeenCalled();
		expect(run.state.records).toHaveLength(1);
	});
	it("does not reopen a terminal row returned by idempotent creation", async () => {
		const stateStore = makeStateStore();
		const complete = vi.fn(async () => ({}));
		const result = await runRationaleBridge({
			newObservations: [
				observation({}),
				observation({
					type: "episode",
					priority: "high",
					content: "Installation completed",
					outcomeStatus: "partial",
				}),
			],
			platform: {
				memorySearch: vi.fn(async () => ({ results: [] })),
				createRationaleRecord: vi.fn(async () => ({
					id: "terminal-rationale",
					outcomeStatus: "failure",
				})),
				completeRationaleRecord: complete,
			} as unknown as PlatformClient,
			stateStore,
			correlation: { runId: "run-replay" },
			logger: { log: vi.fn() },
		});
		expect(complete).not.toHaveBeenCalled();
		expect((await stateStore.load()).records).toEqual([]);
		expect(result.recordIds).toEqual(["terminal-rationale"]);
	});
});
