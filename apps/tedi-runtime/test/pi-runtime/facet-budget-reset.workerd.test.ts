import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { PiTurnAccounting } from "../../src/pi-turn-accounting";
import { DoInferenceBudgetStore } from "../../src/inference-budget-store-do";
import type { PiStorageFixture } from "./storage-fixture";

const RESET = "Durable Object reset because its code was updated.";
const RUN = "budget-reset-run";
const context = { messages: [{ role: "user", content: "budget integration" }] };
const completed = {
	usage: { inputTokens: 60, outputTokens: 40, totalTokens: 100 },
	toolCalls: [],
	toolResults: [],
	text: "done",
	finishReason: "stop",
	stepNumber: 0,
};
type BudgetInput = {
	runId: string;
	cumulativeTokens: number;
	stepCount: number;
};
type Verdict = { abort: boolean; reason: string | null };
type Parent = {
	checkFacetTurnBudget(input: BudgetInput): Promise<Verdict>;
	executeFacetTool?(): Promise<unknown>;
};
type Harness = {
	state: {
		runId: string;
		maxSteps: number | null;
		sessionKey: string;
		toolDescriptors: Array<{
			name: string;
			description: string;
			inputSchema: object;
		}>;
		budgetStop?: { kind: string; reason: string } | null;
		recoveryBlockedRunId?: string;
		toolRegistryUnavailableRunId?: string;
	};
	accounting: PiTurnAccounting;
	parent(): Promise<Parent>;
	setState(state: Harness["state"]): void;
	piExtension(): Promise<{
		tools: Array<{
			execute(
				args: unknown,
				api: { callId: string },
			): Promise<{ control?: { terminate?: boolean } }>;
		}>;
	}>;
	checkNativeToolBudget(): Promise<boolean>;
};

// Runtime imports execute the real production modules in workerd, while their
// production Cloudflare.Env types stay in the separately checked runtime project.
// Importing them into the fixture type graph changes the production global Env default.
const facetModulePath = "../../src/conversation-facet";
const { ConversationFacet } = (await import(
	/* @vite-ignore */ facetModulePath
)) as {
	ConversationFacet: { prototype: Harness };
};

// Invoke production methods without constructing a live Agent or its bindings.
// Only state/accounting and the external parent RPC boundary are controlled.
async function fixture(resolve: () => Promise<Parent>) {
	const rows = new Map<string, unknown>();
	const reservations = new Map<string, number>();
	const receipts = new Map<string, number | null>();
	const storage = {
		get: async (key: string) => structuredClone(rows.get(key)),
		put: async (key: string, value: unknown) => {
			rows.set(key, structuredClone(value));
		},
	} as unknown as Pick<DurableObjectStorage, "get" | "put">;
	const accounting = new PiTurnAccounting(storage, {
		assertActive: async () => {},
		reserveStep: async ({ stepId, estimatedTokens }) => {
			reservations.set(stepId, estimatedTokens);
		},
		recordStep: async ({ stepId, actualTokens }) => {
			receipts.set(stepId, actualTokens);
		},
	});
	await accounting.begin(RUN);
	const facet = Object.create(ConversationFacet.prototype) as Harness;
	Object.defineProperty(facet, "state", {
		value: {
			runId: RUN,
			maxSteps: null,
			sessionKey: "budget-reset-session",
			toolDescriptors: [
				{
					name: "exec",
					description: "Fixture",
					inputSchema: { type: "object", properties: {} },
				},
			],
		},
		writable: true,
	});
	facet.accounting = accounting;
	facet.state.budgetStop = null;
	let dispatching = false;
	facet.parent = vi.fn(async () =>
		dispatching
			? {
					checkFacetTurnBudget: async () => ({ abort: false, reason: null }),
					executeFacetTool: async () => ({ ok: true }),
				}
			: resolve(),
	);
	facet.setState = (state) => {
		facet.state = state;
	};

	return {
		facet,
		accounting,
		reservations,
		receipts,
		run: () => facet.checkNativeToolBudget(),
		nativeTool: async () => {
			const extension = await facet.piExtension();
			dispatching = true;
			const original = facet.parent;
			let first = true;
			facet.parent = async () => {
				if (first) {
					first = false;
					const effect = await original();
					dispatching = false;
					return effect;
				}
				return original();
			};
			try {
				return await extension.tools[0]!.execute({}, { callId: "native-call" });
			} finally {
				dispatching = false;
				facet.parent = original;
			}
		},
	};
}

async function measured(f: Awaited<ReturnType<typeof fixture>>) {
	await f.accounting.prepareStep(context, {});
	await f.accounting.recordProviderUsage(
		completed.usage,
		[],
		await f.accounting.captureProviderAttempt(),
	);
}

