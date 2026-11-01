import { AUTHZ, type BaseContext, ErrorCodes, createError } from "../../orpc";
import { excludeWithdrawnSteering } from "../kernel/steering-history";
import {
	type ChildRunEvidenceRows,
	readChildRunEvidenceRows,
} from "../kernel/child-run-reads";
import {
	augmentTreeWithFanoutChildren,
	buildHomeChildRunTree,
} from "../kernel/child-run-delegated-result";
import { summarizeChildRuntimeEvents } from "../kernel/child-run-events";
import { HOME_MAIN_CONVERSATION_ID } from "../kernel/conversation-index";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import type {
	HomeChildRunEvidence,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	type KernelRuntimeEvent,
	listKernelRuntimeEvents,
	listHomeRunFinishedEvents,
} from "@tedix/db/queries/kernel-runtime-events";
import {
	type KernelRuntimeRun,
	findKernelRuntimeRunByChild,
	getKernelRuntimeRun,
	listKernelRuntimeRuns,
	listPendingDelegationRuns,
} from "@tedix/db/queries/kernel-runtime-runs";
import { auditActor } from "../../audit-helpers";
import { assembleHomeRunTrace } from "../kernel/home-run-trace";
import {
	childRunStatusFromSummary,
	errorMessage,
	isActiveHomeRunStatus,
	nextCursor,
	nonNullRecord,
	nowIso,
	resolveOrganizationId,
	shouldFailSoftChildEvidenceRead,
	shouldFailSoftHomeRunSetRead,
	shouldFailSoftKernelRuntimeRead,
	stringFromPayload,
} from "../kernel/runtime-shared";
import {
	ensureHomeConversationAccess,
	insertKernelRuntimeEvent,
} from "../kernel/run-store";
import { reconcileHomeRunRowsFromChildStatus } from "../kernel/run-store-reconciliation";
import { normalizeHomeRunRecord } from "../kernel/run-store-normalization";
import { getOrganizationTedi } from "@tedix/db/queries/kernel-runtime-support";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	sumRunInferenceCharges,
	sumRunInferenceChargesByRun,
} from "@tedix/db/queries/billing/spending";
import { listActiveKernelApprovalMirrors } from "@tedix/db/queries/kernel-approval-mirrors";
import {
	observedLearningEventId,
	recordObservedLearningInteraction,
} from "../../../services/learning-interaction-recorder";
import { readChildRunStatusesForRunRows } from "../kernel/home-plan";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	type KernelConversationRow,
	getKernelConversation,
	purgeKernelConversation,
} from "@tedix/db/queries/kernel-conversations";
import { cleanupExactKernelToolResults } from "../../../services/kernel-tool-result-retention";
import {
	attachConversationCapability,
	ConversationCapabilityConflictError,
	detachConversationCapability,
	listConversationCapabilities,
} from "@tedix/db/queries/conversation-capabilities";
import { getCapabilityByIdForOrganization } from "@tedix/db/queries/capabilities";
import {
	ConversationArtifactPinConflictError,
	detachConversationArtifactPin,
} from "@tedix/db/queries/conversation-artifact-pins";
import {
	pinConversationArtifactRevision,
	readConversationArtifactPins,
} from "../../../lib/conversation-artifact-pins";
import {
	authed,
	childRunControlForStatus,
	normalizeChildArtifact,
	normalizeChildRuntimeEvent,
	normalizeHomeMessage,
	readOrgGovernancePolicy,
} from "./policy-normalization";
import { resolveApprovalTtlHours } from "@tedix/api-contract/utils/approval-policy";
import { homeDelegationApprovalExpiresAt } from "../../../kernel/progress-ledger";
import {
	emptyKernelRunSet,
	isHomeMessageEvent,
	listKernelConversationsFromIndex,
	readChildRunStatuses,
	readKernelRunRecordsForConversation,
	RUN_EVENT_STREAM_PAGE,
	buildSelectedRunEventStreamPage,
	kernelStreamRow,
} from "./run-reads-streams";
import { approveHomePlanAssignmentsCore } from "./approval-control";
import {
	cancelKernelRunCore,
	resolveKernelWorkstationAttachWorkOrder,
} from "./control-proposals";
import { collapseHomeDelegationNarration } from "../kernel/home-narration";
import { summarizeRunSetReconciliation } from "./reconciliation-observability";

const capabilityView = (
	reference: Awaited<ReturnType<typeof listConversationCapabilities>>[number],
	capability: { name: string; slug: string },
) => ({
	id: reference.id,
	conversationId: reference.conversationId,
	capabilityId: reference.capabilityId,
	replayName: reference.replayName,
	name: capability.name,
	slug: capability.slug,
	whyPresent: {
		type: reference.attachedByType,
		actorId: reference.attachedById,
		attachedAt: reference.createdAt,
	},
	authority: "context_only" as const,
});

