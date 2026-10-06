import { defineCollection } from "astro:content";
import {
	docsCollection,
	partialsCollection,
} from "@cloudflare/nimbus-docs/content";
import { z } from "astro/zod";

export const collections = {
	docs: defineCollection(
		docsCollection({
			schemaFields: {
				audience: z.literal("human").optional(),
				topic: z.string().trim().min(1).optional(),
				resource_type: z
					.enum([
						"guide",
						"tutorial",
						"reference",
						"troubleshooting",
						"learning-path",
						"video",
						"release-note",
					])
					.optional(),
				summary: z.string().optional(),
				read_when: z.array(z.string()).optional(),
				visibility: z.literal("public").optional(),
				status: z
					.enum([
						"proposed",
						"accepted",
						"active",
						"superseded",
						"investigation",
					])
					.optional(),
				date: z.union([z.iso.date(), z.date()]).optional(),
				superseded_by: z.string().trim().min(1).optional(),
			},
		}),
	),
	partials: defineCollection(partialsCollection()),
};
