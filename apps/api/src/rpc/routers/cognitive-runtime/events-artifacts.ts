import { AUTHZ, ErrorCodes, createError, withAuthorization } from "../../orpc";
import {
	ProvisioningHttpError,
	getAgentDiagnostics,
} from "@tedix/provisioning";

import {
	decodeRuntimeEventCursor,
	type TediLivenessVerdict,
	type TediRuntimeStatus,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import { bestRuntimeText } from "@tedix/api-contract/utils/runtime-events";
import {
	findDirectKernelParentRun,
	claimTediArtifact,
	getTediArtifact,
	getTediArtifactClaim,
	listRecentKernelRunsForOrganization,
	listTediArtifacts,
	markTediArtifactPublished,
	listTediRuntimeEventsForRouter,
	patchOldestQueuedDispatchRunId,
	TediArtifactOwnershipConflictError,
	upsertChatDispatchIdempotency,
} from "@tedix/db/queries/cognitive-runtime";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { getOsGadgetExecutionByRunId } from "@tedix/db/queries/os-workspaces/executions";
import {
	recordTediArtifactContributionReceipt,
	TediArtifactContributionReceiptConflictError,
} from "@tedix/db/queries/artifact-policy/contributions";
import { parseOwnedReadObservations } from "@tedix/mcp-shared/read-observation-receipt";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { auditActor } from "../../audit-helpers";
import { resolveProducer } from "../os-workspaces-shared";
import { getProvisioningConfig } from "../tedis/helpers";
import { guessBundleContentType } from "../../../lib/artifact-serve";
import {
	inspectArtifactUriOwnership,
	isOwnedArtifactR2Uri,
} from "../../../lib/artifact-uri-ownership";
import { readOptionalHomePlanFromRun } from "../kernel/home-plan";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	DEFAULT_RUNTIME_BACKEND,
	authed,
	healthForIsolateTedi,
	insertRuntimeEvent,
	isWorkstationEgressEventKind,
	mappedDispatchRunIds,
	nextCursor,
	nextRuntimeEventCursor,
	nonNullRecord,
	normalizeArtifact,
	isTrustedRuntimeArtifactCaller,
	normalizeRuntimeEvent,
	normalizeTediConversationIdForRead,
	notifyKernelChildApprovalBlock,
	notifyKernelChildComplete,
	nowIso,
	requireTediAccess,
	resolveTediRuntimeBackend,
	serviceAuthed,
	stringFromPayload,
} from "./events-policy";
import {
	findCompletedMessageForRun,
	promoteLatestDeltaToCompletedMessage,
	recordWorkstationEgressTraceBundle,
	repairCompletedMessageContent,
} from "./recovery-artifacts";
import {
	isCompactionEventKind,
	startCompactionReflection,
} from "../../../services/compaction-reflection";

export const getStatusRoute = authed.getStatus
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const latestHealthEvent = await listTediRuntimeEventsForRouter(context.db, {
			tediId: input.tediId,
			kind: "runtime.health_changed",
			order: "desc",
			limit: 1,
		});
		const checkedAt = nowIso();
		const backend = "cloudflare-agents" as const;
		const health = healthForIsolateTedi(tedi);
		let agentDiagnostics: Record<string, unknown> | null = null;
		let agentDiagnosticsError: string | null = null;
		{
			const diagProvConfig = getProvisioningConfig(tedi, context.env);
			if (!diagProvConfig) {
				agentDiagnosticsError = "Tedi runtime route is not configured";
			} else {
				try {
					agentDiagnostics = (await getAgentDiagnostics(
						diagProvConfig,
					)) as Record<string, unknown>;
				} catch (error) {
					agentDiagnosticsError =
						error instanceof Error ? error.message : String(error);
				}
			}
		}
		const agentArtifactsDiagnostics =
			agentDiagnostics &&
			"artifacts" in agentDiagnostics &&
			agentDiagnostics.artifacts !== undefined
				? agentDiagnostics.artifacts
				: null;
		const agentMetadata = {
			agentDiagnostics,
			artifacts: agentArtifactsDiagnostics,
			...(agentDiagnosticsError
				? {
						agentDiagnosticsError,
					}
				: {}),
		};

		// T1.4 liveness derivation — uses the attempt marker written by do.ts
		// runLlmRound into DO storage and exposed via /__admin/agent-diag.
		// `alive`: attempt marker present AND lastChunkAt fresh (< FRESH_MS).
		// `maybe-alive`: no fresh chunk marker but tedi.lastActivityAt is recent.
		// `absent`: neither signal is fresh.
		// Only meaningful for isolate tedis (agent-diag is isolate-only).
		const FRESH_MS = 90_000; // above LLM_ROUND_IDLE_TIMEOUT_MS ceiling
		const attempt =
			agentDiagnostics != null &&
			typeof agentDiagnostics === "object" &&
			"attempt" in agentDiagnostics
				? (
						agentDiagnostics as {
							attempt?: unknown;
						}
					).attempt
				: null;
		const lastChunkAtMs =
			attempt != null &&
			typeof attempt === "object" &&
			"lastChunkAt" in attempt &&
			typeof (
				attempt as {
					lastChunkAt?: unknown;
				}
			).lastChunkAt === "string"
				? Date.parse(
						(
							attempt as {
								lastChunkAt: string;
							}
						).lastChunkAt,
					)
				: Number.NaN;
		const lastActivityMs = tedi.lastActivityAt
			? Date.parse(tedi.lastActivityAt)
			: Number.NaN;
		const nowMs = Date.now();
		const livenessVerdict: TediLivenessVerdict =
			Number.isFinite(lastChunkAtMs) && nowMs - lastChunkAtMs < FRESH_MS
				? "alive"
				: Number.isFinite(lastActivityMs) && nowMs - lastActivityMs < FRESH_MS
					? "maybe-alive"
					: "absent";
		const status: TediRuntimeStatus = {
			tediId: input.tediId,
			backend,
			health,
			canonical: {
				health,
				lastActivityAt: tedi.lastActivityAt ?? null,
				lastHeartbeatAt: tedi.lastHeartbeatAt ?? tedi.lastSeenAt ?? null,
				checkedAt,
			},
			lastActivityAt: tedi.lastActivityAt ?? null,
			lastHeartbeatAt: tedi.lastHeartbeatAt ?? tedi.lastSeenAt ?? null,
			checkedAt,
			livenessVerdict,
			backendDiagnostics: {
				backend,
				kind: "adapter",
				health,
				state: tedi.runtimeState ?? tedi.status ?? null,
				metadata: {
					tediStatus: tedi.status,
					runtimeState: tedi.runtimeState,
					runtimeStatus: tedi.runtimeStatus,
					latestHealthEvent: latestHealthEvent[0]
						? normalizeRuntimeEvent(latestHealthEvent[0])
						: null,
					...agentMetadata,
				},
				checkedAt,
				livenessVerdict,
			},
			diagnostics: {
				tediStatus: tedi.status,
				runtimeState: tedi.runtimeState,
				runtimeStatus: tedi.runtimeStatus,
				latestHealthEvent: latestHealthEvent[0]
					? normalizeRuntimeEvent(latestHealthEvent[0])
					: null,
				...agentMetadata,
			},
		};
		return {
			status,
		};
	});

