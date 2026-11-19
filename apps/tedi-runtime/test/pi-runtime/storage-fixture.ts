import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	ConversationFacet,
	type ConfiguredConversationTurn,
} from "../../src/conversation-facet";
import { ActionReceiptJournal } from "../../src/action-receipts";
import { responsesFixtureModel } from "./responses-recovery-fixture";
import { assertTediChatNotCanceled } from "../../src/pi-recovery";
import {
	PiTurnAccounting,
	type PiStepReservation,
	type PiStepReceipt,
	type PiAccountingCheckpoint,
} from "../../src/pi-turn-accounting";

export interface PiStorageSnapshot {
	requests: Array<Record<string, unknown>>;
	sdkOptions: Array<Record<string, unknown>>;
	effects: number;
	/** Tokens charged by the step journal: each reserved attempt's estimate
	 * until its receipt replaces it with the provider-reported usage. */
	budget: { usedTokens: number };
	checkpoint: PiAccountingCheckpoint;
	submission: unknown;
	restrictionReceipts: Array<Record<string, unknown>>;
	facetToolCount: number;
	compactionEnabled: boolean;
}

type FixtureStep = { estimatedTokens: number; actualTokens: number | null };
const STEP_PREFIX = "fixture:step:";

/** Real native Pi, provider SDK and SQLite journal; only external RPC/network are scripted. */
export class PiStorageFixture extends ConversationFacet {
	private readonly actionReceipts = new ActionReceiptJournal(this.ctx.storage);
	private fixtureToolName = "receipt";
	private forcedRestrictedToolCall = false;
	private holdSteeringTool = false;
	private repeatedToolIds = false;
	private releaseSteeringTool: (() => void) | undefined;
	private steeringToolReady: (() => void) | undefined;
	private heldTurn?: ReturnType<PiStorageFixture["turn"]>;
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		Object.assign(this, {
			// Replace the parent port before its resolver imports the production DO.
			parent: async () => ({
				enrollFacetDispatchRun: async () => {},
				assertChatTurnActive: async (runId: string) =>
					assertTediChatNotCanceled(
						runId,
						async (id) => (await this.ctx.storage.get(`cancel:${id}`)) === true,
					),
				reservePiStep: async (input: PiStepReservation) => {
					const key = `${STEP_PREFIX}${input.runId}:${input.stepId}`;
					const previous = await this.ctx.storage.get<FixtureStep>(key);
					if (previous) {
						if (previous.estimatedTokens !== input.estimatedTokens)
							throw new Error("Conflicting inference step reservation");
						return;
					}
					await this.ctx.storage.put<FixtureStep>(key, {
						estimatedTokens: input.estimatedTokens,
						actualTokens: null,
					});
				},
				recordPiStep: async (input: PiStepReceipt) => {
					const key = `${STEP_PREFIX}${input.runId}:${input.stepId}`;
					const step = await this.ctx.storage.get<FixtureStep>(key);
					if (!step)
						throw new Error("Inference receipt has no reserved attempt");
					if (
						step.actualTokens !== null &&
						input.actualTokens !== null &&
						step.actualTokens !== input.actualTokens
					)
						throw new Error("Conflicting inference step receipt");
					if (input.actualTokens !== null && step.actualTokens === null)
						await this.ctx.storage.put<FixtureStep>(key, {
							...step,
							actualTokens: input.actualTokens,
						});
				},
				reconcileFacetToolEffect: async () => null,
				recordFacetModelStep: async () => {},
				executeFacetTool: async () => {
					if (this.holdSteeringTool)
						await new Promise<void>((resolve) => {
							this.releaseSteeringTool = resolve;
							this.steeringToolReady?.();
						});
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
		const model = responsesFixtureModel(async (body) => {
			const requests =
				(await this.ctx.storage.get<Array<Record<string, unknown>>>(
					"fixture:requests",
				)) ?? [];
			requests.push(body);
			await this.ctx.storage.put("fixture:requests", requests);
			if (await this.ctx.storage.get("fixture:provider-rejects"))
				throw new Error("fixture deployment rejected the request");
			if (this.state.executionRestriction && !this.forcedRestrictedToolCall)
				return 2;
			return this.repeatedToolIds && requests.length <= 2 ? 1 : requests.length;
		}, this.fixtureToolName);
		const stream = model.doStream.bind(model);
		model.doStream = async (options) => {
			const prior =
				(await this.ctx.storage.get<Array<Record<string, unknown>>>(
					"fixture:sdk-options",
				)) ?? [];
			prior.push({
				tools: options.tools ?? null,
				toolChoice: options.toolChoice ?? null,
				maxOutputTokens: options.maxOutputTokens ?? null,
			});
			await this.ctx.storage.put("fixture:sdk-options", prior);
			return stream(options);
		};
		return {
			model: this.repeatedToolIds
				? { ...model, provider: "cloudflare-auto" }
				: model,
			identity: {
				provider: "azure-openai" as const,
				model: "gpt-5.6-terra",
				deployment: "gpt-5.6-terra",
			},
		};
	}
	private configuredTurn(id: string, toolName = "receipt", restricted = false) {
		return {
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
				executionRestriction: restricted
					? { tools: "none", learning: "disabled" }
					: null,
				toolDescriptors: restricted
					? []
					: [
							{
								name: toolName,
								description: "Record one effect",
								inputSchema: { type: "object", properties: {} },
							},
						],
			},
			text: "Record one receipt then finish.",
			durableSubmissionId: id,
		} satisfies ConfiguredConversationTurn;
	}
	async turn(id: string, toolName = "receipt", restricted = false) {
		this.fixtureToolName = toolName;
		const completed = await this.runConfiguredConversationTurn(
			this.configuredTurn(id, toolName, restricted),
		);
		completed.result.assistantText = await this.actionReceipts.finish(
			id,
			completed.result.assistantText,
		);
		return completed;
	}
	async restrictedTurn(id: string, maliciousProvider = false) {
		this.forcedRestrictedToolCall = maliciousProvider;
		return this.turn(id, "receipt", true);
	}
	async turnWithRepeatedToolIds(id: string) {
		this.repeatedToolIds = true;
		return this.turn(id);
	}
	async beginHeldTurn(id: string) {
		await this.nativeConversation();
		this.holdSteeringTool = true;
		const ready = new Promise<void>((resolve) => {
			this.steeringToolReady = resolve;
		});
		this.heldTurn = this.turn(id);
		this.ctx.waitUntil(this.heldTurn);
		await Promise.race([
			ready,
			this.heldTurn.then(() => {
				throw new Error("Turn finished before reaching the held tool");
			}),
		]);
	}
	async finishHeldTurn() {
		if (!this.heldTurn) throw new Error("No held turn");
		return this.heldTurn;
	}
	async rejectedSteering(
		input: Parameters<ConversationFacet["controlRunSteering"]>[0],
	) {
		try {
			await this.controlRunSteering(input);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async releaseTool() {
		this.holdSteeringTool = false;
		this.releaseSteeringTool?.();
		this.releaseSteeringTool = undefined;
	}
	async rejectedTurn(id: string) {
		try {
			await this.turn(id);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async rejectProvider() {
		await this.ctx.storage.put("fixture:provider-rejects", true);
	}
	async acceptProvider() {
		await this.ctx.storage.delete("fixture:provider-rejects");
	}
	async seedPendingRunMismatch(ownerRunId: string, currentRunId: string) {
		const input = this.configuredTurn(ownerRunId);
		this.setState({
			...this.state,
			...input.configuration,
			runId: currentRunId,
		});
		await this.ctx.storage.put("pi-facet-pending-submission", {
			configuration: input.configuration,
			submissionId: ownerRunId,
			priorTurnCount: this.state.turnCount,
			turnInput: { text: input.text },
		});
	}
	async pendingMismatchSnapshot(receiptRunId: string) {
		return JSON.stringify({
			state: this.state,
			storage: Array.from(this.ctx.storage.kv.list()).sort(([a], [b]) =>
				a.localeCompare(b),
			),
			receipt: JSON.parse(await this.inspectFixture(receiptRunId)),
		});
	}
	async rejectedPendingRecovery(id: string) {
		try {
			await this.runConfiguredConversationTurn(this.configuredTurn(id));
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async restorePendingRunOwner() {
		const pending = await this.ctx.storage.get<{
			configuration: ConfiguredConversationTurn["configuration"];
		}>("pi-facet-pending-submission");
		if (!pending) throw new Error("Missing pending fixture submission");
		this.setState({ ...this.state, ...pending.configuration });
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
			sdkOptions:
				(await this.ctx.storage.get<Array<Record<string, unknown>>>(
					"fixture:sdk-options",
				)) ?? [],
			effects: (await this.ctx.storage.get<number>("fixture:effects")) ?? 0,
			restrictionReceipts: [
				...(
					await this.ctx.storage.list<Record<string, unknown>>({
						prefix: "turn-execution-restriction:" + runId + ":",
					})
				).values(),
			],
			facetToolCount: this.state.toolDescriptors.length,
			compactionEnabled: this.piSettings().compaction.enabled,
			budget: {
				usedTokens: [
					...(
						await this.ctx.storage.list<FixtureStep>({ prefix: STEP_PREFIX })
					).values(),
				].reduce(
					(total, step) => total + (step.actualTokens ?? step.estimatedTokens),
					0,
				),
			},
			checkpoint: await new PiTurnAccounting(this.ctx.storage, {
				assertActive: async () => {},
				reserveStep: async () => {},
				recordStep: async () => {},
			}).inspect(runId),
			submission: await (
				await this.piHarness.storage()
			).submissionByRequest(
				(await this.nativeConversation()).id,
				runId,
				BACKGROUND_CONTEXT,
			),
		});
	}
}
