import { ConversationFacet } from "../../src/conversation-facet";
import { ActionReceiptJournal } from "../../src/action-receipts";
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
	private readonly actionReceipts = new ActionReceiptJournal(this.ctx.storage);
	private fixtureToolName = "receipt";
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
					if (this.fixtureToolName === "receipt") return "recorded";
					await this.actionReceipts.record({
						id: "fixture-write",
						kind: "tool.completed",
						runId: this.state.runId!,
						payload: {
							name: this.fixtureToolName,
							actionReceipts: [
								{
									operation: "orion.work_item_comment",
									actor: "tedi:orion",
									verified: true,
									url: "https://os.example.test/work/items/scratch#comment-note",
									state: "accepted",
									checkedAt: "2026-10-16T12:00:00.000Z",
								},
							],
						},
					});
					return { changed: true };
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
			}, this.fixtureToolName),
			identity: {
				provider: "azure-openai" as const,
				model: "gpt-5.6-terra",
				deployment: "gpt-5.6-terra",
			},
		};
	}
	async turn(id: string, toolName = "receipt") {
		this.fixtureToolName = toolName;
		this.budget.admit(id, limits, 20);
		const completed = await this.runConfiguredConversationTurn({
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
						name: toolName,
						description: "Record one effect",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
			text: "Record one receipt then finish.",
			durableSubmissionId: id,
		});
		completed.result.assistantText = await this.actionReceipts.finish(
			id,
			completed.result.assistantText,
		);
		return completed;
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
	async failPiStorageRead() {
		this.ctx.storage.sql.exec(
			"ALTER TABLE pi_conversations RENAME TO pi_conversations_unavailable",
		);
		try {
			await (await this.nativePiSession()).messages();
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			this.ctx.storage.sql.exec(
				"ALTER TABLE pi_conversations_unavailable RENAME TO pi_conversations",
			);
		}
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
