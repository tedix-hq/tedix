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
	listWorkAgentSessions,
	reportWorkAgentSessionStatus,
} from "@tedix/db/queries/work-agent-sessions";
import type { WorkAgentSessionRow } from "@tedix/db/schema/work-agent-sessions";
import {
	buildWorkAgentSessionBoard,
	deriveWorkAgentSessionEffectiveState,
	sanitizeWorkAgentSessionText,
} from "../../lib/work-agent-session-board";
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

export const workAgentSessionsContractRouter = sessionsOs.router({
	report: reportProcedure,
	list: listProcedure,
});
