import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	DispatcherHealthReportSchema,
	ListDispatcherHealthResultSchema,
	ReportDispatcherHealthInputSchema,
} from "../schemas/dispatcher-health";

export const dispatcherHealthContract = oc
	.route({ tags: ["dispatcher-health"], prefix: "/dispatcher-health" })
	.errors(baseErrors)
	.router({
		report: oc
			.route({
				method: "POST",
				path: "/reports",
				summary: "Report current dispatcher lane health",
			})
			.input(ReportDispatcherHealthInputSchema)
			.output(DispatcherHealthReportSchema),
		list: oc
			.route({
				method: "GET",
				path: "/reports",
				summary: "List current dispatcher lane health",
			})
			.output(ListDispatcherHealthResultSchema),
	});

export type DispatcherHealthContract = typeof dispatcherHealthContract;