export const listConversationCapabilitiesRoute =
	authed.listConversationCapabilities
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "read",
			});
			const references = await listConversationCapabilities(context.db, {
				organizationId,
				conversationId: input.conversationId,
			});
			const capabilities = await Promise.all(
				references.map(async (reference) => {
					const capability = await getCapabilityByIdForOrganization(
						context.db,
						organizationId,
						reference.capabilityId,
					);
					if (!capability || capability.status !== "active") {
						return null;
					}
					return capabilityView(reference, capability);
				}),
			);
			return { capabilities: capabilities.filter((value) => value !== null) };
		});

export const attachConversationCapabilityRoute =
	authed.attachConversationCapability
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "edit",
			});
			const capability = await getCapabilityByIdForOrganization(
				context.db,
				organizationId,
				input.capabilityId,
			);
			if (!capability || capability.status !== "active") {
				throw createError(ErrorCodes.NOT_FOUND, "Active capability not found");
			}
			const actor = auditActor(context);
			let reference;
			try {
				reference = await attachConversationCapability(context.db, {
					id: crypto.randomUUID(),
					organizationId,
					conversationId: input.conversationId,
					capabilityId: input.capabilityId,
					replayName: input.replayName,
					attachedByType: actor.actorType,
					attachedById: actor.actorId,
					createdAt: nowIso(),
				});
			} catch (error) {
				if (error instanceof ConversationCapabilityConflictError) {
					throw createError(ErrorCodes.BAD_REQUEST, error.message);
				}
				throw error;
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "kernel.conversation.capability_attached",
				resourceType: "kernel_conversation",
				resourceId: input.conversationId,
				metadata: toJsonRecord({
					...actor.actorMetadata,
					capabilityId: capability.id,
					replayName: input.replayName,
					authority: "context_only",
				}),
			});
			return { capability: capabilityView(reference, capability) };
		});

export const detachConversationCapabilityRoute =
	authed.detachConversationCapability
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "edit",
			});
			const detached = await detachConversationCapability(context.db, {
				organizationId,
				conversationId: input.conversationId,
				referenceId: input.referenceId,
			});
			if (!detached) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Conversation capability not found",
				);
			}
			const actor = auditActor(context);
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "kernel.conversation.capability_detached",
				resourceType: "kernel_conversation",
				resourceId: input.conversationId,
				metadata: toJsonRecord({
					...actor.actorMetadata,
					capabilityId: detached.capabilityId,
					replayName: detached.replayName,
				}),
			});
			return { detached: true as const, referenceId: detached.id };
		});

export const listConversationArtifactPinsRoute =
	authed.listConversationArtifactPins
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "read",
			});
			return {
				pins: await readConversationArtifactPins(context.db, {
					organizationId,
					conversationId: input.conversationId,
				}),
			};
		});

export const attachConversationArtifactPinRoute =
	authed.attachConversationArtifactPin
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "edit",
			});
			const actor = auditActor(context);
			let pin;
			try {
				pin = await pinConversationArtifactRevision(context.db, {
					id: crypto.randomUUID(),
					organizationId,
					conversationId: input.conversationId,
					artifactId: input.artifactId,
					replayName: input.replayName,
					attachedByType: actor.actorType,
					attachedById: actor.actorId,
					createdAt: nowIso(),
				});
			} catch (error) {
				if (error instanceof ConversationArtifactPinConflictError) {
					throw createError(ErrorCodes.BAD_REQUEST, error.message);
				}
				throw error;
			}
			if (!pin) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Pinnable immutable artifact revision not found",
				);
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "kernel.conversation.artifact_pinned",
				resourceType: "kernel_conversation",
				resourceId: input.conversationId,
				metadata: toJsonRecord({
					...actor.actorMetadata,
					artifactId: pin.artifactId,
					replayName: pin.replayName,
					revisionDigest: pin.revision.digest,
					authority: "context_only",
				}),
			});
			return { pin };
		});

export const detachConversationArtifactPinRoute =
	authed.detachConversationArtifactPin
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "edit",
			});
			const detached = await detachConversationArtifactPin(context.db, {
				organizationId,
				conversationId: input.conversationId,
				pinId: input.pinId,
			});
			if (!detached) {
				throw createError(ErrorCodes.NOT_FOUND, "Artifact pin not found");
			}
			const actor = auditActor(context);
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "kernel.conversation.artifact_unpinned",
				resourceType: "kernel_conversation",
				resourceId: input.conversationId,
				metadata: toJsonRecord({
					...actor.actorMetadata,
					artifactId: detached.artifactId,
					replayName: detached.replayName,
					revisionDigest: detached.revisionDigest,
				}),
			});
			return { detached: true as const, pinId: detached.id };
		});

