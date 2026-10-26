import { describe, expect, it } from "vite-plus/test";
import {
	detectPrematureHeaderClose,
	slugify,
	validateSkillInput,
	warnFactoryIdLiterals,
	validateWorkflowSource,
} from "./skill-validation";

describe("generated skill slug length boundary", () => {
	it.each([62, 63, 64, 65])(
		"keeps a %i-character first word valid",
		(length) => {
			const slug = slugify(`${"a".repeat(length)} second word`);
			expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
			expect(slug.length).toBeLessThanOrEqual(64);
			expect(slugify(slug)).toBe(slug);
		},
	);

	it("accepts a title whose separator falls at the truncation boundary", async () => {
		const result = await validateSkillInput({} as never, {
			title: `${"a".repeat(63)} second word`,
			content: "Instructions for the skill.",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(slugify(`${"a".repeat(63)} second word`)).toBe("a".repeat(63));
	});
});

const base = {
	title: "Probe Skill",
	description: "A probe skill used by validation tests",
	summary: "probe",
	toolSlugs: ["list_skills"],
};

const skillDoc = (schedule: string) => `---
name: probe
description: probe
capabilities:
  schedule:
    cron: "${schedule}"
---
Body.`;

it.each(["os", "work"])(
	"recognizes the gateway platform %s namespace without an app row",
	async (namespace) => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: `---
capabilities:
  mcp:
    ${namespace}: [list_records]
---
Body.`,
		});

		expect(
			result.warnings.filter((warning) =>
				warning.code.startsWith("SKILL_CAPABILITY_"),
			),
		).toEqual([]);
	},
);

describe("validate_skill schedule parity with the scheduler", () => {
	it("rejects a cron the scheduler cannot parse and names the syntax", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc("MON * * * *"),
		});
		expect(result.valid).toBe(false);
		const issue = result.errors.find(
			(e) => e.code === "SKILL_SCHEDULE_INVALID",
		);
		expect(issue?.message).toContain("Supported cron syntax");
	});

	it("accepts a range with a step and warns the row only exists when active", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc("0-59/5 * * * *"),
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings.map((w) => w.code)).toContain(
			"SKILL_SCHEDULE_PROJECTED_WHEN_ACTIVE",
		);
	});

	it.each([
		["0 7 * * *", false],
		["*/15 * * * *", false],
		["0 7,19 * * *", false],
		["0 7 * * 1", true],
		["0 9 * * 1-5", true],
		["0 6 1 * *", true],
		["0 6 */2 * *", true],
	])("warns when %s fires less than daily: %s", async (cron, warned) => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc(cron as string),
		});
		expect(result.errors).toEqual([]);
		const warning = result.warnings.find(
			(w) => w.code === "SKILL_SCHEDULE_LESS_THAN_DAILY",
		);
		expect(Boolean(warning)).toBe(warned);
		if (warning) expect(warning.message).toContain("at least daily");
	});

	it.each([
		"export default { async run(event, step, env) { return 1; } };",
		"export default { async run(event, step, env) { /* async eligibility() {} */ return 1; } };",
		"export default { async run(event, step, env) { const hint = 'eligibility(event, step, env)'; return 1; } };",
		"export default { async run(event, step, env) { const helper = { eligibility() {} }; return 1; } };",
	])(
		"rejects inference workflows without an exported eligibility method: %s",
		async (source) => {
			const result = await validateSkillInput({} as never, {
				...base,
				content: skillDoc("0 9 * * *").replace(
					'cron: "0 9 * * *"',
					'cron: "0 9 * * *"\n    executionKind: inference',
				),
				files: { "scripts/workflow.ts": source },
			});
			expect(result.errors).toContainEqual(
				expect.objectContaining({
					code: "BACKGROUND_ELIGIBILITY_REQUIRED",
					path: 'files["scripts/workflow.ts"]',
				}),
			);
		},
	);

	it.each([
		"async eligibility(event, step, env) { return {}; },",
		"eligibility: async (event, step, env) => ({}),",
		"eligibility: async function(event, step, env) { return {}; },",
		"eligibility: checkEligibility,",
		"...eligibilityHooks,",
	])(
		"accepts an inference workflow with an exported eligibility callable: %s",
		async (member) => {
			const result = await validateSkillInput({} as never, {
				...base,
				content: skillDoc("0 9 * * *").replace(
					'cron: "0 9 * * *"',
					'cron: "0 9 * * *"\n    executionKind: inference',
				),
				files: {
					"scripts/workflow.ts": `const checkEligibility = async () => ({}); const eligibilityHooks = { eligibility: checkEligibility }; export default { ${member} async run(event, step, env) { return 1; } };`,
				},
			});
			expect(result.errors).toEqual([]);
		},
	);

	it("leaves identifier default exports to existing workflow shape validation", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc("0 9 * * *").replace(
				'cron: "0 9 * * *"',
				'cron: "0 9 * * *"\n    executionKind: inference',
			),
			files: {
				"scripts/workflow.ts":
					"const workflow = { async run(event, step, env) { return 1; }, async eligibility(event, step, env) { return {}; } }; export default workflow;",
			},
		});
		expect(result.errors.map((issue) => issue.code)).not.toContain(
			"BACKGROUND_ELIGIBILITY_REQUIRED",
		);
	});

	it("keeps deterministic workflows free of the inference eligibility requirement", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc("0 9 * * *"),
			files: {
				"scripts/workflow.ts":
					"export default { async run(event, step, env) { return 1; } };",
			},
		});
		expect(result.errors).toEqual([]);
	});

	it("warns when frontmatter is invalid YAML instead of silently dropping it", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: "---\nname: x\ndescription: a: b\n---\nBody.",
		});
		expect(result.warnings.map((w) => w.code)).toContain(
			"SKILL_FRONTMATTER_INVALID_YAML",
		);
	});
});