export const getStabilityRoute = authed.getStability
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured",
			);
		}
		const checkedAt = nowIso();
		let diagnostics: Record<string, unknown> = {};
		try {
			diagnostics = await getAgentDiagnostics(provConfig);
		} catch (error) {
			if (error instanceof ProvisioningHttpError) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					`Runtime stability probe failed: ${error.message}`,
				);
			}
			throw error;
		}
		return {
			stability: {
				tediId: input.tediId,
				backend: "cloudflare-agents" as const,
				checkedAt,
				tasks: {
					queue: diagnostics.queue,
					schedules: diagnostics.schedules,
					state: diagnostics.state,
				},
				raw: {
					source: "agent-diagnostics",
					...diagnostics,
				},
			},
		};
	});

export const listEventsRoute = authed.listEvents
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		await requireTediAccess(context, input.tediId);
		const limit = input.limit ?? 100;
		const mappedRunIds = await mappedDispatchRunIds(context, input);
		const conversationId = input.conversationId
			? normalizeTediConversationIdForRead(input.conversationId)
			: undefined;
		const rows = await listTediRuntimeEventsForRouter(context.db, {
			tediId: input.tediId,
			conversationId,
			runId: input.runId,
			runIds:
				input.runId && mappedRunIds.length > 0
					? [input.runId, ...mappedRunIds]
					: undefined,
			kind: input.kind,
			before: input.before
				? decodeRuntimeEventCursor(input.before)!
				: undefined,
			order: "desc",
			limit,
		});
		const events = rows.map(normalizeRuntimeEvent);
		return {
			// Summary mode: same schema, heavy fields shed. `payload` and long
			// `delta` streams dominate raw event reads; both are optional in TediRuntimeEventSchema, so the
			// compact rows stay contract-valid for every consumer.
			events: input.summary
				? events.map(({ payload: _payload, ...event }) => ({
						...event,
						...(typeof event.delta === "string" && event.delta.length > 200
							? { delta: `${event.delta.slice(0, 200)}…` }
							: {}),
					}))
				: events,
			nextBefore: nextRuntimeEventCursor(rows, limit),
		};
	});

