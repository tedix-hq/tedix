import { AUTHZ, ErrorCodes, createError } from "../../orpc";
import {
	ProvisioningHttpError,
	cancelRuntimeTurn,
	getAgentDiagnostics,
	injectAgentMessage,
} from "@tedix/provisioning";
import type { RunTerminalReason } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type VoiceSttEnv,
	resolveVoiceMessageContent,
	transcribeAudioAttachment,
} from "@tedix/voice/stt";
import {
	getApprovalRequestById,
	resolveApprovalRequest,
} from "@tedix/db/queries/approvals";
import { getProvisioningConfig } from "../tedis/helpers";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	listTediApprovalRequests,
	updateChatDispatchRunId,
	upsertChatDispatchIdempotency,
} from "@tedix/db/queries/cognitive-runtime";
import { predictAgentRunId } from "../kernel/runtime-shared";
import {
	recordTediSubmissionStarted,
	requestRunAbort,
	settleTediSubmission,
} from "../../../kernel/runtime-submission-bridge";
import {
	resolveRuntimeApprovalTimeout,
	runtimeApprovalAuditAction,
	runtimeApprovalResolutionStatus,
	runtimeApprovalResolvedPayload,
} from "@tedix/api-contract/utils/approval-policy";
import { settleRepoCommitApprovalIfNeeded } from "../kernel/repo-commit-approval-settle";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	approvalAuditActor,
	authed,
	healthForIsolateTedi,
	insertRuntimeEvent,
	nextCursor,
	nonNullRecord,
	normalizeApprovalRequest,
	normalizeMessageAttachments,
	normalizeTediConversationId,
	nowIso,
	requireTediAccess,
} from "./events-policy";

