import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ListAgentSessionRequestsInputSchema,
	ListAgentSessionRequestsResultSchema,
	RecordAgentSessionEventsInputSchema,
	RecordAgentSessionEventsResultSchema,
	UpdateAgentSessionRequestInputSchema,
	UpdateAgentSessionRequestResultSchema,
} from "../schemas/agent-session-requests";
import {
	ListWorkAgentSessionsInputSchema,
	ListWorkAgentSessionsResultSchema,
	ListWorkProjectContributorsInputSchema,
	ListWorkProjectContributorsResultSchema,
	ReportWorkAgentSessionStatusInputSchema,
	ReportWorkAgentSessionStatusResultSchema,
} from "../schemas/work-agent-sessions";

export const workAgentSessionsContract = oc
	.route({ tags: ["work-agent-sessions"], prefix: "/work-agent-sessions" })
	.errors(baseErrors)
	.router({
		report: oc
			.route({
				method: "POST",
				path: "/status",
				summary: "Report a local agent session's turn status",
			})
			.input(ReportWorkAgentSessionStatusInputSchema)
			.output(ReportWorkAgentSessionStatusResultSchema),
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List the caller's local agent sessions by urgency",
			})
			.input(ListWorkAgentSessionsInputSchema)
			.output(ListWorkAgentSessionsResultSchema),
		contributors: oc
			.route({
				method: "GET",
				path: "/contributors",
				summary: "List every agent session that contributed to a Work project",
			})
			.input(ListWorkProjectContributorsInputSchema)
			.output(ListWorkProjectContributorsResultSchema),
		recordEvents: oc
			.route({
				method: "POST",
				path: "/events",
				summary: "Upload redacted events from the caller's own agent sessions",
				description:
					"Stores up to 20 redacted events (messages the caller typed, agent turn ends with an activity digest) from the caller's own local Claude Code or Codex sessions and returns at once; a re-uploaded event is stored once. In the background, in session order, a small model observes each message (requests, questions, decisions become open rows of the caller's private request ledger) and reflects each turn (rows it worked on move to in_progress, waiting_on_user, dropped_risk or done, done only with evidence found in the turn; the agent's promises and open loops become new rows; open rows five turns pass by become dropped_risk).",
			})
			.input(RecordAgentSessionEventsInputSchema)
			.output(RecordAgentSessionEventsResultSchema),
		listRequests: oc
			.route({
				method: "GET",
				path: "/requests",
				summary: "List the caller's own request ledger",
				description:
					"The caller's private request ledger rows, oldest message first, optionally filtered by status and session. Read-only.",
			})
			.input(ListAgentSessionRequestsInputSchema)
			.output(ListAgentSessionRequestsResultSchema),
		updateRequest: oc
			.route({
				method: "POST",
				path: "/requests/update",
				summary: "Set the status of one of the caller's ledger rows",
				description:
					"The person closes, reopens or withdraws one of their own rows. `done` requires `evidence` (a commit SHA, link or note).",
			})
			.input(UpdateAgentSessionRequestInputSchema)
			.output(UpdateAgentSessionRequestResultSchema),
	});

export type WorkAgentSessionsContract = typeof workAgentSessionsContract;