export const recordEventRoute = authed.recordEvent
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const createdAt = input.createdAt ?? nowIso();
		const runtimeBackend = input.runtime?.backend ?? DEFAULT_RUNTIME_BACKEND;
		const incomingPayload = nonNullRecord(input.payload);
		const incomingContribution = nonNullRecord(
			incomingPayload?.artifactContributionReceipt,
		);
		if (incomingContribution) {
			const trustedRuntime = isTrustedRuntimeArtifactCaller(
				context,
				input.tediId,
			);
			const rawIds = incomingContribution.artifactIds;
			const validIds =
				Array.isArray(rawIds) &&
				rawIds.length > 0 &&
				rawIds.length <= 20 &&
				rawIds.every(
					(value) =>
						typeof value === "string" &&
						value.length > 0 &&
						value.length <= 500,
				) &&
				new Set(rawIds).size === rawIds.length;
			const rawObservations = incomingContribution.observations;
			const parsedObservations = parseOwnedReadObservations(rawObservations);
			if (!trustedRuntime)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Runtime artifact contribution receipts require the trusted runtime bridge",
				);
			if (
				!input.conversationId ||
				!input.runId ||
				!(["tool.completed", "tool.failed"] as string[]).includes(input.kind) ||
				incomingContribution.version !== 1 ||
				!validIds ||
				!Array.isArray(rawObservations) ||
				parsedObservations.length !== rawObservations.length ||
				!(["observed_prefix", "unavailable"] as unknown[]).includes(
					incomingContribution.completeness,
				)
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Malformed runtime artifact contribution receipt",
				);
		}
		if (input.kind === "message.completed") {
			const existingCompleted = await findCompletedMessageForRun(context, {
				conversationId: input.conversationId,
				runId: input.runId,
				tediId: input.tediId,
			});
			if (existingCompleted) {
				const incomingPayload = nonNullRecord(input.payload) ?? {};
				const incomingContent =
					bestRuntimeText(
						input.delta,
						incomingPayload.content,
						incomingPayload.text,
						incomingPayload.message,
						incomingPayload.data,
					) ?? "";
				return {
					event: await repairCompletedMessageContent(context, {
						existing: existingCompleted,
						content: incomingContent,
						mode: "runtime-completed",
						sourceEventId: input.id,
						sourcePayload: incomingPayload,
					}),
				};
			}
		}
		const event = await insertRuntimeEvent(context, {
			id: input.id,
			organizationId: tedi.organizationId,
			tediId: input.tediId,
			kind: input.kind,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.messageId,
			toolCallId: input.toolCallId,
			approvalRequestId: input.approvalRequestId,
			artifactId: input.artifactId,
			sequence: input.sequence,
			delta: input.delta,
			payload: input.payload,
			runtimeBackend,
			runtimeExternalId: input.runtime?.externalId,
			runtimeExternalUrl: input.runtime?.externalUrl,
			runtimeMetadata: input.runtime?.metadata,
			createdAt,
		});
		const eventPayload = nonNullRecord(event.payload);
		const contribution = nonNullRecord(
			eventPayload?.artifactContributionReceipt,
		);
		if (contribution) {
			const trustedRuntime = isTrustedRuntimeArtifactCaller(
				context,
				input.tediId,
			);
			if (
				!trustedRuntime ||
				!event.conversationId ||
				!event.runId ||
				!incomingContribution ||
				JSON.stringify(eventPayload) !== JSON.stringify(incomingPayload)
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Canonical runtime contribution event does not match this trusted retry",
				);
			}
			const artifactIds = Array.isArray(contribution.artifactIds)
				? contribution.artifactIds.filter(
						(value): value is string =>
							typeof value === "string" &&
							value.length > 0 &&
							value.length <= 500,
					)
				: [];
			const rawObservations = contribution.observations;
			const observations = parseOwnedReadObservations(rawObservations);
			const completeness = contribution.completeness;
			if (
				contribution.version !== 1 ||
				artifactIds.length === 0 ||
				artifactIds.length > 20 ||
				new Set(artifactIds).size !== artifactIds.length ||
				!Array.isArray(rawObservations) ||
				(rawObservations.length > 0 && observations.length === 0) ||
				(completeness !== "observed_prefix" && completeness !== "unavailable")
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Malformed runtime artifact contribution receipt",
				);
			}
			const canonicalObservations = JSON.stringify(observations);
			const persistedObservations = JSON.parse(canonicalObservations);
			const digestBytes = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(canonicalObservations),
			);
			const observationDigest = Array.from(
				new Uint8Array(digestBytes),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			for (const artifactId of artifactIds) {
				const artifact = await getTediArtifactClaim(context.db, artifactId);
				// Earlier detached workstation reads recorded an exact-run private
				// artifact without the child conversation. Permit only those immutable
				// claims to replay against the canonical trusted tool event.
				const legacyWorkstationConversation =
					trustedRuntime &&
					artifact?.conversationId === null &&
					artifact.kind === "log" &&
					artifact.id.startsWith(
						`${event.runId}:artifact:workstation_process:`,
					) &&
					artifact.metadata?.source === "workstation_process" &&
					artifact.metadata?.subKind === "workstation_process" &&
					artifact.metadata?.producer === "workstation-adapter";
				if (
					!artifact ||
					artifact.organizationId !== tedi.organizationId ||
					artifact.tediId !== input.tediId ||
					(!legacyWorkstationConversation &&
						artifact.conversationId !== event.conversationId) ||
					artifact.runId !== event.runId ||
					artifact.accessClassification !== "runtime_private"
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						"Runtime artifact does not match its contribution event",
					);
				}
				// Trusted workstation rows may intentionally remain URI-only. They are
				// private and unverifiable, but must not wedge the terminal outbox.
				if (!artifact.contentDigest && artifact.publicationState === "ready")
					continue;
				if (!artifact.contentDigest)
					throw createError(
						ErrorCodes.CONFLICT,
						"Runtime artifact is not ready for contribution binding",
					);
				try {
					await recordTediArtifactContributionReceipt(context.db, {
						id: `${event.id}:${artifactId}`,
						organizationId: tedi.organizationId,
						tediId: input.tediId,
						artifactId,
						producerRuntimeEventId: event.id,
						conversationId: event.conversationId,
						runId: event.runId,
						contentDigest: artifact.contentDigest,
						observationDigest,
						observations: persistedObservations,
						completeness,
						createdAt: event.createdAt,
						producerEventPayload: toJsonRecord(eventPayload ?? {}),
						allowLegacyNullConversation: legacyWorkstationConversation,
					});
				} catch (error) {
					if (error instanceof TediArtifactContributionReceiptConflictError)
						throw createError(
							ErrorCodes.CONFLICT,
							"Runtime artifact contribution conflicts with its immutable claim",
						);
					throw error;
				}
			}
		}
		if (input.runId && isWorkstationEgressEventKind(event.kind)) {
			const traceBundleWork = recordWorkstationEgressTraceBundle(context, {
				event,
				organizationId: tedi.organizationId,
			}).catch((error) => {
				console.warn(
					"[cognitiveRuntime.recordEvent] workstation egress trace bundle record failed",
					error instanceof Error ? error.message : String(error),
				);
			});
			if (context.waitUntil) {
				context.waitUntil(traceBundleWork);
			} else {
				await traceBundleWork;
			}
		}
		// COMPACTION-TRIGGERED REFLECTION: compaction is the moment context is
		// actually dropped, and the DO already emits exactly one durable
		// `context.compacted` event per real cut. Reflect on THAT conversation
		// now, scoped to that tedi, instead of waiting for the 4am org-wide sweep
		// that has no idea what was lost. Fail-soft and off the response path —
		// a reflection outage must never fail the ledger write that carries the
		// compaction record itself.
		if (isCompactionEventKind(event.kind)) {
			const reflectionWork = startCompactionReflection({
				workflow: context.env.MEMORY_REFLECTION_WORKFLOW,
				eventId: event.id,
				organizationId: tedi.organizationId,
				tediId: input.tediId,
			}).then((outcome) => {
				if (outcome.status === "failed") {
					console.warn(
						"[cognitiveRuntime.recordEvent] compaction reflection failed to start",
						outcome.reason,
					);
				}
			});
			if (context.waitUntil) {
				context.waitUntil(reflectionWork);
			} else {
				await reflectionWork;
			}
		}
		if (input.kind === "run.completed" || input.kind === "message.delta") {
			await promoteLatestDeltaToCompletedMessage(context, {
				completedAt:
					input.kind === "run.completed" ? event.createdAt : undefined,
				conversationId: input.conversationId,
				organizationId: tedi.organizationId,
				runId: input.runId,
				runtimeBackend,
				tediId: input.tediId,
				triggerEventId: event.id,
			});
		}

		// Inbox-wake: when a child run reaches a terminal state and the event
		// carries a homeConversationId in its runtimeMetadata, notify the parent
		// KernelDO so it can inject a synthetic parent turn. Fail-soft.
		if (
			input.runId &&
			(input.kind === "run.completed" ||
				input.kind === "run.failed" ||
				input.kind === "run.canceled")
		) {
			const runtimeMeta = nonNullRecord(input.runtime?.metadata) ?? {};
			const homeConversationId =
				typeof runtimeMeta.homeConversationId === "string" &&
				runtimeMeta.homeConversationId.length > 0
					? runtimeMeta.homeConversationId
					: null;
			let resolvedHomeConversationId = homeConversationId;
			// Fallback: terminal events don't carry homeConversationId in their
			// runtimeMetadata (only message.received does). Direct delegations keep
			// the child id in kernel_runtime_runs.childRunId; multi-tedi plans keep
			// it in metadata.homePlan.assignments. Resolve both shapes so every
			// terminal plan branch durably enters kernel_wake_queue.
			if (!resolvedHomeConversationId) {
				// This lookup is the ONLY chance to queue the parent wake for this
				// terminal event — a transient D1 miss here used to strand the
				// parent run with final_synthesis_missing (the reconcile sweeps
				// only re-drive rows already in kernel_wake_queue). Bounded retry
				// before giving up.
				for (let lookupAttempt = 0; lookupAttempt < 3; lookupAttempt += 1) {
					try {
						const directParent = await findDirectKernelParentRun(context.db, {
							organizationId: tedi.organizationId,
							childRunId: input.runId,
						});
						const parentRow =
							directParent ??
							(
								await listRecentKernelRunsForOrganization(context.db, {
									organizationId: tedi.organizationId,
									limit: 200,
								})
							).find((row) =>
								readOptionalHomePlanFromRun(row)?.assignments.some(
									(assignment) => assignment.childRunId === input.runId,
								),
							);
						if (parentRow?.conversationId) {
							resolvedHomeConversationId = parentRow.conversationId;
						}
						break;
					} catch (error) {
						console.warn(
							"[cognitiveRuntime.recordEvent] inbox-wake parent lookup failed",
							`attempt=${lookupAttempt + 1}`,
							error instanceof Error ? error.message : error,
						);
					}
				}
			}
			if (resolvedHomeConversationId) {
				// Resolve organizationId for the parent org (from the same tedi row
				// already loaded above — the child and parent must be same-org).
				const childStatus =
					input.kind === "run.completed"
						? ("completed" as const)
						: input.kind === "run.failed"
							? ("failed" as const)
							: ("canceled" as const);
				const notifyPromise = notifyKernelChildComplete(context, {
					childRunId: input.runId,
					childStatus,
					childOrganizationId: tedi.organizationId,
					parentOrganizationId: tedi.organizationId,
					parentConversationId: resolvedHomeConversationId,
				}).catch((error) => {
					console.warn(
						"[cognitiveRuntime.recordEvent] inbox-wake notify failed",
						error instanceof Error ? error.message : error,
					);
				});
				if (context.waitUntil) {
					context.waitUntil(notifyPromise);
				} else {
					// No waitUntil (test/direct contexts): the optional chain used to
					// DROP the wake entirely. Await it — this is the parent's only
					// live wake signal.
					await notifyPromise;
				}
			}
		}
		if (
			input.runId &&
			(input.kind === "approval.requested" ||
				input.kind === "approval.resolved")
		) {
			const runtimeMeta = nonNullRecord(input.runtime?.metadata) ?? {};
			const homeConversationId =
				typeof runtimeMeta.homeConversationId === "string" &&
				runtimeMeta.homeConversationId.length > 0
					? runtimeMeta.homeConversationId
					: null;
			const approvalRequestId =
				input.approvalRequestId ??
				stringFromPayload(nonNullRecord(input.payload)?.approvalRequestId);
			if (homeConversationId && approvalRequestId) {
				context.waitUntil?.(
					notifyKernelChildApprovalBlock(context, {
						childRunId: input.runId,
						childOrganizationId: tedi.organizationId,
						parentOrganizationId: tedi.organizationId,
						parentConversationId: homeConversationId,
						approvalRequestId,
						delegatedTediId: input.tediId,
						blocked: input.kind === "approval.requested",
					}).catch((error) => {
						console.warn(
							"[cognitiveRuntime.recordEvent] child approval mirror failed",
							error instanceof Error ? error.message : error,
						);
					}),
				);
			}
		}
		return {
			event,
		};
	});

