/** Native Pi facet for structurally blind, tool-free verification. Parent retains admission and the ledger. */
import {
	defineExtension,
	type AgentChange,
	type Extension,
	type HarnessSettings,
} from "@earendil-works/pi-durable";
import type { TediSessionModelIdentity } from "@tedix/tedi-session/session-harness";
import { PiAgent } from "./pi-agent";
import type { TedixSdkModel } from "./pi-model";
import {
	createToolFreePiModels,
	toolFreePiModel,
} from "./tool-free-pi-provider";
import type { PiApplicationProjection } from "./pi-types";
import {
	sessionUserInput,
	legacySessionMessages,
	entrySessionMessage,
	piEventFrames,
} from "./pi-agent";
import { PiTurnAccounting } from "./pi-turn-accounting";
import { selectChatModelForTurn } from "./turn-model-selection";
import type { AigMetadata, AzureChatEnv } from "./llm";
import type { FacetTurnUsage } from "./step-telemetry";

export interface SynthesisFacetState {
	system: string | null;
	sessionKey?: string | null;
	modelRef: string | null;
	runId?: string | null;
	aigMetadata: AigMetadata | null;
	turnCount: number;
}
export interface SynthesisFacetTurnResult {
	assistantText: string;
	modelIdentity: TediSessionModelIdentity;
	requestId: string | null;
	turnCount: number;
	turnMs: number;
	usage?: FacetTurnUsage;
}
const FALLBACK_SYNTHESIS_SYSTEM =
	"You are completing one tool-free workflow synthesis turn. Use only the input in the message. Return the requested concise result without calling tools or assuming context that was not supplied.";
const TOOL_FREE_EXTENSION = defineExtension({
	name: "tedix.tool-free",
	tools: [],
});

export type SynthesisParentPort = Pick<
	import("./do").AgentTediDO,
	"assertChatTurnActive" | "reservePiStep" | "recordPiStep"
>;

export class SynthesisSessionFacet extends PiAgent<
	Cloudflare.Env,
	SynthesisFacetState
