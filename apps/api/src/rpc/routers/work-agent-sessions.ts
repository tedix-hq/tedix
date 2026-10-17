/**
 * Local agent session status board.
 *
 * A human's local coding-agent hosts (Claude Code, Codex) report each
 * session's turn status through the Tedix plugin; the board lists that human's
 * own sessions by urgency. Organization and user come only from the
 * authenticated human principal, never from input, so no credential can read
 * or write another person's board.
 */

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
	fileAgentSessionRequest,
	listAgentSessionRequests,
	updateAgentSessionRequests,
} from "@tedix/db/queries/agent-session-requests";
import type { AgentSessionRequestRow } from "@tedix/db/schema/agent-session-requests";
import {
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
} {
	if (context.authType !== "user" || !context.user?.sub || !context.userId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The agent session board requires an authenticated human user",
		);
	}
	return { organizationId: requireOrgId(context), userId: context.userId };
}

function sessionOutput(row: WorkAgentSessionRow) {
	return {
		id: row.id,
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
	const { row, changed } = await reportWorkAgentSessionStatus(context.db, {
		...owner,
		harness: input.harness,
		sessionKey: input.sessionKey,
		state: input.state,
		summary: sanitizeWorkAgentSessionText(input.summary, 200),
		label: sanitizeWorkAgentSessionText(input.label, 120),
		projectId: input.projectId,
		workItemId: input.workItemId,
		now,
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
	return buildWorkAgentSessionBoard(rows.map(sessionOutput), now);
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
		const model = workersAiLedgerModel(context.env);
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
				ledgerLessonNoveltyModel(context.env),
			);
		};
		context.waitUntil?.(
			processAgentSessionEvents(context.db, model, owner).catch(() => 0),
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
	attention: readOs.attention.handler(async ({ context, input }) => {
		const owner = requireBoardOwner(context);
		const now = new Date();
		const { readAttentionSources, listUnattendedObjectives } =
			await import("@tedix/db/queries/work-attention");
		const { buildAttention } = await import("../../lib/work-attention");
		const [sources, sessions, requests, unattendedObjectives] =
			await Promise.all([
				readAttentionSources(
					context.db,
					owner.organizationId,
					new Date(now.getTime() - 86_400_000).toISOString(),
					context.user!.sub,
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
				listUnattendedObjectives(
					context.db,
					owner.organizationId,
					new Date(now.getTime() - 86_400_000).toISOString(),
				),
			]);
		return {
			...buildAttention(
				sources,
				sessions,
				requests,
				now,
				input.utcOffsetMinutes,
			),
			unattendedObjectives,
		};
	}),
	fileRequest: writeOs.fileRequest.handler(async ({ input, context }) => {
		const owner = requireBoardOwner(context);
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
		const row = await fileAgentSessionRequest(context.db, {
			...owner,
			...input,
			now: new Date().toISOString(),
		});
		if (!row) throw createError(ErrorCodes.NOT_FOUND, "Request not found");
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