export const listArtifactsRoute = authed.listArtifacts
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		await requireTediAccess(context, input.tediId);
		const limit = input.limit ?? 100;
		const rows = await listTediArtifacts(context.db, {
			tediId: input.tediId,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.messageId,
			kind: input.kind,
			name: input.name,
			before: input.cursor,
			limit,
		});
		return {
			artifacts: rows.map((row) =>
				normalizeArtifact(row, {
					exposePrivateRuntimeLocation: isTrustedRuntimeArtifactCaller(
						context,
						input.tediId,
					),
				}),
			),
			nextCursor: nextCursor(rows, limit),
		};
	});

export const recordArtifactRoute = authed.recordArtifact
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const artifactId = input.id ?? crypto.randomUUID();
		const preexistingArtifact = await getTediArtifactClaim(
			context.db,
			artifactId,
		);
		if (
			preexistingArtifact &&
			(preexistingArtifact.organizationId !== tedi.organizationId ||
				preexistingArtifact.tediId !== input.tediId)
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Artifact id is already owned by another tedi",
			);
		}
		const claimedProducerHeader = Boolean(
			context.headers?.get("X-Tedix-Skill-Run-Id") ||
			context.headers?.get("X-Tedix-Skill-Id"),
		);
		const producer = resolveProducer(context);
		// Every newly produced runtime artifact is private, including executions
		// that observed zero governed sources. An empty envelope is evidence of no
		// observed reads, never permission to mint a bearer URL. Exact retries of
		// pre-classification artifacts retain their immutable original class.
		const accessClassification =
			preexistingArtifact != null
				? preexistingArtifact.accessClassification
				: ("runtime_private" as const);
		const execution = producer.skillRunId
			? await getOsGadgetExecutionByRunId(context.db, {
					organizationId: tedi.organizationId,
					tediId: input.tediId,
					runId: producer.skillRunId,
				})
			: undefined;
		let verifiedExecution = execution;
		let unverifiableReason: string | null = null;
		if (claimedProducerHeader && !execution) {
			unverifiableReason = "missing_or_ambiguous_execution";
		} else if (claimedProducerHeader && execution) {
			try {
				if (typeof execution.resourceAccessEnvelope !== "string") {
					throw new Error("missing execution access envelope");
				}
				const parsed = OsDerivedAccessEnvelopeSchema.safeParse(
					JSON.parse(execution.resourceAccessEnvelope),
				);
				if (!parsed.success) {
					verifiedExecution = undefined;
					unverifiableReason = "malformed_execution_access_envelope";
				}
			} catch {
				verifiedExecution = undefined;
				unverifiableReason = "malformed_execution_access_envelope";
			}
		}
		if (claimedProducerHeader && unverifiableReason) {
			const actor = auditActor(context);
			console.warn("[artifact] unverifiable source-derived producer", {
				artifactId,
				organizationId: tedi.organizationId,
				tediId: input.tediId,
				runId: producer.skillRunId,
				reason: unverifiableReason,
			});
			await insertAuditEvent(context.db, {
				organizationId: tedi.organizationId,
				actorType: actor.actorType,
				actorId: actor.actorId,
				action: "artifact.producer_unverifiable",
				resourceType: "tedi_artifact",
				resourceId: artifactId,
				metadata: {
					...actor.actorMetadata,
					reason: unverifiableReason,
					runId: producer.skillRunId,
				},
			});
		}
		if (
			accessClassification === "source_derived" &&
			!input.files?.length &&
			!(typeof input.content === "string" && input.content.length > 0)
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Source-derived artifacts require server-addressed content",
			);
		}
		const runtimeBackend = await resolveTediRuntimeBackend(
			context,
			input.tediId,
		);
		// Publish-with-body: when inline `content` is provided, write it to the
		// tedi deliverable R2 bucket and derive uri/sizeBytes — so this call
		// produces a complete OPENABLE deliverable (served by GET /artifacts/...),
		// not just a registry row pointing at a uri the caller had to write.
		let effectiveUri = input.uri;
		let effectiveSizeBytes = input.sizeBytes;
		let effectiveMetadata = input.metadata;
		let contentDigest: string | null = null;
		let publishBody: (() => Promise<void>) | null = null;
		const bucket = (context.env as { TEDI_R2_BUCKET?: R2Bucket })
			.TEDI_R2_BUCKET;
		if (
			(input.files?.length ||
				(typeof input.content === "string" && input.content.length > 0)) &&
			!bucket
		) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Artifact storage is not configured",
			);
		}
		const decodeBody = (
			content: string,
			encoding: "utf8" | "base64" | undefined,
		): string | Uint8Array =>
			encoding === "base64"
				? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
				: content;
		const bodyBytes = (body: string | Uint8Array): number =>
			typeof body === "string"
				? new TextEncoder().encode(body).byteLength
				: body.byteLength;
		const bodySha256 = async (body: string | Uint8Array): Promise<string> => {
			const bytes =
				typeof body === "string" ? new TextEncoder().encode(body) : body;
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			return Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
		};
		const verifyStoredBody = async (
			key: string,
			expected: { sha256: string; sizeBytes: number; contentType: string },
		): Promise<void> => {
			if (!bucket) throw new Error("Artifact storage is not configured");
			const head = await bucket.head(key);
			if (!head || head.size !== expected.sizeBytes) {
				throw new Error(
					"Stored artifact body does not match its immutable claim",
				);
			}
			const storedType = head.httpMetadata?.contentType;
			if (storedType !== expected.contentType) {
				throw new Error(
					"Stored artifact content type does not match its immutable claim",
				);
			}
			const stored = await bucket.get(key);
			if (
				!stored ||
				(await bodySha256(new Uint8Array(await stored.arrayBuffer()))) !==
					expected.sha256
			) {
				throw new Error(
					"Stored artifact body does not match its immutable claim",
				);
			}
		};
		// Bundle mode: a multi-file deliverable (interactive dashboard / static
		// site). Files land under a content-addressed immutable R2 prefix.
		if (input.files && input.files.length > 0) {
			const bucketName = "tedix-tedi-production";
			const normalizePath = (raw: string): string | null => {
				const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "").trim();
				if (!cleaned || cleaned.length > 512) return null;
				const segments = cleaned.split("/");
				if (
					segments.some(
						(s) => !s || s === "." || s === ".." || /[^\w.\- ]/.test(s),
					)
				) {
					return null;
				}
				return segments.join("/");
			};
			const entrypoint = normalizePath(input.entrypoint ?? "index.html");
			if (!entrypoint) {
				throw createError(ErrorCodes.BAD_REQUEST, "Invalid entrypoint path");
			}
			const preparedFiles = await Promise.all(
				input.files.map(async (file) => {
					const path = normalizePath(file.path);
					if (!path)
						throw createError(
							ErrorCodes.BAD_REQUEST,
							`Invalid bundle file path: ${file.path}`,
						);
					const body = decodeBody(file.content, file.contentEncoding);
					return {
						path,
						body,
						contentType: file.mimeType ?? guessBundleContentType(path),
						sizeBytes: bodyBytes(body),
						sha256: await bodySha256(body),
					};
				}),
			);
			if (
				new Set(preparedFiles.map((file) => file.path)).size !==
				preparedFiles.length
			) {
				throw createError(ErrorCodes.BAD_REQUEST, "Duplicate bundle file path");
			}
			if (!preparedFiles.some((file) => file.path === entrypoint)) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Bundle entrypoint is missing",
				);
			}
			const totalBytes = preparedFiles.reduce(
				(sum, file) => sum + file.sizeBytes,
				0,
			);
			const contentManifest = preparedFiles
				.map(({ path, sha256, sizeBytes, contentType }) => ({
					path,
					sha256,
					sizeBytes,
					contentType,
				}))
				.sort((a, b) => a.path.localeCompare(b.path));
			contentDigest = await bodySha256(
				JSON.stringify({ version: 1, entrypoint, files: contentManifest }),
			);
			if (bucket) {
				const prefix = `${input.tediId}/artifacts/deliverable/bundle/${contentDigest}/`;
				publishBody = async () => {
					for (const file of preparedFiles) {
						const key = `${prefix}${file.path}`;
						const written = await bucket.put(key, file.body, {
							onlyIf: { etagDoesNotMatch: "*" },
							httpMetadata: {
								contentType: file.contentType,
							},
							customMetadata: {
								tediId: input.tediId,
								producer: "record_artifact",
								sha256: file.sha256,
								sizeBytes: String(file.sizeBytes),
							},
						});
						if (!written) await verifyStoredBody(key, file);
					}
				};
				effectiveUri = `r2://${bucketName}/${prefix}`;
				effectiveSizeBytes = totalBytes;
				effectiveMetadata = {
					...input.metadata,
					bundle: true,
					entrypoint,
					fileCount: input.files.length,
					contentManifest,
				};
			}
		} else if (typeof input.content === "string" && input.content.length > 0) {
			const bucketName = "tedix-tedi-production";
			// Names are presentation metadata and commonly repeat (for example every
			// workstation job publishes evidence.json). Scope the object by the
			// canonical artifact id so recording a later artifact cannot overwrite
			// the immutable body referenced by an earlier ledger row.
			const body = decodeBody(input.content, input.contentEncoding);
			contentDigest = await bodySha256(body);
			const contentType = input.mimeType ?? "text/plain; charset=utf-8";
			const representationDigest = await bodySha256(
				`${contentDigest}\0${contentType}`,
			);
			const safeName =
				(input.name.split(/[\\/]/).pop() ?? input.name)
					.trim()
					.replace(/[^A-Za-z0-9._-]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 120) || "deliverable";
			const key = `${input.tediId}/artifacts/deliverable/${contentDigest}/${representationDigest}/${safeName}`;
			if (bucket) {
				// "base64" carries binary formats (PDF, PNG, ...) — decode to raw
				// bytes before writing; "utf8" (default) writes the string as-is.
				publishBody = async () => {
					const written = await bucket.put(key, body, {
						onlyIf: { etagDoesNotMatch: "*" },
						httpMetadata: {
							contentType,
						},
						customMetadata: {
							tediId: input.tediId,
							producer: "record_artifact",
							sha256: contentDigest!,
							sizeBytes: String(bodyBytes(body)),
						},
					});
					if (!written) {
						await verifyStoredBody(key, {
							sha256: contentDigest!,
							sizeBytes: bodyBytes(body),
							contentType,
						});
					}
				};
				effectiveUri = `r2://${bucketName}/${key}`;
				effectiveSizeBytes = bodyBytes(body);
				effectiveMetadata = {
					...input.metadata,
					contentSha256: contentDigest,
				};
			}
		}
		if (
			inspectArtifactUriOwnership({
				uri: effectiveUri,
				organizationId: tedi.organizationId,
				tediId: input.tediId,
			}).kind === "invalid-r2"
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Artifact R2 uri is outside the artifact owner's storage namespace",
			);
		}
		let artifact;
		try {
			const claim = await claimTediArtifact(context.db, {
				id: artifactId,
				organizationId: tedi.organizationId,
				tediId: input.tediId,
				conversationId: input.conversationId,
				runId: input.runId,
				messageId: input.messageId,
				kind: input.kind,
				name: input.name,
				mimeType: input.mimeType,
				uri: effectiveUri,
				sizeBytes: effectiveSizeBytes,
				metadata:
					effectiveMetadata === undefined
						? undefined
						: toJsonRecord(effectiveMetadata),
				createdAt: input.createdAt,
				accessClassification,
				contentDigest,
				producerExecutionId: verifiedExecution?.id ?? null,
				accessEnvelope: verifiedExecution?.resourceAccessEnvelope ?? null,
				publicationState: publishBody ? "pending" : "ready",
			});
			artifact = claim.artifact;
		} catch (error) {
			if (error instanceof TediArtifactOwnershipConflictError) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Artifact id is already owned by another tedi",
				);
			}
			throw error;
		}
		try {
			await publishBody?.();
		} catch {
			throw createError(
				ErrorCodes.CONFLICT,
				"Artifact body conflicts with immutable storage",
			);
		}
		if (publishBody) {
			const published = await markTediArtifactPublished(context.db, {
				id: artifactId,
				organizationId: tedi.organizationId,
				tediId: input.tediId,
				contentDigest,
			});
			if (published) artifact = published;
			if (artifact.publicationState !== "ready") {
				throw createError(
					ErrorCodes.CONFLICT,
					"Artifact publication could not be finalized",
				);
			}
		}
		await insertRuntimeEvent(context, {
			organizationId: tedi.organizationId,
			tediId: input.tediId,
			kind: "artifact.created",
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.messageId,
			artifactId,
			runtimeBackend,
			payload: {
				artifact: normalizeArtifact(artifact),
			},
			createdAt: nowIso(),
		});
		return {
			artifact: normalizeArtifact(artifact, {
				exposePrivateRuntimeLocation:
					artifact.tediId === input.tediId &&
					isTrustedRuntimeArtifactCaller(context, artifact.tediId),
			}),
		};
	});