export const listConversationsRoute = authed.listConversations
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		return listKernelConversationsFromIndex(context, {
			organizationId,
			limit: input.limit ?? 100,
			list: input,
		});
	});

export const renameConversationRoute = authed.renameConversation
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "edit",
		});
		const title = input.title.trim();
		const renamedAt = nowIso();
		// The event write-through updates the durable conversation projection.
		await insertKernelRuntimeEvent(context, {
			id: [
				"home",
				organizationId,
				"event",
				"conversation.updated",
				input.conversationId,
				renamedAt,
			].join(":"),
			organizationId,
			kind: "conversation.updated",
			conversationId: input.conversationId,
			payload: {
				conversation: {
					title,
				},
				title,
				source: "kernelRuntime.renameConversation",
			},
			createdAt: renamedAt,
		});
		await recordObservedLearningInteraction(context, {
			organizationId,
			clientEventId: await observedLearningEventId(
				"rename",
				input.conversationId,
				renamedAt,
			),
			eventKind: "manually_replaced",
			surface: "kernel",
			issueKey: "kernel-conversation-title",
			targetType: "conversation_title",
			targetId: input.conversationId,
			threadId: input.conversationId,
			metadata: {
				replacementChars: title.length,
			},
			occurredAt: renamedAt,
		});
		return {
			conversation: {
				id: input.conversationId,
				organizationId,
				title,
				status: "active" as const,
				channel: "home",
				lastMessageAt: renamedAt,
				messageCount: 0,
				createdAt: renamedAt,
				updatedAt: renamedAt,
			},
		};
	});

export const deleteConversationRoute = authed.deleteConversation
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		if (input.conversationId === HOME_MAIN_CONVERSATION_ID) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The org's main Home thread cannot be deleted",
			);
		}
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "edit",
		});
		const deletedAt = nowIso();

		// Snapshot before cancellation: canceling changes updatedAt and therefore
		// must not race an offset-paginated read. Every active parent cancel uses
		// the canonical cascade, which stamps durable abort intent, stops both the
		// primary and steering child runs, settles delegation Work attempts, and
		// aborts the in-flight KernelDO turn.
		const conversationRuns: KernelRuntimeRun[] = [];
		for (let offset = 0; ; offset += 100) {
			const page = await listKernelRuntimeRuns(context.db, {
				organizationId,
				conversationId: input.conversationId,
				orderBy: "created",
				limit: 100,
				offset,
			});
			conversationRuns.push(...page);
			if (page.length < 100) break;
		}
		const activeRuns = conversationRuns.filter((run) =>
			isActiveHomeRunStatus(run.status),
		);
		for (const run of activeRuns) {
			await cancelKernelRunCore(context, {
				organizationId,
				homeRunId: run.id,
				reason: "Conversation permanently deleted by operator",
			});
		}

		const purged = await purgeKernelConversation(context.db, {
			organizationId,
			conversationId: input.conversationId,
			deletedAt,
		});
		await cleanupExactKernelToolResults({
			db: context.db,
			bucket: context.env.TEDI_R2_BUCKET,
			rows: purged.evictedToolResults,
		});

		// Preserve only a content-free compliance receipt outside the purged
		// conversation ledger. This proves who performed the destructive action
		// without retaining titles, messages, prompts, or model output.
		const actor = auditActor(context);
		await insertAuditEvent(context.db, {
			organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "kernel.conversation.deleted",
			resourceType: "kernel_conversation",
			resourceId: input.conversationId,
			metadata: toJsonRecord({
				...actor.actorMetadata,
				source: "kernelRuntime.deleteConversation",
				hardDeleted: true,
				canceledRunCount: activeRuns.length,
			}),
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});
		return {
			ok: true as const,
			conversationId: input.conversationId,
			deletedAt,
			hardDeleted: true as const,
			canceledRunCount: activeRuns.length,
		};
	});

export const pinConversationRoute = authed.pinConversation
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "edit",
		});
		const pinnedAtIso = nowIso();
		const pinnedAt = input.pinned ? pinnedAtIso : null;
		// Event-sourced pin, org-durable + shared: reuses the SAME
		// `conversation.updated` event kind rename/delete write — a `pinned`
		// boolean payload sibling to `title`/`deletedAt` — so the projection
		// overlay rides the existing plumbing with no new query surface. Unlike
		// deletedAt this is clearable: `pinned: false` writes pinnedAt = null.
		await insertKernelRuntimeEvent(context, {
			id: [
				"home",
				organizationId,
				"event",
				"conversation.updated",
				input.conversationId,
				input.pinned ? "pinned" : "unpinned",
				pinnedAtIso,
			].join(":"),
			organizationId,
			kind: "conversation.updated",
			conversationId: input.conversationId,
			payload: {
				conversation: {
					pinned: input.pinned,
				},
				pinned: input.pinned,
				source: "kernelRuntime.pinConversation",
			},
			createdAt: pinnedAtIso,
		});
		return {
			conversation: {
				id: input.conversationId,
				organizationId,
				status: "active" as const,
				channel: "home",
				lastMessageAt: pinnedAtIso,
				messageCount: 0,
				pinnedAt,
				createdAt: pinnedAtIso,
				updatedAt: pinnedAtIso,
			},
		};
	});