export const enqueueMessageRoute = authed.enqueueMessage
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		// Schema allows empty content so attachment-only sends (voice notes
		// record "" typed text) pass; a message still needs SOMETHING to act on.
		if (!input.content.trim() && !input.attachments?.length) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Message content or attachment required",
			);
		}
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured",
			);
		}
		const createdAt = nowIso();
		const conversationId = normalizeTediConversationId(input.conversationId);
		const messageId = crypto.randomUUID();
		const metadata = nonNullRecord(input.metadata) ?? {};
		// inbox-wake synthetic turns skip voice-transcription (content is already
		// a plain system string) and the isolate preflight check (the DO delivers
		// even when a health probe would stale-fail a cold isolate).
		const dispatchMode =
			typeof metadata.dispatchMode === "string" ? metadata.dispatchMode : null;
		const isInboxWakeTurn = dispatchMode === "kernel-inbox-wake";
		const { content: dispatchContent, voiceTranscript } = isInboxWakeTurn
			? {
					content: input.content,
					voiceTranscript: undefined,
				}
			: await resolveVoiceMessageContent({
					env: context.env as unknown as VoiceSttEnv,
					content: input.content,
					attachments: input.attachments,
					logContext: "cognitiveRuntime.enqueueMessage",
					transcribe: transcribeAudioAttachment,
					gatewayMetadata: {
						orgId: tedi.organizationId,
						tediId: tedi.id,
						source: "voice-stt",
						usage: JSON.stringify({
							k: "voice_stt",
							u: "units",
							q: 1,
						}),
					},
				});
		const attachments = normalizeMessageAttachments(input.attachments);
		const turnMetadata = voiceTranscript
			? {
					...metadata,
					voiceTranscript,
				}
			: metadata;
		const runtimeBackend = "cloudflare-agents" as const;
		const runtimeMetadata = {
			source: "cognitiveRuntime.enqueueMessage",
			dispatch: "tedi.isolate.inject",
			...metadata,
		};

		// PREFLIGHT: check D1-cached lifecycle health before writing ledger rows.
		// `healthForIsolateTedi` is a cheap read of already-loaded tedi fields.
		//
		// - unreachable/stopped → bail immediately (runtime_unavailable); the
		//   isolate body is known-dead and inject would 503 anyway.
		// - starting (status=provisioning) → attempt one active /__admin/agent-diag
		//   probe with a tight timeout; if it fails, treat as unavailable.
		// - healthy/degraded → proceed unchanged (zero added latency on hot path).
		// kernel-inbox-wake turns skip preflight — they are synthetic system turns
		// injected by the DO alarm and must deliver regardless of the cached health.
		if (!isInboxWakeTurn) {
			const preflightHealth = healthForIsolateTedi(tedi);
			let bootStatus: "runtime_unavailable" | "runtime_starting" | "ok" =
				preflightHealth === "unreachable" || preflightHealth === "stopped"
					? "runtime_unavailable"
					: preflightHealth === "starting"
						? "runtime_starting"
						: "ok";
			if (bootStatus === "runtime_starting") {
				// Active probe — 3s hard cap so a cold/slow runtime doesn't block.
				try {
					await Promise.race([
						getAgentDiagnostics(provConfig),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("preflight timeout")), 3000),
						),
					]);
					bootStatus = "ok";
				} catch {
					bootStatus = "runtime_unavailable";
				}
			}
			if (bootStatus === "runtime_unavailable") {
				console.warn(
					"[cognitiveRuntime.enqueueMessage] preflight: isolate unreachable — skipping dispatch",
					{
						tediId: input.tediId,
						tediStatus: tedi.status,
					},
				);
				await insertRuntimeEvent(context, {
					organizationId: tedi.organizationId,
					tediId: input.tediId,
					kind: "run.failed",
					conversationId,
					runId: input.idempotencyKey,
					messageId,
					payload: {
						error: "Runtime preflight failed: tedi is unreachable or stopped",
						reason: "runtime_unavailable" satisfies RunTerminalReason,
					},
					runtimeBackend,
					runtimeExternalId: input.idempotencyKey,
					runtimeMetadata: {
						...runtimeMetadata,
						preflightOnly: true,
					},
				});
				return {
					idempotencyKey: input.idempotencyKey,
					conversationId,
					status: "failed" as const,
					reason: "runtime_unavailable" as const,
					error: "Runtime preflight failed: tedi is unreachable or stopped",
				};
			}
		}

		// Pre-write the idempotency row so even if the bridge timeline
		// races the first event ingest, the mapping is visible. Bridge
		// also writes (UPSERT semantics via primary key conflict path).
		try {
			await upsertChatDispatchIdempotency(context.db, {
				idempotencyKey: input.idempotencyKey,
				tediId: input.tediId,
				organizationId: tedi.organizationId,
				conversationId,
				status: "queued",
				createdAt,
			});
		} catch (error) {
			console.warn(
				"[cognitiveRuntime.enqueueMessage] failed to write idempotency row",
				error instanceof Error ? error.message : error,
			);
		}

		// The Agent runtime's ledger-mirror writes the full run chain under the
		// REAL run id (`{tediId}:mcp:{sanitized(idempotencyKey)}`). A pre-write
		// keyed off the RAW idempotency key would never match and strand a
		// forever-queued pair that sweepOrphanRuns later false-seals as run.failed.
		// Let the body own the ledger.
		//
		// Ledger pre-admit: `predictAgentRunId` computes
		// the SAME deterministic id the isolate will independently derive from
		// this exact `clientRequestId` (both funnel through the shared
		// `buildRuntimeRunId`, and its sanitizer is idempotent, so pre- vs
		// post-sanitize order never diverges the two ids). Admitting under that
		// id — instead of only at the isolate's own `run.started` echo below —
		// means a crash between accepting this request and the isolate's queue
		// actually taking it is a ledgered, requeue-eligible row instead of an
		// invisible loss. `recordTediSubmissionStarted`/`admitSubmission` are
		// idempotent on this deterministic id, so the choke-point admit at
		// `run.started` (below) safely no-ops into the same row — this is not a
		// new race, it's a third caller into an already-proven-safe idempotent
		// path (the isolate's own ledger-mirror admit already races the same
		// admit today). Fail-soft: a prediction/pre-admit failure must never
		// block dispatch — the choke-point admit is the fallback of record.
		let predictedRunId: string | undefined;
		let submissionPreAdmitted = false;
		try {
			// The isolate's OWN `buildRunId(tediId, ...)` call (apps/tedi-runtime)
			// uses ITS identity — `isolate_agent_id` (the DO key), falling back to
			// `slug` when unset, exactly mirroring `resolveIdentityFromD1` in
			// apps/tedi-runtime/src/do.ts. The D1 primary key (`input.tediId`,
			// used below for the ledger row's own subject identity) is a
			// DIFFERENT value and must never be used here — using it would predict
			// a run id the isolate will never actually report, silently stranding
			// this pre-admitted row forever instead of matching the choke-point
			// admit.
			predictedRunId = predictAgentRunId({
				clientRequestId: input.idempotencyKey,
				tediId: tedi.isolateAgentId ?? tedi.slug ?? input.tediId,
			});
			await recordTediSubmissionStarted(context.db, {
				tediId: input.tediId,
				runId: predictedRunId,
				organizationId: tedi.organizationId,
				conversationId,
				runtimeBackend,
			});
			submissionPreAdmitted = true;
		} catch (error) {
			console.warn(
				"[cognitiveRuntime.enqueueMessage] ledger pre-admit failed; dispatch continues, choke-point admit remains the fallback",
				error instanceof Error ? error.message : error,
			);
		}

		// Always use async-supervised inject so callers get a quick accept
		// instead of being capped by the synchronous inject request lifetime.
		try {
			const result = await injectAgentMessage(provConfig, {
				message: dispatchContent,
				session: conversationId,
				...(attachments?.length
					? {
							attachments,
						}
					: {}),
				clientRequestId: input.idempotencyKey,
				metadata,
				async: true,
			}).then((injected) => ({
				success: injected.success,
				error: injected.error,
				idempotencyKey: input.idempotencyKey,
				conversationId: injected.session_key ?? conversationId,
				runId: injected.run_id,
				status: injected.success ? ("queued" as const) : ("failed" as const),
			}));
			if (!result.success) {
				// Settle the pre-admitted row (if any) under the SAME predicted id —
				// never `input.idempotencyKey`, which is not what was pre-admitted.
				// No terminal ledger event will ever reference `predictedRunId` on
				// this path (the `run.failed` event below is keyed off the raw
				// idempotency key, matching today's behavior), so without this the
				// pre-admitted row would sit `running` until the 15-min timeout sweep.
				if (predictedRunId) {
					await settleTediSubmission(context.db, {
						runId: predictedRunId,
						organizationId: tedi.organizationId,
						outcome: "failed",
						error: result.error ?? "enqueue rejected by tedi gateway",
					});
				}
				await insertRuntimeEvent(context, {
					organizationId: tedi.organizationId,
					tediId: input.tediId,
					kind: "run.failed",
					conversationId,
					runId: input.idempotencyKey,
					messageId,
					payload: {
						error: result.error ?? "enqueue rejected by tedi gateway",
						reason: "dispatch_failed" satisfies RunTerminalReason,
					},
					runtimeBackend,
					runtimeExternalId: input.idempotencyKey,
					runtimeMetadata,
				});
				return {
					idempotencyKey: input.idempotencyKey,
					conversationId,
					runId: result.runId,
					status: "failed" as const,
					error: result.error ?? "enqueue rejected by tedi gateway",
					reason: "dispatch_failed" as const,
				};
			}
			if (result.runId) {
				const sessionKey = result.conversationId ?? conversationId;
				const ledgerPrefix = tedi.slug || tedi.id;
				const ledgerConversationId = sessionKey.startsWith(`${ledgerPrefix}:`)
					? sessionKey
					: `${ledgerPrefix}:${sessionKey}`;
				try {
					if (typeof context.db.update === "function") {
						await updateChatDispatchRunId(context.db, {
							idempotencyKey: input.idempotencyKey,
							runId: result.runId,
							mappedAt: nowIso(),
						});
					}
				} catch (error) {
					console.warn(
						"[cognitiveRuntime.enqueueMessage] failed to map isolate run id",
						error instanceof Error ? error.message : error,
					);
				}
				await insertRuntimeEvent(context, {
					id: `${result.runId}:0`,
					organizationId: tedi.organizationId,
					tediId: input.tediId,
					kind: "message.received",
					conversationId: ledgerConversationId,
					runId: result.runId,
					messageId,
					sequence: 0,
					payload: {
						role: "user",
						content: dispatchContent,
						attachments,
						metadata: turnMetadata,
					},
					runtimeBackend,
					runtimeExternalId: input.idempotencyKey,
					runtimeMetadata,
					createdAt,
				});
				await insertRuntimeEvent(context, {
					id: `${result.runId}:1`,
					organizationId: tedi.organizationId,
					tediId: input.tediId,
					kind: "run.started",
					conversationId: ledgerConversationId,
					runId: result.runId,
					messageId,
					sequence: 1,
					payload: {
						status: "queued",
						inputMessageId: messageId,
					},
					runtimeBackend,
					runtimeExternalId: input.idempotencyKey,
					runtimeMetadata,
					createdAt,
				});
			}
			return {
				idempotencyKey: input.idempotencyKey,
				conversationId,
				runId: result.runId,
				status: "queued" as const,
			};
		} catch (error) {
			const message =
				error instanceof ProvisioningHttpError
					? error.message
					: error instanceof Error
						? error.message
						: "Failed to enqueue tedi message";
			// A client-side deadline does NOT prove the service-binding request was
			// rejected. Cloudflare can keep delivering it after our AbortSignal fires;
			// that is exactly what happens while a cold Agent DO finishes identity
			// hydration. The deterministic submission was durably admitted before the
			// request, so keep supervising that same run. Its terminal runtime event
			// will settle it, or the submission recovery sweep can safely requeue a
			// provably pre-input attempt. Never retry here: the delivery outcome is
			// unknown and a replacement request could duplicate side effects.
			if (
				error instanceof ProvisioningHttpError &&
				error.timedOut &&
				submissionPreAdmitted &&
				predictedRunId
			) {
				console.warn(
					"[cognitiveRuntime.enqueueMessage] runtime admission timed out; preserving pre-admitted run for reconciliation",
					{ tediId: input.tediId, runId: predictedRunId },
				);
				try {
					await updateChatDispatchRunId(context.db, {
						idempotencyKey: input.idempotencyKey,
						runId: predictedRunId,
						mappedAt: nowIso(),
					});
				} catch (mappingError) {
					console.warn(
						"[cognitiveRuntime.enqueueMessage] failed to map outcome-unknown run id",
						mappingError instanceof Error ? mappingError.message : mappingError,
					);
				}
				return {
					idempotencyKey: input.idempotencyKey,
					conversationId,
					runId: predictedRunId,
					status: "queued" as const,
				};
			}
			// Same fallback-settle rationale as the `!result.success` branch above
			// for definite failures: without a durable ambiguous-timeout admission,
			// there is no supervised run to preserve, so close the pre-admitted row.
			if (predictedRunId) {
				await settleTediSubmission(context.db, {
					runId: predictedRunId,
					organizationId: tedi.organizationId,
					outcome: "failed",
					error: message,
				});
			}
			await insertRuntimeEvent(context, {
				organizationId: tedi.organizationId,
				tediId: input.tediId,
				kind: "run.failed",
				conversationId,
				runId: input.idempotencyKey,
				messageId,
				payload: {
					error: message,
					reason: "dispatch_failed" satisfies RunTerminalReason,
				},
				runtimeBackend,
				runtimeExternalId: input.idempotencyKey,
				runtimeMetadata,
			});
			return {
				idempotencyKey: input.idempotencyKey,
				conversationId,
				status: "failed" as const,
				error: message,
				reason: "dispatch_failed" as const,
			};
		}
	});