export const getArtifactRoute = authed.getArtifact
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const requester = await requireTediAccess(context, input.tediId);
		// Artifact ids are stable and globally unique, while independent Work
		// reviewers are intentionally allowed to inspect evidence produced by a
		// peer tedi in the same organization. Keep the lookup tenant-scoped so an
		// id from another organization is indistinguishable from a missing one.
		const artifact = await getTediArtifact(context.db, {
			organizationId: requester.organizationId,
			artifactId: input.artifactId,
		});
		if (!artifact) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi artifact not found");
		}
		return {
			artifact: normalizeArtifact(artifact, {
				exposePrivateRuntimeLocation:
					artifact.tediId === input.tediId &&
					isTrustedRuntimeArtifactCaller(context, artifact.tediId),
			}),
		};
	});

export const createArtifactShareLinkRoute = authed.createArtifactShareLink
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		await requireTediAccess(context, input.tediId);
		const artifact = await getTediArtifact(context.db, input);
		if (!artifact) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi artifact not found");
		}
		// Only reviewed runtime-private releases mint share links; unversioned
		// bearer links were retired.
		if (artifact.accessClassification !== "runtime_private")
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Artifact has no active owner release approval",
			);
		const {
			getActiveArtifactReleaseApproval,
			getArtifactRedactionCandidate,
			getArtifactReleaseReviewHead,
		} = await import("@tedix/db/queries/artifact-policy/releases");
		const candidate = await getArtifactRedactionCandidate(context.db, {
			organizationId: artifact.organizationId,
			childArtifactId: artifact.id,
		});
		const head = candidate
			? await getArtifactReleaseReviewHead(context.db, {
					organizationId: artifact.organizationId,
					candidateId: candidate.id,
				})
			: null;
		const approvalId = head?.eventType === "approved" ? head.id : null;
		const digest = artifact.contentDigest;
		const active =
			candidate && approvalId && digest
				? await getActiveArtifactReleaseApproval(context.db, {
						organizationId: artifact.organizationId,
						childArtifactId: artifact.id,
						approvalId,
						childContentDigest: digest,
					})
				: null;
		if (!active)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Artifact has no active owner release approval",
			);
		if (
			!isOwnedArtifactR2Uri({
				uri: artifact.uri,
				organizationId: artifact.organizationId,
				tediId: artifact.tediId,
			})
		)
			throw createError(ErrorCodes.NOT_FOUND, "Artifact body not found");
		const { signArtifactReleaseUrl } =
			await import("../../../lib/artifact-url");
		const { untrustedContentBaseUrl } =
			await import("../../../lib/untrusted-origin");
		const signed = await signArtifactReleaseUrl({
			baseUrl: untrustedContentBaseUrl(context.env, context.env.API_URL),
			secret: context.env.SECRETS_MASTER_KEY,
			tediId: input.tediId,
			artifactId: input.artifactId,
			approvalId: approvalId!,
			contentDigest: digest!,
			nowMs: Date.now(),
			ttlSeconds: input.ttlSeconds,
		});
		return {
			url: signed.url,
			expiresAt: signed.expiresAt,
			artifactId: input.artifactId,
		};
	});

