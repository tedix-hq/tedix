import type { FiberRecoveryContext, FiberRecoveryResult } from "agents";
import {
	observeWorkstationRefresh,
	workstationProvisioningFiberName,
} from "../../src/workstation-provisioning-attempt";
import {
	reconcileWorkstationUntilSettled,
	workstationProvisioningRecoveryInput,
	type WorkstationProvisioningCheckpoint,
} from "../../src/workstation-provisioning";
import { ConversationFacet } from "../../src/conversation-facet";
import { describeFacetTools } from "../../src/facet-tool-descriptors";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
	ScopedComputerWorkspace,
	computerWorkspaceScope,
	OPERATOR_COMPUTER_SCOPE,
} from "../../src/computer-workspace-scope";
import type { TediComputerWorkspaceDO } from "../../src/computer-workspace-do";
import {
	ComputerEnvironmentController,
	createComputerEnvironmentTools,
} from "../../src/computer-environment";
import { captureWorkstationTurnContext } from "../../src/workstation-turn-context";
import {
	computerExecutionProvenance,
	collectComputerExecutionWake,
	computerExecutionWakeKey,
	type ComputerExecutionWakeRecord,
} from "../../src/computer-execution-wake";
import {
	ComputerWorkflowContinuation,
	retainComputerForNativeExecutions,
} from "../../src/computer-workflow-continuation";
import {
	delegatedWorkLeaseRenewalKey,
	renewDelegatedWorkLease,
	scheduleDelegatedWorkLeaseRenewal,
	type DelegatedWorkLeaseDeps,
	type DelegatedWorkLeaseRenewal,
} from "../../src/delegated-work-lease";

interface Env extends Cloudflare.Env {
	TEDI_COMPUTER_WORKSPACE: DurableObjectNamespace<TediComputerWorkspaceDO>;
}

/** Native Pi inference drives the production scoped Computer tools.
 * Workstation transport is scripted; SDK Fibers, intervals and storage are real.
 * This isolated root fixture has no registered parent custody and does not prove
 * production admission. Registered-facet admission is tested separately. */
