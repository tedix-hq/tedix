import {
	env,
	WorkflowEntrypoint,
	type WorkflowEvent,
} from "cloudflare:workers";
import {
	AgentWorkflow,
	type AgentWorkflowStep,
	type AgentWorkflowEvent,
	type WorkflowCallback,
} from "agents/workflows";
import { ChatTurnWorkflow } from "../../src/chat-turn-workflow";
import {
	buildFacetWorkflowTurnInput,
	type ChatTurnParams,
} from "../../src/chat-turn-input";
import type { AgentTediDO } from "../../src/do";

export interface CallbackFixtureOptions {
	agentName?: string;
	originName?: string;
	facet?: boolean;
	otherBinding?: boolean;
	rpcShapedId?: boolean;
	poisonCached?: boolean;
	freshCallbackError?: string;
	turnError?: string;
	cached?: boolean;
}
const memoryReset = new Error(
	"Durable Object's isolate exceeded its memory limit and was reset.",
);

function fixture(
	options: {
		agentName?: string;
		originName?: string;
		facet?: boolean;
		otherBinding?: boolean;
		rpcShapedId?: boolean;
		poisonCached?: boolean;
		freshCallbackError?: Error;
		turnError?: Error;
	} = {},
) {
	const ids = (env as unknown as { PI_TEST: DurableObjectNamespace }).PI_TEST;
	const callbacks: { route: string; callback: WorkflowCallback }[] = [];
	const attempts: string[] = [];
	const disposed: number[] = [];
	const names: string[] = [];
	let forgedEqualityCalls = 0;
	let gets = 0;
	let modelCalls = 0;
	let cachedAttempts = 0;
	let freshAttempts = 0;
	const namespace = {
		idFromName: (name: string) => ids.idFromName(name),
		get(id: DurableObjectId) {
			const index = gets++;
			const callback = async (value: WorkflowCallback, route = "root") => {
				attempts.push(value.type);
				if (index === 0) {
					cachedAttempts++;
					if (options.poisonCached && modelCalls) throw memoryReset;
				} else {
					freshAttempts++;
					if (options.freshCallbackError && freshAttempts === 1)
						throw options.freshCallbackError;
				}
				callbacks.push({ route, callback: value });
			};
			const turn = async () => {
				modelCalls++;
				if (options.turnError) throw options.turnError;
				return { text: "fixture response", stopReason: "stop", toolCalls: [] };
			};
			return {
				id:
					index === 0 && options.rpcShapedId
						? {
								equals: async () => {
									forgedEqualityCalls++;
									return true;
								},
							}
						: id,
				__unsafe_ensureInitialized: async () => {},
				markChatWorkflowStarted: async () => {},
				runFacetWorkflowTurn: turn,
				_workflow_handleCallback: callback,
				_cf_invokeAgentPath: async (
					_path: unknown,
					method: string,
					args: unknown[],
				) => {
					if (method === "_workflow_handleCallback")
						return callback(args[0] as WorkflowCallback, "facet");
					if (method === "runFacetWorkflowTurn") return turn();
				},
				[Symbol.dispose]: () => {
					disposed.push(index);
				},
			};
		},
	};
	const params: ChatTurnParams = {
		...(options.agentName === "missing"
			? {}
			: { agentName: options.agentName ?? "original" }),
		sessionKey: "agent:main:callback-fixture",
		userText: "scripted fixture",
		userTs: 1,
		conversationId: "fixture:agent:main:callback-fixture",
		runId: "fixture:chat:callback",
		clientRequestId: "callback",
	};
	const originName = options.originName ?? "original";
	const event = {
		instanceId: "callback-fixture",
		timestamp: new Date(1),
		workflowName: "callback-fixture",
		payload: {
			...params,
			__agentName: originName,
			__agentBinding: "TEDI_AGENT",
			__workflowName: "CHAT_TURN_WORKFLOW",
			__agentOrigin: options.facet
				? {
						kind: "facet" as const,
						version: 1 as const,
						rootBinding: "TEDI_AGENT",
						path: [{ className: "Fixture", name: originName }],
					}
				: {
						kind: "agent" as const,
						version: 1 as const,
						binding: options.otherBinding ? "OTHER_AGENT" : "TEDI_AGENT",
						name: originName,
					},
		},
	};
	const step = {
		async do(name: string, ...args: unknown[]) {
			names.push(name);
			return (args.at(-1) as () => Promise<unknown>)();
		},
	} as unknown as AgentWorkflowStep;
	const otherIds = (env as unknown as { PI_STORAGE: DurableObjectNamespace })
		.PI_STORAGE;
	const bindings = {
		TEDI_AGENT: namespace,
		OTHER_AGENT: {
			...namespace,
			idFromName: (name: string) => otherIds.idFromName(name),
		},
	} as unknown as Cloudflare.Env;
	return {
		event,
		step,
		bindings,
		callbacks,
		disposed,
		names,
		attempts,
		forgedEqualityCalls: () => forgedEqualityCalls,
		stats: () => ({ modelCalls, cachedAttempts, freshAttempts, gets }),
	};
}

class CachedWorkflow extends AgentWorkflow<AgentTediDO, ChatTurnParams> {
	override async run(
		event: AgentWorkflowEvent<ChatTurnParams>,
		step: AgentWorkflowStep,
	) {
		await this.agent.runFacetWorkflowTurn(
			buildFacetWorkflowTurnInput(event.payload),
		);
		await step.reportComplete({ text: "fixture response" });
	}
}

export class WorkflowCallbackFixture extends WorkflowEntrypoint<
	Cloudflare.Env,
	CallbackFixtureOptions
> {
	override async run(event: WorkflowEvent<CallbackFixtureOptions>) {
		const options = {
			...event.payload,
			freshCallbackError: event.payload.freshCallbackError
				? new Error(event.payload.freshCallbackError)
				: undefined,
			turnError: event.payload.turnError
				? new Error(event.payload.turnError)
				: undefined,
		};
		const f = fixture(options);
		let result: unknown;
		let error: string | undefined;
		let sameFailure = false;
		try {
			const workflow = event.payload.cached
				? new CachedWorkflow(this.ctx, f.bindings)
				: new ChatTurnWorkflow(this.ctx, f.bindings);
			result = await workflow.run(f.event, f.step);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
			sameFailure =
				failure === memoryReset ||
				failure === options.turnError ||
				failure === options.freshCallbackError;
		}
		return {
			result,
			error,
			sameFailure,
			callbacks: f.callbacks,
			disposed: f.disposed,
			names: f.names,
			attempts: f.attempts,
			forgedEqualityCalls: f.forgedEqualityCalls(),
			stats: f.stats(),
		};
	}
}