export const archiveConversationRoute = authed.archiveConversation
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		if (input.conversationId === HOME_MAIN_CONVERSATION_ID) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The org's main Home thread cannot be archived",
			);
		}
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "edit",
		});
		const changedAt = nowIso();
		await insertKernelRuntimeEvent(context, {
			id: [
				"home",
				organizationId,
				"event",
				"conversation.updated",
				input.conversationId,
				input.archived ? "archived" : "restored",
				changedAt,
			].join(":"),
			organizationId,
			kind: "conversation.updated",
			conversationId: input.conversationId,
			payload: {
				conversation: { archived: input.archived },
				archived: input.archived,
				source: "kernelRuntime.archiveConversation",
			},
			createdAt: changedAt,
		});
		return {
			conversation: {
				id: input.conversationId,
				organizationId,
				status: input.archived ? ("archived" as const) : ("active" as const),
				channel: "home",
				lastMessageAt: changedAt,
				messageCount: 0,
				createdAt: changedAt,
				updatedAt: changedAt,
			},
		};
	});

/**
 * A `conversation.updated` payload's permanent-delete marker — the same shape
 * `conversation-index.ts`'s write-through reads (top level or nested under
 * `conversation`).
 */
function conversationEventHasDeletedMarker(payload: unknown): boolean {
	const record = nonNullRecord(payload);
	return (
		stringFromPayload(nonNullRecord(record?.conversation)?.deletedAt) !==
			undefined || stringFromPayload(record?.deletedAt) !== undefined
	);
}

/**
 * The conversation-scoped durable stream: every kernel event that carries no
 * run id, in the same offset/receipt envelope as `readRunEvents`. The
 * `conversation.updated` family (rename, pin, archive/restore, auto-title)
 * lives here; without this lane those events were unreachable by any stream
 * consumer and mounted surfaces depended on the list poll.
 *
 * Deletion is the one event the ledger can no longer carry: `deleteConversation`
 * purges the conversation's event rows, so the terminal frame is derived from
 * the content-free `kernel_conversations` tombstone with a deterministic id —
 * resumable, dedupe-safe, and exactly the `conversation.updated` marker the
 * projection records for a soft delete.
 */
export const readConversationEventsRoute = authed.readConversationEvents
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "read",
		});
		const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 30_000);
		const pageLimit = Math.min(
			Math.max(input.limit ?? RUN_EVENT_STREAM_PAGE, 1),
			RUN_EVENT_STREAM_PAGE,
		);
		const deadline = Date.now() + waitMs;
		const start = input.offset ?? 0;
		while (true) {
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "read",
			});
			let conversation: KernelConversationRow | undefined;
			let rows: KernelRuntimeEvent[];
			try {
				[conversation, rows] = await Promise.all([
					getKernelConversation(context.db, {
						organizationId,
						conversationId: input.conversationId,
					}),
					listKernelRuntimeEvents(context.db, {
						organizationId,
						conversationId: input.conversationId,
						runIdNull: true,
						order: "asc",
						limit: pageLimit,
						offset: start,
					}),
				]);
			} catch (error) {
				if (shouldFailSoftKernelRuntimeRead(error)) {
					console.warn("[kernelRuntime] conversation events read failed", {
						organizationId,
						conversationId: input.conversationId,
						error: errorMessage(error),
					});
					return {
						events: [],
						stream: {
							streamId: `home:conversation:${input.conversationId}`,
							offset: start,
							nextOffset: start,
							closed: false,
						},
					};
				}
				throw error;
			}
			const page = buildSelectedRunEventStreamPage(
				rows.map(kernelStreamRow),
				[],
				{ runId: input.conversationId, start },
			);
			page.stream.streamId = `home:conversation:${input.conversationId}`;
			const deletedAt = conversation?.deletedAt ?? null;
			// The tombstone frame occupies the position after the last live row;
			// a full page means more live rows remain, so the marker waits for
			// the next (empty-tail) read.
			if (deletedAt !== null && rows.length < pageLimit) {
				page.stream.closed = true;
				const ledgerFrame = page.events.findLast(
					(event) =>
						event.kind === "conversation.updated" &&
						conversationEventHasDeletedMarker(event.payload),
				);
				if (ledgerFrame) {
					page.stream.terminalEventId = ledgerFrame.id;
				} else {
					const frame = {
						id: homeRuntimeEventId({
							organizationId,
							kind: "conversation.updated",
							conversationId: input.conversationId,
							suffix: `deleted:${deletedAt}`,
						}),
						kind: "conversation.updated",
						conversationId: input.conversationId,
						payload: {
							conversation: { deletedAt },
							deletedAt,
							source: "kernelRuntime.deleteConversation",
						},
						createdAt: deletedAt,
					};
					page.events.push(frame);
					page.stream.nextOffset = start + page.events.length;
					page.stream.terminalEventId = frame.id;
				}
			}
			if (
				waitMs === 0 ||
				page.events.length > 0 ||
				page.stream.closed ||
				Date.now() >= deadline
			) {
				return page;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(1000, deadline - Date.now())),
			);
		}
	});