export class ComputerTurnFixture extends ConversationFacet {
	protected override facetAdmissionClassName() {
		return null;
	}
	protected override async facetAdmissionCustody(
		_runId: string,
		_sessionKey: string,
	): Promise<import("../../src/pi-agent").FacetAdmissionResponse> {
		return { enabled: false as const };
	}
	private retentionComputer(stage: "start" | "wait") {
		const owner = { runId: "retention-run", workItemId: "retention-work" };
		return new ComputerEnvironmentController(
			this.ctx.storage,
			"retention-environment",
			{
				open: async () => ({ ok: true, leaseId: "retention-lease" }),
				status: async () => ({
					ok: true,
					readiness: { toolsReady: true, repoReady: true },
					repoSync: { workdir: "/fixture/repository" },
				}),
				close: async () => ({ ok: true }),
				files: async () => ({}),
				start: async () => {
					await this.ctx.storage.put(
						"retention-starts",
						((await this.ctx.storage.get<number>("retention-starts")) ?? 0) + 1,
					);
					if (stage === "start")
						throw Error("native launch acknowledgement interrupted");
					return { ok: true };
				},
				wait: async () => {
					throw Error("native wait acknowledgement interrupted");
				},
				read: async () => ({
					ok: true,
					terminal: true,
					exitCode: 0,
					stdoutTail: "original result",
				}),
				cancel: async () => {
					throw Error("must not cancel unknown execution");
				},
			},
			async () => {},
			owner.runId,
			{
				retained: async (execution) =>
					new ComputerWorkflowContinuation(this.ctx.storage).register({
						...execution,
						...owner,
						launchedByRunId: owner.runId,
						sessionKey: "retention-session",
						homeRunId: "retention-home",
						detachedAt: Date.now(),
						attempt: 0,
					}),
				detached: async () => {
					throw Error("interrupted path should not need a detached receipt");
				},
				collected: (id) =>
					collectComputerExecutionWake(this.ctx.storage, id, owner),
			},
		);
	}
	async interruptBeforeDetach(stage: "start" | "wait") {
		const computer = this.retentionComputer(stage);
		await computer.open("repository");
		const result = (await computer.exec(
			{ command: "bounded fixture command" },
			"retention-call",
		)) as { executionId: string; outcome: string };
		await this.ctx.storage.put("retention-id", result.executionId);
		return { ...(await this.inspectRetention(false)), result };
	}
	async inspectRetention(collect: boolean) {
		const id = (await this.ctx.storage.get<string>("retention-id"))!;
		const receipt = collect
			? ((await this.retentionComputer("start").execution(id, false)) as Record<
					string,
					unknown
				>)
			: null;
		const result = receipt
			? {
					executionId: String(receipt.executionId),
					terminal: receipt.terminal === true,
					stdout: String(receipt.stdout ?? ""),
				}
			: null;
		const pending = await retainComputerForNativeExecutions(
			this.ctx.storage,
			{
				runId: "retention-run",
				workItemId: "retention-work",
				leaseId: "retention-lease",
			},
			{
				canceled: false,
				cancel: async () => {
					throw Error("must not cancel");
				},
			},
		);
		return {
			id,
			pending,
			starts: await this.ctx.storage.get<number>("retention-starts"),
			result,
		};
	}
	private async refreshReconcile(
		input: WorkstationProvisioningCheckpoint,
		checkpoint: (value: WorkstationProvisioningCheckpoint) => void,
	) {
		return reconcileWorkstationUntilSettled(
			{
				identity: { tediId: "fixture", orgId: "fixture", slug: "fixture" },
				env: {
					TEDI_SERVICE: {
						fetch: async () => {
							const calls =
								((await this.ctx.storage.get<number>("refresh-calls")) ?? 0) +
								1;
							await this.ctx.storage.put("refresh-calls", calls);
							if (calls === 1) await new Promise(() => {});
							return Response.json({
								ok: true,
								ready: true,
								readiness: { toolsReady: true, repoReady: true },
								workstationPersistence: { status: "persisted" },
								workstationLease: { id: input.leaseId, status: "active" },
							});
						},
					} as unknown as Fetcher,
				},
			},
			input,
			{ checkpoint },
		);
	}
	override async onFiberRecovered(
		ctx: FiberRecoveryContext,
	): Promise<FiberRecoveryResult | undefined> {
		if (ctx.name !== workstationProvisioningFiberName("refresh-fixture"))
			return (await super.onFiberRecovered(ctx)) ?? undefined;
		const input = workstationProvisioningRecoveryInput(ctx);
		if (!input) return { status: "error", error: "missing refresh input" };
		return {
			status: "completed",
			snapshot: await this.refreshReconcile(input, () => {}),
		};
	}
	async observeNativeRefresh() {
		const input = {
			leaseId: "refresh-fixture",
			refreshId: "generation:retained-refresh",
		};
		const result = await observeWorkstationRefresh(input, {
			inspect: (key) => this.inspectFiberByKey(key),
			latest: async () => null,
			start: (key) =>
				this.startFiber(
					workstationProvisioningFiberName(input.leaseId),
					async (ctx) => {
						await this.refreshReconcile(
							{
								...input,
								attempt: 0,
								phase: "provision",
								startedAt: Date.now(),
							},
							(value) => ctx.stash(value),
						);
					},
					{ idempotencyKey: key },
				),
		});
		return {
			result: { ready: result.ready === true, ok: result.ok === true },
			calls: (await this.ctx.storage.get<number>("refresh-calls")) ?? 0,
		};
	}

	private detachedOwnerTools(replaceAmbient: boolean) {
		// The production dispatch builder owns the captured identity. The fixture
		// changes only transport and ambient state, never the captured object.
		const input = {
			conversationId: "fixture-conversation",
			runId: "detached-owner-run",
			sessionKey: "detached-owner-session",
			workItemId: "detached-owner-work",
			homeRunId: "detached-owner-home",
		};
		const turn = captureWorkstationTurnContext(input);
		const scope = computerWorkspaceScope(input);
		let active: typeof turn | null = turn;
		const computer = new ComputerEnvironmentController(
			this.ctx.storage,
			"detached-owner-environment",
			{
				open: async () => ({ ok: true, leaseId: "detached-owner-lease" }),
				status: async () => ({
					ok: true,
					readiness: { toolsReady: true, repoReady: true },
					repoSync: { workdir: "/fixture/repository" },
				}),
				close: async () => ({ ok: true }),
				files: async () => ({ ok: true }),
				start: async () => {
					const starts =
						(await this.ctx.storage.get<number>("detached-owner-starts")) ?? 0;
					await this.ctx.storage.put("detached-owner-starts", starts + 1);
					return { ok: true };
				},
				wait: async () => {
					active = replaceAmbient
						? {
								...turn,
								runId: "another-run",
								workItemId: "another-work",
								sessionKey: "another-session",
							}
						: null;
					return { ok: true, running: true, terminal: false };
				},
				read: async () => ({
					ok: true,
					found: true,
					running: true,
					terminal: false,
				}),
				cancel: async () => ({ ok: true, terminal: true }),
			},
			async () => {},
			turn.runId,
			{
				collected: async () => {},
				detached: async (execution) => {
					const owner = computerExecutionProvenance(
						scope,
						turn,
						active,
						active,
					);
					if (!owner.sessionKey)
						throw new Error("detached Work execution has no owning session");
					await new ComputerWorkflowContinuation(this.ctx.storage).register({
						...execution,
						...owner,
						sessionKey: owner.sessionKey,
						launchedByRunId: turn.runId,
						homeRunId: turn.homeRunId,
						detachedAt: Date.now(),
						attempt: 0,
					});
				},
			},
		);
		return { computer, tools: createComputerEnvironmentTools({}, computer) };
	}

