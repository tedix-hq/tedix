import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	RepositoryEventSchema,
	RepositoryObserverConfigSchema,
	RepositoryReviewSchema,
} from "../schemas/repository-observer";
const receipt = z.strictObject({
	observationId: z.uuid(),
	workItemId: z.uuid(),
	status: z.string(),
});
export const repositoryObserverContract = oc.errors(baseErrors).router({
	configure: oc
		.route({
			method: "POST",
			summary: "Configure an advisory repository commit and Ship observer",
		})
		.input(
			z.strictObject({
				projectId: z.uuid(),
				config: RepositoryObserverConfigSchema,
			}),
		)
		.output(z.strictObject({ projectId: z.uuid() })),
	observe: oc
		.route({
			method: "POST",
			summary: "Wake the configured owner for a repository push or Ship event",
		})
		.input(RepositoryEventSchema)
		.output(receipt),
	report: oc
		.route({
			method: "POST",
			summary:
				"Record one lesson application comment and the current diagnosis",
		})
		.input(RepositoryReviewSchema)
		.output(receipt),
	repair: oc
		.route({
			method: "POST",
			summary:
				"Request one configured safe source repair or unchanged-candidate retry",
		})
		.input(
			z.strictObject({
				observationId: z.uuid(),
				lessonId: z.uuid(),
				paths: z.array(z.string()).max(100).default([]),
			}),
		)
		.output(z.strictObject({ runId: z.string(), status: z.string() })),
	pending: oc
		.route({
			method: "GET",
			summary: "List pending repository observations needing a diagnosis",
		})
		.input(z.strictObject({ projectId: z.uuid() }))
		.output(
			z.array(
				z.strictObject({
					observationId: z.uuid(),
					workItemId: z.uuid(),
					deadline: z.string().nullable(),
					summary: z.string(),
				}),
			),
		),
});
