import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ApproveHomePlanAssignmentsInputSchema,
	CancelHomeRunInputSchema,
	ConversationCapabilityReplayNameSchema,
	ConversationCapabilitySchema,
	ConversationArtifactPinSchema,
	EnqueueHomeMessageInputSchema,
	EnqueueHomeMessageOutputSchema,
	ExecuteHomeReadOnlyToolInputSchema,
	ExecuteHomeReadOnlyToolOutputSchema,
	HomeChildRunEvidenceSchema,
	HomeChildRunTreeSchema,
	HomeConversationSchema,
	HomeMessageSchema,
	HomePlanAssignmentApprovalResultSchema,
	HomePlanSchema,
	HomeRunSchema,
	HomeRunSetSchema,
	HomeRunTraceSchema,
	ListHomeReadOnlyToolsInputSchema,
	ListHomeReadOnlyToolsOutputSchema,
	ListHomeConversationsInputSchema,
	ReadHomeChildRunEvidenceInputSchema,
	ReadHomeChildRunTreeInputSchema,
	ReadHomeMessagesInputSchema,
	ReadHomeRunEventsInputSchema,
	ReadHomeRunInputSchema,
	ReadHomeRunSetInputSchema,
	ReadKernelToolResultInputSchema,
	ReadKernelToolResultOutputSchema,
	ResolveHomeDelegationWorkOrderInputSchema,
	RespondHomeApprovalInputSchema,
	RetryDelegationWorkItemInputSchema,
	RetryHomeRunInputSchema,
	SteerHomeRunInputSchema,
} from "../schemas/kernel-runtime";
import { RuntimeStreamReadOutputSchema } from "../schemas/runtime-submissions";
import { UploadHomeAttachmentInputSchema } from "../schemas/chat-attachments";
import { TediMessageAttachmentSchema } from "../schemas/cognitive-runtime";