export const listApprovalsRoute = authed.listApprovals
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const limit = input.limit ?? 100;
		const status =
			input.status === "canceled" ? "cancelled" : (input.status ?? "pending");
		const rows = await listTediApprovalRequests(context.db, {
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			status,
			before: input.cursor,
			limit,
		});
		return {
			approvals: rows.map(normalizeApprovalRequest),
			nextCursor: nextCursor(rows, limit),
		};
	});

export const stopRunRoute = authed.stopRun
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured",
			);
		}

		// The run is a CHAT_TURN_WORKFLOW instance on the Agent runtime. Terminate
		// the durable Workflow instance directly via `/hooks/cancel-turn` on the
		// tedi-runtime Worker — fail-soft: an already-terminal or missing instance
		// is treated as success (the child has already settled).
		//
		// clientRequestId is the 3rd colon-delimited segment of the runId:
		// buildRuntimeRunId produces `{tediId}:mcp:{sanitizeTurnKey(clientRequestId)}`
		// where tediId is a hyphen-only UUID (no colons) and the surface is "mcp".
		const turnKey = input.runId.split(":")[2] ?? input.runId;
		// Durable abort intent BEFORE the runtime RPC: a
		// runtime-unreachable cancel used to be lost with the throw below — the
		// stamp survives it, and recovery honors it (abort beats requeue/lease).
		// Fail-soft: never blocks the cancel.
		await requestRunAbort(context.db, {
			runId: input.runId,
			organizationId: tedi.organizationId,
			reason: input.reason ?? null,
		});
		let cancelResult: {
			success: boolean;
			detail?: string;
			error?: string;
		};
		try {
			cancelResult = await cancelRuntimeTurn(provConfig, {
				clientRequestId: turnKey,
				runId: input.runId,
			});
		} catch (error) {
			if (error instanceof ProvisioningHttpError) {
				if (error.status === 400) {
					throw createError(ErrorCodes.BAD_REQUEST, error.message, error);
				}
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					`Tedi runtime is unavailable (status ${error.status}); retry later.`,
					error,
				);
			}
			throw error;
		}
		if (!cancelResult.success) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				cancelResult.error ?? "Tedi runtime rejected cancel request",
			);
		}
		const event = await insertRuntimeEvent(context, {
			organizationId: tedi.organizationId,
			tediId: input.tediId,
			kind: "run.canceled",
			conversationId: input.conversationId,
			runId: input.runId,
			payload: {
				status: "canceled",
				reason: input.reason,
			},
			runtimeExternalId: input.runId,
			runtimeMetadata: {
				source: "cognitiveRuntime.stopRun",
				dispatch: "tedi.isolate.cancel-turn",
				cancelDetail: cancelResult.detail ?? null,
			},
		});
		return {
			ok: true,
			event,
		};
	});

