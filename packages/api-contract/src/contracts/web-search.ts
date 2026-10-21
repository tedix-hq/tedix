import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	WebSearchInputSchema,
	WebSearchOutputSchema,
} from "../schemas/web-search";

export const webSearchContract = oc
	.route({ tags: ["web-search"], prefix: "/web-search" })
	.errors(baseErrors)
	.router({
		search: oc
			.route({
				method: "POST",
				path: "/search",
				summary: "Search the public web for the calling tedi",
				description:
					"Runs one search through the deployment's model gateway when the organization enabled web search and the tedi did not opt out. Results are untrusted third-party text.",
			})
			.input(WebSearchInputSchema)
			.output(WebSearchOutputSchema),
	});

export type WebSearchContract = typeof webSearchContract;