describe("validateWorkflowSource AST semantics", () => {
	const caps = { mcp: {}, network: false } as never;
	const codes = (source: string) =>
		validateWorkflowSource(source, "scripts/workflow.ts", caps).map(
			(issue) => issue.code,
		);

	it("accepts an arrow-function `run` property", () => {
		expect(
			codes(`export default { run: async (event, step) => ({ ok: true }) };`),
		).toEqual([]);
	});

	it("accepts a default export bound through a top-level identifier", () => {
		expect(
			codes(
				`const workflow = { async run(event, step, env) { return 1; } }; export default workflow;`,
			),
		).toEqual([]);
	});

	it("does not treat member calls as ambient globals", () => {
		// `env.MCP.tools.fetch` is an MCP method named "fetch", not ambient fetch;
		// `scope.eval` is not `eval()`. Text heuristics flagged both.
		const source = `export default {
  async run(event, step, env) {
    const out = await step.do("probe", async () => env.MCP.tools.fetch({ url: "https://example.com" }));
    return scope.eval(String(out));
  }
};`;
		expect(codes(source)).toEqual([]);
	});

	it("allows erased type-only imports and type-position import()", () => {
		const source = `import { type WorkflowEvent } from "cloudflare:workers";
import { type Foo } from "node:path";
type Inspect = import("node:util").InspectOptions;
export default {
  async run(event: WorkflowEvent, step, env) { return 1; }
};`;
		expect(codes(source)).toEqual([]);
	});

	it("accepts nested type annotations and a trailing parameter comma", () => {
		expect(
			codes(`export default {
  async run(event: { pairs: Map<string, number> }, step: Step, env: Env,) { return 1; }
};`),
		).toEqual([]);
	});

	it("accepts generic parameter types whose arguments contain commas", () => {
		expect(
			codes(
				`export default { async run(event: Record<string, unknown>, step: Step) { return 1; } };`,
			),
		).toEqual([]);
		expect(
			codes(
				`export default { async run(event: Record<string, Map<string, number[]>>, step: Step, env: Readonly<Record<string, string>>) { return 1; } };`,
			),
		).toEqual([]);
	});

	it.each([
		"event: Record<string, unknown>",
		"event: Record<string, unknown>, step: Step, env: Env, extra: Map<string, number>",
	])(
		"still rejects a wrong argument count with generic types: (%s)",
		(params) => {
			expect(
				codes(`export default { async run(${params}) { return 1; } };`),
			).toContain("WORKFLOW_RUN_SIGNATURE_INVALID");
		},
	);

	it.each([
		['import("node:fs")', "WORKFLOW_DYNAMIC_IMPORT"],
		['require("node:fs")', "WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED"],
		['eval("1")', "WORKFLOW_EVAL_OR_FUNCTION"],
		['new Function("return 1")', "WORKFLOW_EVAL_OR_FUNCTION"],
	])("rejects executable %s", (expression, code) => {
		expect(
			codes(
				`export default { async run(event, step) { return ${expression}; } };`,
			),
		).toContain(code);
	});

	it("rejects a mixed type and runtime import", () => {
		expect(
			codes(`import { type Foo, bar } from "node:path";
export default { async run(event, step) { return bar; } };`),
		).toContain("WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED");
	});

	it("reports illegal module-level return syntax", () => {
		expect(
			codes(`return 1; export default { async run(event, step) {} };`),
		).toContain("WORKFLOW_SOURCE_SYNTAX_ERROR");
	});

	it("ignores import statements inside comments", () => {
		const source = `/*
import fs from "node:fs";
*/
export default { async run(event, step) { return 1; } };`;
		expect(codes(source)).toEqual([]);
	});

	it("flags a fetch that runs at module evaluation inside a top-level block", () => {
		const found = codes(`if (Date.now() > 0) {
  fetch("https://example.com");
}
export default { async run(event, step) { return 1; } };`);
		expect(found).toContain("WORKFLOW_TOP_LEVEL_SIDE_EFFECT");
	});

	it("reports a syntax error instead of silently misreading broken source", () => {
		const found = codes(
			`export default { async run(event, step) { return 1; }`,
		);
		expect(found).toContain("WORKFLOW_SOURCE_SYNTAX_ERROR");
	});
});

