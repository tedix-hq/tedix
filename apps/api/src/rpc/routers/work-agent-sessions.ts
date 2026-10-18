import { organizationModelEnv } from "../../services/unrouted-model-egress";
/**
 * Local agent session status board.
 *
 * A human's local coding-agent hosts (Claude Code, Codex) report each
 * session's turn status through the Tedix plugin; the board lists that human's
 * own sessions by urgency. Organization and user come only from the
 * authenticated human principal, never from input, so no credential can read
 * or write another person's board.
 */

import { ATTENTION_LAYOUT_NAMESPACE } from "@tedix/api-contract/schemas/attention-layout";
import {
	getUserConfig,
	putUserConfig,
	upsertUserConfig,
} from "@tedix/db/queries/user-configs";
import { readAttentionLayout } from "../../services/attention-layout";
import { enrichLaneTelemetry } from "../../services/lane-telemetry";
import { SESSION_ACTIVITY_RESOURCE } from "@tedix/api-contract/schemas/agent-session-requests";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { scrubText } from "@tedix/context-core/trace-safety";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { authorizePersonalResourceDelegation } from "../../services/personal-resource-delegation-authority";
import { implement } from "@orpc/server";
import { workAgentSessionsContract } from "@tedix/api-contract/contracts/work-agent-sessions";
import {
	listAgentSessionActivity,
	getAgentSessionRequest,
	listAgentSessionRequests,
	updateAgentSessionRequests,
} from "@tedix/db/queries/agent-session-requests";
import type { AgentSessionRequestRow } from "@tedix/db/schema/agent-session-requests";
import {
	listTediLaneSources,
	getWorkAgentSession,
	listWorkAgentSessions,
	listWorkProjectContributorSources,
	reportWorkAgentSessionStatus,
} from "@tedix/db/queries/work-agent-sessions";
import type { WorkAgentSessionRow } from "@tedix/db/schema/work-agent-sessions";
import {
	buildWorkAgentSessionBoard,
	buildWorkProjectContributors,
	deriveWorkAgentSessionEffectiveState,
	sanitizeWorkAgentSessionText,
} from "../../lib/work-agent-session-board";
import {
	acceptAgentSessionEvents,
	processAgentSessionEvents,
	workersAiLedgerModel,
} from "../../services/agent-session-request-ledger";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	userHoldsPermission,
	withAuthorization,
} from "../orpc";

const sessionsOs = implement(workAgentSessionsContract).$context<BaseContext>();
const authenticatedOs = sessionsOs.use(withAuth);
const writeOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The board is private to one human: handlers accept only an authenticated user principal and scope every row to its own organization and canonical user id",
		},
		"mcp:work.write",
	),
);
const readOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The board is private to one human: handlers accept only an authenticated user principal and scope every row to its own organization and canonical user id",
		},
		"mcp:work.read",
	),
);
const layoutReadOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Personal layout rows belong to the authenticated human or to the freshly verified active owner of its own personal tedi; no caller-selected owner is accepted",
		},
		"mcp:work.read",
	),
);
const layoutWriteOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Personal layout rows belong to the authenticated human or to the freshly verified active owner of its own personal tedi; no caller-selected owner is accepted",
		},
		"mcp:work.write",
	),
);

async function requireLayoutOwner(
	context: BaseContext,
): Promise<{ organizationId: string; userId: string }> {
	if (context.authType === "user") return requireBoardOwner(context);
	const organizationId = requireOrgId(context);
	const { resolveOsWorkspaceOwnerCandidate } =
		await import("../../services/os-workspace-visibility");
	const subject = await resolveOsWorkspaceOwnerCandidate(context);
	if (!subject)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A personal layout requires its human owner or their own active personal tedi",
		);
	const { getMemberByUserId } =
		await import("@tedix/db/queries/organization-members");
	const member = await getMemberByUserId(context.db, organizationId, subject);
	if (member?.status !== "active" || !member.userId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The layout owner needs an active membership and canonical user identity",
		);
	return { organizationId, userId: member.userId };
}

const projectReadOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Project contributors are read-only Work rows scoped to the caller's organization",
		},
		"mcp:work.read",
	),
);

/** The caller's organization and canonical user id, or FORBIDDEN. */
export function requireBoardOwner(context: BaseContext): {
	organizationId: string;
	userId: string;
	descopeUserId: string;
} {
	if (context.authType !== "user" || !context.user?.sub || !context.userId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The agent session board requires an authenticated human user",
		);
	}
	return {
		organizationId: requireOrgId(context),
		userId: context.userId,
		descopeUserId: context.user.sub,
	};
}

function sessionOutput(row: WorkAgentSessionRow) {
	return {
		id: row.id,
		telemetry: row.telemetry
			? { ...row.telemetry, usageSamples: undefined }
			: null,
		harness: row.harness,
		sessionKey: row.sessionKey,
		label: row.label,
		state: row.state,
		summary: row.summary,
		projectId: row.projectId,
		workItemId: row.workItemId,
		stateSince: row.stateSince,
		lastEventAt: row.lastEventAt,
	};
}

const reportProcedure = writeOs.report.handler(async ({ input, context }) => {
	const owner = requireBoardOwner(context);
	const now = new Date().toISOString();
	const prior = input.telemetry
		? await getWorkAgentSession(context.db, {
				...owner,
				harness: input.harness,
				sessionKey: input.sessionKey,
			})
		: null;
	const sameResult =
		prior?.telemetry?.finishedAt &&
		prior.telemetry.estimatedCostUsd !== null &&
		JSON.stringify(prior.telemetry.usage) ===
			JSON.stringify(input.telemetry?.usage) &&
		JSON.stringify(prior.telemetry.usageSamples) ===
			JSON.stringify(input.telemetry?.usageSamples) &&
		prior.telemetry.rateScope === input.telemetry?.rateScope &&
		prior.telemetry.finalMessage === input.telemetry?.finalMessage &&
		JSON.stringify(prior.telemetry.corrections) ===
			JSON.stringify(input.telemetry.corrections);
	const telemetry = input.telemetry
		? sameResult
			? {
					...input.telemetry,
					estimatedCostUsd: prior.telemetry!.estimatedCostUsd,
					rateVersionId: prior.telemetry!.rateVersionId,
					rateVersionIds: prior.telemetry!.rateVersionIds,
					estimatedAt: prior.telemetry!.estimatedAt,
					lesson: prior.telemetry!.lesson,
					lessonStatus: prior.telemetry!.lessonStatus,
				}
			: await enrichLaneTelemetry(
					context,
					input.telemetry,
					owner,
					input.sessionKey,
				)
		: undefined;
	const { row, changed } = await reportWorkAgentSessionStatus(context.db, {
		...owner,
		telemetry,
		harness: input.harness,
		sessionKey: input.sessionKey,
		state: input.state,
		summary: sanitizeWorkAgentSessionText(input.summary, 200),
		label: sanitizeWorkAgentSessionText(input.label, 120),
		projectId: input.projectId,
		workItemId: input.workItemId,
		now:
			input.telemetry?.source === "import" ? input.telemetry.heartbeatAt : now,
	});
	return {
		session: {
			...sessionOutput(row),
			effectiveState: deriveWorkAgentSessionEffectiveState(row, now),
		},
		changed,
	};
});