const allow = async (): Promise<Verdict> => ({ abort: false, reason: null });

describe("production ConversationFacet budget stop integration", () => {
	it("reacquires the parent once after a code-update reset through native tool execution", async () => {
		let resolutions = 0;
		const inputs: BudgetInput[] = [];
		const f = await fixture(async () => {
			const attempt = ++resolutions;
			return {
				checkFacetTurnBudget: async (input) => {
					inputs.push(input);
					if (attempt === 1) throw new Error(RESET);
					return allow();
				},
			};
		});
		await measured(f);

		const inspect = vi.spyOn(f.accounting, "inspect");
		const usage = vi.spyOn(f.accounting, "usage");
		await expect(f.nativeTool()).resolves.not.toHaveProperty("control");
		expect(resolutions).toBe(2);
		expect(inputs).toEqual([
			{ runId: RUN, cumulativeTokens: 100, stepCount: 1 },
			{ runId: RUN, cumulativeTokens: 100, stepCount: 1 },
		]);
		expect(usage).toHaveBeenCalledTimes(1);
		// usage internally reads the checkpoint once in addition to the gate's read.
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(f.accounting.hasFault()).toBe(false);
		expect((await f.accounting.inspect(RUN)).fault).toBeNull();
	});

	it("retries parent resolution itself once", async () => {
		let resolutions = 0;
		const probe = vi.fn(allow);
		const f = await fixture(async () => {
			if (++resolutions === 1) throw new Error(RESET);
			return { checkFacetTurnBudget: probe };
		});
		await expect(f.run()).resolves.toBe(false);
		expect(resolutions).toBe(2);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"preserves an exhausted verdict after reset=%s",
		async (reset) => {
			let calls = 0;
			const f = await fixture(async () => ({
				checkFacetTurnBudget: async () => {
					if (++calls === 1 && reset) throw new Error(RESET);
					return { abort: true, reason: "daily limit reached" };
				},
			}));
			await expect(f.run()).resolves.toBe(true);
			expect(calls).toBe(reset ? 2 : 1);
			expect(f.facet.state.budgetStop).toEqual({
				kind: "budget_exhausted",
				reason: "daily limit reached",
			});
			expect(f.facet.state.recoveryBlockedRunId).toBe(RUN);
			await expect(f.run()).resolves.toBe(true);
			expect(calls).toBe(reset ? 2 : 1);
		},
	);

	it.each(["budget storage unavailable", RESET])(
		"fences a persistent parent failure: %s",
		async (message) => {
			let calls = 0;
			const f = await fixture(async () => ({
				checkFacetTurnBudget: async () => {
					calls++;
					throw new Error(message);
				},
			}));
			await expect(f.run()).rejects.toThrow(message);
			expect(calls).toBe(message === RESET ? 2 : 1);
			expect(f.facet.parent).toHaveBeenCalledTimes(calls);
			expect(f.accounting.hasFault()).toBe(true);
			expect((await f.accounting.inspect(RUN)).fault).toBe(message);
			await expect(f.accounting.assertComplete()).rejects.toThrow(message);
		},
	);

	it.each(["inspect", "usage"] as const)(
		"does not retry accounting.%s on a reset-shaped failure",
		async (method) => {
			const f = await fixture(async () => ({ checkFacetTurnBudget: allow }));
			const read = vi
				.spyOn(f.accounting, method)
				.mockRejectedValueOnce(new Error(RESET));
			const block = vi.spyOn(f.accounting, "block");
			await expect(f.run()).rejects.toThrow(RESET);
			expect(f.facet.parent).not.toHaveBeenCalled();
			expect(block).toHaveBeenCalledTimes(1);
			// The fence itself may inspect storage to retain its failure; this is not a retry of the gate.
			expect(read.mock.results[0]?.type).toBe("return");
			read.mockRestore();
			expect(f.accounting.hasFault()).toBe(true);
			expect((await f.accounting.inspect(RUN)).fault).toBe(RESET);
		},
	);

	it("does not retry accounting.block if fencing itself rejects", async () => {
		const f = await fixture(async () => ({
			checkFacetTurnBudget: async () => {
				throw new Error("generic parent failure");
			},
		}));
		const block = vi
			.spyOn(f.accounting, "block")
			.mockRejectedValue(new Error(RESET));
		await expect(f.run()).rejects.toThrow(RESET);
		expect(block).toHaveBeenCalledTimes(1);
		expect(f.facet.parent).toHaveBeenCalledTimes(1);
	});

	it("stops at the governed step ceiling before resolving a parent", async () => {
		const f = await fixture(async () => ({ checkFacetTurnBudget: allow }));
		await measured(f);
		f.facet.state.maxSteps = 1;
		await expect(f.run()).resolves.toBe(true);
		expect(f.facet.parent).not.toHaveBeenCalled();
		expect(f.facet.state.budgetStop?.kind).toBe("step_ceiling");
		expect(f.facet.state.recoveryBlockedRunId).toBe(RUN);
	});

	it("retains unknown receipts and reservations through the retry", async () => {
		let calls = 0;
		const inputs: BudgetInput[] = [];
		const f = await fixture(async () => ({
			checkFacetTurnBudget: async (input) => {
				inputs.push(input);
				if (++calls === 1) throw new Error(RESET);
				return allow();
			},
		}));
		await f.accounting.prepareStep(context, {});
		await f.accounting.prepareStep(context, {});
		await f.accounting.recordProviderUsage(
			completed.usage,
			[],
			await f.accounting.captureProviderAttempt(),
		);
		const checkpoint = await f.accounting.inspect(RUN);
		const reservations = [...f.reservations];
		const receipts = [...f.receipts];
		expect(receipts.some(([, tokens]) => tokens === null)).toBe(true);
		expect((await f.accounting.usage()).totalTokens).toBeNull();
		await expect(f.run()).resolves.toBe(false);
		expect(inputs).toEqual([
			{ runId: RUN, cumulativeTokens: 0, stepCount: 2 },
			{ runId: RUN, cumulativeTokens: 0, stepCount: 2 },
		]);
		expect(await f.accounting.inspect(RUN)).toEqual(checkpoint);
		expect([...f.reservations]).toEqual(reservations);
		expect([...f.receipts]).toEqual(receipts);
		expect((await f.accounting.usage()).totalTokens).toBeNull();
	});

	it("does not retry a rejected native effect or clear its registry fence", async () => {
		const rejected = vi.fn(async () => ({ code: "facet_tool_unavailable" }));
		const f = await fixture(async () => ({
			checkFacetTurnBudget: allow,
			executeFacetTool: rejected,
		}));
		const extension = await f.facet.piExtension();
		await expect(
			extension.tools[0]!.execute({}, { callId: "rejected-call" }),
		).rejects.toThrow();
		expect(f.facet.state.toolRegistryUnavailableRunId).toBe(RUN);
		await expect(
			extension.tools[0]!.execute({}, { callId: "rejected-call" }),
		).rejects.toThrow();
		expect(rejected).toHaveBeenCalledTimes(1);
	});

	it("does not double-charge a cumulative budget update whose acknowledgement reset", async () => {
		const bindings = env as unknown as {
			PI_STORAGE: DurableObjectNamespace<PiStorageFixture>;
		};
		const stub = bindings.PI_STORAGE.get(
			bindings.PI_STORAGE.idFromName(crypto.randomUUID()),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = new DoInferenceBudgetStore({
				sql<T>(
					strings: TemplateStringsArray,
					...values: (string | number | boolean | null)[]
				): T[] {
					const query = strings.reduce(
						(text, part, index) =>
							text + part + (index < values.length ? "?" : ""),
						"",
					);
					return state.storage.sql.exec(query, ...values).toArray() as T[];
				},
			});
			const limits = {
				dailyMessageLimit: 10,
				dailyTokenLimit: 1000,
				operatorMessageReserve: 0,
				operatorTokenReserve: 0,
				governedLearningMessageReserve: 0,
				governedLearningTokenReserve: 0,
			};
			store.admit(RUN, limits, 20);
			const parentModulePath = "../../src/do";
			const { AgentTediDO } = (await import(
				/* @vite-ignore */ parentModulePath
			)) as {
				AgentTediDO: {
					prototype: {
						checkFacetTurnBudget(
							this: {
								getInferenceBudgetStore(): DoInferenceBudgetStore;
								inferenceBudgetLimits(): typeof limits;
							},
							input: BudgetInput,
						): Promise<Verdict>;
					};
				};
			};
			const parent = {
				getInferenceBudgetStore: () => store,
				inferenceBudgetLimits: () => limits,
			};
			let probes = 0;
			const f = await fixture(async () => ({
				checkFacetTurnBudget: async (input) => {
					const verdict = await AgentTediDO.prototype.checkFacetTurnBudget.call(
						parent,
						input,
					);
					if (++probes === 1) throw new Error(RESET);
					return verdict;
				},
			}));
			await measured(f);
			await expect(f.run()).resolves.toBe(false);
			expect(probes).toBe(2);
			expect(store.status(limits).usedTokens).toBe(100);
			expect(f.accounting.hasFault()).toBe(false);
		});
	});
});