describe("workflow header comment", () => {
	const body = `export default { async run() { return 1; } };`;
	const caps = { mcp: {}, network: false } as never;

	it("flags a cron step that closes the /* tedix */ header early", () => {
		const source = `/* tedix
name: probe
capabilities:
  schedule:
    cron: "*/5 * * * *"
*/
${body}`;
		expect(detectPrematureHeaderClose(source)).toContain("closes early");
		const errors = validateWorkflowSource(source, "scripts/workflow.ts", caps);
		expect(errors.map((e) => e.code)).toContain(
			"WORKFLOW_HEADER_COMMENT_CLOSED_EARLY",
		);
	});

	it("accepts a well-formed header and a source without one", () => {
		const header = `/* tedix
name: probe
cron: "0-59/5 * * * *"
*/
${body}`;
		expect(detectPrematureHeaderClose(header)).toBeNull();
		expect(detectPrematureHeaderClose(body)).toBeNull();
		expect(detectPrematureHeaderClose(`/* note */ ${body}`)).toBeNull();
	});

	it("ignores runtime imports inside comments", () => {
		const source = `/* Example only:
import fs from "node:fs";
*/
export default { async run(event, step, env) { return { ok: true }; } };`;
		expect(validateWorkflowSource(source, "scripts/workflow.ts", caps)).toEqual(
			[],
		);
	});
});

describe("factory UUID warning", () => {
	it("warns only for literals matching this binding, including templates", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const factory = {
			projectId: id,
			workspaceId: null,
			objectiveId: null,
			blueprintRevisionId: null,
			ownerTediId: null,
			healthWorkItemId: null,
			output: null,
		};
		expect(
			warnFactoryIdLiterals(
				`export default { run() { return "${id}"; } }`,
				factory,
			),
		).toEqual([expect.objectContaining({ code: "FACTORY_ID_LITERAL" })]);
		expect(
			warnFactoryIdLiterals(
				"const x = `project:" + id + "`; export default { run() {} }",
				factory,
			),
		).toHaveLength(1);
		expect(
			warnFactoryIdLiterals(
				`// ${id}\nexport default { run() { return "22222222-2222-4222-8222-222222222222"; } }`,
				factory,
			),
		).toEqual([]);
		expect(
			warnFactoryIdLiterals(
				"export default { run(e,s,env) { return env.__RUN_CONTEXT__.factory; } }",
				factory,
			),
		).toEqual([]);
	});
});

it("warns on configured related resource IDs", () => {
	const id = "22222222-2222-4222-8222-222222222222";
	expect(
		warnFactoryIdLiterals(`const site = "${id}"; export default { run() {} }`, {
			projectId: "project",
			workspaceId: null,
			objectiveId: null,
			blueprintRevisionId: null,
			ownerTediId: null,
			healthWorkItemId: null,
			output: null,
			resourceIds: { docsSite: id },
		}),
	).toHaveLength(1);
});
