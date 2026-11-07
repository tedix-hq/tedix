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

	/** Script the next turn's model responses, in order. */
	scriptModel(scope: WorkspaceScope, steps: ScriptStep[]) {
		this.bindScope(scope);
		this.#script = steps;
	}

	readScript(scope: WorkspaceScope): ScriptStep[] {
		this.bindScope(scope);
		return this.#script;
	}

	protected override modelFor(): ModelPort {
		return scriptedModel(this.#script);
	}
}

export class TurnFacet extends ProductionTurnFacet {
	protected override async modelFor(plan: TurnPlan): Promise<ModelPort> {
		const parent = durableObjectStubByName(
			this.env.WORKSPACE,
			this.env,
			tenantStoreName(plan.scope),
		) as unknown as {
			readScript(scope: WorkspaceScope): Promise<ScriptStep[]>;
		};
		return scriptedModel(await parent.readScript(plan.scope));
	}
}

function scriptedModel(script: ScriptStep[]): ModelPort {
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
			id: "faux",
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
