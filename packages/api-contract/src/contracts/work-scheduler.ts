import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	WorkExecutionClusterPlanSchema,
	WorkSchedulerExecutorSchema,
	WorkSchedulerReadyQueueSchema,
	WorkSchedulerVerbositySchema,
} from "../schemas/work-scheduler";

const WorkSchedulerIdentityInputSchema = z.strictObject({
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Optional bounded ready-item count."),
	candidateLimit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Optional upper bound on candidates evaluated before ranking."),
	verbosity: WorkSchedulerVerbositySchema.optional().describe(
		"Receipt verbosity; defaults to `compact`, which omits prose explanations so an agent can read a full page without gateway truncation.",
	),
	executor: WorkSchedulerExecutorSchema.optional().describe(
		"Optional executor identity used for eligibility evaluation; omission derives it from the authenticated credential.",
	),
});

export const workSchedulerContract = oc
	.route({ tags: ["work-scheduler"], prefix: "/work-scheduler" })
	.errors(baseErrors)
	.router({
		listReady: oc
			.route({
				method: "GET",
				path: "/ready",
				summary: "List ready Work",
			})
			.input(
				WorkSchedulerIdentityInputSchema.extend({
					cursor: z
						.string()
						.min(1)
						.max(500)
						.optional()
						.describe(
							"Opaque scheduler continuation cursor; omit for the first page.",
						),
				}),
			)
			.output(WorkSchedulerReadyQueueSchema),
		planClusters: oc
			.route({
				method: "GET",
				path: "/clusters",
				summary: "Plan dependency-safe Work execution clusters",
			})
			.input(
				WorkSchedulerIdentityInputSchema.extend({
					maxParallelism: z
						.number()
						.int()
						.min(1)
						.max(50)
						.optional()
						.describe(
							"Maximum mutually compatible items in one execution wave.",
						),
				}),
			)
			.output(WorkExecutionClusterPlanSchema),
	});

export type WorkSchedulerContract = typeof workSchedulerContract;
