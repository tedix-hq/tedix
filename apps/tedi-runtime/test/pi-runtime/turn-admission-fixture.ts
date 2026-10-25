import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { driveChatTurnSteps } from "../../src/chat-turn-steps";
import { FacetTurnAdmission } from "../../src/facet-turn-admission";
import { KeyedFacetTurnGate } from "../../src/facet-turn-gate";
import type {
	FacetWorkflowTurnInput,
	FacetWorkflowTurnResult,
} from "../../src/delegated-work-lease";
import {
	runtimeFacetTurns,
	type RuntimeFacetTurnsHost,
} from "../../src/runtime-facet-turns";

export interface TurnAdmissionParams {
	objectName: string;
	runId: string;
}
interface FixtureEnv {
	TURN_ADMISSION: DurableObjectNamespace<TurnAdmissionFixture>;
}

/** Production parent turn entry and native Workflow steps, with scripted bodies. */
export class TurnAdmissionFixture extends DurableObject<FixtureEnv> {
	private readonly facetTurnAdmission = new FacetTurnAdmission();
	private readonly facetWorkflowTurns = new KeyedFacetTurnGate();
	private active = 0;
	private peak = 0;
	private deferred = 0;
	private inlineChildren = 0;
	private completed: string[] = [];
	private released = false;
	private readonly waiters = new Set<() => void>();

	private facetTurnsHost(): RuntimeFacetTurnsHost {
		return {
			ctx: this.ctx,
			state: { tediId: "fixture", systemPrompt: "fixture persona" },
			admitInferenceTurn: () => {},
			tediAigMetadata: () => ({}),
			modelOverrideForSurface: () => null,
			settleCumulativeInferenceTokens: () => {},
			emitFacetTurnDatapoint: () => {},
			subAgent: async () => ({
				configureSynthesisTurn: async () => {},
				runSynthesisTurn: async () => {
					this.inlineChildren++;
					return { assistantText: "child done", turnCount: 1, turnMs: 1 };
				},
			}),
			facetWorkflowTurns: this.facetWorkflowTurns,
			facetTurnAdmission: this.facetTurnAdmission,
			keepAliveWhile: <T>(run: () => Promise<T>) => run(),
			ensureIdentity: async () => {},
			sessionRepo: { findTurnByIdempotencyKey: () => null },
			acceptRuntimeTurn: async () => {},
			runFacetWorkflowTurnImpl: async (input: FacetWorkflowTurnInput) => {
				this.active++;
				this.peak = Math.max(this.peak, this.active);
				try {
					if (!this.released)
						await new Promise<void>((resolve) => this.waiters.add(resolve));
					if (input.userText === "nested") {
						const child = await runtimeFacetTurns.runSynthesisFacetTurn.call(
							this.facetTurnsHost(),
							{
								runId: `${input.runId}-synthesis`,
								sessionKey: "workflow:synth:fixture",
								guardedUserText: "synthesize",
							},
						);
						if (child.assistantText !== "child done")
							throw new Error("Inline sub-turn failed");
						// A root's synchronous facet work runs inside its slot. A
						// separately enqueued child must receive a denial, never wait
						// in the parent step for a slot held by that same parent.
						const children = await Promise.all(
							Array.from({ length: 4 }, (_, i) =>
								this.turn(`${input.runId}-child-${i}`),
							),
						);
						if (children.some((child) => child.stopReason !== "turn_deferred"))
							throw new Error("Saturated children must defer immediately");
					}
					if (input.userText === "fail")
						throw new Error("scripted turn failure");
					this.completed.push(input.runId);
					return { text: "done", stopReason: "stop", toolCalls: [] };
				} finally {
					this.active--;
				}
			},
		} as unknown as RuntimeFacetTurnsHost;
	}

	async turn(
		runId: string,
		mode = "ordinary",
	): Promise<FacetWorkflowTurnResult> {
		const input: FacetWorkflowTurnInput = {
			runId,
			userText: mode,
			sessionKey: runId,
			conversationId: `fixture:${runId}`,
			userTs: 1,
		};
		const result = await runtimeFacetTurns.runFacetWorkflowTurn.call(
			this.facetTurnsHost(),
			input,
		);
		if (result.stopReason === "turn_deferred") this.deferred++;
		return result;
	}
	async failureProbe() {
		try {
			await this.turn("failure", "fail");
			return "unexpected success";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	release() {
		this.released = true;
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	inspect() {
		return {
			active: this.active,
			peak: this.peak,
			deferred: this.deferred,
			inlineChildren: this.inlineChildren,
			completed: this.completed,
		};
	}
}

export class TurnAdmissionWorkflowFixture extends WorkflowEntrypoint<
	FixtureEnv,
	TurnAdmissionParams
> {
	override async run(
		event: WorkflowEvent<TurnAdmissionParams>,
		step: WorkflowStep,
	) {
		const agent = this.env.TURN_ADMISSION.getByName(event.payload.objectName);
		return driveChatTurnSteps(
			{
				do: (name, config, run) =>
					step.do(name, config, run as () => Promise<never>),
				sleep: (name, delay) => step.sleep(name, delay),
				reportComplete: async () => {},
			},
			{
				retryKey: event.payload.runId,
				markStarted: async () => {},
				runFacetTurn: async () =>
					JSON.stringify(await agent.turn(event.payload.runId)),
			},
		);
	}
}
