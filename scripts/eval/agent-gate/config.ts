import { cases } from "./cases";

export default {
	description: "Tedix prompt-context selection: fictional public task shapes",
	prompts: ["{{caseId}}"],
	providers: ["file://provider.ts"],
	evaluateOptions: { repeat: 3, maxConcurrency: 1, cache: false },
	tests: cases.map((c) => ({
		description: c.id,
		vars: { caseId: c.id },
		assert: [{ type: "equals", value: JSON.stringify(c.expected) }],
	})),
};