export const readMessagesRoute = authed.readMessages
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "read",
		});
		const limit = input.limit ?? 100;
		const rowReadLimit = limit * 3;
		let rows: KernelRuntimeEvent[];
		try {
			rows = await listKernelRuntimeEvents(context.db, {
				organizationId,
				conversationId: input.conversationId,
				kinds: ["message.received", "message.completed", "run.completed"],
				createdBefore: input.cursor,
				order: "desc",
				limit: rowReadLimit,
			});
		} catch (error) {
			if (shouldFailSoftKernelRuntimeRead(error)) {
				console.warn("[kernelRuntime] message history read failed", {
					organizationId,
					conversationId: input.conversationId,
					error: errorMessage(error),
				});
				return {
					messages: [],
					nextCursor: null,
				};
			}
			throw error;
		}
		rows = await excludeWithdrawnSteering(
			context.db,
			organizationId,
			input.conversationId,
			rows,
		);
		const orderedRows = [...rows].reverse();
		const completedRuns = new Map<string, string>();
		for (const row of orderedRows) {
			if (row.kind === "run.completed" && row.runId) {
				completedRuns.set(row.runId, row.createdAt);
			}
		}
		// Run records FIRST: they carry the classified per-turn state, and
		// `readChildRunStatuses` needs them to skip live child reads for turns
		// whose parent run is already terminal (one turn, one status).
		const homeRunsById = await readKernelRunRecordsForConversation(context, {
			conversationId: input.conversationId,
			organizationId,
			limit: rowReadLimit,
		});
		const childRunStatuses = await readChildRunStatuses(
			context,
			orderedRows,
			homeRunsById,
		);
		const messageRowsDesc = rows.filter(isHomeMessageEvent).slice(0, limit);
		const messageRows = [...messageRowsDesc].reverse().sort((a, b) => {
			// Completion events now carry their actual append time so offset-stream
			// readers cannot miss a late insert. Preserve the transcript's invariant
			// independently: within one run, the accepted user turn always precedes
			// its assistant completion, regardless of storage/insertion timing.
			if (a.runId && a.runId === b.runId) {
				if (a.kind === "message.received" && b.kind === "message.completed") {
					return -1;
				}
				if (a.kind === "message.completed" && b.kind === "message.received") {
					return 1;
				}
			}
			return 0;
		});
		// One delegation = one row. Delegation lifecycle NARRATION (dispatch ack,
		// cancel marker, status-only terminal restatement) duplicates the
		// delegation receipt rendered from the very same row's metadata. The
		// ledger keeps every row verbatim; the rendered transcript drops the
		// duplicates and blanks the prose on the row that owns the receipt.
		const narration = collapseHomeDelegationNarration(messageRows);
		return {
			messages: messageRows.flatMap((row) => {
				const disposition = narration.get(row.id);
				if (disposition === "drop") return [];
				const message = normalizeHomeMessage(
					row,
					completedRuns,
					childRunStatuses,
					homeRunsById,
				);
				return [
					disposition === "blank" ? { ...message, content: "" } : message,
				];
			}),
			nextCursor:
				messageRowsDesc.length >= limit
					? (messageRowsDesc[messageRowsDesc.length - 1]?.createdAt ?? null)
					: nextCursor(rows, rowReadLimit),
		};
	});