export const emitAutomationEventRoute = authed.emitAutomationEvent
	.use(withAuthorization("tedis:update", "tedis:update"))
	.handler(async ({ context, input }) => {
		// The consumer builds a service-binding context from the message's
		// organizationId, so the org claim inside the event must be proven
		// here at emit time: the caller must have access to the target tedi,
		// and the event's org must be the tedi's actual org.
		const tedi = await requireTediAccess(context, input.event.tediId);
		if (tedi.organizationId !== input.event.organizationId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"event.organizationId does not match the target tedi's organization",
			);
		}
		const queue = context.env.AUTOMATION_EVENTS;
		if (!queue) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Automation queue binding is not configured",
			);
		}
		await queue.send(
			input.event,
			input.delaySeconds
				? {
						delaySeconds: input.delaySeconds,
					}
				: undefined,
		);
		return {
			queued: true,
			idempotencyKey: input.event.idempotencyKey,
		};
	});

export const writeDispatchIdempotencyRoute =
	serviceAuthed.writeDispatchIdempotency.handler(async ({ context, input }) => {
		await upsertChatDispatchIdempotency(context.db, {
			idempotencyKey: input.idempotencyKey,
			tediId: input.tediId,
			organizationId: input.organizationId ?? null,
			conversationId: input.conversationId,
			status: input.status ?? "queued",
			createdAt: nowIso(),
		});
		return {
			ok: true,
		};
	});

export const patchDispatchIdempotencyRoute =
	serviceAuthed.patchDispatchIdempotency.handler(async ({ context, input }) => {
		const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
		const matched = await patchOldestQueuedDispatchRunId(context.db, {
			tediId: input.tediId,
			conversationId: input.conversationId,
			runId: input.runId,
			cutoff,
			mappedAt: nowIso(),
		});
		return {
			ok: true,
			matched,
		};
	});
