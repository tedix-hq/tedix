import type { SandboxedPlugin } from "emdash/plugin";
import {
	isTedixHomepageEntry,
	readHomepagePolicy,
	validateHomepagePublishContent,
} from "../../lib/tedix-home-validation";

export default {
	hooks: {
		"content:beforePublish": {
			// Publishing malformed homepage blocks would break a public route.
			errorPolicy: "abort",
			handler: async ({ collection, content }, ctx) => {
				const policy = readHomepagePolicy(await ctx.settings.get("policy"));
				if (!isTedixHomepageEntry(collection, content, policy)) return;
				const data = content.data;
				const reason = validateHomepagePublishContent(
					data && typeof data === "object" && !Array.isArray(data)
						? (data as Record<string, unknown>).content
						: undefined,
					policy,
				);
				if (reason) return { cancel: true, reason };
			},
		},
	},
} satisfies SandboxedPlugin;
