import { isLocalDemoProject } from "@tedix/auth/local-demo";
import {
	workstationDispatchIdentity,
	inspectWorkstationDispatchAdmission,
} from "../kernel/workstation-dispatch";
import { resolveHomeAttachments } from "./attachment-storage";
import { AUTHZ, ErrorCodes, createError, withServiceAuth } from "../../orpc";
import {
	type ExecutionRequirement,
	ExecutionRequirementSchema,
} from "@tedix/api-contract/schemas/execution-evidence";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
	createDelegationWorkItem,
	directDelegationDispatchContent,
} from "../kernel/delegation-work-item";
import {
	KERNEL_RUNTIME_BACKEND,
	ensureHomeConversationAccess,
	existingRunStartedCause,
	insertKernelRuntimeEvent,
	insertKernelRuntimeRun,
	recordHomeDelegationDispatchFailure,
} from "../kernel/run-store";
import type { KernelDO } from "../../../kernel/kernel-do";
import {
	type KernelTurnWorkInput,
	type KernelTurnWorkResult,
	runKernelTurnWork,
} from "../kernel/turn-work";
import { REPO_COMMIT_WRITE_KIND } from "@tedix/api-contract/schemas/repo-commit-write";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import { type VoiceSttEnv, resolveVoiceMessageContent } from "@tedix/voice/stt";
import { buildDelegationWorkOrder } from "../kernel/delegation-dispatch";
import { classifyWorkstationDispatch } from "../kernel/dispatch-policy";
import { defaultHomeConversationIdForCaller } from "../kernel/conversation-origin";
import { deriveEmbodiedCapability } from "../kernel/tedi-capabilities";
import {
	ensureWorkstationAttachApprovalRequest,
	recordWorkstationAttachKernelTraceBundle,
	workstationAttachWorkOrder,
} from "../kernel/workstation-attach";
import {
	errorMessage,
	homeRunProgress,
	isMissingKernelRuntimeRunsTable,
	isMissingKernelRuntimeTable,
	nonNullRecord,
	nowIso,
	offsetIso,
	predictAgentRunId,
	resolveOrganizationId,
	stringFromPayload,
	withTimeout,
} from "../kernel/runtime-shared";
import { generateAndPersistHomeConversationTitle } from "../kernel/conversation-title";
import {
	getApprovalRequestById,
	resolveApprovalRequest,
} from "@tedix/db/queries/approvals";
import { getWorkstationCapableTediIds } from "@tedix/db/queries/workstations";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import {
	claimKernelExecutionPolicy,
	kernelRunStatusToSubmissionOutcome,
	settleKernelSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { resolveApprovalTtlHours } from "@tedix/api-contract/utils/approval-policy";
import { unresolvedSkillReferences } from "../kernel/context-assembly";
import { verificationRequirementLines } from "../kernel/delegated-stop";
import {
	KernelDelegateRunnerOutput,
	activeTranscribeAudio,
	authed,
	buildKernelCorrectionSignal,
	detectOperatorSlashCommand,
	explicitDelegationNeedsEmbodiedSurface,
	kernelDelegateRunner,
	kernelPlanAssistantContent,
	kernelRuntimeOs,
	maybeBuildHomePlan,
	normalizeMessageAttachments,
	operatorSlashCommandRefusal,
	readOrgGovernancePolicy,
	readSessionWriteAllowlist,
	remainingKernelTurnBudgetMs,
} from "./policy-normalization";
import {
	delegationWorkOrderApprovalRequestId,
	ensureKernelHarnessStampOnResult,
	failedKernelRun,
	resolveKernelDelegateTarget,
} from "./run-reads-streams";
import { buildKernelTurnWorkDeps } from "./turn-delegation";
import { runWorkstationWorkOrderDispatch } from "./workstation-dispatch";
import {
	proposeCodemodeExecuteImpl,
	proposeRepoCommitImpl,
} from "./control-proposals";
import type { DbQueryClient } from "@tedix/db/query-client";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsOutput } from "@tedix/db/queries/os-workspaces/outputs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { authorizedWorkspaceDocumentContext } from "./workspace-output-context";

export async function resolveWorkspaceContext(
	db: DbQueryClient,
	organizationId: string,
	input:
		| {
				workspaceId: string;
				workpiece?: { kind: "gadget" | "output"; id: string };
		  }
		| undefined,
): Promise<Record<string, unknown> | null> {
	if (!input) return null;
	const workspace = await getOsWorkspace(db, {
		organizationId,
		workspaceId: input.workspaceId,
	});
	if (!workspace || workspace.status !== "active") {
		throw createError(ErrorCodes.NOT_FOUND, "Workspace not found");
	}
	if (!input.workpiece) {
		return { workspaceId: workspace.id, workspaceName: workspace.name };
	}
	if (input.workpiece.kind === "gadget") {
		const gadget = await getOsGadget(db, {
			organizationId,
			gadgetId: input.workpiece.id,
		});
		if (!gadget || gadget.workspaceId !== workspace.id) {
			throw createError(ErrorCodes.NOT_FOUND, "Workspace Gadget not found");
		}
		return {
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			workpiece: { kind: "gadget", id: gadget.id, name: gadget.name },
		};
	}
	const output = await getOsOutput(db, {
		organizationId,
		outputId: input.workpiece.id,
	});
	if (!output || output.workspaceId !== workspace.id) {
		throw createError(ErrorCodes.NOT_FOUND, "Workspace Output not found");
	}
	return {
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		workpiece: { kind: "output", id: output.id, name: output.title },
	};
}

