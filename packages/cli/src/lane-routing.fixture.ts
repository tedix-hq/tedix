import { routingPolicySchema } from "./lane-routing";

// Fictional operator choices for routing tests, not managed service defaults.
export const testRoutingPolicy = routingPolicySchema.parse({
	version: 1,
	nearLimitPercent: 10,
	signalMaxAgeMs: 300_000,
	rules: [
		{
			name: "hard",
			tags: ["security"],
			sizes: ["large"],
			risks: ["high", "critical"],
			routes: [
				{ executor: "codex", model: "review-example" },
				{ executor: "claude-code", model: "review-example" },
				{ executor: "opencode", model: "example/review" },
			],
		},
		{
			name: "mechanical",
			tags: ["mechanical"],
			sizes: ["small"],
			risks: [],
			routes: [
				{ executor: "opencode", model: "example/small" },
				{ executor: "claude-code", model: "small-example" },
				{ executor: "codex", model: "small-example" },
				{ executor: "devin" },
			],
		},
		{
			name: "general",
			tags: [],
			sizes: [],
			risks: [],
			routes: [
				{ executor: "codex", model: "general-example" },
				{ executor: "claude-code", model: "general-example" },
				{ executor: "opencode", model: "example/general" },
				{ executor: "devin" },
			],
		},
	],
	budgetFiles: {},
});
