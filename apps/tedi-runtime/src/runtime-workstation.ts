import { exceptionTopology } from "@tedix/worker-kit/exception-topology";
import { withCompletionEvidence } from "@tedix/api-contract/schemas/execution-evidence";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import type { FiberInspection } from "agents";
import { type ToolSet } from "ai";
import {
	recordWorkstationProcessArtifactRefs,
	resolveWorkstationProcessArtifactRunId,
	trustedExistingWorkstationArtifactIds,
	trustedPersistedWorkstationArtifactIds,
} from "./artifact-recorder";
import type { HttpPlatformClient } from "./brain/platform-client";
import { originalAcquisitionAuthority } from "./computer-acquisition";
import {
	type ComputerEnvironment,
	ComputerEnvironmentController,
	createComputerEnvironmentTools,
} from "./computer-environment";
import {
	canDispatchComputerExecutionWake,
	collectComputerExecutionWake,
	computerExecutionProvenance,
	computerExecutionWakeDelaySeconds,
	computerExecutionWakeKey,
	type ComputerExecutionWakeRecord,
	resolveComputerExecutionWake,
} from "./computer-execution-wake";
import { ComputerWorkflowContinuation } from "./computer-workflow-continuation";
import { type ComputerWorkspaceScope } from "./computer-workspace-scope";
import { ConversationFacet } from "./conversation-facet";
import type { AgentTediDO } from "./do";
import { isDuplicateWorkflowInstanceError } from "./durable-messages-send";
import { buildRunId, buildWorkflowInstanceId } from "./ledger-mirror";
import {
	buildRepoCommitGateCommand,
	classifyRepoCommitGateResult,
} from "./repo-commit-gate";
import { identityValue, unknownRecord } from "./runtime-facet-turns";
import {
	logTediRuntimeFailure,
	logTediRuntimeState,
} from "./runtime-failure-log";
import {
	cancelWorkstationProcess,
	execWorkstation,
	operateComputerFiles,
	readWorkstationProcess,
	readWorkstationStatus,
	releaseWorkstation,
	requestWorkstation,
	startWorkstationProcess,
	waitWorkstationProcess,
	type WorkstationProcessCancelInput,
	type WorkstationProcessStartInput,
	type WorkstationProcessStatusInput,
	type WorkstationProcessWaitInput,
	type WorkstationReleaseInput,
	type WorkstationRequestInput,
	type WorkstationStatusInput,
} from "./workstation";
import {
	compactPublicWorkstationJobReadReceipt,
	sanitizePublicWorkstationJobReceipt,
} from "./workstation-job-receipt";
import {
	reconcileWorkstationUntilSettled,
	type WorkstationProvisioningCheckpoint,
	workstationProvisioningStatusInput,
} from "./workstation-provisioning";
import {
	admitWorkstationProvisioning,
	isActiveWorkstationProvisioningFiber,
	latestWorkstationProvisioningFiber,
	observeWorkstationRefresh,
	shouldStartWorkstationProvisioningSuccessor,
	workstationProvisioningAttemptKey,
	workstationProvisioningBaseKey,
	workstationProvisioningFiberMetadata,
	workstationProvisioningFiberName,
} from "./workstation-provisioning-attempt";
import {
	resolveWorkstationTurnIdentity,
	withWorkstationTurnContext,
	workstationProcessConversationProvenance,
	type WorkstationTurnContext,
} from "./workstation-turn-context";
type ActiveTurnBinding = NonNullable<AgentTediDO["activeTurnBinding"]>;
function stringArrayFromUnknown(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export interface RuntimeWorkstationHost {
	owner: object;
	ensureIdentity: AgentTediDO["ensureIdentity"];
	state: AgentTediDO["state"];
	env: AgentTediDO["env"];
	resolveWorkstationTurnBinding: AgentTediDO["resolveWorkstationTurnBinding"];
	readLatestWorkstationProvisioningFiber: AgentTediDO["readLatestWorkstationProvisioningFiber"];
	startWorkstationProvisioningFiber: AgentTediDO["startWorkstationProvisioningFiber"];
	inspectFiberByKey: AgentTediDO["inspectFiberByKey"];
	listFibers: AgentTediDO["listFibers"];
	startFiber: AgentTediDO["startFiber"];
	reconcileWorkstationUntilSettled: AgentTediDO["reconcileWorkstationUntilSettled"];
	recordWorkstationProcessArtifactRows: AgentTediDO["recordWorkstationProcessArtifactRows"];
	readWorkstationProcessTool: AgentTediDO["readWorkstationProcessTool"];
	cancelWorkstationProcessTool: AgentTediDO["cancelWorkstationProcessTool"];
	activeTurnBinding: AgentTediDO["activeTurnBinding"];
	getPlatformClient: AgentTediDO["getPlatformClient"];
	recordPendingTraceIds: AgentTediDO["recordPendingTraceIds"];
	computerWorkspace: AgentTediDO["computerWorkspace"];
	ctx: AgentTediDO["ctx"];
	requestWorkstationTool: AgentTediDO["requestWorkstationTool"];
	releaseWorkstationTool: AgentTediDO["releaseWorkstationTool"];
	readWorkstationStatusTool: AgentTediDO["readWorkstationStatusTool"];
	startWorkstationProcessTool: AgentTediDO["startWorkstationProcessTool"];
	readWorkstationJobTool: AgentTediDO["readWorkstationJobTool"];
	waitWorkstationJobTool: AgentTediDO["waitWorkstationJobTool"];
	cancelWorkstationJobTool: AgentTediDO["cancelWorkstationJobTool"];
	armComputerExecutionWake: AgentTediDO["armComputerExecutionWake"];
	assertChatTurnActive: AgentTediDO["assertChatTurnActive"];
	schedule: AgentTediDO["schedule"];
	subAgent: AgentTediDO["subAgent"];
	rearmComputerExecutionWake: AgentTediDO["rearmComputerExecutionWake"];
	dispatchComputerExecutionWake: AgentTediDO["dispatchComputerExecutionWake"];
	acceptRuntimeTurn: AgentTediDO["acceptRuntimeTurn"];
	recordWorkflowDispatch: AgentTediDO["recordWorkflowDispatch"];
	dispatchAdmittedChatWorkflow: AgentTediDO["dispatchAdmittedChatWorkflow"];
	name: AgentTediDO["name"];
	clearWorkflowDispatch: AgentTediDO["clearWorkflowDispatch"];
	workspaceAiTools: AgentTediDO["workspaceAiTools"];
	computerEnvironment: AgentTediDO["computerEnvironment"];
}
export const runtimeWorkstation = {
	async reconcileWorkstationUntilSettled(
		this: RuntimeWorkstationHost,
		input: WorkstationStatusInput | WorkstationProvisioningCheckpoint,
		options: {
			checkpoint: (value: WorkstationProvisioningCheckpoint) => void;
			signal?: AbortSignal;
		},
	): Promise<WorkstationProvisioningCheckpoint> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) throw new Error("Tedi identity is not resolved");
		return reconcileWorkstationUntilSettled(
			{
				env: this.env as unknown as {
					ENVIRONMENT?: string;
					TEDI_SERVICE?: Fetcher;
				},
				identity: { orgId, slug, tediId },
			},
			input,
			options,
		);
	},
	async requestWorkstationTool(
		this: RuntimeWorkstationHost,
		input: WorkstationRequestInput,
		turnContext?: WorkstationTurnContext | null,
		confirmed?: (receipt: unknown) => Promise<void>,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) {
			return {
				ok: false,
				error: "Tedi identity is not resolved",
			};
		}
		const binding = await this.resolveWorkstationTurnBinding(turnContext);
		const request = withWorkstationTurnContext(input, binding);
		const receipt = await requestWorkstation(
			this.env as unknown as {
				ENVIRONMENT?: string;
				TEDI_SERVICE?: Fetcher;
			},
			{ orgId, slug, tediId },
			request,
		);
		// Commit the exact acquisition before provisioning-fiber bookkeeping can await.
		await confirmed?.(receipt);
		const statusInput = workstationProvisioningStatusInput(receipt, request);
		if (!statusInput) return receipt;

		try {
			const previous = await this.readLatestWorkstationProvisioningFiber(
				statusInput.leaseId,
			);
			if (previous && isActiveWorkstationProvisioningFiber(previous)) {
				return {
					...(unknownRecord(receipt) ?? { result: receipt }),
					provisioningFiber: {
						accepted: false,
						fiberId: previous.fiberId,
						status: previous.status,
					},
				};
			}
			const fiber = await this.startWorkstationProvisioningFiber(
				statusInput,
				previous,
			);
			return {
				...(unknownRecord(receipt) ?? { result: receipt }),
				provisioningFiber: {
					accepted: fiber.accepted,
					fiberId: fiber.fiberId,
					status: fiber.status,
				},
			};
		} catch (error) {
			return {
				...(unknownRecord(receipt) ?? { result: receipt }),
				provisioningFiber: {
					accepted: false,
					error: error instanceof Error ? error.message : String(error),
					status: "error",
				},
			};
		}
	},
	async startWorkstationProvisioningFiber(
		this: RuntimeWorkstationHost,
		input: WorkstationStatusInput | WorkstationProvisioningCheckpoint,
		previous: FiberInspection | null,
		refreshKey?: string,
	) {
		return admitWorkstationProvisioning(this.owner, input.leaseId, {
			active: async () => {
				const [base, scoped] = await Promise.all([
					this.inspectFiberByKey(workstationProvisioningBaseKey(input.leaseId)),
					this.listFibers({
						name: workstationProvisioningFiberName(input.leaseId),
						status: ["pending", "running", "interrupted"],
						limit: 100,
					}),
				]);
				const active = [base, ...scoped].find(
					(fiber) => fiber && isActiveWorkstationProvisioningFiber(fiber),
				);
				if (!active && scoped.length === 100)
					throw new Error(
						"Provisioning admission cannot prove all prior fibers settled",
					);
				return active ?? null;
			},
			start: () =>
				this.startFiber(
					workstationProvisioningFiberName(input.leaseId),
					async (ctx) => {
						await this.reconcileWorkstationUntilSettled(input, {
							checkpoint: (value) => ctx.stash(value),
							signal: ctx.signal,
						});
					},
					{
						idempotencyKey:
							refreshKey ??
							workstationProvisioningAttemptKey(input.leaseId, previous),
						metadata: workstationProvisioningFiberMetadata(input, previous),
					},
				),
		});
	},
	async readLatestWorkstationProvisioningFiber(
		this: RuntimeWorkstationHost,
		leaseId: string,
	): Promise<FiberInspection | null> {
		const [baseAttempt, scopedAttempts] = await Promise.all([
			this.inspectFiberByKey(workstationProvisioningBaseKey(leaseId)),
			this.listFibers({
				limit: 1,
				name: workstationProvisioningFiberName(leaseId),
			}),
		]);
		return latestWorkstationProvisioningFiber(baseAttempt, scopedAttempts[0]);
	},
	async readWorkstationStatusTool(
		this: RuntimeWorkstationHost,
		input: WorkstationStatusInput,
		turnContext?: WorkstationTurnContext | null,
		timeoutMs?: number,
		refreshId?: string,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) {
			return { ok: false, error: "Tedi identity is not resolved" };
		}
		const binding = await this.resolveWorkstationTurnBinding(turnContext);
		const request = withWorkstationTurnContext(input, binding);
		// The durable fiber owns native recovery; foreground calls only observe it.
		if (refreshId)
			return observeWorkstationRefresh(
				{ leaseId: request.leaseId, refreshId },
				{
					inspect: (key) => this.inspectFiberByKey(key),
					latest: () =>
						this.readLatestWorkstationProvisioningFiber(request.leaseId),
					start: (key) =>
						this.startWorkstationProvisioningFiber(
							{
								...request,
								refreshId,
								attempt: 0,
								phase: "provision",
								startedAt: Date.now(),
							},
							null,
							key,
						),
				},
			);
		const [result, fiber] = await Promise.all([
			readWorkstationStatus(
				this.env as unknown as {
					ENVIRONMENT?: string;
					TEDI_SERVICE?: Fetcher;
				},
				{ orgId, slug, tediId },
				request,
				{ timeoutMs },
			),
			this.readLatestWorkstationProvisioningFiber(request.leaseId),
		]);
		const resultRecord = unknownRecord(result);
		let provisioningFiber: Record<string, unknown> | null = fiber
			? {
					createdAt: fiber.createdAt,
					error: fiber.error,
					fiberId: fiber.fiberId,
					settledAt: fiber.settledAt,
					startedAt: fiber.startedAt,
					status: fiber.status,
				}
			: null;
		if (
			shouldStartWorkstationProvisioningSuccessor(
				fiber,
				resultRecord?.status,
				resultRecord?.ready,
				unknownRecord(resultRecord?.bootstrap)?.nextAction,
				unknownRecord(resultRecord?.bootstrap)?.lastBootstrapError,
			)
		) {
			try {
				const successor = await this.startWorkstationProvisioningFiber(
					request,
					fiber,
				);
				provisioningFiber = {
					accepted: successor.accepted,
					fiberId: successor.fiberId,
					resumedFromFiberId: fiber.fiberId,
					status: successor.status,
				};
			} catch (error) {
				provisioningFiber = {
					...provisioningFiber,
					resumeError: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return {
			...(resultRecord ?? { result }),
			provisioningFiber,
		};
	},
	async releaseWorkstationTool(
		this: RuntimeWorkstationHost,
		input: WorkstationReleaseInput,
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) {
			return { ok: false, error: "Tedi identity is not resolved" };
		}
		const result = await releaseWorkstation(
			this.env as unknown as {
				ENVIRONMENT?: string;
				TEDI_SERVICE?: Fetcher;
			},
			{ orgId, slug, tediId },
			withWorkstationTurnContext(
				input,
				await this.resolveWorkstationTurnBinding(turnContext),
			),
		);
		const record = unknownRecord(result);
		const workstation = unknownRecord(record?.workstation);
		const workstationLease = unknownRecord(record?.workstationLease);
		return {
			ok: record?.ok === true,
			leaseId: record?.leaseId ?? input.leaseId,
			leaseStatus: workstationLease?.status ?? null,
			alreadyReleased: record?.alreadyReleased === true,
			adapterCleanup: unknownRecord(record?.adapterCleanup)?.status ?? null,
			workstation:
				workstation && typeof workstation.id === "string"
					? {
							id: workstation.id,
							status: workstation.status ?? null,
						}
					: null,
			...(typeof record?.error === "string" ? { error: record.error } : {}),
		};
	},
	async runRepoCommitGate(
		this: RuntimeWorkstationHost,
		paths: string[],
	): Promise<{
		ok: boolean;
		ran: boolean;
		output: string;
	}> {
		const command = buildRepoCommitGateCommand(paths);
		if (!command)
			return { ok: false, ran: false, output: "unsafe or missing gate paths" };
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug)
			return { ok: false, ran: false, output: "tedi identity is not resolved" };
		try {
			const result = await execWorkstation(
				this.env as unknown as { ENVIRONMENT?: string; TEDI_SERVICE?: Fetcher },
				{ orgId, slug, tediId },
				withWorkstationTurnContext(
					// The pre-push gate normally outlasts the workstation's 120s default.
					{ command, timeoutMs: 300_000 },
					await this.resolveWorkstationTurnBinding(null),
				),
			);
			return classifyRepoCommitGateResult(
				(result ?? {}) as Record<string, unknown>,
			);
		} catch (error) {
			return {
				ok: false,
				ran: false,
				output: error instanceof Error ? error.message : String(error),
			};
		}
	},
	async startWorkstationProcessTool(
		this: RuntimeWorkstationHost,
		input: WorkstationProcessStartInput,
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) {
			return {
				ok: false,
				error: "Tedi identity is not resolved",
			};
		}
		const identity = resolveWorkstationTurnIdentity(
			await this.resolveWorkstationTurnBinding(turnContext),
			turnContext ?? undefined,
		);
		const request = withWorkstationTurnContext(input, identity);
		return startWorkstationProcess(
			this.env as unknown as {
				ENVIRONMENT?: string;
				TEDI_SERVICE?: Fetcher;
			},
			{ orgId, slug, tediId },
			request,
			{
				conversationProvenance: workstationProcessConversationProvenance(
					request,
					identity,
				),
			},
		);
	},
	async readWorkstationProcessTool(
		this: RuntimeWorkstationHost,
		input: WorkstationProcessStatusInput,
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) {
			return {
				ok: false,
				error: "Tedi identity is not resolved",
			};
		}
		const binding = await this.resolveWorkstationTurnBinding(turnContext);
		const result = await readWorkstationProcess(
			this.env as unknown as {
				ENVIRONMENT?: string;
				TEDI_SERVICE?: Fetcher;
			},
			{ orgId, slug, tediId },
			withWorkstationTurnContext(input, binding),
		);
		return this.recordWorkstationProcessArtifactRows(
			input,
			result,
			binding,
			turnContext,
		);
	},
	async waitWorkstationJobTool(
		this: RuntimeWorkstationHost,
		input: Omit<WorkstationProcessWaitInput, "processId"> & { jobId: string },
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug)
			return { ok: false, error: "Tedi identity is not resolved" };
		return waitWorkstationProcess(
			this.env as unknown as { ENVIRONMENT?: string; TEDI_SERVICE?: Fetcher },
			{ orgId, slug, tediId },
			withWorkstationTurnContext(
				{ ...input, processId: input.jobId },
				await this.resolveWorkstationTurnBinding(turnContext),
			),
		);
	},
	async readWorkstationJobTool(
		this: RuntimeWorkstationHost,
		input: Omit<WorkstationProcessStatusInput, "processId"> & { jobId: string },
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		const result = await this.readWorkstationProcessTool(
			{ ...input, processId: input.jobId },
			turnContext,
		);
		const record = unknownRecord(result);
		const jobResult = compactPublicWorkstationJobReadReceipt(
			record ?? { result },
		);
		return withCompletionEvidence(
			"read_execution",
			{ ...jobResult, jobId: input.jobId },
			{ key: `read_execution:${input.jobId}` },
		);
	},
	async cancelWorkstationProcessTool(
		this: RuntimeWorkstationHost,
		input: WorkstationProcessCancelInput,
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		await this.ensureIdentity();
		const { tediId, orgId, slug } = this.state;
		if (!tediId || !slug) {
			return {
				ok: false,
				error: "Tedi identity is not resolved",
			};
		}
		const binding = await this.resolveWorkstationTurnBinding(turnContext);
		const result = await cancelWorkstationProcess(
			this.env as unknown as {
				ENVIRONMENT?: string;
				TEDI_SERVICE?: Fetcher;
			},
			{ orgId, slug, tediId },
			withWorkstationTurnContext(input, binding),
		);
		return this.recordWorkstationProcessArtifactRows(
			input,
			result,
			binding,
			turnContext,
		);
	},
	async cancelWorkstationJobTool(
		this: RuntimeWorkstationHost,
		input: Omit<WorkstationProcessCancelInput, "processId"> & { jobId: string },
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		const result = await this.cancelWorkstationProcessTool(
			{ ...input, processId: input.jobId },
			turnContext,
		);
		const record = unknownRecord(result);
		const jobResult =
			unknownRecord(
				sanitizePublicWorkstationJobReceipt(record ?? { result }),
			) ?? {};
		return withCompletionEvidence(
			"cancel_execution",
			{ ...jobResult, jobId: input.jobId },
			{ key: `cancel_execution:${input.jobId}` },
		);
	},
	async resolveWorkstationTurnBinding(
		this: RuntimeWorkstationHost,
		turnContext?:
			| (WorkstationTurnContext & { platform?: HttpPlatformClient })
			| null,
	): Promise<ActiveTurnBinding | null> {
		if (turnContext === null) return null;
		const active = this.activeTurnBinding;
		const identity = resolveWorkstationTurnIdentity(active, turnContext);
		if (!identity) return null;
		if (turnContext?.platform)
			return { ...identity, platform: turnContext.platform };
		if (active && identity === active) return active;
		if (
			active?.runId === identity.runId &&
			active.conversationId === identity.conversationId
		) {
			return { ...active, ...identity };
		}
		const platform = await this.getPlatformClient();
		if (!platform) return null;
		return { ...identity, platform };
	},
	async recordWorkstationProcessArtifactRows(
		this: RuntimeWorkstationHost,
		input: WorkstationProcessStatusInput | WorkstationProcessCancelInput,
		result: unknown,
		binding: ActiveTurnBinding | null,
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown> {
		const resultRecord = unknownRecord(result);
		const job = unknownRecord(resultRecord?.job);
		if (!resultRecord || !job) return result;
		const existingPersistence = unknownRecord(job.artifactRowPersistence);
		if (
			existingPersistence?.status === "persisted" &&
			typeof existingPersistence.recorded === "number" &&
			existingPersistence.recorded > 0
		) {
			return result;
		}
		const evidence = unknownRecord(job.evidence) ?? undefined;
		const artifactRefs = stringArrayFromUnknown(job.artifactRefs);
		const evidenceRefs = stringArrayFromUnknown(evidence?.artifactRefs);
		const refs = artifactRefs.length > 0 ? artifactRefs : evidenceRefs;
		if (refs.length === 0) return result;

		const active = binding;
		const context = unknownRecord(job.context);
		const runId = resolveWorkstationProcessArtifactRunId({
			activeRunId: active?.runId,
			evidenceKernelRunId: evidence?.kernelRunId as string | undefined,
			evidenceWorkItemId: evidence?.workItemId as string | undefined,
			inputKernelRunId: input.kernelRunId,
			inputWorkItemId: input.workItemId,
		});
		const processId =
			identityValue(input.processId) ??
			identityValue(job.processId as string | undefined) ??
			identityValue(evidence?.processId as string | undefined);
		const tediId = identityValue(this.state.tediId);
		if (!runId || !processId || !tediId) return result;
		// A detached process read can retain its run ID in evidence after the
		// ambient turn has gone away. Only a matching dispatch identity may own
		// new artifact claims; never create another null-conversation row.
		const turnIdentity = resolveWorkstationTurnIdentity(
			active,
			turnContext ?? undefined,
		);
		const conversationId =
			turnIdentity?.runId === runId
				? identityValue(turnIdentity.conversationId)
				: undefined;
		if (!conversationId) return result;

		const platform = active?.platform ?? (await this.getPlatformClient());
		if (!platform) return result;
		const trustedPersistedIds = trustedPersistedWorkstationArtifactIds({
			persistedEvidenceReadback: resultRecord.persistedEvidenceReadback,
			persistence: existingPersistence ?? undefined,
			artifactRefs: refs,
			runId,
			processId,
		});
		const trustedExistingIds = trustedExistingWorkstationArtifactIds({
			persistence: existingPersistence ?? undefined,
			artifactRefs: refs,
			runId,
			processId,
		});

		const registration = await recordWorkstationProcessArtifactRefs({
			platform,
			tediId,
			conversationId,
			runId,
			processId,
			artifactRefs: refs,
			persistedArtifactIds: Array.from(
				new Set([...trustedExistingIds, ...trustedPersistedIds]),
			),
			evidence,
			traceBundleId:
				identityValue(input.traceBundleId) ??
				identityValue(context?.traceBundleId as string | undefined),
		});
		if (registration.artifactIds.length > 0) {
			this.recordPendingTraceIds(runId, [], registration.artifactIds);
		}
		return {
			...resultRecord,
			job: {
				...job,
				artifactRowPersistence: registration,
			},
		};
	},
	computerEnvironment(
		this: RuntimeWorkstationHost,
		scope: ComputerWorkspaceScope,
		turnContext: WorkstationTurnContext | null,
	): ComputerEnvironmentController {
		const workspace = this.computerWorkspace(scope);
		return new ComputerEnvironmentController(
			this.ctx.storage,
			`computer-environment:${workspace.id}`,
			{
				open: (preparation, executionId, work, confirmed) =>
					this.requestWorkstationTool(
						{
							preparation,
							executionId,
							reason: "Open task computer",
							attemptId: work?.attemptId,
							workItemId: work?.workItemId,
						},
						turnContext,
						confirmed,
					),
				close: (selected) =>
					this.releaseWorkstationTool(
						{
							...selected,
							preserveChanges: selected.preparation === "repository",
						},
						turnContext,
					),
				status: (selected, timeoutMs, refreshNative) =>
					this.readWorkstationStatusTool(
						selected,
						turnContext,
						timeoutMs,
						refreshNative ? selected.revalidationId : undefined,
					),
				files: async (selected, operation, input) => {
					await this.ensureIdentity();
					if (!this.state.tediId || !this.state.slug)
						throw new Error("Tedi identity is not resolved");
					return operateComputerFiles(
						this.env,
						{
							tediId: this.state.tediId,
							slug: this.state.slug,
							orgId: this.state.orgId,
						},
						withWorkstationTurnContext(
							{ ...input, ...selected, operation },
							await this.resolveWorkstationTurnBinding(turnContext),
						),
					);
				},
				start: (selected, input) =>
					this.startWorkstationProcessTool(
						{ ...selected, ...input, kind: "command" },
						turnContext,
					),
				read: (selected, id) =>
					this.readWorkstationJobTool({ ...selected, jobId: id }, turnContext),
				wait: (selected, id, timeoutMs) =>
					this.waitWorkstationJobTool(
						{ ...selected, jobId: id, timeoutMs },
						turnContext,
					),
				cancel: (selected, id) =>
					this.cancelWorkstationJobTool(
						{ ...selected, jobId: id },
						turnContext,
					),
			},
			undefined,
			turnContext?.runId,
			{
				retained: (execution) =>
					this.armComputerExecutionWake(scope, turnContext, execution, false),
				detached: ({ command, environment, executionId }) =>
					this.armComputerExecutionWake(scope, turnContext, {
						command,
						environment,
						executionId,
					}),
				collected: (executionId) =>
					collectComputerExecutionWake(
						this.ctx.storage,
						executionId,
						turnContext,
					),
			},
			{
				captureAuthority: async () => {
					if (turnContext?.runId)
						await this.assertChatTurnActive(turnContext.runId);
					return originalAcquisitionAuthority(
						this.ctx.storage,
						() => this.getPlatformClient(),
						{
							runId: turnContext?.runId,
							workItemId: turnContext?.workItemId,
							tediId: this.state.tediId ?? undefined,
						},
					);
				},
			},
		);
	},
	async armComputerExecutionWake(
		this: RuntimeWorkstationHost,
		scope: ComputerWorkspaceScope,
		turnContext: WorkstationTurnContext | null,
		execution: {
			command: string;
			environment: ComputerEnvironment;
			executionId: string;
		},
		scheduleNotification = true,
	): Promise<void> {
		// A delegated-run scope is keyed by Work Item, so the conversation the
		// wake must land in comes from the live turn rather than the scope.
		const { sessionKey, workItemId } = computerExecutionProvenance(
			scope,
			turnContext,
			this.activeTurnBinding,
			null,
		);
		if (!sessionKey) {
			if (workItemId)
				throw new Error(
					"computer_continuation_failed: detached Work execution has no owning session",
				);
			console.warn(
				`[computer.wake] no session key for detached execution ${execution.executionId}; completion will not wake this tedi`,
			);
			return;
		}
		const record: ComputerExecutionWakeRecord = {
			attempt: 0,
			command: execution.command,
			detachedAt: Date.now(),
			environment: execution.environment,
			executionId: execution.executionId,
			sessionKey,
			...(workItemId ? { workItemId } : {}),
			...(turnContext?.runId ? { launchedByRunId: turnContext.runId } : {}),
			...(turnContext?.homeRunId ? { homeRunId: turnContext.homeRunId } : {}),
		};
		await new ComputerWorkflowContinuation(this.ctx.storage).register(record);
		// Work-owned execution is resumed by its original workflow and Attempt.
		// Legacy Work records remain evidence; they cannot become unfenced cron turns.
		// Pre-dispatch retention must not race the inline result with a chat wake.
		if (!scheduleNotification || !canDispatchComputerExecutionWake(record))
			return;
		await this.schedule(
			computerExecutionWakeDelaySeconds(0),
			"onComputerExecutionWake",
			{ executionId: execution.executionId },
			{ idempotent: true, retry: { maxAttempts: 3 } },
		);
	},
	async onComputerExecutionWake(
		this: RuntimeWorkstationHost,
		input: { executionId: string },
	): Promise<void> {
		const key = computerExecutionWakeKey(input.executionId);
		const record = await this.ctx.storage.get<ComputerExecutionWakeRecord>(key);
		// The model already collected it (or cancelled it): nothing is owed.
		if (!record) return;
		if (!canDispatchComputerExecutionWake(record)) return;
		let receipt: Record<string, unknown> = {};
		try {
			receipt =
				unknownRecord(
					await this.readWorkstationJobTool(
						{ ...record.environment, jobId: record.executionId },
						null,
					),
				) ?? {};
		} catch (e) {
			// A transient read failure is not evidence about the process. Re-arm.
			console.warn(
				`[computer.wake] status read failed for ${record.executionId}`,
				{ exception: exceptionTopology(e) },
			);
		}
		const decision = resolveComputerExecutionWake(record, receipt, Date.now());
		if (decision.action === "abandon") {
			console.warn(
				`[computer.wake] dropped execution ${record.executionId}: ${decision.reason}`,
			);
			await this.ctx.storage.delete(key);
			return;
		}
		// A wake dispatched into a conversation that is mid-turn would race that
		// turn's own settlement, and that turn may still collect the command
		// itself. Wait for the same stability the scheduler waits for.
		if (
			decision.action === "wake" &&
			!(await (
				await this.subAgent(
					ConversationFacet,
					record.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"),
				)
			).waitUntilStable({ timeout: 30_000 }))
		) {
			await this.rearmComputerExecutionWake(key, record, record.attempt + 1);
			return;
		}
		if (decision.action === "rearm") {
			await this.rearmComputerExecutionWake(key, record, decision.attempt);
			return;
		}
		// Delete BEFORE dispatch: the wake is owed exactly once, and a duplicate
		// notification is worse than a lost re-arm.
		await this.ctx.storage.delete(key);
		await this.dispatchComputerExecutionWake(record, decision.text);
	},
	async rearmComputerExecutionWake(
		this: RuntimeWorkstationHost,
		key: string,
		record: ComputerExecutionWakeRecord,
		attempt: number,
	): Promise<void> {
		await this.ctx.storage.put<ComputerExecutionWakeRecord>(key, {
			...record,
			attempt,
		});
		await this.schedule(
			computerExecutionWakeDelaySeconds(attempt),
			"onComputerExecutionWake",
			{ executionId: record.executionId },
			{ idempotent: true, retry: { maxAttempts: 3 } },
		);
	},
	async dispatchComputerExecutionWake(
		this: RuntimeWorkstationHost,
		record: ComputerExecutionWakeRecord,
		userText: string,
	): Promise<void> {
		if (!canDispatchComputerExecutionWake(record)) return;
		const { tediId, slug } = this.state;
		if (!tediId) return;
		const clientRequestId = `computer-exec:${record.executionId}`;
		const runId = buildRunId(tediId, clientRequestId, "cron");
		await this.acceptRuntimeTurn(runId, record.sessionKey, {
			kind: "computer_wake",
			record,
			userText,
		});
		const workflowInstanceId = buildWorkflowInstanceId(clientRequestId);
		const userTs = Date.now();
		const recorded = await this.recordWorkflowDispatch(workflowInstanceId, {
			runId,
			sessionKey: record.sessionKey,
			userText,
			userTs,
			...(record.workItemId ? { workItemId: record.workItemId } : {}),
		});
		if (!recorded) {
			logTediRuntimeState("tedi.computer.wake_context_unavailable", "error");
			return;
		}
		try {
			await this.dispatchAdmittedChatWorkflow(
				"CHAT_TURN_WORKFLOW",
				{
					agentName: this.name,
					clientRequestId,
					conversationId: buildTediConversationId({
						tediRef: slug || tediId,
						sessionKey: record.sessionKey,
					}),
					runId,
					sessionKey: record.sessionKey,
					trustedInstructionOrigin: "computer_execution",
					userText,
					userTs,
					...(record.workItemId ? { workItemId: record.workItemId } : {}),
				},
				{ agentBinding: "TEDI_AGENT", id: workflowInstanceId },
			);
		} catch (e) {
			if (!isDuplicateWorkflowInstanceError(e))
				await this.clearWorkflowDispatch(workflowInstanceId);
			logTediRuntimeFailure("tedi.computer.wake_dispatch_failed", e, "error");
		}
	},
	workstationAiTool(
		this: RuntimeWorkstationHost,
		scope: ComputerWorkspaceScope,
		turnContext: WorkstationTurnContext | null,
	): ToolSet {
		return createComputerEnvironmentTools(
			this.workspaceAiTools(scope, turnContext),
			this.computerEnvironment(scope, turnContext),
		);
	},
};
