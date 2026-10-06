import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	CreatePurposeCharterRevisionInputSchema,
	OrganizationOwnerBriefSchema,
	OrganizationPurposeCharterSchema,
} from "../schemas/organization-purpose";

export const organizationPurposeContract = oc
	.route({ tags: ["organization-purpose"], prefix: "/organization-purpose" })
	.errors(baseErrors)
	.router({
		getActive: oc
			.route({
				method: "GET",
				path: "/active",
				summary: "Get the active organization Purpose Charter",
			})
			.input(z.object({}))
			.output(
				z.object({ charter: OrganizationPurposeCharterSchema.nullable() }),
			),
		listRevisions: oc
			.route({
				method: "GET",
				path: "/revisions",
				summary: "List Purpose Charter revision history",
			})
			.input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
			.output(z.object({ data: z.array(OrganizationPurposeCharterSchema) })),
		createRevision: oc
			.route({
				method: "POST",
				path: "/revisions",
				summary: "Create and activate a Purpose Charter revision",
				description:
					"Human-governed write: preserves history, supersedes the prior active revision, and becomes the default purpose link for new objectives.",
				successStatus: 201,
			})
			.input(CreatePurposeCharterRevisionInputSchema)
			.output(OrganizationPurposeCharterSchema),
		getOwnerBrief: oc
			.route({
				method: "GET",
				path: "/owner-brief",
				summary: "Get the compact owner-attention brief",
				description:
					"Deterministic, exception-driven read model: at most three decisions, exceptions, and purpose-linked outcomes plus purpose drift counts.",
			})
			.input(
				z.object({
					outcomeWindowDays: z.number().int().min(1).max(90).default(7),
				}),
			)
			.output(OrganizationOwnerBriefSchema),
	});

export type OrganizationPurposeContract = typeof organizationPurposeContract;