> {
	protected override facetAdmissionClassName() {
		return "SynthesisSessionFacet";
	}
	initialState: SynthesisFacetState = {
		modelRef: null,
		system: null,
		aigMetadata: null,
		turnCount: 0,
	};
	private readonly accounting = new PiTurnAccounting(this.ctx.storage, {
		assertActive: async (runId) => {
			await (await this.parent()).assertChatTurnActive(runId);
		},
		reserveStep: async (input) => (await this.parent()).reservePiStep(input),
		recordStep: async (input) => (await this.parent()).recordPiStep(input),
	});
	protected async parent(): Promise<SynthesisParentPort> {
		const { AgentTediDO } = await import("./do");
		return this.parentAgent(AgentTediDO);
	}
	protected selected(): {
		model: TedixSdkModel;
		identity: TediSessionModelIdentity;
	} {
		const selected = selectChatModelForTurn(
			this.env as unknown as AzureChatEnv,
			this.state.modelRef ? { modelRef: this.state.modelRef } : null,
			this.state.aigMetadata ?? undefined,
			undefined,
			undefined,
			this.facetBeforeDispatch(),
		);
		if (typeof selected.model === "string")
			throw new Error("Native Pi requires a resolved governed model adapter");
		return { ...selected, model: selected.model };
	}
	protected override projection(): PiApplicationProjection {
		const models = createToolFreePiModels({
			runId: () => this.state.runId,
			selected: () => this.selected(),
			accounting: this.accounting,
			assertDispatch: () => this.assertFacetRuntimeDispatch(),
			receiptOperation: () => this.facetReceiptOperation(),
			assertOriginalReceipt: (runId, operationId) =>
				this.assertFacetOriginalReceipt(runId, operationId),
		});
		return {
			input: async (value) => sessionUserInput(value),
			legacy: async (value) => legacySessionMessages(value),
			message: entrySessionMessage,
			event: piEventFrames,
			models: () => models,
		};
	}

	protected override piExtension(): Extension {
		return TOOL_FREE_EXTENSION;
	}
	protected override piConfiguration(): AgentChange {
		return {
			model: {
				provider: "tedix",
				modelId: toolFreePiModel(this.selected().identity).id,
			},
			tools: [],
			extensions: [TOOL_FREE_EXTENSION],
			instructions: this.state.system ?? FALLBACK_SYNTHESIS_SYSTEM,
		};
	}
	protected override piSettings(): HarnessSettings {
		return { compaction: { enabled: false }, stream: { maxRetries: 0 } };
	}
	async configureSynthesisTurn(input: {
		runId: string;
		sessionKey?: string;
		system: string;
		modelRef: string | null;
		aigMetadata: AigMetadata;
	}): Promise<void> {
		const selected = await this.prepareFacetRuntimeAdmission({
			runId: input.runId,
			sessionKey: input.sessionKey ?? "",
			configuration: input,
		});
		if (selected) {
			this.setState({ ...this.state, ...input });
			return;
		}
		const pending = await (
			await this.piHarness.pi()
		).inspect({
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "tool-free-config",
		});
		if (
			pending.tasks.length ||
			pending.submissions.length ||
			(await (await this.nativePiSession()).busy())
		)
			throw new Error("Synthesis turn configuration denied while busy");
		this.setState({ ...this.state, ...input });
		await this.configurePiTurn();
	}
	async runSynthesisTurn(input: {
		text: string;
	}): Promise<SynthesisFacetTurnResult> {
		const operationId = `tedix:synthesis:${this.state.runId}`;
		const admitted = await this.acceptFacetRuntimeTurn({
			runId: this.state.runId ?? "",
			sessionKey: this.state.sessionKey ?? "",
			configuration: {
				modelRef: this.state.modelRef,
				runId: this.state.runId,
				sessionKey: this.state.sessionKey,
				system: this.state.system,
				aigMetadata: this.state.aigMetadata,
			},
			input: { text: input.text, operationId },
			operationId,
		});

		const cached = await this.ctx.storage.get<{
			input: string;
			result: SynthesisFacetTurnResult;
		}>(`pi:tool-free-result:${operationId}`);
		if (cached) {
			if (cached.input !== input.text)
				throw new Error("Admitted tool-free run input changed");
			if (this.state.turnCount < cached.result.turnCount)
				this.setState({ ...this.state, turnCount: cached.result.turnCount });
			return cached.result;
		}
		if (admitted) await this.configurePiTurn();
		const startedAt = Date.now();
		await this.accounting.begin(this.state.runId);
		const runId = this.state.runId;
		if (!runId) throw new Error("synthesis turn has no admitted run");
		const terminal = await (
			await this.nativePiSession()
		).prompt(input.text, { operationId });
		if (terminal.status !== "done")
			throw new Error(terminal.reason ?? "synthesis Pi turn failed");
		await this.accounting.assertComplete();
		const context = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "synthesis-answer",
		};
		const conversation = await this.nativeConversation();
		const record = await (
			await this.piHarness.storage()
		).submissionByRequest(conversation.id, operationId, context);
		if (
			!record ||
			record.status !== "done" ||
			record.type !== "input" ||
			record.answer === undefined
		)
			throw new Error("Native synthesis receipt has no exact answer");
		const entry = await this.entryById(record.answer);
		const answer = entry?.model?.find(
			(message) => message.role === "assistant",
		);
		if (!answer || answer.role !== "assistant")
			throw new Error("Native synthesis answer is not an assistant");
		const selected = this.selected();
		if (
			answer.provider !== "tedix" ||
			answer.model !==
				`${selected.identity.provider}/${selected.identity.model}`
		)
			throw new Error("synthesis answer model violates admitted model pin");
		const modelIdentity = selected.identity;
		const assistantText = answer.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.trim();
		const turnCount = this.state.turnCount + 1;
		const measuredUsage = await this.accounting.usage();
		const result = {
			...(measuredUsage.totalTokens !== null ? { usage: measuredUsage } : {}),
			assistantText,
			modelIdentity,
			requestId: answer.responseId ?? null,
			turnCount,
			turnMs: Date.now() - startedAt,
		};
		await this.ctx.storage.put(`pi:tool-free-result:${operationId}`, {
			input: input.text,
			result,
		});
		this.setState({ ...this.state, turnCount });
		await this.completeFacetRuntimeTurn(runId, operationId, {
			result,
			parentRunId: runId,
			accounting: await this.accounting.inspect(runId),
		});
		return result;
	}
}
