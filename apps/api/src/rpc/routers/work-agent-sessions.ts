/**
 * Local agent session status board.
 *
 * A human's local coding-agent hosts (Claude Code, Codex) report each
 * session's turn status through the Tedix plugin; the board lists that human's
 * own sessions by urgency. Organization and user come only from the
 * authenticated human principal, never from input, so no credential can read
 * or write another person's board.
 */

import { implement } from "@orpc/server";
import { workAgentSessionsContract } from "@tedix/api-contract/contracts/work-agent-sessions";
import {
	getAgentSessionRequest,
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
			now: new Date().toISOString(),
		});
		const model = workersAiLedgerModel(context.env);
		model.learn = async (lessons, scope) => {
			const ownerUserId = context.user?.sub;
			if (!lessons.length || !ownerUserId) return;
			const { recordLedgerLessonCandidates } =
				await import("../../services/request-ledger-lessons");
			await recordLedgerLessonCandidates(context.db, lessons, {
				...scope,
				ownerUserId,
			});
		};
		context.waitUntil?.(
			processAgentSessionEvents(context.db, model, owner).catch(() => 0),
		);
		return result;
	},
);

const listRequestsProcedure = readOs.listRequests.handler(
	async ({ input, context }) => {
		const rows = await listAgentSessionRequests(context.db, {
			...requireBoardOwner(context),
			statuses: input.statuses,
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
	report: reportProcedure,
	list: listProcedure,
	contributors: contributorsProcedure,
	recordEvents: recordEventsProcedure,
	listRequests: listRequestsProcedure,
	updateRequest: updateRequestProcedure,
});