const listProcedure = readOs.list.handler(async ({ input, context }) => {
	const owner = requireBoardOwner(context);
	const now = new Date().toISOString();
	const rows = await listWorkAgentSessions(context.db, {
		...owner,
		includeEnded: input.includeEnded === true,
		now,
	});
	const tediSources = await listTediLaneSources(
		context.db,
		owner.organizationId,
		new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString(),
	);
	const tediLanes = tediSources.attempts.map((attempt) => {
		const calls = tediSources.costs.filter(
			(call) => call.runId === attempt.runId,
		);
		const events = tediSources.events.filter(
			(event) => event.runId === attempt.runId,
		);
		const tools: Record<string, number> = {};
		for (const event of events) {
			const name = event.payload?.toolName ?? event.payload?.name;
			if (typeof name === "string") tools[name] = (tools[name] ?? 0) + 1;
		}
		const models = [...new Set(calls.map((call) => call.model))];
		const usage = calls.length
			? {
					input: calls.reduce((n, c) => n + c.inputTokens, 0),
					cached: calls.reduce((n, c) => n + c.cacheReadTokens, 0),
					output: calls.reduce((n, c) => n + c.outputTokens, 0),
					reasoning: 0,
				}
			: null;
		const telemetry = {
			executor: "tedi" as const,
			model: models.length ? models.join(", ") : null,
			provider: null,
			reasoningEffort: null,
			brief: attempt.brief ?? attempt.title,
			startedAt: attempt.startedAt,
			finishedAt: attempt.finishedAt,
			heartbeatAt: attempt.heartbeatAt,
			outcome:
				attempt.outcome === "succeeded"
					? ("succeeded" as const)
					: attempt.outcome === "failed"
						? ("failed" as const)
						: attempt.outcome
							? ("stopped" as const)
							: null,
			finalMessage: attempt.summary ?? "",
			tools,
			usage,
			shas: [],
			workItems: [attempt.workItemId],
			corrections: [],
			source: "runtime" as const,
			estimatedCostUsd:
				calls.length && calls.every((c) => c.estimatedCostUsd !== null)
					? calls.reduce((n, c) => n + c.estimatedCostUsd!, 0)
					: null,
			rateVersionId: null,
			lesson: null,
			lessonStatus: "unavailable" as const,
		};
		return {
			id: attempt.id,
			harness: "tedi" as const,
			sessionKey: attempt.id,
			label: attempt.title,
			state:
				attempt.outcome === "failed"
					? ("error" as const)
					: attempt.outcome
						? ("done" as const)
						: ("working" as const),
			summary: attempt.summary ?? "",
			projectId: attempt.projectId,
			workItemId: attempt.workItemId,
			stateSince: attempt.finishedAt ?? attempt.startedAt,
			lastEventAt: attempt.heartbeatAt,
			telemetry,
		};
	});
	return buildWorkAgentSessionBoard(
		[...rows.map(sessionOutput), ...tediLanes],
		now,
	);
});

const contributorsProcedure = projectReadOs.contributors.handler(
	async ({ input, context }) => {
		const { reports, attempts } = await listWorkProjectContributorSources(
			context.db,
			{ organizationId: requireOrgId(context), projectId: input.projectId },
		);
		return {
			contributors: buildWorkProjectContributors(
				reports,
				attempts,
				new Date().toISOString(),
			),
		};
	},
);

function requestOutput(row: AgentSessionRequestRow) {
	return {
		id: row.id,
		harness: row.harness,
		sessionKey: row.sessionKey,
		repository: row.repository,
		projectId: row.projectId ?? null,
		kind: row.kind,
		text: row.text,
		status: row.status,
		evidence: row.evidence,
		sourceAt: row.sourceAt,
		statusChangedAt: row.statusChangedAt,
	};
}

/**
 * Store the uploaded events and return at once; the observer and reflector
 * run after the response. Each upload also retries earlier pending events.
 */