	async detachOwningSession(replaceAmbient: boolean) {
		const { computer, tools } = this.detachedOwnerTools(replaceAmbient);
		await computer.open("repository");
		const result = await tools.exec!.execute!(
			{ command: "git push origin fixture" },
			{ toolCallId: "detached-owner-call", messages: [], context: undefined },
		);
		const receipt = result as {
			status?: string;
			executionId: string;
			error?: string;
		};
		await this.ctx.storage.put("detached-owner-id", receipt.executionId);
		return {
			result: {
				status: receipt.status,
				executionId: receipt.executionId,
				error: receipt.error,
			},
			...(await this.inspectDetachedOwner()),
		};
	}

	async inspectDetachedOwner() {
		const executionId = await this.ctx.storage.get<string>("detached-owner-id");
		const wake = executionId
			? await this.ctx.storage.get<ComputerExecutionWakeRecord>(
					computerExecutionWakeKey(executionId),
				)
			: undefined;
		return {
			starts: await this.ctx.storage.get<number>("detached-owner-starts"),
			wake: wake
				? {
						executionId: wake.executionId,
						sessionKey: wake.sessionKey,
						workItemId: wake.workItemId,
						homeRunId: wake.homeRunId,
						launchedByRunId: wake.launchedByRunId,
						leaseId: wake.environment.leaseId,
						command: wake.command,
						detachedAt: wake.detachedAt,
						attempt: wake.attempt,
					}
				: null,
		};
	}

	async beginLeaseRenewal() {
		await this.ctx.storage.put<DelegatedWorkLeaseRenewal>(
			delegatedWorkLeaseRenewalKey("run-1"),
			{
				runId: "run-1",
				sessionKey: "session-1",
				workItemId: "work-1",
				attemptId: "attempt-1",
				armedAt: Date.now(),
			},
		);
		await this.reenterLeaseRenewal();
	}

	async reenterLeaseRenewal() {
		await scheduleDelegatedWorkLeaseRenewal(
			"run-1",
			this.scheduleEvery.bind(this),
		);
	}

	async onDelegatedWorkLeaseRenewal(
		input: { runId: string },
		schedule: { id: string },
	) {
		const client = {
			heartbeatWorkAttempt: async (binding: {
				workItemId: string;
				attemptId: string;
			}) => {
				const heartbeats =
					(await this.ctx.storage.get<unknown[]>("renewal-proof:heartbeats")) ??
					[];
				heartbeats.push(binding);
				await this.ctx.storage.put("renewal-proof:heartbeats", heartbeats);
			},
		} as unknown as NonNullable<
			Awaited<ReturnType<DelegatedWorkLeaseDeps["getClient"]>>
		>;
		const retained = await renewDelegatedWorkLease(input.runId, {
			storage: this.ctx.storage,
			getClient: async () => client,
			isSettled: () => false,
			assertActive: async () => {
				if (await this.ctx.storage.get("renewal-proof:canceled"))
					throw new Error("canceled");
			},
			cancel: async () => {
				await this.ctx.storage.put("renewal-proof:canceled", true);
			},
			rearm: () => this.reenterLeaseRenewal(),
		});
		if (!retained) await this.cancelSchedule(schedule.id);
	}

	async inspectLeaseRenewal() {
		return {
			heartbeats:
				(await this.ctx.storage.get<
					Array<{ workItemId: string; attemptId: string }>
				>("renewal-proof:heartbeats")) ?? [],
			record: await this.ctx.storage.get<DelegatedWorkLeaseRenewal>(
				delegatedWorkLeaseRenewalKey("run-1"),
			),
			schedules: (await this.listSchedules())
				.filter((row) => row.callback === "onDelegatedWorkLeaseRenewal")
				.map((row) => ({
					id: row.id,
					type: row.type,
					intervalSeconds: row.type === "interval" ? row.intervalSeconds : null,
				})),
		};
	}

