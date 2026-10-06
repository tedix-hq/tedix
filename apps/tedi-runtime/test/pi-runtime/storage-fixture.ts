import { ConversationFacet } from "../../src/conversation-facet";
import { responsesFixtureModel } from "./responses-recovery-fixture";
import { DoInferenceBudgetStore } from "../../src/inference-budget-store-do";
import { assertTediChatNotCanceled } from "../../src/pi-recovery";
import {
	PiTurnAccounting,
	type PiStepReservation,
	type PiStepReceipt,
	type PiAccountingCheckpoint,
} from "../../src/pi-turn-accounting";

export interface PiStorageSnapshot {
	requests: Array<Record<string, unknown>>;
	effects: number;
	budget: ReturnType<DoInferenceBudgetStore["status"]>;
	checkpoint: PiAccountingCheckpoint;
	submission: unknown;
}

const limits = {
	dailyMessageLimit: 10,
	dailyTokenLimit: 100_000,
	operatorMessageReserve: 0,
	operatorTokenReserve: 0,
	governedLearningMessageReserve: 0,
	governedLearningTokenReserve: 0,
};

/** Real native Pi, provider SDK and SQLite journal; only external RPC/network are scripted. */
export class PiStorageFixture extends ConversationFacet {
	private readonly budget = new DoInferenceBudgetStore(this);
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		Object.assign(this, {
			parentAgent: async () => ({
				enrollFacetDispatchRun: async () => {},
				assertChatTurnActive: async (runId: string) =>
					assertTediChatNotCanceled(
						runId,
						async (id) => (await this.ctx.storage.get(`cancel:${id}`)) === true,
					),
				reservePiStep: async (input: PiStepReservation) =>
					this.budget.reserveStep(
						input.runId,
						input.stepId,
						input.estimatedTokens,
						limits,
					),
				recordPiStep: async (input: PiStepReceipt) =>
					this.budget.recordStep(
						input.runId,
						input.stepId,
						input.actualTokens,
						limits,
					),
				reconcileFacetToolEffect: async () => null,
				recordFacetModelStep: async () => {},
				checkFacetTurnBudget: async () => ({ abort: false }),
				executeFacetTool: async () => {
					await this.ctx.storage.put(
						"fixture:effects",
						((await this.ctx.storage.get<number>("fixture:effects")) ?? 0) + 1,
					);
					return "recorded";
				},
			}),
		});
	}
	protected selectModelForTurn() {
		return {
			model: responsesFixtureModel(async (body) => {
				const requests =
					(await this.ctx.storage.get<Array<Record<string, unknown>>>(
						"fixture:requests",
					)) ?? [];
				requests.push(body);
				await this.ctx.storage.put("fixture:requests", requests);
				return requests.length;
			}),
			identity: {
				provider: "azure-openai" as const,
				model: "gpt-5.6-terra",
				deployment: "gpt-5.6-terra",
			},
		};
	}
	async turn(id: string) {
		this.budget.admit(id, limits, 20);
		return this.runConfiguredConversationTurn({
			configuration: {
				system: "Stable fixture persona\nDynamic instructions",
				stableSystemPrefix: "Stable fixture persona",
				promptCacheSurface: "conversation",
				modelRef: null,
				aigMetadata: { tediId: "storage-fixture", orgId: "fixture-org" },
				sessionKey: "fixture",
				runId: id,
				maxSteps: null,
				reasoning: "high",
				maxOutputTokens: 16_000,
				toolDescriptors: [
					{
						name: "receipt",
						description: "Record one effect",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
			text: "Record one receipt then finish.",
			durableSubmissionId: id,
		});
	}
	async rejectedTurn(id: string) {
		try {
			await this.turn(id);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async cancelRun(id: string) {
		await this.ctx.storage.put(`cancel:${id}`, true);
	}
	async inspectFixture(runId: string) {
		return JSON.stringify({
			requests:
				(await this.ctx.storage.get<Array<Record<string, unknown>>>(
					"fixture:requests",
				)) ?? [],
			effects: (await this.ctx.storage.get<number>("fixture:effects")) ?? 0,
			budget: this.budget.status(limits),
			checkpoint: await new PiTurnAccounting(this.ctx.storage, {
				assertActive: async () => {},
				reserveStep: async () => {},
				recordStep: async () => {},
			}).inspect(runId),
			submission: await (
				await this.piHarness.storage()
			).submissionByRequest((await this.nativeConversation()).id, runId, {
				abortSignal: undefined,
				value: () => undefined,
				toString: () => "storage-fixture",
			}),
		});
	}
}