const recordEventsProcedure = writeOs.recordEvents.handler(
	async ({ input, context }) => {
		const owner = requireBoardOwner(context);
		const result = await acceptAgentSessionEvents(context.db, {
			...owner,
			events: input.events,
			retryFailed: input.retryFailed,
			rebuildFailedSession: input.rebuildFailedSession,
			now: new Date().toISOString(),
		});
		if (
			result.rebuilt === 0 ||
			(input.retryFailed && !result.accepted && !result.retried)
		)
			return result;
		const model = workersAiLedgerModel(
			organizationModelEnv(context.env, context.db, requireOrgId(context)),
		);
		const { enqueueRequestFiling } =
			await import("../../services/request-filing-queue");
		model.enqueueFilings = async (owner) => {
			const { automaticFilingEnabled } =
				await import("../../services/request-filing-settings");
			if (await automaticFilingEnabled(context.db, owner))
				await enqueueRequestFiling(context.env, {
					...owner,
					ownerSubject: context.user!.sub!,
				});
		};
		model.learn = async (lessons, scope) => {
			const ownerUserId = context.user?.sub;
			if (!lessons.length || !ownerUserId) return;
			const { recordLedgerLessonCandidates, ledgerLessonNoveltyModel } =
				await import("../../services/request-ledger-lessons");
			await recordLedgerLessonCandidates(
				context.db,
				lessons,
				{
					...scope,
					ownerUserId,
				},
				ledgerLessonNoveltyModel(
					organizationModelEnv(context.env, context.db, scope.organizationId),
				),
			);
		};
		context.waitUntil?.(
			processAgentSessionEvents(context.db, model, owner, {
				onRecorded: async (scope) => {
					const { captureLocalKernelRequests } =
						await import("../../kernel/request-local-source");
					await captureLocalKernelRequests(context, scope);
				},
			}).catch(() => 0),
		);
		return result;
	},
);

const listActivityProcedure = authenticatedOs
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only a trusted worker skill run with its ledger owner's exact live read delegation can read session activity; human and other machine principals are denied",
			},
			"mcp:work.read",
		),
	)
	.listActivity.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const runId = context.headers.get("X-Tedix-Skill-Run-Id");
		if (
			context.authType !== "service-binding" ||
			!context.tediId ||
			!runId ||
			context.headers.get("X-Tedix-Mcp-Tool-Id") !==
				SESSION_ACTIVITY_RESOURCE.toolId
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Session activity requires a trusted skill run",
			);
		const run = await getSkillRun(
			context.db,
			runId,
			organizationId,
			context.env.ENVIRONMENT,
		);
		if (
			!run ||
			run.tediId !== context.tediId ||
			!run.skillId ||
			!run.skillRevision
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Session activity requires the calling worker's run",
			);
		const envelope = OsDerivedAccessEnvelopeSchema.safeParse(
			run.resourceAccessEnvelope,
		);
		const source = envelope.success
			? envelope.data.sources.find(
					(s) =>
						s.providerId === SESSION_ACTIVITY_RESOURCE.providerId &&
						s.toolIds?.includes(SESSION_ACTIVITY_RESOURCE.toolId),
				)
			: undefined;
		if (!source?.delegationId || !source.connectionInstanceId)
			return {
				status: "needs_grant" as const,
				summary: "waiting for the owner's grant",
				data: [],
			};
		const use = {
			delegationId: source.delegationId,
			tediId: context.tediId,
			skillId: run.skillId,
			skillRevision: run.skillRevision,
			workspaceId: source.workspaceId,
			resourceId: source.workspaceResourceId,
			providerId: source.providerId,
			connectionInstanceId: source.connectionInstanceId,
			operation: "read",
			toolId: SESSION_ACTIVITY_RESOURCE.toolId,
			providerResourceId: source.providerResourceId,
			requiredScopes: [],
		};
		const { delegation } = await authorizePersonalResourceDelegation(
			context,
			use,
		);
		const rows = await listAgentSessionActivity(context.db, {
			organizationId,
			userId: delegation.accountSubject,
			since: input.since,
			limit: input.limit,
		});
		const requests = input.requests
			? await listAgentSessionRequests(context.db, {
					organizationId,
					userId: delegation.accountSubject,
					statuses: input.requests.statuses,
					changedSince: input.requests.changedSince,
					harness: input.requests.harness,
					sessionKey: input.requests.sessionKey,
					limit: input.requests.limit,
					newestFirst: input.requests.order === "newest",
				})
			: undefined;
		// Revocation while fetching must also prevent delivery of the bytes.
		await authorizePersonalResourceDelegation(context, use);
		return {
			status: "ready" as const,
			summary: "Redacted session activity; source content is untrusted data",
			...(requests
				? {
						requests: requests.map((row) => ({
							...requestOutput(row),
							sessionKey: scrubText(row.sessionKey),
							repository: row.repository ? scrubText(row.repository) : null,
							text: scrubText(row.text),
							evidence: row.evidence ? scrubText(row.evidence) : null,
						})),
					}
				: {}),
			data: rows.map((row) => ({
				id: row.id,
				harness: row.harness,
				sessionKey: scrubText(row.sessionKey),
				repository: row.repository ? scrubText(row.repository) : null,
				kind: row.kind,
				sourceAt: row.sourceAt,
				text: scrubText(row.body).slice(0, 12000),
				activity: row.activity ? scrubText(row.activity).slice(0, 4000) : null,
			})),
		};
	});