	async makeLeaseRenewalDue() {
		// Advance only the test clock boundary. Dispatch, deduplication, interval
		// recurrence and callback settlement remain the installed SDK's real code.
		this.ctx.storage.sql.exec(
			"UPDATE cf_agents_jobs SET time = ? WHERE fn = ? AND running = 0",
			Date.now() - 1,
			"onDelegatedWorkLeaseRenewal",
		);
		await this.ctx.storage.setAlarm(Date.now() + 60_000);
	}

	async cancelLeaseRenewal() {
		await this.ctx.storage.put("renewal-proof:canceled", true);
	}

	private calls = 0;
	private seenTools: Array<{ name: string; description?: string }> = [];
	private expectedFindDescription = "";
	private readonly sessionKey = "intended-conversation";

	private computer(operator = false) {
		return new ScopedComputerWorkspace(
			this.env.TEDI_COMPUTER_WORKSPACE,
			operator
				? OPERATOR_COMPUTER_SCOPE
				: computerWorkspaceScope({ sessionKey: this.sessionKey }),
			this.ctx.id.toString(),
			async () => "computer-turn-tedi",
		);
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		Object.assign(this, {
			parentAgent: async () => ({
				enrollFacetDispatchRun: async () => {},
				assertChatTurnActive: async () => {},
				reservePiStep: async () => {},
				recordPiStep: async () => {},
				reconcileFacetToolEffect: async () => null,
				recordFacetModelStep: async () => {},
				checkFacetTurnBudget: async () => ({ abort: false }),
				executeFacetTool: async (input: {
					tool: string;
					args: unknown;
					toolCallId: string;
				}) => {
					const tool = this.computer().tools()[input.tool];
					if (!tool?.execute)
						throw new Error("Scoped Computer tool unavailable");
					return tool.execute(input.args as never, {
						toolCallId: input.toolCallId,
						messages: [],
						context: undefined,
					});
				},
			}),
		});
	}
	protected selectModelForTurn() {
		return {
			model: this.getModel(),
			identity: {
				provider: "workers-ai" as const,
				model: "@cf/computer-fixture",
			},
		};
	}

	private getModel(): LanguageModelV4 {
		return {
			specificationVersion: "v4",
			provider: "local-fixture",
			modelId: "computer-turn",
			supportedUrls: {},
			doGenerate: async () => {
				throw new Error("stream only");
			},
			doStream: async (options) => {
				this.calls++;
				this.seenTools = (options.tools ?? []).map((tool) => ({
					name: tool.name,
					description: "description" in tool ? tool.description : undefined,
				}));
				const first = this.calls === 1;
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							if (first) {
								controller.enqueue({
									type: "tool-call",
									toolCallId: "native-write",
									toolName: "write",
									input: JSON.stringify({
										path: "/workspace/from-model.txt",
										content: "written in conversation",
									}),
								});
							} else {
								controller.enqueue({ type: "text-start", id: "answer" });
								controller.enqueue({
									type: "text-delta",
									id: "answer",
									delta: "completed",
								});
								controller.enqueue({ type: "text-end", id: "answer" });
							}
							controller.enqueue({
								type: "finish",
								finishReason: {
									unified: first ? "tool-calls" : "stop",
									raw: "fixture",
								},
								usage: {
									inputTokens: {
										total: 10,
										noCache: 10,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: { total: 10, text: 10, reasoning: 0 },
								},
							});
							controller.close();
						},
					}),
				};
			},
		};
	}

	async run() {
		const tools = this.computer().tools();
		this.expectedFindDescription = String(tools.find!.description ?? "");
		const outcome = await this.runConfiguredConversationTurn({
			configuration: {
				system: "Use the scoped Computer tools",
				modelRef: null,
				aigMetadata: { tediId: "computer-fixture", orgId: "fixture-org" },
				sessionKey: this.sessionKey,
				runId: crypto.randomUUID(),
				maxSteps: 3,
				toolDescriptors: describeFacetTools(tools),
			},
			text: "Write from-model.txt using the write tool, then finish.",
			durableSubmissionId: crypto.randomUUID(),
		});
		return {
			text: outcome.result.assistantText,
			seenTools: this.seenTools,
			expectedFindDescription: this.expectedFindDescription,
			conversationFile:
				await this.computer().workspace.readFile("from-model.txt"),
			operatorFile:
				await this.computer(true).workspace.readFile("from-model.txt"),
		};
	}
}