export const readRunSetRoute = authed.readRunSet
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "read",
		});
		const limit = input.limit ?? 50;
		// Zero-based offset into the newest-first run rows. Default 0 keeps the
		// no-offset caller's behavior identical (head page). The Home cockpit
		// pages with offset>0 to backfill a heavy conversation's tail without
		// inflating the SSR first page.
		const offset = input.offset ?? 0;
		let rows: KernelRuntimeRun[];
		try {
			rows = await listKernelRuntimeRuns(context.db, {
				organizationId,
				conversationId: input.conversationId,
				limit,
				offset,
			});
		} catch (error) {
			if (shouldFailSoftHomeRunSetRead(error)) {
				console.warn("[kernelRuntime] run-set read failed", {
					organizationId,
					conversationId: input.conversationId,
					error: errorMessage(error),
				});
				return {
					runSet: emptyKernelRunSet({
						conversationId: input.conversationId,
						organizationId,
					}),
				};
			}
			throw error;
		}
		const [childRunStatuses, approvalMirrorRows] = await Promise.all([
			readChildRunStatusesForRunRows(context, rows),
			listActiveKernelApprovalMirrors(context.db, {
				organizationId,
				parentConversationId: input.conversationId,
				limit: 100,
			}).catch((error) => {
				// Rebuildable rendering projection: never let its absence or a
				// transient read failure take down the canonical Home run-set.
				console.warn("[kernelRuntime] approval-mirror read failed", {
					organizationId,
					conversationId: input.conversationId,
					error: errorMessage(error),
				});
				return undefined;
			}),
		]);
		const reconciledRows = await reconcileHomeRunRowsFromChildStatus(context, {
			childRunStatuses,
			rows,
		});
		const reconciliation = summarizeRunSetReconciliation(rows, reconciledRows);
		if (reconciliation) {
			console.info("[kernelRuntime] run-set reconciliation applied", {
				organizationId,
				conversationId: input.conversationId,
				...reconciliation,
			});
		}
		const fullRuns = await withDelegatedRunSettledCharges(
			context,
			organizationId,
			reconciledRows.map((row) =>
				normalizeHomeRunRecord(row, childRunStatuses),
			),
		);
		// Summary mode: shed the per-run `metadata` bags and
		// the approval-mirror rendering projection — both optional in the schema
		// and both bulk a scanning agent never needed. Identity, status, timing,
		// progress, and usage survive untouched.
		const runs = input.summary
			? fullRuns.map(({ metadata: _metadata, ...run }) => run)
			: fullRuns;
		return {
			runSet: {
				activeRunIds: runs
					.filter((run) => isActiveHomeRunStatus(run.status))
					.map((run) => run.id),
				conversationId: input.conversationId,
				organizationId,
				runs,
				...(approvalMirrorRows && !input.summary
					? {
							approvalMirrors: Object.fromEntries(
								approvalMirrorRows.map((mirror) => [mirror.id, mirror]),
							),
						}
					: {}),
				updatedAt: runs[0]?.updatedAt ?? null,
				metadata: {
					source: "kernelRuntime.readRunSet",
					model: "kernel_runtime_runs",
				},
			},
		};
	});

/**
 * Attach each delegated run's own settled EUR charges. Delegated work reserves
 * credits under the child run, so that id is the charge key. Fail-soft: a
 * charge read failure leaves `settledCharge` absent instead of failing the set.
 */
async function withDelegatedRunSettledCharges(
	context: BaseContext,
	organizationId: string,
	runs: HomeRun[],
): Promise<HomeRun[]> {
	const childRunIds = runs.flatMap((run) =>
		run.childRunId ? [run.childRunId] : [],
	);
	if (!childRunIds.length) return runs;
	let byRun: Awaited<ReturnType<typeof sumRunInferenceChargesByRun>>;
	try {
		byRun = await sumRunInferenceChargesByRun(context.db, {
			organizationId,
			runIds: childRunIds,
		});
	} catch (error) {
		console.warn("[kernelRuntime] delegated run charge read failed", {
			organizationId,
			error: errorMessage(error),
		});
		return runs;
	}
	return runs.map((run) => {
		const charge = run.childRunId ? byRun.get(run.childRunId) : undefined;
		return charge && charge.chargeCount > 0
			? { ...run, settledCharge: { currency: "eur" as const, ...charge } }
			: run;
	});
}

/** Bounds the run scan for one conversation's charge total. */
const CONVERSATION_CHARGE_RUN_PAGE = 100;
const CONVERSATION_CHARGE_RUN_PAGES = 20;

export const readConversationChargesRoute = authed.readConversationCharges
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "read",
		});
		const runIds: string[] = [];
		let runCount = 0;
		for (let page = 0; page < CONVERSATION_CHARGE_RUN_PAGES; page++) {
			const rows = await listKernelRuntimeRuns(context.db, {
				organizationId,
				conversationId: input.conversationId,
				orderBy: "created",
				limit: CONVERSATION_CHARGE_RUN_PAGE,
				offset: page * CONVERSATION_CHARGE_RUN_PAGE,
			});
			runCount += rows.length;
			for (const row of rows) {
				runIds.push(row.id);
				// Delegated work reserves credits under the child run.
				if (row.childRunId) runIds.push(row.childRunId);
			}
			if (rows.length < CONVERSATION_CHARGE_RUN_PAGE) break;
		}
		const charges = await sumRunInferenceCharges(context.db, {
			organizationId,
			runIds,
		});
		return { currency: "eur" as const, runCount, ...charges };
	});