export const enqueueMessageRoute = authed.enqueueMessage
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const enqueueStartedAtMs = Date.now();
		if (
			input.delegateToTediId &&
			(context.env as CloudflareEnv & { TEDIX_LOCAL_DEMO_ENABLED?: string })
				.TEDIX_LOCAL_DEMO_ENABLED === "true" &&
			isLocalDemoProject(context.env.DESCOPE_PROJECT_ID)
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This local installation does not run tedis. Send a Home message without delegateToTediId to draft or use local tools, or use Tedix Cloud for delegated worker tasks. Nothing was dispatched.",
			);
		}
		// Schema allows empty content so attachment-only sends (voice notes
		// record "" typed text) pass; a message still needs SOMETHING to act on.
		if (!input.content.trim() && !input.attachments?.length) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Message content or attachment required",
			);
		}
		// An operator slash command is a command the caller expected to RUN, not
		// prose for the planner. Routed as a message it becomes an objective and
		// mints a work item from the command text — which is how a `/retry <id>`
		// typed at the wrong surface created a bogus item titled after the
		// command (plus pasted terminal context) while the item it named stayed
		// blocked. Refuse it here so every text surface fails the same way
		// instead of each client registry drifting on its own.
		const operatorCommand = detectOperatorSlashCommand(input.content);
		if (operatorCommand) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				operatorSlashCommandRefusal(operatorCommand),
			);
		}
		const organizationId = resolveOrganizationId(context, input.organizationId);
		// An absent conversationId is caller-scoped, NOT the operator's durable
		// `home:main` thread — see defaultHomeConversationIdForCaller.
		const conversationId =
			input.conversationId ?? defaultHomeConversationIdForCaller(context);
		await ensureHomeConversationAccess(context, {
			conversationId,
			organizationId,
			required: "edit",
		});
		if (input.executionPolicy === "observe_only" && input.delegateToTediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"observe_only turns cannot explicitly delegate",
			);
		}
		if (input.executionPolicy === "observe_only" && input.attachments?.length) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"observe_only turns cannot include attachments",
			);
		}
		const runId = input.idempotencyKey ?? crypto.randomUUID();
		// A `/skill <slug>` reference that resolves to nothing would produce an
		// ordinary turn with a visible affordance that silently did nothing, and
		// bill an LLM call for it. Refuse HERE, after authorization, naming the
		// slug — the operator fixes a typo instead of wondering why the skill was
		// ignored. Reads nothing when the message references no skills.
		// (Planning re-checks the same predicate as the backstop for a skill
		// archived between this call and the turn; see the unresolved notice in
		// `serializeRetrievedSkills`.)
		const unresolvedSkills = await unresolvedSkillReferences(
			context.db,
			organizationId,
			input.content,
		);
		if (unresolvedSkills.length > 0) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`${unresolvedSkills.map((slug) => `"/skill ${slug}"`).join(", ")} did not resolve to a usable skill, so this message was NOT sent. A referenced skill must exist in this organization, be readable here (org-level and not private to one tedi), and be active, proven, or crystallized — a draft, stale, or archived skill cannot steer a turn. Remove the reference or correct the slug.`,
			);
		}
		const existingConversation = await getKernelConversation(context.db, {
			organizationId,
			conversationId,
		});
		if (
			input.workspaceContext &&
			existingConversation?.workspaceId &&
			existingConversation.workspaceId !== input.workspaceContext.workspaceId
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Conversation belongs to a different Workspace",
			);
		}
		const workspaceContext = await resolveWorkspaceContext(
			context.db,
			organizationId,
			input.workspaceContext ??
				(existingConversation?.workspaceId
					? { workspaceId: existingConversation.workspaceId }
					: undefined),
		);
		const selectedWorkspaceDocument = await authorizedWorkspaceDocumentContext(
			context,
			organizationId,
			workspaceContext,
		).catch((error) => {
			console.warn(
				"[kernelRuntime] selected workspace document context unavailable",
				errorMessage(error),
			);
			return null;
		});
		if (input.modelRef) {
			const { buildModelCatalogProjection } =
				await import("../../../services/model-catalog-projection");
			const catalog = await buildModelCatalogProjection({
				db: context.db,
				env: context.env,
				organizationId,
				tedi: null,
				includeDenied: true,
			});
			if (
				!catalog.models.some(
					(model) => model.ref === input.modelRef && model.allowed,
				)
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Selected model is not available for this organization",
				);
			}
		}
		const createdAt = nowIso();
		const assistantAt = offsetIso(createdAt, 1);
		const completedAt = offsetIso(createdAt, 2);
		const delegateTarget = input.delegateToTediId
			? await resolveKernelDelegateTarget(context, {
					delegateToTediId: input.delegateToTediId,
					organizationId,
				})
			: null;
		// "Workstations over bodies" (docs/decisions/workstations-over-bodies.md):
		// the workstation-attach path is gated on CAPABILITY, not body kind.
		// A target is workstation-capable when it carries a durable workstation
		// signal (a warm workstation_leases seat OR a configured coding repo).
		// A plain Agent-runtime tedi stays a raw delegation.
		// `isolateWorkstationWarm` is the lease-only sub-signal (NOT repoConfig):
		// it feeds the dispatch policy's no-spawn/wake low-risk gate for isolate
		// workstations, the isolate analogue of `runtimeStatus === "running"`.
		const targetCapability: {
			workstationCapable: boolean;
			isolateWorkstationWarm: boolean | null;
		} = delegateTarget
			? await (async () => {
					try {
						const capableIds = await getWorkstationCapableTediIds(
							context.db,
							organizationId,
						);
						const hasWorkstationLease = capableIds.has(delegateTarget.id);
						return {
							workstationCapable: deriveEmbodiedCapability({
								runtimeKind: delegateTarget.runtimeKind,
								repoConfig: delegateTarget.repoConfig,
								hasWorkstationLease,
							}),
							isolateWorkstationWarm: hasWorkstationLease,
						};
					} catch (error) {
						// Fail-soft: fall back to signal-free derivation and UNKNOWN warm-state.
						console.warn(
							"[kernelRuntime] workstation-capability read failed; degrading to body/repo signal",
							errorMessage(error),
						);
						return {
							workstationCapable: deriveEmbodiedCapability({
								runtimeKind: delegateTarget.runtimeKind,
								repoConfig: delegateTarget.repoConfig,
							}),
							isolateWorkstationWarm: null,
						};
					}
				})()
			: {
					workstationCapable: false,
					isolateWorkstationWarm: null,
				};
		const targetWorkstationCapable = targetCapability.workstationCapable;
		// Workstation attach is a function of (NEEDS × capability): an embodied tedi
		// whose ask doesn't need a body degrades to the raw isolate-delegate path.
		const explicitNeedsEmbodied = explicitDelegationNeedsEmbodiedSurface(
			input.metadata,
		);
		const workstationNeeded = targetWorkstationCapable && explicitNeedsEmbodied;
		// An embodied isolate routes through the WORKSTATION-ATTACH path (the
		// certified work-order + seat model) ONLY when the work needs the body;
		// otherwise it degrades to the native isolate-delegate path.
		const isolateDelegation = delegateTarget !== null && !workstationNeeded;
		const workstationAttach = Boolean(delegateTarget) && workstationNeeded;
		const userMessageId = `${runId}:input`;
		const assistantMessageId = `${runId}:assistant`;
		const delegateClientRequestId =
			isolateDelegation && input.delegateToTediId
				? `${runId}:delegate:${input.delegateToTediId}`
				: null;
		const childRunId =
			isolateDelegation && input.delegateToTediId && delegateClientRequestId
				? predictAgentRunId({
						clientRequestId: delegateClientRequestId,
						tediId: input.delegateToTediId,
					})
				: null;
		const approvalRequestId = workstationAttach
			? delegationWorkOrderApprovalRequestId(runId)
			: null;
		try {
			await claimKernelExecutionPolicy(context.db, {
				runId,
				organizationId,
				conversationId,
				idempotencyKey: input.idempotencyKey,
				delegatedTediId: input.delegateToTediId,
				executionPolicy: input.executionPolicy,
			});
		} catch {
			throw createError(
				ErrorCodes.CONFLICT,
				"This idempotency key is already bound to a different Home execution policy or identity",
			);
		}
		const metadata: Record<string, unknown> = {
			...nonNullRecord(input.metadata),
			...(workspaceContext ? { workspaceContext } : {}),
		};
		const { content: turnContent, voiceTranscript } =
			await resolveVoiceMessageContent({
				env: context.env as unknown as VoiceSttEnv,
				content: input.content,
				attachments: input.attachments,
				logContext: "kernelRuntime.enqueueMessage",
				transcribe: activeTranscribeAudio,
				gatewayMetadata: {
					orgId: organizationId,
					source: "voice-stt",
					usage: JSON.stringify({
						k: "voice_stt",
						u: "units",
						q: 1,
					}),
				},
			});
		const attachments = normalizeMessageAttachments(input.attachments);
		// Validate private handles before persisting a turn; bytes stay in R2.
		await resolveHomeAttachments(
			context.env.TEDI_R2_BUCKET,
			organizationId,
			attachments,
		);
		const turnMetadata = voiceTranscript
			? {
					...metadata,
					voiceTranscript,
				}
			: metadata;
		const kernelCorrection = await buildKernelCorrectionSignal(context, {
			createdAt,
			metadata,
			organizationId,
		});
		const planBuilt =
			!input.delegateToTediId && input.executionPolicy !== "observe_only"
				? await maybeBuildHomePlan({
						content: turnContent,
						context,
						createdAt,
						organizationId,
						runId,
						objectiveId: stringFromPayload(metadata.objectiveId),
					})
				: null;
		const homePlan = planBuilt?.plan ?? null;
		const kernelPlanUsage = planBuilt?.usage ?? null;
		// Governance policy: read once per turn for the org (fail-soft — null
		// when no active policy pack exists). Used for approval TTL and fan-out
		// cap; defaults apply when absent.
		const governancePolicy = await readOrgGovernancePolicy(
			context,
			organizationId,
		);
		const sessionWriteAllowlist = await readSessionWriteAllowlist(context, {
			organizationId,
			conversationId,
		});
		// Kernel turns are persisted BEFORE the kernel runs and the kernel work
		// is registered with `context.waitUntil` (see `turnWork` below): a
		// caller that disconnects mid-kernel (e.g. an MCP client's inner
		// timeout) must not cancel the route decision or lose the turn.
		const kernelEligible = !input.delegateToTediId && !homePlan;
		// Home-initiated workstation attachment security model (policy-gated):
		// classify the workstation adapter dispatch. LOW risk =
		// explicit human delegation by an authenticated operator to an
		// already-RUNNING workstation adapter (no spawn/wake) → the work-order approval is
		// auto-resolved by policy (audit row retained). Anything else keeps the
		// human approval card. Certified dispatch is preserved either way — this
		// gates only the human-approval click, never body certification.
		const dispatchPolicy = workstationAttach
			? classifyWorkstationDispatch({
					explicitHumanDelegation: Boolean(input.delegateToTediId),
					hasActingUser: Boolean(context.descopeUserId ?? context.user?.sub),
					runtimeRunning:
						delegateTarget?.runtimeStatus === "running"
							? true
							: delegateTarget?.runtimeStatus
								? false
								: null,
					// A warm workstation_leases seat means dispatch attaches to an
					// already-available workstation (no spawn/wake), so it is eligible
					// for the low-risk auto path. `null` means an unknown/failed lease
					// read and fails closed to approval.
					isolateWorkstationWarm: targetCapability.isolateWorkstationWarm,
					// The kernel only runs when there is NO explicit delegation, and
					// workstationAttach requires one — so a kernel route risk never
					// exists on this path (was `kernelResult?.route?.risk ?? null`,
					// which was always null here).
					routeRisk: null,
				})
			: null;
		const autoApprovedAttach = dispatchPolicy?.autoDispatch === true;
		// A policy auto-approved workstation attachment is
		// dispatched immediately only when the workstation auto-dispatch switch
		// is armed. The switch gates workstation delivery, not Kernel→tedi
		// delegate_tedi auto-dispatch.
		const workstationAutoDispatchEnabled =
			(
				context.env as {
					WORKSTATION_AUTO_DISPATCH_ENABLED?: string;
				}
			).WORKSTATION_AUTO_DISPATCH_ENABLED === "true";
		const workstationDispatchNow =
			autoApprovedAttach && workstationAutoDispatchEnabled;
		const requestedDelegationWorkItemId = input.delegateToTediId
			? stringFromPayload(metadata.workItemId)
			: undefined;
		const workstationIdentity =
			workstationAttach && delegateTarget
				? workstationDispatchIdentity({
						homeRunId: runId,
						target: delegateTarget,
					})
				: null;
		const workstationChildRunId = workstationIdentity?.deliveryKey ?? null;
		if (workstationIdentity && requestedDelegationWorkItemId)
			await inspectWorkstationDispatchAdmission(context, {
				organizationId,
				workItemId: requestedDelegationWorkItemId,
				targetTediId: delegateTarget!.id,
				runtimeRunId: workstationIdentity.runtimeRunId,
				now: createdAt,
			});
		const requestedWorkItem = requestedDelegationWorkItemId
			? await getWorkItemById(
					context.db,
					requestedDelegationWorkItemId,
					organizationId,
				)
			: null;
		const requestedExecutionRequirement = requestedWorkItem
			? ExecutionRequirementSchema.safeParse(
					requestedWorkItem.metadata?.executionRequirement,
				)
			: null;
		const directExecutionRequirement: ExecutionRequirement = workstationAttach
			? requestedExecutionRequirement?.success &&
				requestedExecutionRequirement.data.surface === "workstation"
				? requestedExecutionRequirement.data
				: {
						surface: "workstation",
						requiredCapabilities: ["process"],
						fallbackSurface: null,
						prohibitedSurfaces: [],
						satisfiable: true,
						reason:
							"the operator explicitly requested an interactive workstation attachment",
					}
			: {
					surface: "native",
					requiredCapabilities: [],
					fallbackSurface: "workstation",
					prohibitedSurfaces: [],
					satisfiable: true,
					reason:
						"the operator explicitly selected the Agent-runtime delegation surface",
				};
		// Work-Item auto-tracking (HYBRID, step 1): eager-create + claim the
		// Work Item for a DIRECT delegation, keyed to the child run id. Only the
		// direct isolate-delegate branch — the plan path (homePlan != null) is
		// owned by approvePlanAssignments, which the `!homePlan` guard separates
		// from this. Auto-created tracking is fail-soft; an explicit canonical
		// item request is checked below and fails closed before dispatch.
		const delegationWorkItemId =
			input.delegateToTediId &&
			!homePlan &&
			(isolateDelegation ? childRunId : workstationChildRunId)
				? await createDelegationWorkItem(context, {
						assigneeTediId: input.delegateToTediId,
						childRunId: (isolateDelegation
							? childRunId
							: workstationIdentity?.runtimeRunId)!,
						content: turnContent,
						conversationId,
						createdAt,
						executionRequirement: directExecutionRequirement,
						homeRunId: runId,
						organizationId,
						objectiveId: stringFromPayload(metadata.objectiveId),
						workItemId: requestedDelegationWorkItemId,
					})
				: null;
		if (requestedDelegationWorkItemId && !delegationWorkItemId) {
			throw createError(
				ErrorCodes.CONFLICT,
				`Work Item ${requestedDelegationWorkItemId} is unavailable for this delegation`,
			);
		}
		const runtimeMetadata = {
			source: "kernelRuntime.enqueueMessage",
			subject: "home",
			executionPolicy: input.executionPolicy,
			executionRequirement: directExecutionRequirement,
			// Step 2 — linkage: stamp the Work Item id so reconcile can resolve it
			// from the run/runtime metadata fast path (fallback = sourceIntentId).
			...(delegationWorkItemId
				? {
						workItemId: delegationWorkItemId,
					}
				: {}),
			delegation: workstationAttach
				? "workstation_attach"
				: input.delegateToTediId
					? "explicit"
					: homePlan
						? "planned"
						: "none",
			childRunId,
			homePlanId: homePlan?.id,
			...(workstationAttach && autoApprovedAttach
				? {
						dispatch: workstationDispatchNow
							? "certified-workstation-attach-initiated"
							: "certified-workstation-attach-pending",
					}
				: {}),
			...metadata,
			...(kernelCorrection
				? {
						kernelCorrection,
					}
				: {}),
		};
		const directDelegationWorkOrder =
			isolateDelegation && input.delegateToTediId
				? buildDelegationWorkOrder({
						route: {
							routeKind: "delegate_tedi",
							rationale: "Operator-directed delegation",
							risk: "low",
							confidence: 1,
							effortClass: "embodied",
							answer: null,
							targetTediId: input.delegateToTediId,
							targetTediLabel: delegateTarget?.slug ?? "the selected tedi",
							targetActivityId: null,
							plannedToolIds: [],
							toolIntent: null,
							workflowHint: null,
							clarifyingQuestion: null,
							evidenceExpectation: null,
						},
						card: null,
						userContent: turnContent,
						executionRequirement: directExecutionRequirement,
						verifyCommand: input.verifyCommand ?? null,
						// `tedix ask --require-code-proof` rides in as turn metadata; it
						// is the coding signal for the coding tool guidance.
						requiredProofKind:
							metadata.requiredProofKind === "code" ? "code" : null,
					})
				: null;
		const delegationWorkOrderBase =
			workstationAttach && input.delegateToTediId && approvalRequestId
				? workstationAttachWorkOrder({
						approvalRequestId,
						content: turnContent,
						delegateToTediId: input.delegateToTediId,
						runId,
						workItemId: delegationWorkItemId,
						verifyCommand: input.verifyCommand ?? null,
						executionRequirement: directExecutionRequirement,
					})
				: directDelegationWorkOrder;
		// Auto-approved attachments land in the SAME state the human-approve path
		// produces (resolveDelegationWorkOrder): work order waiting certified
		// dispatch, run queued.
		const delegationWorkOrder = delegationWorkOrderBase
			? autoApprovedAttach
				? {
						...delegationWorkOrderBase,
						status: "approved_waiting_certified_dispatch",
					}
				: delegationWorkOrderBase
			: null;
		const initialRunStatus = workstationAttach
			? autoApprovedAttach
				? "queued"
				: "requires_approval"
			: input.delegateToTediId
				? "queued"
				: kernelEligible
					? // Persisted before the kernel runs; patched to "completed" (with
						// kernelRoute/kernelEvidence) by the protected kernel work below.
						"running"
					: "completed";
		// Operator-directed delegation (`input.delegateToTediId` set) never runs
		// the kernel route planner (`kernelEligible = !delegateToTediId`), and the
		// only route writer-back is gated `WHERE status="running"` — but a directed
		// run is `queued`, so its `kernelRoute` would stay null forever and the Tedix OS
		// rail decision chip would never render. Synthesize the route the operator's
		// explicit choice implies (full-confidence delegate, `source:"explicit"`).
		// MUST stay gated on `delegateToTediId`: the shared insert below is also hit
		// by kernel-eligible `running` turns (route written later) and
		// `homePlan`/`completed` turns (no route) — an unconditional stamp would
		// forge a route on those.
		const directedKernelRoute = input.delegateToTediId
			? {
					routeKind: "delegate_tedi",
					source: "explicit",
					confidence: 1,
					risk: "low",
					rationale: "Operator-directed delegation",
				}
			: null;
		// Shared run-row metadata; `kernelRoute`/`kernelEvidence` are added at the
		// use sites (null at insert time, kernel results in the completion
		// patch).
		const runRowMetadata = {
			source: "kernelRuntime.enqueueMessage",
			contentLength: turnContent.length,
			attachmentCount: attachments?.length ?? 0,
			idempotencyKey: runId,
			executionPolicy: input.executionPolicy,
			approvalRequestId,
			childConversationId: isolateDelegation ? "agent:main:main" : null,
			childRunId,
			...(delegationWorkItemId
				? {
						workItemId: delegationWorkItemId,
					}
				: {}),
			delegatedTediId: input.delegateToTediId ?? null,
			delegationWorkOrder,
			homePlan,
			...(kernelPlanUsage
				? {
						kernelPlanUsage,
					}
				: {}),
			homeDispatchPolicy: dispatchPolicy,
			...(kernelCorrection
				? {
						kernelCorrection,
					}
				: {}),
			// Re-drive stamp: the request-context input needed to RE-RUN this
			// routing turn if the org KernelDO is evicted before it routes (the
			// inline turn is wrap-or-lose). reconcileStaleSubmissions →
			// decideKernelRedrive reads this to re-schedule runPlannerStep for a
			// provably pre-side-effect crash. EXCLUDES runRowMetadata itself (no
			// recursion); runRowMetadata is reconstructed from the row at re-drive.
			redriveInput: {
				selectedWorkspaceDocument,
				executionPolicy: input.executionPolicy,
				attachments,
				organizationId,
				conversationId,
				runId,
				userMessageId,
				assistantMessageId,
				content: turnContent,
				...(input.modelRef ? { modelRef: input.modelRef } : {}),
				descopeUserId: context.descopeUserId ?? context.user?.sub,
				createdAt,
				assistantAt,
				completedAt,
				approvalRequestId,
				delegationWorkOrder,
				homePlan,
				runtimeMetadata,
				governancePolicy,
				sessionWriteAllowlist,
			},
		};
		try {
			const priorCause = await existingRunStartedCause(context, {
				organizationId,
				conversationId,
				runId,
				messageId: userMessageId,
			});
			const inputEvent = await insertKernelRuntimeEvent(context, {
				organizationId,
				kind: "message.received",
				conversationId,
				runId,
				messageId: userMessageId,
				delegatedTediId: input.delegateToTediId,
				childRunId: childRunId ?? undefined,
				payload: {
					role: "user",
					content: turnContent,
					attachments,
					channel: "home",
					metadata: turnMetadata,
				},
				runtimeMetadata,
				createdAt,
			});
			await insertKernelRuntimeEvent(context, {
				organizationId,
				kind: "run.started",
				conversationId,
				runId,
				messageId: userMessageId,
				causeEventId: priorCause === undefined ? inputEvent.id : priorCause,
				delegatedTediId: input.delegateToTediId,
				childRunId: childRunId ?? undefined,
				payload: {
					status: workstationAttach
						? autoApprovedAttach
							? "queued"
							: "requires_approval"
						: input.delegateToTediId
							? "queued"
							: "needs_delegation",
					inputMessageId: userMessageId,
				},
				runtimeMetadata,
				createdAt,
			});
			await insertKernelRuntimeRun(context, {
				id: runId,
				organizationId,
				conversationId,
				status: initialRunStatus,
				inputMessageId: userMessageId,
				outputMessageId: assistantMessageId,
				delegatedTediId: input.delegateToTediId,
				childRunId: childRunId ?? undefined,
				childConversationId: isolateDelegation ? "agent:main:main" : null,
				progress: homeRunProgress({
					eventCount: 0,
					status: initialRunStatus,
				}),
				metadata: {
					...runRowMetadata,
					kernelRoute: directedKernelRoute,
					kernelEvidence: null,
				},
				runtimeMetadata,
				startedAt: createdAt,
				completedAt:
					input.delegateToTediId || workstationAttach || kernelEligible
						? null
						: completedAt,
				createdAt,
				updatedAt:
					input.delegateToTediId || workstationAttach || kernelEligible
						? createdAt
						: completedAt,
			});
			if (kernelCorrection) {
				await insertKernelRuntimeEvent(context, {
					id: homeRuntimeEventId({
						organizationId,
						kind: "decision.recorded",
						conversationId,
						runId,
						suffix: "kernel-route-correction",
					}),
					organizationId,
					kind: "decision.recorded",
					conversationId,
					runId,
					payload: kernelCorrection,
					runtimeMetadata: {
						source: "kernelRuntime.enqueueMessage",
						signal: "kernel.route_corrected",
						priorRunId: kernelCorrection.priorRunId,
						priorRunFound: kernelCorrection.priorRunFound,
					},
					createdAt,
				});
			}
			if (
				workstationAttach &&
				input.delegateToTediId &&
				approvalRequestId &&
				delegationWorkOrder
			) {
				await ensureWorkstationAttachApprovalRequest(context, {
					approvalRequestId,
					content: turnContent,
					conversationId,
					createdAt,
					delegateToTediId: input.delegateToTediId,
					organizationId,
					runId,
					workOrder: delegationWorkOrder,
					ttlHours: resolveApprovalTtlHours(governancePolicy),
				});
				if (autoApprovedAttach) {
					// Policy auto-approval: the approval ROW is still created above
					// (full audit trail), then resolved by the dispatch policy instead
					// of a human click. Only updates while status="pending", so an
					// already-resolved (idempotent re-enqueue) approval is untouched.
					await resolveApprovalRequest(context.db, approvalRequestId, {
						status: "approved",
						resolvedBy: "home-dispatch-policy",
						resolution: `auto-approved (low risk): ${dispatchPolicy?.reasons.join("; ") ?? "policy conditions met"}`,
					});
				}
			}
		} catch (error) {
			if (isMissingKernelRuntimeTable(error)) {
				const message =
					"kernel runtime storage is not migrated yet; apply the kernel_runtime_events D1 migration before enabling live Home sends.";
				return {
					idempotencyKey: runId,
					conversationId,
					status: "failed",
					run: failedKernelRun({
						organizationId,
						conversationId,
						idempotencyKey: runId,
						error: message,
					}),
					error: message,
				};
			}
			if (isMissingKernelRuntimeRunsTable(error)) {
				const message =
					"Home run-set storage is not migrated yet; apply the kernel_runtime_runs D1 migration before enabling durable Home work cards.";
				return {
					idempotencyKey: runId,
					conversationId,
					status: "failed",
					run: failedKernelRun({
						organizationId,
						conversationId,
						idempotencyKey: runId,
						error: message,
					}),
					error: message,
				};
			}
			throw error;
		}

		// ── Certified workstation adapter dispatch for the policy
		// auto-approved attachment (workstation switch on + low-risk classification).
		// Mirrors the isolate delegate-dispatch pattern below: background via
		// waitUntil when available (the receipt stays fast and a disconnecting
		// caller cannot cancel delivery), else await. Failure is recorded by
		// the dispatch module through the shared dispatch-failure path; success
		// stamps childRunId + runtimeMetadata.dispatch="workstation-dispatched"
		// so run-set reconciliation supervises the child to completion.
		if (
			workstationDispatchNow &&
			input.delegateToTediId &&
			delegationWorkOrder
		) {
			const dispatchWork = runWorkstationWorkOrderDispatch(context, {
				content: turnContent,
				conversationId,
				delegateToTediId: input.delegateToTediId,
				existingMetadata: {
					...runRowMetadata,
					kernelRoute: directedKernelRoute,
					kernelEvidence: null,
				},
				existingRuntimeMetadata: runtimeMetadata,
				organizationId,
				runId,
				trigger: "policy-auto-approval",
				userMessageId,
				workItemId: delegationWorkItemId,
				workOrder: delegationWorkOrder,
			}).catch((error) => {
				console.warn(
					"[kernelRuntime.enqueueMessage] workstation work order dispatch failed",
					errorMessage(error),
				);
				return null;
			});
			if (context.waitUntil) {
				context.waitUntil(dispatchWork);
			} else {
				await dispatchWork;
			}
		}

		// ── Kernel path (no delegation, no plan). The route decision, direct
		// read, completion patch, and transcript events live in
		// `runKernelTurnWork` (kernel/turn-work.ts) and run in ONE of two
		// mutually exclusive execution contexts per turn:
		//
		//   1. KernelDO (preferred when the KERNEL binding exists):
		//      the org-scoped Durable Object runs the turn in ITS OWN execution
		//      context, so a caller that disconnects mid-kernel cannot cancel
		//      the route decision or lose the turn — no waitUntil grace limit.
		//   2. Inline (legacy / DO-error fallback): the promise is BOTH awaited
		//      (fast callers still get the synchronous answer) and registered
		//      with `waitUntil` so a disconnecting caller doesn't cancel it.
		//
		// Persist-first inserts above stay HERE in both cases — the turn input
		// carries runId/message ids, so the DO never double-inserts.
		if (kernelEligible) {
			const turnInput: KernelTurnWorkInput = {
				selectedWorkspaceDocument,
				executionPolicy: input.executionPolicy,
				attachments,
				modelRef: input.modelRef,
				organizationId,
				conversationId,
				// The edge runs the latest deployed version; hand it to the DO so a
				// continuously-active (never-hibernating) KernelDO self-restarts onto
				// current code instead of needing a rename migration.
				callerVersionId: (
					context.env as {
						CF_VERSION_METADATA?: {
							id?: string;
						};
					}
				).CF_VERSION_METADATA?.id,
				runId,
				userMessageId,
				assistantMessageId,
				content: turnContent,
				// Preserve the authenticated actor for org context and authority
				// assembly in the pure routing pass.
				descopeUserId: context.descopeUserId ?? context.user?.sub,
				createdAt,
				assistantAt,
				completedAt,
				approvalRequestId,
				delegationWorkOrder,
				homePlan,
				runRowMetadata,
				runtimeMetadata,
				governancePolicy,
				sessionWriteAllowlist,
			};
			const kernel = (
				context.env as {
					KERNEL?: DurableObjectNamespace<KernelDO>;
				}
			).KERNEL;
			if (kernel) {
				let doTurn: Promise<KernelTurnWorkResult> | null = null;
				try {
					const stub = kernel.get(kernel.idFromName(organizationId));
					doTurn = Promise.resolve(stub.processTurn(turnInput)).then(
						(result) => result as unknown as KernelTurnWorkResult,
					);
				} catch (error) {
					// Synchronous DO failure (binding misconfig, idFromName/get throw)
					// falls back to today's inline behavior below.
					console.warn(
						"[kernelRuntime] kernel DO turn failed — falling back to inline turn work",
						errorMessage(error),
					);
				}
				if (doTurn) {
					// Hybrid soft-deadline response contract (docs/product/tedix-os.md "Kernel
					// Runtime Decision"): race the DO turn against the soft deadline
					// ONCE. The settled-union shape makes the pre/post-deadline error
					// distinction structural:
					//
					//   - "result" before the deadline → return it verbatim (fast
					//     turns unchanged).
					//   - "error" before the deadline → fall through to the inline
					//     path (today's fail-soft retry; the turn body is idempotent
					//     across the seam: deterministic event ids +
					//     onConflictDoNothing inserts + conditional running→terminal
					//     completion patch).
					//   - "deadline" → return the ack below and NEVER reach the
					//     inline path again: the DO keeps running the turn in its own
					//     execution context (live-proven detachment), so a LATE error
					//     resolves an already-raced promise nobody reads — it cannot
					//     trigger an inline re-run and the turn may have partially
					//     completed under the DO anyway. The ack already told the
					//     caller to poll (task.id = run.id).
					type KernelTurnOutcome =
						| {
								kind: "result";
								result: KernelTurnWorkResult;
						  }
						| {
								kind: "error";
								error: unknown;
						  }
						| {
								kind: "deadline";
						  };
					const settled: Promise<KernelTurnOutcome> = doTurn.then(
						(result) => ({
							kind: "result" as const,
							result,
						}),
						(error) => ({
							kind: "error" as const,
							error,
						}),
					);
					let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
					const remainingBudgetMs = remainingKernelTurnBudgetMs(
						enqueueStartedAtMs,
						Date.now(),
					);
					const deadline = new Promise<KernelTurnOutcome>((resolve) => {
						deadlineTimer = setTimeout(
							() =>
								resolve({
									kind: "deadline",
								}),
							remainingBudgetMs,
						);
					});
					const outcome = await Promise.race([settled, deadline]);
					clearTimeout(deadlineTimer);
					// Non-blocking planner (kernel-do.ts KERNEL_ASYNC_DISPATCH_MARKER,
					// flag-gated default OFF): the async planner makes `processTurn` resolve
					// FAST with a sentinel meaning it scheduled the planner off the DO thread
					// instead of running it inline. Treat it exactly like the soft-deadline
					// ack — the run row is durable persist-first and the answer is polled via
					// task.id. The literal mirrors kernel-do's marker (kernel-do imports from
					// this file, so a value import back would be a cycle).
					const asyncDispatched =
						outcome.kind === "result" &&
						(outcome.result as Record<string, unknown>)
							.kernelAsyncDispatched === true;
					if (outcome.kind === "result" && !asyncDispatched) {
						return await ensureKernelHarnessStampOnResult(
							context,
							outcome.result,
						);
					}
					if (outcome.kind === "deadline" || asyncDispatched) {
						// Detach ONLY on the genuine soft-deadline: the async-dispatch sentinel
						// means `doTurn` already resolved (the planner runs in the DO alarm, not
						// in this promise), so there is nothing to dangle. On a real deadline a
						// late rejection must never surface as unhandled, and `waitUntil` keeps
						// the caller context from cancelling the in-flight RPC await.
						if (outcome.kind === "deadline") {
							const dangling = doTurn.then(
								() => undefined,
								() => undefined,
							);
							if (context.waitUntil) {
								context.waitUntil(dangling);
							}
						}
						// Ack built from the persist-first data already durable above:
						// the run row was inserted with status "running" and
						// kernelRoute/kernelEvidence null — the DO patches both when the
						// turn completes. The top-level contract status enum has no
						// "running" (queued | failed | needs_delegation |
						// requires_approval), so "queued" is the closest allowed value:
						// the turn is accepted and still executing under the DO.
						// `assistantMessage` is intentionally omitted (optional in
						// EnqueueHomeMessageOutputSchema; the missing-table error paths
						// already return without it) — the kernel's answer does not
						// exist yet. Callers recover the outcome via the MCP tasks
						// extension: the task linkage keys on `run.id` (apps/mcp
						// handler.ts `_emitTaskLinkage`), so the ack MUST carry the
						// real run id.
						return {
							idempotencyKey: runId,
							conversationId,
							status: "queued" as const,
							run: {
								id: runId,
								organizationId,
								conversationId,
								status: "running",
								inputMessageId: userMessageId,
								outputMessageId: assistantMessageId,
								delegatedTediId: null,
								childRunId: null,
								runtime: {
									backend: KERNEL_RUNTIME_BACKEND,
									externalId: runId,
									metadata: runtimeMetadata,
								},
								startedAt: createdAt,
								completedAt: null,
								createdAt,
								updatedAt: createdAt,
								metadata: {
									...runRowMetadata,
									kernelRoute: null,
									kernelEvidence: null,
								},
								progress: homeRunProgress({
									eventCount: 0,
									status: "running",
								}),
							} satisfies HomeRun,
							homePlan: undefined,
							assistantMessage: undefined,
							error: undefined,
						};
					}
					// Pre-deadline DO error → today's inline fail-soft path below.
					// (Explicit `error` guard: the `result && !asyncDispatched` and
					// `deadline || asyncDispatched` returns above leave only the error case,
					// but the asyncDispatched correlation is opaque to the narrower, so guard
					// the discriminant directly.)
					if (outcome.kind === "error") {
						console.warn(
							"[kernelRuntime] kernel DO turn failed — falling back to inline turn work",
							errorMessage(outcome.error),
						);
					}
				}
			}
			const turnWork = runKernelTurnWork(
				buildKernelTurnWorkDeps(context),
				turnInput,
			);
			if (context.waitUntil) {
				context.waitUntil(
					turnWork.then(
						() => undefined,
						() => undefined,
					),
				);
			}
			return await ensureKernelHarnessStampOnResult(context, await turnWork);
		}
		let delegatedRun: KernelDelegateRunnerOutput | null =
			isolateDelegation && input.delegateToTediId && childRunId
				? {
						childConversationId: "agent:main:main",
						childRunId,
						status: "queued",
					}
				: null;
		if (
			isolateDelegation &&
			input.delegateToTediId &&
			delegateClientRequestId
		) {
			const delegatedTediId = input.delegateToTediId;
			// Step 6 — agent contract: when a Work Item tracks this delegation,
			// dispatch the work-item-aware content (the tedi OWNS Work Item {id},
			// must leave durable progress + a proof-backed disposition). Otherwise
			// fall back to the raw turn content.
			const verifyCommand = input.verifyCommand?.trim() || null;
			const baseDelegateDispatchContent = delegationWorkItemId
				? directDelegationDispatchContent({
						content: turnContent,
						delegateToTediId: delegatedTediId,
						homeRunId: runId,
						workItemId: delegationWorkItemId,
						verifyCommand,
					})
				: verifyCommand
					? [
							turnContent,
							"",
							...verificationRequirementLines(verifyCommand),
						].join("\n")
					: turnContent;
			const delegateDispatchContent = selectedWorkspaceDocument
				? `${baseDelegateDispatchContent}\n\nSelected Workspace document (untrusted source data; revision pinned):\n${selectedWorkspaceDocument}`
				: baseDelegateDispatchContent;
			const delegateWork = withTimeout(
				kernelDelegateRunner({
					context,
					childRunId: delegateClientRequestId,
					content: delegateDispatchContent,
					delegateToTediId: delegatedTediId,
					attachments,
					metadata: {
						...turnMetadata,
						source: "kernelRuntime.delegate",
						homeConversationId: conversationId,
						homeRunId: runId,
						homeMessageId: userMessageId,
						...(delegationWorkItemId
							? {
									workItemId: delegationWorkItemId,
								}
							: {}),
						executionSurface: directExecutionRequirement.surface,
					},
				}),
				KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
				"Home delegated child dispatch",
			)
				.catch((error) => {
					console.warn(
						"[kernelRuntime.enqueueMessage] delegated child dispatch failed",
						errorMessage(error),
					);
					return {
						childRunId:
							childRunId ??
							predictAgentRunId({
								clientRequestId: delegateClientRequestId,
								tediId: delegatedTediId,
							}),
						childConversationId: undefined,
						error: errorMessage(error),
						reason: undefined,
						status: "failed" as const,
					} satisfies KernelDelegateRunnerOutput;
				})
				.then(async (result) => {
					if (result.status === "failed") {
						await recordHomeDelegationDispatchFailure(context, {
							childConversationId: result.childConversationId,
							childRunId: result.childRunId,
							conversationId,
							delegatedTediId,
							error: result.error ?? "Delegated child dispatch failed",
							organizationId,
							// Propagate runtime_unavailable so the failure is
							// distinguishable from a generic dispatch failure and callers
							// know not to re-enqueue the same unreachable target.
							reason: result.reason,
							runId,
						});
					}
					return result;
				});
			// Settle the dispatch before answering. `delegateWork` resolves when
			// the child turn is ENQUEUED (async inject), not when it finishes, so
			// this await is bounded by KERNEL_DELEGATE_ENQUEUE_BUDGET_MS — the same
			// posture as every other kernelDelegateRunner call site. Deferring it to
			// waitUntil meant an isolate eviction (a deploy rollout)
			// took the inject, the ledger seed-writes AND the failure recorder with
			// it, while the operator was told the work had been delegated.
			delegatedRun = await delegateWork;
		}
		const delegationFailed = delegatedRun?.status === "failed";
		const outputStatus = delegationFailed
			? "failed"
			: workstationAttach
				? autoApprovedAttach
					? "queued"
					: "requires_approval"
				: input.delegateToTediId
					? "queued"
					: "needs_delegation";
		const assistantContent = delegationFailed
			? `I recorded this Home turn, but delegated execution failed: ${delegatedRun?.error ?? "unknown error"}`
			: workstationAttach
				? autoApprovedAttach
					? workstationDispatchNow
						? "Low-risk workstation attachment auto-approved and dispatched to the workstation-backed tedi — progress will stream into this work card."
						: "Low-risk workstation attachment: the dispatch policy auto-approved this workstation work order (explicit delegation to a running workstation adapter). It is queued for certified dispatch."
					: "I drafted a workstation attachment work order. It is not dispatched yet; the selected workstation adapter needs the certified attachment path with progress events, timeout semantics, and commit/ack."
				: input.delegateToTediId
					? "I delegated this Home turn to the selected tedi and linked the child run back to Home."
					: homePlan
						? kernelPlanAssistantContent(homePlan)
						: // Structurally unreachable: kernel-eligible turns (no
							// delegateToTediId, no homePlan) return above via the LLM
							// route. Deterministic honest fallback only — not a heuristic.
							"This turn was recorded in the Home thread.";
		const assistantEvent = await insertKernelRuntimeEvent(context, {
			organizationId,
			kind: "message.completed",
			conversationId,
			runId,
			messageId: assistantMessageId,
			delegatedTediId: input.delegateToTediId,
			childRunId:
				delegatedRun?.childRunId ??
				childRunId ??
				workstationChildRunId ??
				undefined,
			payload: {
				role: "assistant",
				content: assistantContent,
				channel: "home",
				metadata: {
					homeSubject: true,
					approvalRequestId,
					delegatedTediId: input.delegateToTediId ?? null,
					childConversationId: delegatedRun?.childConversationId ?? null,
					childRunId:
						delegatedRun?.childRunId ?? childRunId ?? workstationChildRunId,
					delegationError: delegatedRun?.error ?? null,
					delegationWorkOrder,
					homePlan,
				},
			},
			runtimeMetadata: {
				...runtimeMetadata,
				childConversationId: delegatedRun?.childConversationId,
				delegationStatus: delegatedRun?.status,
				delegationError: delegatedRun?.error,
				delegationWorkOrder,
				homePlanId: homePlan?.id,
			},
			createdAt: assistantAt,
		});
		if (homePlan) {
			await insertKernelRuntimeEvent(context, {
				organizationId,
				kind: "decision.recorded",
				conversationId,
				runId,
				messageId: assistantMessageId,
				payload: {
					status: "proposed",
					action: "home.plan.proposed",
					homePlan,
					attentionRoutes: homePlan.attentionRoutes,
				},
				runtimeMetadata: {
					...runtimeMetadata,
					homePlanId: homePlan.id,
					source: homePlan.source,
				},
				createdAt: offsetIso(createdAt, 1.5),
			});
		}
		const terminalEvent = await insertKernelRuntimeEvent(context, {
			organizationId,
			kind: delegationFailed
				? "run.failed"
				: workstationAttach
					? autoApprovedAttach
						? "approval.resolved"
						: "approval.requested"
					: "run.completed",
			conversationId,
			runId,
			messageId: assistantMessageId,
			delegatedTediId: input.delegateToTediId,
			childRunId:
				delegatedRun?.childRunId ??
				childRunId ??
				workstationChildRunId ??
				undefined,
			payload: {
				status: outputStatus,
				approvalRequestId,
				inputMessageId: userMessageId,
				outputMessageId: assistantMessageId,
				childConversationId: delegatedRun?.childConversationId ?? null,
				childRunId:
					delegatedRun?.childRunId ?? childRunId ?? workstationChildRunId,
				error: delegatedRun?.error ?? null,
				delegationWorkOrder,
				homePlan,
			},
			runtimeMetadata: {
				...runtimeMetadata,
				childConversationId: delegatedRun?.childConversationId,
				delegationStatus: delegatedRun?.status,
				delegationError: delegatedRun?.error,
				delegationWorkOrder,
				homePlanId: homePlan?.id,
			},
			createdAt: completedAt,
		});
		// Conversation auto-title: this branch (explicit delegateToTediId /
		// workstation attach / home-plan) bypasses runKernelTurnWork entirely
		// and settles its own terminal event above, so it must dispatch the
		// SAME title generation runKernelTurnWork's settle path does —
		// otherwise a conversation whose FIRST turn happens to delegate
		// (e.g. `tedix tedi <target> ask "..."`) could never title itself.
		// Skipped on delegationFailed (no productive exchange to summarize);
		// unconditional on approval status, mirroring turn-work.ts (a
		// requires_approval turn still gets a real first-exchange title).
		if (!delegationFailed) {
			const titleWork = generateAndPersistHomeConversationTitle(context, {
				organizationId,
				conversationId,
				runId,
				userContent: turnContent,
				assistantContent,
			});
			if (context.waitUntil) {
				context.waitUntil(titleWork);
			} else {
				await titleWork;
			}
		}
		if (workstationAttach && input.delegateToTediId && workstationChildRunId) {
			const traceWork = recordWorkstationAttachKernelTraceBundle(context, {
				approvalRequestId,
				assistantContent,
				assistantEvent,
				autoApprovedAttach,
				childRunId: workstationChildRunId,
				completedAt,
				conversationId,
				delegatedTediId: input.delegateToTediId,
				dispatchPolicy: dispatchPolicy
					? (dispatchPolicy as unknown as Record<string, unknown>)
					: null,
				organizationId,
				runId,
				startedAt: createdAt,
				terminalEvent,
				workItemId: delegationWorkItemId,
				workstationDispatchNow,
			});
			if (context.waitUntil) {
				context.waitUntil(traceWork);
			} else {
				await traceWork;
			}
		}

		// Durable submission ledger: settle the plan-path run exactly-once in-band.
		// Normal kernel turns settle in turn-work.ts; delegation/workstation runs
		// stay in-flight (queued/requires_approval) and are settled by reconciliation
		// or a later turn. Plan-producing turns complete immediately (status="completed"
		// or "failed") but were admitted by insertKernelRuntimeRun above and bypassed
		// turn-work entirely, leaving the submission stuck at "running" until the
		// kernel-do reconciliation sweep. settleKernelSubmission is idempotent
		// (exactly-once conditional UPDATE) so a late reconciliation sweep is safe.
		// Fail-soft: a ledger error MUST NOT break the turn.
		{
			const planRunStatus: TediRunStatus = delegationFailed
				? "failed"
				: workstationAttach || input.delegateToTediId
					? "queued"
					: "completed";
			const planSubmissionOutcome =
				kernelRunStatusToSubmissionOutcome(planRunStatus);
			if (planSubmissionOutcome) {
				const planSettle = settleKernelSubmission(context.db, {
					runId,
					organizationId,
					conversationId,
					outcome: planSubmissionOutcome,
				}).catch(() => {});
				if (context.waitUntil) {
					context.waitUntil(planSettle);
				} else {
					await planSettle;
				}
			}
		}
		const run: HomeRun = {
			id: runId,
			organizationId,
			conversationId,
			status: delegationFailed
				? "failed"
				: workstationAttach
					? autoApprovedAttach
						? "queued"
						: "requires_approval"
					: input.delegateToTediId
						? "queued"
						: "completed",
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			delegatedTediId: input.delegateToTediId ?? null,
			childRunId:
				delegatedRun?.childRunId ?? childRunId ?? workstationChildRunId,
			runtime: {
				backend: KERNEL_RUNTIME_BACKEND,
				externalId: runId,
				metadata: {
					...runtimeMetadata,
					childConversationId: delegatedRun?.childConversationId,
					delegationStatus: delegatedRun?.status,
					delegationError: delegatedRun?.error,
					delegationWorkOrder,
					homePlanId: homePlan?.id,
					...(delegationWorkItemId
						? {
								workItemId: delegationWorkItemId,
							}
						: {}),
				},
			},
			startedAt: createdAt,
			completedAt: workstationAttach ? null : completedAt,
			createdAt,
			updatedAt: workstationAttach ? assistantAt : completedAt,
			metadata: {
				source: "kernelRuntime.enqueueMessage",
				contentLength: turnContent.length,
				attachmentCount: input.attachments?.length ?? 0,
				idempotencyKey: runId,
				approvalRequestId,
				childConversationId: delegatedRun?.childConversationId,
				delegationStatus: delegatedRun?.status,
				delegationError: delegatedRun?.error,
				delegationWorkOrder,
				...(delegationWorkItemId
					? {
							workItemId: delegationWorkItemId,
						}
					: {}),
				homePlan,
				// Kernel-eligible turns returned above — delegation/plan paths
				// never produce a kernel route.
				kernelRoute: null,
				kernelEvidence: null,
				homeDispatchPolicy: dispatchPolicy,
			},
			progress: homeRunProgress({
				eventCount: 0,
				status: delegationFailed
					? "failed"
					: workstationAttach
						? autoApprovedAttach
							? "queued"
							: "requires_approval"
						: input.delegateToTediId
							? "queued"
							: "completed",
			}),
		};
		return {
			idempotencyKey: runId,
			conversationId,
			status: outputStatus,
			run,
			homePlan: homePlan ?? undefined,
			assistantMessage: {
				id: assistantMessageId,
				organizationId,
				conversationId,
				runId,
				role: "assistant",
				status: "completed",
				content: assistantContent,
				runtime: assistantEvent.runtime,
				createdAt: assistantEvent.createdAt,
				startedAt: assistantEvent.createdAt,
				completedAt: run.completedAt,
				metadata: assistantEvent.payload,
			},
			error: delegatedRun?.error,
		};
	});