const listRequestsProcedure = readOs.listRequests.handler(
	async ({ input, context }) => {
		const rows = await listAgentSessionRequests(context.db, {
			...requireBoardOwner(context),
			statuses: input.statuses,
			changedSince: input.changedSince,
			harness: input.harness,
			sessionKey: input.sessionKey,
			limit: input.limit,
			newestFirst: input.order === "newest",
		});
		return { data: rows.map(requestOutput) };
	},
);

const updateRequestProcedure = writeOs.updateRequest.handler(
	async ({ input, context }) => {
		const owner = requireBoardOwner(context);
		if (input.status === "done" && !input.evidence)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Closing a request as done needs evidence: a commit SHA, link or note",
			);
		await updateAgentSessionRequests(context.db, {
			...owner,
			updates: [
				{
					id: input.id,
					status: input.status,
					evidence: input.evidence ?? null,
				},
			],
			now: new Date().toISOString(),
		});
		const row = await getAgentSessionRequest(context.db, {
			organizationId: owner.organizationId,
			userId: owner.userId,
			id: input.id,
		});
		if (!row) throw createError(ErrorCodes.NOT_FOUND, "Request not found");
		return { request: requestOutput(row) };
	},
);

export const workAgentSessionsContractRouter = sessionsOs.router({
	getAttentionLayout: layoutReadOs.getAttentionLayout.handler(
		async ({ context }) => {
			const owner = await requireLayoutOwner(context);
			return readAttentionLayout(
				context.db,
				owner.userId,
				owner.organizationId,
			);
		},
	),
	updateAttentionLayout: layoutWriteOs.updateAttentionLayout.handler(
		async ({ context, input }) => {
			const owner = await requireLayoutOwner(context);
			const saved = await putUserConfig(context.db, {
				userId: owner.userId,
				namespace: ATTENTION_LAYOUT_NAMESPACE,
				key: owner.organizationId,
				value: input.layout,
				expectedRevision: input.expectedRevision,
			});
			if (!saved.ok)
				throw createError(
					ErrorCodes.CONFLICT,
					"Your layout changed elsewhere. Reload it before saving again.",
				);
			return { layout: input.layout, revision: saved.row.revision };
		},
	),
	visitAttention: writeOs.visitAttention.handler(async ({ context }) => {
		const owner = requireBoardOwner(context);
		const key = {
			userId: owner.userId,
			namespace: "work.attention.visit",
			key: owner.organizationId,
		};
		const previous = await getUserConfig(context.db, key);
		await upsertUserConfig(context.db, {
			...key,
			value: { at: new Date().toISOString() },
		});
		return {
			previousVisitAt:
				typeof previous?.value.at === "string" ? previous.value.at : null,
		};
	}),
	attention: readOs.attention.handler(async ({ context, input }) => {
		const owner = requireBoardOwner(context);
		const now = new Date();
		let workspaceProjects: Set<string> | null = null;
		if (input.workspaceId) {
			const { requireWorkspace } = await import("./os-workspaces-shared");
			await requireWorkspace(context, input.workspaceId);
			const { listOsWorkspaceProjects } =
				await import("@tedix/db/queries/os-workspaces/projects");
			workspaceProjects = new Set(
				(
					await listOsWorkspaceProjects(context.db, {
						organizationId: owner.organizationId,
						workspaceId: input.workspaceId,
						status: "active",
						limit: 500,
					})
				).map((p) => p.projectId),
			);
		}
		const {
			readAttentionSources,
			listUnattendedObjectives,
			readAttentionFactoryLinks,
		} = await import("@tedix/db/queries/work-attention");
		const { buildAttention } = await import("../../lib/work-attention");
		const { readContinuity } = await import("../../lib/stall-attention");
		const [
			sources,
			sessions,
			requests,
			factoryLinks,
			unattendedObjectives,
			continuity,
		] = await Promise.all([
			readAttentionSources(
				context.db,
				owner.organizationId,
				new Date(now.getTime() - 86_400_000).toISOString(),
				owner.descopeUserId,
				owner.userId,
			),
			listWorkAgentSessions(context.db, {
				...owner,
				includeEnded: false,
				now: now.toISOString(),
			}),
			listAgentSessionRequests(context.db, {
				...owner,
				limit: 200,
				newestFirst: true,
			}),
			readAttentionFactoryLinks(
				context.db,
				owner.organizationId,
				owner.descopeUserId,
				new Date(now.getTime() - 86_400_000).toISOString(),
			),
			listUnattendedObjectives(
				context.db,
				owner.organizationId,
				new Date(now.getTime() - 86_400_000).toISOString(),
			),
			readContinuity(
				context.db,
				owner.organizationId,
				now,
				"",
				owner.userId,
				context.env.ENVIRONMENT,
			),
		]);
		const { readFilingReview } =
			await import("../../services/request-filing-review");
		const review = await readFilingReview(
			context.db,
			{ ...owner, learningOwnerId: owner.descopeUserId },
			now.toISOString(),
		);
		const result = {
			...review,
			...buildAttention(
				sources,
				sessions,
				requests,
				now,
				input.utcOffsetMinutes,
			),
			unattendedObjectives,
			stalls: continuity.stalls,
			cadencePromises: continuity.promises,
		};
		result.unattendedObjectives = result.unattendedObjectives.filter(
			(o) =>
				!result.projects.some(
					(p) => p.objectiveId === o.id && (p.active > 0 || p.recent > 0),
				),
		);
		for (const card of result.cards) {
			const runId =
				card.source === "attempt"
					? sources.attempts.find((a) => a.id === card.id)?.runId
					: card.source === "skill"
						? card.id
						: null;
			const link = runId
				? factoryLinks.find((f) => f.runId === runId)
				: undefined;
			if (link) {
				card.workspaceId = link.workspaceId;
				card.factoryName = link.factoryName;
				if (
					card.activitySource === "cloud_tedi" ||
					card.activitySource === "unknown"
				)
					card.activitySource = "factory";
			}
		}
		if (workspaceProjects) {
			const ids = workspaceProjects;
			result.cards = result.cards.filter((c) =>
				c.workspaceId
					? c.workspaceId === input.workspaceId
					: !!c.projectId && ids.has(c.projectId),
			);
			result.projects = result.projects.filter((p) => ids.has(p.id));
			result.unfiled = [];
			result.filings = result.filings.filter(
				(row) => row.projectId && ids.has(row.projectId),
			);
			result.pendingFilingCount = 0;
			const scopeIds = new Set([
				...ids,
				...result.projects.flatMap((p) =>
					p.objectiveId ? [p.objectiveId] : [],
				),
			]);
			result.unattendedObjectives = result.unattendedObjectives.filter((o) =>
				scopeIds.has(o.id),
			);
			result.stalls = result.stalls.filter((s) => scopeIds.has(s.scopeId));
			result.cadencePromises = result.cadencePromises.filter((p) =>
				scopeIds.has(p.scopeId),
			);
		}
		return result;
	}),
	classifyRequests: writeOs.classifyRequests.handler(
		async ({ context, input }) => {
			const owner = requireBoardOwner(context);
			if (
				input.enabled !== false &&
				!userHoldsPermission(context, "tedis:update")
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Automatic filing requires project creation permission",
				);
			const { setAutomaticFiling, automaticFilingEnabled } =
				await import("../../services/request-filing-settings");
			if (input.enabled !== undefined)
				await setAutomaticFiling(context.db, owner, input.enabled);
			if (!(await automaticFilingEnabled(context.db, owner)))
				return { queued: false };
			const { enqueueRequestFiling, processRequestFilingQueue } =
				await import("../../services/request-filing-queue");
			if (input.runNow) {
				const pass = await processRequestFilingQueue(
					context.env,
					{
						...owner,
						ownerSubject: context.user!.sub!,
					},
					1,
				);
				return {
					queued: pass.state === "processed" && (pass.pending ?? 0) > 0,
					pass,
				};
			}
			await enqueueRequestFiling(context.env, {
				...owner,
				ownerSubject: context.user!.sub!,
			});
			return { queued: true };
		},
	),
	fileRequest: writeOs.fileRequest.handler(async ({ input, context }) => {
		const owner = requireBoardOwner(context);
		if (input.acceptanceChecks && !input.workItemId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Acceptance checks require canonical Work",
			);
		if (input.workItemId) {
			const { getWorkItemById } =
				await import("@tedix/db/queries/work-items/crud");
			const work = await getWorkItemById(
				context.db,
				input.workItemId,
				owner.organizationId,
			);
			if (!work || work.projectId !== input.projectId)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Work not found in the filed project",
				);
		}
		if (input.projectId) {
			const { attentionProjectExists } =
				await import("@tedix/db/queries/work-attention");
			if (
				!(await attentionProjectExists(
					context.db,
					owner.organizationId,
					input.projectId,
				))
			)
				throw createError(ErrorCodes.NOT_FOUND, "Project not found");
		}
		const previous = await getAgentSessionRequest(context.db, {
			organizationId: owner.organizationId,
			userId: owner.userId,
			id: input.id,
		});
		if (!previous) throw createError(ErrorCodes.NOT_FOUND, "Request not found");
		if (
			input.expectedProjectId !== undefined &&
			previous.projectId !== input.expectedProjectId
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"This filing changed; reload the decision",
			);
		let row = previous;
		if (previous.projectId !== input.projectId) {
			const { recordRequestFiling } =
				await import("@tedix/db/queries/request-filings");
			const result = await recordRequestFiling(context.db, {
				...owner,
				row: previous,
				projectId: input.projectId,
				by: "correction",
				shareCorrection: await (
					await import("../../services/request-filing-settings")
				).automaticFilingEnabled(context.db, owner),
				learningOwnerId: context.user!.sub,
				confidence: 1,
				reason: "Destination corrected by the ledger owner",
				now: new Date().toISOString(),
			});
			if (!result)
				throw createError(
					ErrorCodes.CONFLICT,
					"Request moved; refresh before correcting it",
				);
			const { enqueueRequestFiling } =
				await import("../../services/request-filing-queue");
			await enqueueRequestFiling(context.env, {
				...owner,
				ownerSubject: context.user!.sub!,
			});
			const { recordFilingCorrectionLesson } =
				await import("../../services/request-ledger-lessons");
			await recordFilingCorrectionLesson(context.db, result.event);
			row = result.row;
		}
		if (input.workItemId) {
			const { bindLocalKernelRequest } =
				await import("../../kernel/request-local-source");
			await bindLocalKernelRequest(
				context,
				row,
				input.workItemId,
				input.acceptanceChecks ?? [],
			);
		}
		return { request: requestOutput(row) };
	}),
	report: reportProcedure,
	list: listProcedure,
	contributors: contributorsProcedure,
	recordEvents: recordEventsProcedure,
	listActivity: listActivityProcedure,
	listRequests: listRequestsProcedure,
	updateRequest: updateRequestProcedure,
});
