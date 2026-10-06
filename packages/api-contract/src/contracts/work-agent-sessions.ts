import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ListWorkAgentSessionsInputSchema,
	ListWorkAgentSessionsResultSchema,
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
	});

export type WorkAgentSessionsContract = typeof workAgentSessionsContract;