/** Show every held delegation's review window, stamped or derived from the org TTL. */
function withHomeDelegationExpiry<
	T extends { createdAt: string | null; metadata: unknown },
>(run: T, approvalTtlHours: number | undefined): T {
	const metadata = run.metadata as Record<string, unknown> | null;
	const delegation = metadata?.homeDelegation as
		| Record<string, unknown>
		| null
		| undefined;
	if (!metadata || !delegation || typeof delegation.expiresAt === "string")
		return run;
	const expiresAt = homeDelegationApprovalExpiresAt(
		{ createdAt: run.createdAt, metadata },
		approvalTtlHours,
	);
	return expiresAt
		? {
				...run,
				metadata: {
					...metadata,
					homeDelegation: { ...delegation, expiresAt },
				},
			}
		: run;
}

export const listPendingHomeDelegationsRoute = authed.listPendingHomeDelegations
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		if (context.userRole !== "owner" && context.userRole !== "admin") {
			return {
				runSet: emptyKernelRunSet({
					conversationId: "__pending-home-delegations__",
					organizationId,
				}),
			};
		}
		const candidates = await listPendingDelegationRuns(context.db, {
			organizationId,
			limit: input.limit ?? 50,
			kind: "home_delegation",
		});
		const approvalTtlHours =
			candidates.length > 0
				? resolveApprovalTtlHours(
						await readOrgGovernancePolicy(context, organizationId),
					)
				: undefined;
		const visible = [];
		for (const candidate of candidates) {
			try {
				await ensureHomeConversationAccess(context, {
					conversationId: candidate.conversationId,
					organizationId,
					required: "read",
				});
				visible.push(
					normalizeHomeRunRecord(
						withHomeDelegationExpiry(candidate, approvalTtlHours),
					),
				);
			} catch {
				// A global inbox must fail closed for private conversations.
			}
		}
		return {
			runSet: {
				...emptyKernelRunSet({
					conversationId: "__pending-home-delegations__",
					organizationId,
				}),
				runs: visible,
				updatedAt: visible[0]?.updatedAt ?? null,
			},
		};
	});

export const readChildRunEvidenceRoute = authed.readChildRunEvidence
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const owner = await getOrganizationTedi(context.db, {
			id: input.delegatedTediId,
			organizationId,
		});
		if (!owner) {
			throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
		}
		const eventLimit = input.limit ?? 100;
		const artifactLimit = input.artifactLimit ?? 25;
		// T1.5: populated flag — cross-ref kernelRuntimeRuns to distinguish a
		// known-dispatched run with 0 ledger rows (populated:false) from one that
		// simply hasn't been indexed yet (populated:undefined). Uses the
		// (delegatedTediId, childRunId) index (schema line 259-260).
		// Looked up BEFORE readChildRunEvidenceRows so its id can be passed as
		// kernelRunId: egress events are recorded with runId = this id (the
		// kernel delegation row PK), not childRunId.
		let dispatched:
			| {
					id: string;
					metadata: KernelRuntimeRun["metadata"];
					runtimeMetadata: KernelRuntimeRun["runtimeMetadata"];
			  }
			| undefined;
		try {
			dispatched = await findKernelRuntimeRunByChild(context.db, {
				organizationId,
				delegatedTediId: input.delegatedTediId,
				childRunId: input.childRunId,
			});
		} catch {
			// Fail-soft: leave dispatched undefined rather than blocking the read.
		}
		let evidenceRows: ChildRunEvidenceRows;
		// T1.5: track whether the evidence store was reachable.
		let storeHealthy = true;
		try {
			evidenceRows = await readChildRunEvidenceRows(context, {
				artifactLimit,
				eventLimit,
				includeMappedWorkstationRun: true,
				kernelRunId: dispatched?.id,
				organizationId,
				runId: input.childRunId,
				tediId: input.delegatedTediId,
			});
		} catch (error) {
			if (shouldFailSoftChildEvidenceRead(error)) {
				console.warn("[kernelRuntime] child run evidence read failed", {
					organizationId,
					runId: input.childRunId,
					tediId: input.delegatedTediId,
					error: errorMessage(error),
				});
				evidenceRows = {
					artifactRows: [],
					eventRows: [],
					observedRunIds: [input.childRunId],
				};
				storeHealthy = false;
			} else {
				throw error;
			}
		}
		const { artifactRows, eventRows, observedRunIds } = evidenceRows;
		const summary = summarizeChildRuntimeEvents(eventRows);
		const status = childRunStatusFromSummary(summary);
		const terminalEventKind =
			(summary?.childRunTerminalEventKind as
				| HomeChildRunEvidence["terminalEventKind"]
				| undefined) ?? null;
		const knownDispatched = Boolean(dispatched);
		const populated: boolean | undefined =
			eventRows.length > 0 ? true : knownDispatched ? false : undefined;
		const workItemId =
			stringFromPayload(nonNullRecord(dispatched?.metadata)?.workItemId) ??
			stringFromPayload(
				nonNullRecord(dispatched?.runtimeMetadata)?.workItemId,
			) ??
			null;
		return {
			evidence: {
				organizationId,
				delegatedTediId: input.delegatedTediId,
				childRunId: input.childRunId,
				workItemId,
				observedRunIds,
				status,
				latestEventAt:
					(summary?.childRunLatestEventAt as string | null | undefined) ?? null,
				latestEventKind:
					(summary?.childRunLatestEventKind as
						| HomeChildRunEvidence["latestEventKind"]
						| undefined) ?? null,
				terminalAt:
					(summary?.childRunTerminalAt as string | null | undefined) ?? null,
				terminalEventKind,
				stopReason:
					(summary?.childRunStopReason as string | null | undefined) ?? null,
				preview:
					(summary?.childRunPreview as string | null | undefined) ?? null,
				events: eventRows.map(normalizeChildRuntimeEvent),
				artifacts: artifactRows.map(normalizeChildArtifact),
				control: childRunControlForStatus(status),
				...(populated !== undefined
					? {
							populated,
						}
					: {}),
				storeHealthy,
			},
		};
	});