export const startGoalLoopRoute = authed.startGoalLoop
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		if (input.evaluator === "work_items" && !input.objectiveId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"objectiveId is required when evaluator is 'work_items'",
			);
		}
		const instance = await context.env.KERNEL_GOAL_LOOP_WORKFLOW.create({
			params: {
				organizationId,
				content: input.content,
				condition: input.condition,
				maxTurns: input.maxTurns,
				budgetUsd: input.budgetUsd,
				evaluator: input.evaluator,
				objectiveId: input.objectiveId,
				conversationId: input.conversationId,
			},
		});
		return {
			workflowId: instance.id,
		};
	});

export const proposeRepoCommitRoute = kernelRuntimeOs.proposeRepoCommit
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		return proposeRepoCommitImpl(context, input);
	});

export const proposeCodemodeExecuteRoute =
	kernelRuntimeOs.proposeCodemodeExecute
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			return proposeCodemodeExecuteImpl(context, input);
		});

export const getRepoCommitApprovalStatusRoute =
	kernelRuntimeOs.getRepoCommitApprovalStatus
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const row = await getApprovalRequestById(
				context.db,
				input.approvalRequestId,
			);
			if (
				!row ||
				row.tediId !== input.tediId ||
				(row.payload as Record<string, unknown> | null)?.kind !==
					REPO_COMMIT_WRITE_KIND
			) {
				throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
			}
			return {
				status: row.status,
				resolution: row.resolution,
			};
		});