export const kernelRuntimeContract = oc
	.route({ tags: ["kernel-runtime"], prefix: "/kernel/runtime" })
	.errors(baseErrors)
	.router({
		listConversationCapabilities: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/capabilities",
				summary: "List named conversation capabilities",
			})
			.input(
				z.strictObject({
					conversationId: z.string().min(1),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Optional explicit organization scope; omitted to use the authenticated principal's organization.",
						),
				}),
			)
			.output(
				z.object({ capabilities: z.array(ConversationCapabilitySchema) }),
			),

		listConversationArtifactPins: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/artifact-pins",
				summary: "List immutable conversation artifact pins",
			})
			.input(
				z.strictObject({
					conversationId: z.string().min(1),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Optional explicit organization scope; omitted to use the authenticated principal's organization.",
						),
				}),
			)
			.output(z.object({ pins: z.array(ConversationArtifactPinSchema) })),

		attachConversationArtifactPin: oc
			.route({
				method: "POST",
				path: "/conversations/{conversationId}/artifact-pins",
				summary: "Pin an immutable artifact revision",
				description:
					"Pins the current SHA-256 revision of a platform-published single-file artifact as context only. It grants no tools, MCP scopes, policy, or FGA authority.",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Optional explicit organization scope; omitted to use the authenticated principal's organization.",
						),
					artifactId: z.string().min(1).max(200),
					replayName: ConversationCapabilityReplayNameSchema,
				}),
			)
			.output(z.object({ pin: ConversationArtifactPinSchema })),

		detachConversationArtifactPin: oc
			.route({
				method: "DELETE",
				path: "/conversations/{conversationId}/artifact-pins/{pinId}",
				summary: "Detach an artifact revision pin",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Optional explicit organization scope; omitted to use the authenticated principal's organization.",
						),
					pinId: z.uuid(),
				}),
			)
			.output(z.object({ detached: z.literal(true), pinId: z.uuid() })),

		attachConversationCapability: oc
			.route({
				method: "POST",
				path: "/conversations/{conversationId}/capabilities",
				summary: "Attach a named conversation capability",
				description:
					"Adds context-only capability metadata. Execution authority remains governed by MCP scopes, capability links, tool policy, and FGA.",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Optional explicit organization scope; omitted to use the authenticated principal's organization.",
						),
					capabilityId: z.uuid(),
					replayName: ConversationCapabilityReplayNameSchema,
				}),
			)
			.output(z.object({ capability: ConversationCapabilitySchema })),

		detachConversationCapability: oc
			.route({
				method: "DELETE",
				path: "/conversations/{conversationId}/capabilities/{referenceId}",
				summary: "Detach a named conversation capability",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Optional explicit organization scope; omitted to use the authenticated principal's organization.",
						),
					referenceId: z.uuid(),
				}),
			)
			.output(z.object({ detached: z.literal(true), referenceId: z.uuid() })),

		uploadAttachment: oc
			.route({
				method: "POST",
				path: "/attachments",
				summary: "Upload a private Home chat attachment",
			})
			.input(UploadHomeAttachmentInputSchema)
			.output(TediMessageAttachmentSchema),
		listConversations: oc
			.route({
				method: "GET",
				path: "/conversations",
				summary: "List Tedix Home conversations",
				description:
					"Returns org-scoped Home conversation records. Home is a control-plane subject, not a tedi identity.",
			})
			.input(ListHomeConversationsInputSchema)
			.output(
				z.object({
					conversations: z.array(HomeConversationSchema),
					nextCursor: z.string().nullable().optional(),
				}),
			),

		renameConversation: oc
			.route({
				method: "POST",
				path: "/conversations/{conversationId}/rename",
				summary: "Rename a Tedix Home conversation",
				description:
					"Sets the operator-facing title of a Home conversation. Event-sourced: " +
					"writes a `conversation.updated` kernel runtime event whose title " +
					"overlays the derived conversation list.",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					title: z.string().min(1).max(200),
					organizationId: z.string().optional(),
				}),
			)
			.output(z.object({ conversation: HomeConversationSchema })),

		deleteConversation: oc
			.route({
				method: "POST",
				path: "/conversations/{conversationId}/delete",
				summary: "Permanently delete a Tedix Home conversation",
				description:
					"Permanently deletes conversation-owned content. Every active Home run is " +
					"canceled first through the canonical parent/child cascade, including " +
					"delegated and steering child runs. The runtime event ledger, parent run " +
					"rows, submissions, pending approval/wake state, grants, and model-facing " +
					"kernel trace bundles are removed. A content-free tombstone prevents late " +
					"events from reviving the conversation, and a separate audit receipt records " +
					"the destructive action. Accepted Work Items and child-tedi ledgers are not " +
					"conversation-owned and remain intact. The main Home thread is protected.",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					organizationId: z.string().optional(),
				}),
			)
			.output(
				z.object({
					ok: z.boolean(),
					conversationId: z.string(),
					deletedAt: z.string(),
					hardDeleted: z.literal(true),
					canceledRunCount: z.number().int().nonnegative(),
				}),
			),

		pinConversation: oc
			.route({
				method: "POST",
				path: "/conversations/{conversationId}/pin",
				summary: "Pin or unpin a Tedix Home conversation",
				description:
					"Sets the pinned state of a Home conversation. Event-sourced — writes " +
					"a `conversation.updated` kernel runtime event with a `pinned` boolean " +
					"marker, the same event kind `renameConversation`/`deleteConversation` " +
					"use. Org-durable and shared across every surface (Tedix OS + CLI), unlike " +
					"the retired per-user `tedi_session_states` pin overlay. Clearable: " +
					"`pinned: false` unpins (sets `pinnedAt` back to null).",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					pinned: z.boolean(),
					organizationId: z.string().optional(),
				}),
			)
			.output(z.object({ conversation: HomeConversationSchema })),

		archiveConversation: oc
			.route({
				method: "POST",
				path: "/conversations/{conversationId}/archive",
				summary: "Archive or restore a Tedix Home conversation",
				description:
					"Sets a clearable archive marker without deleting the immutable runtime ledger. " +
					"Archived conversations are hidden from ordinary lists and can be restored by " +
					"sending `archived: false`.",
			})
			.input(
				z.object({
					conversationId: z.string().min(1),
					archived: z.boolean(),
					organizationId: z
						.string()
						.optional()
						.describe(
							"Omitted for the authenticated caller organization; internal operators may supply it only within their authorized tenant scope",
						),
				}),
			)
			.output(z.object({ conversation: HomeConversationSchema })),

		readMessages: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/messages",
				summary: "Read Tedix Home conversation messages",
				description:
					"Returns org-scoped Home transcript rows without borrowing a tedi runtime ledger.",
			})
			.input(ReadHomeMessagesInputSchema)
			.output(
				z.object({
					messages: z.array(HomeMessageSchema),
					nextCursor: z.string().nullable().optional(),
				}),
			),

		readRunSet: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/run-set",
				summary: "Read Tedix Home run set",
				description:
					"Returns durable per-conversation Home run membership and active run ids for cockpit work-card rendering.",
			})
			.input(ReadHomeRunSetInputSchema)
			.output(z.object({ runSet: HomeRunSetSchema })),

		readChildRunEvidence: oc
			.route({
				method: "GET",
				path: "/child-runs/{childRunId}/evidence",
				summary: "Read evidence for a delegated Tedix Home child run",
				description:
					"Returns the delegated tedi's canonical runtime events and artifacts while preserving Home as the owning conversation surface.",
			})
			.input(ReadHomeChildRunEvidenceInputSchema)
			.output(z.object({ evidence: HomeChildRunEvidenceSchema })),

		readChildRunTree: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/child-tree",
				summary: "Read Tedix Home delegated child-run tree",
				description:
					"Returns a read-only hierarchy of delegated child runs for the Home collaboration panel. It never binds the operator to a child runtime.",
			})
			.input(ReadHomeChildRunTreeInputSchema)
			.output(z.object({ tree: HomeChildRunTreeSchema })),

		resolveDelegationWorkOrder: oc
			.route({
				method: "POST",
				path: "/delegation-work-orders/{approvalRequestId}/resolve",
				summary: "Resolve a Tedix Home delegation work order",
				description:
					"Links a canonical approval decision back to a Home workstation attachment work order without exposing the selected body adapter as the product route.",
			})
			.input(ResolveHomeDelegationWorkOrderInputSchema)
			.output(z.object({ run: HomeRunSchema })),

		approvePlanAssignments: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/plan/approve",
				summary: "Approve Tedix Home plan assignments",
				description:
					"Promotes proposed Home plan assignments into canonical Work Items and optionally dispatches isolate child runs.",
			})
			.input(ApproveHomePlanAssignmentsInputSchema)
			.output(
				z.object({
					run: HomeRunSchema,
					homePlan: HomePlanSchema,
					assignments: z.array(HomePlanAssignmentApprovalResultSchema),
				}),
			),

		readRun: oc
			.route({
				method: "GET",
				path: "/runs/{runId}",
				summary: "Read one Tedix Home run",
				description:
					"Returns a single org-scoped Home run with reconciled delegated child-run status for cockpit work-card inspection.",
			})
			.input(ReadHomeRunInputSchema)
			.output(z.object({ run: HomeRunSchema })),

		readRunTrace: oc
			.route({
				method: "GET",
				path: "/runs/{runId}/trace",
				summary: "Read one converged multi-tedi Home run trace",
				description:
					"Assembles one bounded reference graph across the parent Kernel events, delegated tedi events, artifacts, workstation events, wake receipts, and final synthesis. Canonical ledgers remain the source of truth.",
			})
			.input(ReadHomeRunInputSchema)
			.output(z.object({ trace: HomeRunTraceSchema })),

		readRunEvents: oc
			.route({
				method: "GET",
				path: "/runs/{runId}/events",
				summary: "Read a Tedix Home run's durable event stream by offset",
				description:
					"Canonical-D1 replay of a Home run's runtime events from a run-local offset (or tail=N for the latest slice). Returns a stream receipt with nextOffset plus terminal/closed state for resume-by-offset clients.",
			})
			.input(ReadHomeRunEventsInputSchema)
			.output(RuntimeStreamReadOutputSchema),

		cancelRun: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/cancel",
				summary: "Cancel a Tedix Home run",
				description:
					"Marks an active org-scoped Home run as canceled and records a run.canceled event. No-ops with an error when the run is already terminal.",
			})
			.input(CancelHomeRunInputSchema)
			.output(z.object({ run: HomeRunSchema })),

		steerRun: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/steer",
				summary: "Steer an active Tedix Home run",
				description:
					"Records an operator steering instruction on an active Home run without canceling the parent conversation. The instruction is persisted as a Home transcript/event row and appears on the run metadata for reconciliation and audit.",
			})
			.input(SteerHomeRunInputSchema)
			.output(z.object({ run: HomeRunSchema })),

		respondApproval: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/approval/respond",
				summary: "Approve or reject what a Tedix Home run is waiting on",
				description:
					"The single Home approval surface. Resolves the run's pending target from the run itself: a parked write-action approval card (kind home_tool_write — approve executes the server-stored call exactly once via the canonical approval latch; reject cancels the run without executing), a Home delegation recommendation or workstation attachment work order (approve dispatches the certified work order; reject cancels it), or a proposed Home plan (approve promotes assignments into Work Items and dispatches; reject cancels assignments, plan, run, and linked Work Items).",
			})
			.input(RespondHomeApprovalInputSchema)
			.output(
				z.object({
					run: HomeRunSchema,
					homePlan: HomePlanSchema.optional(),
					assignments: z.array(HomePlanAssignmentApprovalResultSchema),
				}),
			),

		enqueueMessage: oc
			.route({
				method: "POST",
				path: "/messages/enqueue",
				summary: "Record or delegate a Tedix Home message",
				description:
					"Records a Home turn against the organization. Delegated execution remains explicit through delegateToTediId.",
			})
			.input(EnqueueHomeMessageInputSchema)
			.output(EnqueueHomeMessageOutputSchema),

		executeReadOnlyTool: oc
			.route({
				method: "POST",
				path: "/read-only-tools/execute",
				summary: "Execute an explicit read-only MCP tool from Home",
				description:
					"Executes exactly one catalog-verified read-only MCP tool as the authenticated operator. This bypasses Home routing and delegation, but persists a bounded request and receipt in the selected Home conversation.",
			})
			.input(ExecuteHomeReadOnlyToolInputSchema)
			.output(ExecuteHomeReadOnlyToolOutputSchema),

		readToolResult: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/tool-results/{resultId}",
				summary: "Read a retained Home tool result",
				description:
					"Reads bounded pages or performs exact literal search over a retained result. It never replays the provider call.",
			})
			.input(ReadKernelToolResultInputSchema)
			.output(ReadKernelToolResultOutputSchema),

		listReadOnlyTools: oc
			.route({
				method: "GET",
				path: "/read-only-tools",
				summary: "List explicit read-only MCP tools available to Home",
				description:
					"Returns the organization app catalog filtered to tools whose current declaration explicitly carries readOnlyHint true. Execution revalidates the MCP wire declaration.",
			})
			.input(ListHomeReadOnlyToolsInputSchema)
			.output(ListHomeReadOnlyToolsOutputSchema),

		startGoalLoop: oc
			.route({
				method: "POST",
				path: "/goal-loop/start",
				summary: "Start a durable kernel goal loop",
				description:
					"Starts the KERNEL_GOAL_LOOP_WORKFLOW durable Workflow wrapping the kernel's governed self-prompting loop (loop-engineering.md L2). Submits `content` as repeated Home turns until the checker (deterministic regex, adversarial LLM judge, or work_items — every leaf completion unit under `objectiveId` evidence-certified `done`) is satisfied or a ceiling (maxTurns/budgetUsd/stall) trips. Completion is a point-in-time certified snapshot; new work may reopen the objective. Poll via workflows.getStatus with the returned workflowId (type 'goal_loop').",
			})
			.input(
				z.object({
					organizationId: z.string().optional(),
					content: z.string().min(1),
					condition: z.string().min(1),
					maxTurns: z.number().int().min(1).max(8).optional(),
					budgetUsd: z.number().positive().optional(),
					evaluator: z
						.enum(["deterministic", "adversarial", "work_items"])
						.optional(),
					objectiveId: z.string().optional(),
					conversationId: z.string().optional(),
				}),
			)
			.output(
				z.object({
					workflowId: z.string(),
				}),
			),

		retryRun: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/retry",
				summary: "Retry a failed Tedix Home delegated run",
				description:
					"Re-dispatches the same delegation work order from a terminal failed run to the same target tedi under a fresh idempotency key (a new run row). Only valid when the run is status='failed' and carries both a delegatedTediId and a delegationWorkOrder in its metadata. The original failed run is not modified. Double-dispatch is prevented by the fresh idempotency key — two concurrent POSTs produce two new run rows with distinct ids.",
			})
			.input(RetryHomeRunInputSchema)
			.output(
				z.object({
					run: HomeRunSchema,
					newRunId: z.string(),
				}),
			),

		retryDelegation: oc
			.route({
				method: "POST",
				path: "/delegations/{workItemId}/retry",
				summary: "Retry a failed delegation attempt",
				description:
					"Operator-gated recovery for an accepted Work Item whose latest delegation attempt failed proof admission or dispatch. Re-dispatches the linked Home work order to the same target tedi under a fenced attempt and deterministic child-run key, bounded by MAX_DELEGATION_RETRIES derived from immutable attempt history.",
			})
			.input(RetryDelegationWorkItemInputSchema)
			.output(
				z.object({
					run: HomeRunSchema,
					childRunId: z.string(),
					retryCount: z.number(),
				}),
			),

		proposeRepoCommit: oc
			.route({
				method: "POST",
				path: "/repo-commit/propose",
				summary: "Gate a repo_commit through the write-approval latch",
				description:
					"Called by the tedi DO (service binding only) before executing a git commit. Recomputes the risk tier server-side and either auto-resolves the approval row (low-risk trusted tool) or parks it pending human review. The MCP executor is NEVER called here — execution happens in the DO after the status reaches 'approved'.",
			})
			.input(
				z.object({
					tediId: z.string(),
					orgId: z.string(),
					conversationId: z.string(),
					owner: z.string(),
					repo: z.string(),
					baseRef: z.string(),
					branch: z.string(),
					message: z.string(),
					openPr: z.boolean(),
					prBase: z.string().nullable().optional(),
					changeSummary: z.object({
						fileCount: z.number(),
						addedOrModified: z.array(z.string()),
						deleted: z.array(z.string()),
						totalBytes: z.number(),
					}),
					/**
					 * Exact content fingerprint of the ordered changeset + push
					 * target, computed once by the caller's publish fence and
					 * persisted onto the approval so the fence has an
					 * operator-approved anchor outside the tedi's own store.
					 * Optional only for deploy skew with a runtime that predates
					 * it; a present value must be a lowercase 64-hex SHA-256.
					 */
					changeFingerprint: z
						.string()
						.regex(/^[0-9a-f]{64}$/)
						.nullish(),
					executionLedgerId: z.string(),
					riskTier: z.enum(["low", "high"]),
				}),
			)
			.output(
				z.object({
					approvalRequestId: z.string(),
					status: z.enum(["approved", "pending"]),
					autoResolved: z.boolean(),
					decisionReason: z.string(),
				}),
			),

		proposeCodemodeExecute: oc
			.route({
				method: "POST",
				path: "/codemode-execute/propose",
				summary:
					"Gate a codemode `execute` session through the write-approval latch",
				description:
					"Called by the tedi DO (service binding only) when a network-isolated `execute` call is attempted in a coding session that is not pre-authorized. Arbitrary model JS over the durable workspace is always HIGH risk, so this always parks a human approval card (never auto-resolves). On approval the DO authorizes the whole session and the model re-issues `execute`, which then runs inline — the parked code is never re-run server-side.",
			})
			.input(
				z.object({
					tediId: z.string(),
					orgId: z.string(),
					conversationId: z.string(),
					sessionKey: z.string(),
					executionId: z.string(),
					codeHash: z.string(),
					approvalRequestId: z.string().optional(),
					executionMode: z.enum(["session_replay", "durable_call"]).optional(),
					homeRunId: z.string().optional(),
					childRunId: z.string().optional(),
					pendingSeq: z.number().int().min(0).optional(),
					connector: z.string().optional(),
					method: z.string().optional(),
				}),
			)
			.output(
				z.object({
					approvalRequestId: z.string(),
					status: z.enum(["approved", "pending"]),
				}),
			),

		getRepoCommitApprovalStatus: oc
			.route({
				method: "GET",
				path: "/repo-commit/approval/{approvalRequestId}",
				summary: "Poll the status of a repo_commit approval request",
				description:
					"Called by the tedi DO drain loop (service binding only) to check whether a parked repo_commit approval has been resolved. Returns the raw status row so the DO can decide to proceed or wait.",
			})
			.input(
				z.object({
					approvalRequestId: z.string(),
					tediId: z.string(),
				}),
			)
			.output(
				z.object({
					status: z.string(),
					resolution: z.string().nullable().optional(),
				}),
			),
	});

export type KernelRuntimeContract = typeof kernelRuntimeContract;