export const readChildRunTreeRoute = authed.readChildRunTree
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			conversationId: input.conversationId,
			organizationId,
			required: "read",
		});
		const limit = input.limit ?? 50;
		let rows: KernelRuntimeRun[];
		try {
			rows = await listKernelRuntimeRuns(context.db, {
				organizationId,
				conversationId: input.conversationId,
				limit,
			});
		} catch (error) {
			if (shouldFailSoftHomeRunSetRead(error)) {
				console.warn("[kernelRuntime] child-run tree read failed", {
					organizationId,
					conversationId: input.conversationId,
					error: errorMessage(error),
				});
				return {
					tree: buildHomeChildRunTree({
						organizationId,
						conversationId: input.conversationId,
						runs: [],
					}),
				};
			}
			throw error;
		}
		const childRunStatuses = await readChildRunStatusesForRunRows(
			context,
			rows,
		);
		const runs = rows.map((row) =>
			normalizeHomeRunRecord(row, childRunStatuses),
		);
		const baseTree = buildHomeChildRunTree({
			organizationId,
			conversationId: input.conversationId,
			runs,
		});
		const tree = await augmentTreeWithFanoutChildren(context, baseTree, rows);
		return {
			tree,
		};
	});

export const resolveDelegationWorkOrderRoute = authed.resolveDelegationWorkOrder
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		return resolveKernelWorkstationAttachWorkOrder(context, {
			approvalRequestId: input.approvalRequestId,
			organizationId,
			resolution: input.resolution,
			status: input.status,
		});
	});

export const approvePlanAssignmentsRoute = authed.approvePlanAssignments
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		return approveHomePlanAssignmentsCore(context, {
			organizationId,
			homeRunId: input.runId,
			assignmentIds: input.assignmentIds,
			dispatch: input.dispatch,
			approvalNote: input.approvalNote,
		});
	});

export const readRunRoute = authed.readRun
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		let row: KernelRuntimeRun | undefined;
		try {
			row = await getKernelRuntimeRun(context.db, {
				id: input.runId,
				organizationId,
			});
			if (!row) {
				// A completion notice may name a delegated child. Its parent owns
				// the Home result and the conversation ACL checked below.
				const [child] = await listHomeRunFinishedEvents(context.db, {
					organizationId,
					runId: input.runId,
					limit: 1,
					head: true,
				});
				if (child?.parentRunId)
					row = await getKernelRuntimeRun(context.db, {
						organizationId,
						id: child.parentRunId,
					});
			}
		} catch (error) {
			if (shouldFailSoftHomeRunSetRead(error)) {
				console.warn("[kernelRuntime] run read failed", {
					organizationId,
					homeRunId: input.runId,
					error: errorMessage(error),
				});
				throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
			}
			throw error;
		}
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: row.conversationId,
			organizationId,
			required: "read",
		});
		const childRunStatuses = await readChildRunStatusesForRunRows(context, [
			row,
		]);
		const [reconciledRow = row] = await reconcileHomeRunRowsFromChildStatus(
			context,
			{
				childRunStatuses,
				rows: [row],
			},
		);
		return {
			run: normalizeHomeRunRecord(reconciledRow, childRunStatuses),
		};
	});

export const readRunTraceRoute = authed.readRunTrace
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const row = await getKernelRuntimeRun(context.db, {
			id: input.runId,
			organizationId,
		});
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: row.conversationId,
			organizationId,
			required: "read",
		});
		return {
			trace: await assembleHomeRunTrace(context, row),
		};
	});
