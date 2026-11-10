import type { OutputTransferSnapshot } from "@tedix/db/queries/durable-sqlite/output-rpc";
import type { ChangeRecord } from "@tedix/agent-governance/types";
import type { WorkspaceChangeInput } from "@tedix/api-contract/schemas/workspace-feed";
/**
 * Test worker: the real WorkspaceDO with a scripted model instead of the AI
 * Gateway, plus a stand-in for the tedi object a guest turn asks for.
 */
import { DurableObject } from "cloudflare:workers";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	TurnFacet as ProductionTurnFacet,
	type TurnPlan,
	WorkspaceDO as ProductionWorkspaceDO,
} from "../src/do";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { tenantStoreName } from "@tedix/db/tenant-store/router";
import type { WorkspaceEnv, WorkspaceScope } from "../src/env";
import type { ModelPort } from "../src/model";
import { RUN_CODE_TOOL } from "../src/prompt";

export { WorkspaceBindingLoopback } from "../src/do";

export type ScriptStep =
	| { code: string; tokensPerSecond?: number }
	| { text: string; tokensPerSecond?: number };

export class WorkspaceDO extends ProductionWorkspaceDO {
	#script: ScriptStep[] = [];
	#projectionFailures = 0;
	#loseTransferReply = false;
	failTransferReply(scope: WorkspaceScope) {
		this.bindScope(scope);
		this.#loseTransferReply = true;
	}
	override async receiveOutputTransfer(
		scope: WorkspaceScope,
		transferId: string,
		snapshot: OutputTransferSnapshot,
	) {
		const output = await super.receiveOutputTransfer(
			scope,
			transferId,
			snapshot,
		);
		if (this.#loseTransferReply) {
			this.#loseTransferReply = false;
			throw new Error("Injected lost transfer reply");
		}
		return output;
	}
	#actionFailure: "before" | "after" | null = null;
	#eventFailure: "before" | "after" | null = null;

	pruneChatLedger(scope: WorkspaceScope) {
		this.bindScope(scope);
		this.ctx.storage.sql.exec("DELETE FROM events");
	}

	failEventProjection(scope: WorkspaceScope, when: "before" | "after") {
		this.bindScope(scope);
		this.#eventFailure = when;
	}

	protected override async projectEvent(event: WorkspaceChangeInput) {
		const failure = this.#eventFailure;
		this.#eventFailure = null;
		if (failure === "before")
			throw new Error("Injected event projection outage");
		await super.projectEvent(event);
		if (failure === "after")
			throw new Error("Injected lost event projection reply");
	}

	failNextProjection(scope: WorkspaceScope) {
		this.bindScope(scope);
		this.#projectionFailures = 1;
	}

	failActionProjection(scope: WorkspaceScope, when: "before" | "after") {
		this.bindScope(scope);
		this.#actionFailure = when;
	}

	protected override async projectAction(
		scope: WorkspaceScope,
		record: ChangeRecord,
	) {
		const failure = this.#actionFailure;
		this.#actionFailure = null;
		if (failure === "before")
			throw new Error("Injected action projection outage");
		await super.projectAction(scope, record);
		if (failure === "after")
			throw new Error("Injected lost action projection reply");
	}

	retryProjections(scope: WorkspaceScope) {
		this.bindScope(scope);
		return this.alarm();
	}

	protected override async projectOutput(
		scope: WorkspaceScope,
		outputId: string,
	) {
		if (this.#projectionFailures > 0) {
			this.#projectionFailures -= 1;
			throw new Error("Injected projection outage");
		}
		return super.projectOutput(scope, outputId);
	}

	/** Script the next turn's model responses, in order. */
	scriptModel(scope: WorkspaceScope, steps: ScriptStep[]) {
		this.bindScope(scope);
		this.#script = steps;
	}

	readScript(scope: WorkspaceScope): ScriptStep[] {
		this.bindScope(scope);
		return this.#script;
	}

	protected override configuredModels() {
		return [{ id: "faux", label: "Scripted test model" }];
	}

	protected override modelFor(
		_scope: WorkspaceScope,
		_turnId: string,
		_actorId: string,
		modelId?: string,
	): ModelPort {
		if (modelId !== undefined && modelId !== "faux")
			throw new Error("Model request was not propagated");
		return scriptedModel(this.#script, modelId);
	}
}

export class TurnFacet extends ProductionTurnFacet {
	protected override async modelFor(plan: TurnPlan): Promise<ModelPort> {
		if (plan.modelId !== undefined && plan.modelId !== "faux")
			throw new Error("Facet model request was not propagated");
		const parent = durableObjectStubByName(
			this.env.WORKSPACE,
			this.env,
			tenantStoreName(plan.scope),
		) as unknown as {
			readScript(scope: WorkspaceScope): Promise<ScriptStep[]>;
		};
		return scriptedModel(await parent.readScript(plan.scope), plan.modelId);
	}
}

function scriptedModel(script: ScriptStep[], modelId?: string): ModelPort {
	{
		const core = createFauxCore({
			tokensPerSecond: script[0]?.tokensPerSecond ?? 0,
		});
		core.setResponses(
			script.map((step) =>
				"code" in step
					? fauxAssistantMessage(
							fauxToolCall(RUN_CODE_TOOL, { code: step.code }),
							{
								stopReason: "toolUse",
							},
						)
					: fauxAssistantMessage(fauxText(step.text)),
			),
		);
		const model = core.getModel();
		return {
			id: modelId ?? "faux-default",
			contextWindow: 128_000,
			maxOutputTokens: 4_000,
			stream: (context, options) =>
				core.streamSimple(model, normalizeContext(context), {
					signal: options?.signal,
				}),
		};
	}
}

export class TediAgentFixture extends DurableObject<WorkspaceEnv> {
	async guestProfile(input: { tediId: string; userText: string }) {
		return {
			systemPrompt: `You are tedi ${input.tediId}.`,
			addenda: `Recall for: ${input.userText}`,
		};
	}
}

export default {
	fetch() {
		return new Response("test worker");
	},
};