export const approveRoute = authed.approve
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const metadata = nonNullRecord(input.metadata) ?? {};
		const status = runtimeApprovalResolutionStatus(input.approved);
		const approval = await getApprovalRequestById(
			context.db,
			input.approvalRequestId,
		);
		if (!approval) {
			throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
		}
		const timeout = resolveRuntimeApprovalTimeout({
			status: approval.status,
			expiresAt: approval.expiresAt,
		});
		if (timeout.expired) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`This approval request has expired; timeout policy defaulted to deny (${timeout.reason})`,
			);
		}
		const resolved = await resolveApprovalRequest(
			context.db,
			input.approvalRequestId,
			{
				status,
				resolvedBy: context.user?.sub ?? context.tediId ?? "system",
				resolution: input.resolution,
			},
		);
		if (!resolved) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Failed to resolve request. It may have already been resolved.",
			);
		}
		const eventPayload = runtimeApprovalResolvedPayload({
			approved: input.approved,
			resolution: input.resolution,
			metadata,
		});
		const event = await insertRuntimeEvent(context, {
			organizationId: tedi.organizationId,
			tediId: input.tediId,
			kind: "approval.resolved",
			approvalRequestId: input.approvalRequestId,
			payload: eventPayload,
			runtimeExternalId: input.approvalRequestId,
			runtimeMetadata: {
				source: "cognitiveRuntime.approve",
				dispatch: "approval.d1.resolve",
			},
		});
		const actor = approvalAuditActor(context);
		await insertAuditEvent(context.db, {
			organizationId: tedi.organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: runtimeApprovalAuditAction({
				status,
			}),
			resourceType: "approval_request",
			resourceId: input.approvalRequestId,
			metadata: toJsonRecord({
				tediId: input.tediId,
				actionType: resolved.actionType,
				approvalStatus: status,
				resolution: input.resolution,
				runtimeEventId: event.id,
				...metadata,
			}),
		});
		await settleRepoCommitApprovalIfNeeded(context, {
			approval: resolved,
			status,
		});
		return {
			ok: true,
			event,
		};
	});
