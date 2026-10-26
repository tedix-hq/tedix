import { describe, expect, it } from "vite-plus/test";
import {
	isSkillReadableByTedi,
	type SkillReadabilitySubject,
} from "./cognitive/skill-crud";
import {
	computeSkillPromotion,
	computeSkillPromotionBlockers,
} from "./cognitive/skill-promotion";
import { classifyLowQualitySkill } from "./cognitive/skill-quality";
import { computeSkillRepairs } from "./cognitive/skill-repair";
import { normalizeSkillSearchTerms } from "./cognitive/skill-search";
import {
	extractMcpToolMetadataSlugs,
	parseSkillFrontmatterCapabilities,
} from "./cognitive/skill-tool-metadata";
import {
	validateSkillInput,
	validateWorkflowSource,
} from "./cognitive/skill-validation";

const makeEntry = (
	overrides: Partial<SkillReadabilitySubject>,
): SkillReadabilitySubject =>
	({
		tediId: null,
		visibility: "org",
		...overrides,
	}) as SkillReadabilitySubject;

const makeRepairDb = (
	rows: Array<{ id: string; toolId: string }>,
): Parameters<typeof computeSkillRepairs>[0] =>
	({
		select: () => ({
			from: () => ({
				where: async () => rows,
			}),
		}),
	}) as unknown as Parameters<typeof computeSkillRepairs>[0];

const makePromotionDb = (
	...rowSets: Array<Array<Record<string, unknown>>>
): Parameters<typeof computeSkillPromotionBlockers>[0] => {
	let index = 0;
	const nextRows = () => rowSets[index++] ?? [];
	return {
		select: () => ({
			from: () => ({
				where: () => {
					const rows = nextRows();
					return rows;
				},
			}),
		}),
	} as unknown as Parameters<typeof computeSkillPromotionBlockers>[0];
};

const makeRepairEntry = (
	overrides: Partial<Parameters<typeof computeSkillRepairs>[1]> = {},
): Parameters<typeof computeSkillRepairs>[1] =>
	({
		id: "skill-1",
		organizationId: "org-1",
		tediId: null,
		domainId: null,
		title: "CMS Transfer",
		slug: "cms-transfer",
		description: "Move content into the CMS without rewriting it.",
		content: "# CMS Transfer",
		files: null,
		inputSchema: null,
		successCount: 0,
		failureCount: 0,
		lastUsedAt: null,
		avgDurationMs: null,
		revision: 1,
		revisionReasoning: null,
		supersedesId: null,
		visibility: "org",
		agentSkillsFormat: null,
		r2Path: null,
		appId: "app-1",
		toolIds: null,
		summary: "Transfer content safely.",
		tags: null,
		audience: null,
		preconditions: null,
		lifecycleState: "active",
		createdAt: "2026-05-24T00:00:00.000Z",
		updatedAt: "2026-05-24T00:00:00.000Z",
		...overrides,
	}) as Parameters<typeof computeSkillRepairs>[1];

const makePromotionEntry = (
	overrides: Partial<Parameters<typeof computeSkillPromotionBlockers>[1]> = {},
): Parameters<typeof computeSkillPromotionBlockers>[1] =>
	({
		id: "skill-1",
		organizationId: "org-1",
		title: "CMS Transfer",
		slug: "cms-transfer",
		content: "# CMS Transfer",
		appId: "app-1",
		...overrides,
	}) as Parameters<typeof computeSkillPromotionBlockers>[1];

describe("validateSkillInput", () => {
	it("returns structured EMPTY_BODY validation errors for blank skill content", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Blank Skill",
			description: "A skill with intentionally blank body content",
			content: "",
			summary: "blank body validation test",
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual({
			code: "EMPTY_BODY",
			message:
				"content must not be empty (canonical skill body lives in content)",
			path: "content",
		});
	});

	it("accepts a well-formed grounding policy", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Grounded Market Report",
			description: "Publish a market report with verified sources only",
			summary: "grounding policy validation test",
			content: `---
capabilities:
  grounding:
    required: true
    minCausalScore: 1.0
---
Publish the report.`,
			toolSlugs: ["list_skills"],
		});

		expect(
			result.errors.filter((issue) => issue.code === "SKILL_GROUNDING_INVALID"),
		).toEqual([]);
	});

	it("rejects a malformed grounding policy at write time", async () => {
		// Silently defaulting a typo'd policy to "no grounding required" is the
		// exact failure this gate exists to prevent — the skill would believe it
		// declared a standard of proof the runtime never enforces.
		const result = await validateSkillInput({} as never, {
			title: "Ungrounded Market Report",
			description: "Publish a market report with a typo'd grounding policy",
			summary: "grounding policy validation test",
			content: `---
capabilities:
  grounding:
    required: yes-please
    minCasualScore: 1.0
---
Publish the report.`,
			toolSlugs: ["list_skills"],
		});

		expect(result.valid).toBe(false);
		const grounding = result.errors.filter(
			(issue) => issue.code === "SKILL_GROUNDING_INVALID",
		);
		expect(grounding).toHaveLength(2);
		expect(grounding.map((issue) => issue.path).sort()).toEqual([
			"capabilities.grounding.minCasualScore",
			"capabilities.grounding.required",
		]);
	});

	it("warns when MCP tool metadata has no app scope to resolve against", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Progressive Discovery Audit",
			description: "Audit skills against the current MCP tool surface",
			summary: "Check tool coverage and progressive disclosure gaps",
			content: "Review the tools and report uncovered entries.",
			toolSlugs: ["list_skills", "read_skill"],
			metadataToolSlugs: ["list_skills", "read_skill"],
		});

		expect(result.valid).toBe(true);
		expect(result.warnings).toContainEqual({
			code: "MCP_TOOL_METADATA_UNSCOPED",
			message:
				"metadata.io.modelcontextprotocol/tools is present but no appId/appSlug scope was provided, so tool names cannot be resolved to app_tools.id values",
			path: "metadata.io.modelcontextprotocol/tools",
		});
	});

	it.each([
		["scripts/workflow.js"],
		["scripts/workflow.mjs"],
		["scripts/workflow.cjs"],
	])(
		"rejects %s because skill workflows execute workflow.ts snapshots",
		async (path) => {
			const result = await validateSkillInput({} as never, {
				title: "Legacy JS Workflow",
				description: "A skill with an unsupported JavaScript workflow file",
				summary: "legacy JS workflow validation test",
				content: "Run a deterministic workflow.",
				files: {
					[path]:
						"export default { async run(event, step, env) { return {}; } }",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.errors).toContainEqual({
				code: "UNSUPPORTED_WORKFLOW_JS",
				message: `Executable skill workflows must use files['scripts/workflow.ts']; ${path} is not supported by run_skill_workflow`,
				path: `files["${path}"]`,
			});
		},
	);

	it("accepts workflow MCP capabilities as an auditable tool association", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Workflow MCP Proof",
			description: "Exercise one read-only MCP tool inside a durable workflow.",
			summary: "Prove workflow MCP identity and evidence.",
			content: `---
capabilities:
  network: false
  mcp:
    home:
      - read_home_run_set
---

# Workflow MCP Proof`,
			files: {
				"scripts/workflow.ts":
					"export default { async run(event, step, env) { return step.do('read', async () => env.MCP.home.read_home_run_set({})); } }",
			},
		});

		expect(result.valid).toBe(true);
		expect(result.warnings.map((warning) => warning.code)).not.toContain(
			"MISSING_TOOL_ASSOCIATION",
		);
	});

	it("warns on secret-looking literals in content and files without echoing them", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Leaky Skill",
			description: "A skill that embeds credentials it should reference",
			summary: "secret literal lint test",
			content:
				"Call the API with header `X-API-Key: sk_live1234567890abcdef` and go.",
			files: {
				"references/key.pem":
					"-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----",
			},
		});

		// Heuristic lint — warnings, never write rejections.
		expect(result.valid).toBe(true);
		const secretWarnings = result.warnings.filter(
			(warning) => warning.code === "SKILL_SECRET_LITERAL",
		);
		expect(secretWarnings.map((warning) => warning.path)).toEqual([
			"content",
			'files["references/key.pem"]',
		]);
		for (const warning of secretWarnings) {
			expect(warning.message).not.toContain("sk_live1234567890abcdef");
			expect(warning.message).not.toContain("MIIEow");
		}
	});

	it("does not flag placeholder-style credential prose as a secret literal", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Clean Auth Skill",
			description: "Documents auth wiring using placeholders only",
			summary: "secret literal negative test",
			content:
				"Set `X-API-Key: sk_...` from the connection, or `Authorization: Bearer <token>`.",
		});

		expect(
			result.warnings.filter((w) => w.code === "SKILL_SECRET_LITERAL"),
		).toEqual([]);
	});

	const capabilityDb = (
		appRows: Array<{
			id: string;
			slug: string;
			metadata: Record<string, unknown> | null;
		}>,
		toolRows: Array<{ toolId: string }> = [],
	): Parameters<typeof validateSkillInput>[0] => {
		let call = 0;
		return {
			select: () => ({
				from: () => ({
					where: () => {
						call++;
						return call === 1 ? appRows : toolRows;
					},
				}),
			}),
		} as unknown as Parameters<typeof validateSkillInput>[0];
	};

	const capabilityContent = (namespace: string, methods: string[]) => `---
capabilities:
  network: false
  mcp:
    ${namespace}:
${methods.map((method) => `      - ${method}`).join("\n")}
---

# Capability Lint Probe`;

	it("warns when a capability namespace resolves to no app slug", async () => {
		const result = await validateSkillInput(capabilityDb([]), {
			title: "Typo Namespace",
			description: "Declares a namespace no app slug can satisfy",
			summary: "capability namespace lint test",
			content: capabilityContent("fyrecrawl", ["firecrawl_search"]),
		});

		expect(result.valid).toBe(true);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({
				code: "SKILL_CAPABILITY_UNKNOWN_NAMESPACE",
				path: "capabilities.mcp.fyrecrawl",
			}),
		);
	});

	it("recognizes the aggregate cognitive workflow namespace without an app row", async () => {
		const result = await validateSkillInput(capabilityDb([]), {
			title: "Hosted Artifact Skill",
			description: "Publishes a workflow-owned hosted artifact",
			summary: "aggregate platform namespace validation",
			content: capabilityContent("cognitive", ["record_artifact"]),
		});

		expect(
			result.warnings.filter((warning) =>
				warning.code.startsWith("SKILL_CAPABILITY_"),
			),
		).toEqual([]);
	});

	it("recognizes the gateway-native rationale namespace without an app row", async () => {
		// Every executive daily loop writes its operating receipt through
		// env.MCP.rationale.create_rationale_records, which resolves at dispatch
		// via the aggregate bridge and has no apps row by design. Warning on it
		// flagged every correct executive skill and taught authors to ignore
		// capability warnings wholesale.
		const result = await validateSkillInput(capabilityDb([]), {
			title: "Executive Loop Skill",
			description: "Records a workflow operating receipt",
			summary: "gateway-native rationale namespace validation",
			content: capabilityContent("rationale", ["create_rationale_records"]),
		});

		expect(
			result.warnings.filter((warning) =>
				warning.code.startsWith("SKILL_CAPABILITY_"),
			),
		).toEqual([]);
	});

	it("still warns for an unknown cognitive runtime method", async () => {
		const result = await validateSkillInput(capabilityDb([]), {
			title: "Invalid Hosted Artifact Skill",
			description: "Declares a typo in the platform workflow namespace",
			summary: "aggregate platform method validation",
			content: capabilityContent("cognitive", ["record_artifcat"]),
		});

		expect(result.warnings).toContainEqual(
			expect.objectContaining({
				code: "SKILL_CAPABILITY_UNKNOWN_METHOD",
				path: "capabilities.mcp.cognitive",
			}),
		);
	});

	it("rejects malformed expected workflow outcomes", async () => {
		const result = await validateSkillInput({} as never, {
			title: "Malformed Reliability Skill",
			description: "Declares an invalid expected terminal outcome",
			summary: "reliability policy validation",
			content: `---
capabilities:
  reliability:
    parameter: mode
    expectedTerminalStatuses:
      timeout: timed-out
---

# Invalid outcome policy`,
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				code: "SKILL_RELIABILITY_INVALID",
				path: "capabilities.reliability.expectedTerminalStatuses.timeout",
			}),
		);
	});

	it("warns when a declared capability method has no matching app tool", async () => {
		const result = await validateSkillInput(
			capabilityDb(
				[{ id: "app-fc", slug: "firecrawl-tedix", metadata: null }],
				[{ toolId: "firecrawl_search" }, { toolId: "firecrawl_scrape" }],
			),
			{
				title: "Typo Method",
				description: "Declares one real and one bogus method",
				summary: "capability method lint test",
				content: capabilityContent("firecrawl", [
					"firecrawl_search",
					"firecrawl_serach",
				]),
			},
		);

		expect(result.valid).toBe(true);
		const methodWarnings = result.warnings.filter(
			(warning) => warning.code === "SKILL_CAPABILITY_UNKNOWN_METHOD",
		);
		expect(methodWarnings).toHaveLength(1);
		expect(methodWarnings[0]!.message).toContain("firecrawl_serach");
		expect(methodWarnings[0]!.message).not.toContain("firecrawl_search,");
	});

	it("skips method lint for upstream-proxy apps whose tools live upstream", async () => {
		const result = await validateSkillInput(
			capabilityDb([
				{
					id: "app-proxy",
					slug: "proxy-tedix",
					metadata: {
						mcpConfig: { upstreamMcpUrl: "https://vendor.example/mcp" },
					},
				},
			]),
			{
				title: "Proxy Namespace",
				description: "Targets a proxy app with no materialized tool rows",
				summary: "capability proxy lint test",
				content: capabilityContent("proxy", ["vendor_tool"]),
			},
		);

		expect(
			result.warnings.filter((warning) =>
				warning.code.startsWith("SKILL_CAPABILITY_"),
			),
		).toEqual([]);
	});

	it("skips method lint for zero-tool (dynamic) apps", async () => {
		const result = await validateSkillInput(
			capabilityDb(
				[{ id: "app-dyn", slug: "dynamic-tedix", metadata: null }],
				[],
			),
			{
				title: "Dynamic Namespace",
				description: "Targets a code-mode app with no materialized tools",
				summary: "capability dynamic lint test",
				content: capabilityContent("dynamic", ["some_tool"]),
			},
		);

		expect(
			result.warnings.filter((warning) =>
				warning.code.startsWith("SKILL_CAPABILITY_"),
			),
		).toEqual([]);
	});
});

describe("classifyLowQualitySkill", () => {
	it("flags sentence-shaped low-evidence active skills with weak descriptions", () => {
		const result = classifyLowQualitySkill(
			makeRepairEntry({
				title: "An runtime heartbeat poll was completed successfully",
				slug: "an-runtime-heartbeat-poll-was-run-and-completed-successfully",
				description: "Heartbeat complete",
				successCount: 0,
				failureCount: 0,
				lastUsedAt: null,
				createdAt: "2026-04-01T00:00:00.000Z",
			}),
			{ orphanOlderThanDays: 1 },
		);

		expect(result?.reasons.map((reason) => reason.code)).toEqual([
			"LONG_SENTENCE_SLUG",
			"ORPHANED_UNUSED",
			"UNPROVEN_ACTIVE",
			"WEAK_DESCRIPTION",
		]);
	});

	it("does not flag a proven task-shaped skill with a useful description", () => {
		const result = classifyLowQualitySkill(
			makeRepairEntry({
				title: "Customer Onboarding Review",
				slug: "customer-onboarding-review",
				description:
					"Review a newly created customer org, verify app assignments, and confirm the tedi has the required operating context.",
				successCount: 5,
				failureCount: 0,
				lastUsedAt: "2026-05-24T00:00:00.000Z",
				lifecycleState: "proven",
			}),
		);

		expect(result).toBeNull();
	});
});

describe("extractMcpToolMetadataSlugs", () => {
	it("extracts metadata.io.modelcontextprotocol/tools from canonical skill frontmatter", () => {
		const content = `---
name: cms-transfer
metadata:
  "io.modelcontextprotocol/tools": ["notion_fetch", "cms_create_post"]
---

# CMS Transfer`;

		expect(extractMcpToolMetadataSlugs(content)).toEqual([
			"notion_fetch",
			"cms_create_post",
		]);
	});

	it("extracts list-style MCP tool metadata and deduplicates names", () => {
		const content = `---
name: operator-appearance
metadata:
  "io.modelcontextprotocol/tools":
    - read_operator_preferences
    - update_operator_preferences
    - read_operator_preferences
---

# Tedix OS Appearance`;

		expect(extractMcpToolMetadataSlugs(content)).toEqual([
			"read_operator_preferences",
			"update_operator_preferences",
		]);
	});

	it("extracts quoted and block-style YAML tool metadata", () => {
		const content = `---
name: operator-appearance
metadata:
  "io.modelcontextprotocol/tools":
    - "read_operator_preferences"
    - 'update_operator_preferences'
    - read_operator_preferences
---

# Tedix OS Appearance`;

		expect(extractMcpToolMetadataSlugs(content)).toEqual([
			"read_operator_preferences",
			"update_operator_preferences",
		]);
	});

	it("ignores malformed frontmatter", () => {
		const content = `---
metadata:
  "io.modelcontextprotocol/tools": [notion_fetch
---

# Broken`;

		expect(extractMcpToolMetadataSlugs(content)).toEqual([]);
	});
});

describe("parseSkillFrontmatterCapabilities", () => {
	it("parses canonical workflow capabilities from YAML frontmatter", () => {
		const content = `---
name: research-skill
capabilities:
  network: true
  mcp:
    notion: [search, getPage]
    firecrawl:
      - scrape
      - crawl
      - scrape
---

# Research`;

		expect(parseSkillFrontmatterCapabilities(content)).toEqual({
			network: true,
			mcp: {
				notion: ["search", "getPage"],
				firecrawl: ["scrape", "crawl"],
			},
		});
	});

	it("ignores non-boolean network and malformed frontmatter capabilities", () => {
		expect(
			parseSkillFrontmatterCapabilities(`---
capabilities:
  network: "true"
  mcp:
    notion: search
---

# Research`),
		).toEqual({
			network: false,
			mcp: {},
		});

		expect(
			parseSkillFrontmatterCapabilities(`---
capabilities: [broken
---
# Broken`),
		).toEqual({ network: false, mcp: {} });
	});
});

describe("validateWorkflowSource sandbox boundary", () => {
	const runnable = (body: string, imports = "") => `${imports}
export default {
  async run(event, step, env) {
    ${body}
  }
};`;

	it("allows the Cloudflare workflow primitive import", () => {
		expect(
			validateWorkflowSource(
				runnable(
					'await step.do("proof", async () => ({ ok: true }));',
					'import { NonRetryableError } from "cloudflare:workflows";',
				),
				"scripts/workflow.ts",
				{ network: false, mcp: {} },
			),
		).toEqual([]);
	});

	it.each([
		'import { env } from "cloudflare:workers";',
		'import { connect } from "cloudflare:sockets";',
		'import fs from "node:fs";',
		'import "untrusted-package";',
	])("rejects tenant runtime import %s", (runtimeImport) => {
		const issues = validateWorkflowSource(
			runnable("return { ok: true };", runtimeImport),
			"scripts/workflow.ts",
			{ network: false, mcp: {} },
		);
		expect(issues.map((issue) => issue.code)).toContain(
			"WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED",
		);
	});

	it("allows erased type-only imports", () => {
		expect(
			validateWorkflowSource(
				runnable(
					"return { ok: true };",
					'import type { WorkflowEvent } from "cloudflare:workers";',
				),
				"scripts/workflow.ts",
				{ network: false, mcp: {} },
			),
		).toEqual([]);
	});

	it("requires network authority and durable fetch placement independently", () => {
		const durableFetch = runnable(
			'await step.do("fetch", async () => fetch("https://example.com"));',
		);
		expect(
			validateWorkflowSource(durableFetch, "scripts/workflow.ts", {
				network: false,
				mcp: {},
			}).map((issue) => issue.code),
		).toContain("WORKFLOW_NETWORK_WITHOUT_CAPABILITY");
		expect(
			validateWorkflowSource(durableFetch, "scripts/workflow.ts", {
				network: true,
				mcp: {},
			}),
		).toEqual([]);

		const replayUnsafeFetch = runnable(
			'const response = await fetch("https://example.com"); return response.status;',
		);
		expect(
			validateWorkflowSource(replayUnsafeFetch, "scripts/workflow.ts", {
				network: true,
				mcp: {},
			}).map((issue) => issue.code),
		).toContain("WORKFLOW_NETWORK_OUTSIDE_STEP");
	});
});

describe("validateWorkflowSource scanner regressions", () => {
	const manifest = { network: false, mcp: {} };

	it("accepts a template literal nested inside another template's interpolation", () => {
		const source = `
function rows(items) {
  return \`<ul>\${items.map((i) => \`<li>\${i}</li>\`).join("")}</ul>\`;
}
export default {
  async run(event, step, env) {
    return await step.do("render", async () => rows(["a"]));
  }
};`;
		expect(
			validateWorkflowSource(source, "scripts/workflow.ts", manifest).map(
				(issue) => issue.code,
			),
		).not.toContain("WORKFLOW_NO_DEFAULT_EXPORT");
	});

	it("accepts regex literals containing quotes and trailing escaped slashes", () => {
		const source = `
function esc(s) {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function bare(u) {
  return String(u).replace(/^https?:\\/\\//, "");
}
export default {
  async run(event, step, env) {
    return await step.do("clean", async () => esc(bare("https://x.dev")));
  }
};`;
		expect(
			validateWorkflowSource(source, "scripts/workflow.ts", manifest).map(
				(issue) => issue.code,
			),
		).not.toContain("WORKFLOW_NO_DEFAULT_EXPORT");
	});

	it("does not mistake division for a regex literal", () => {
		const source = `
const HALF = 10 / 2;
function ratio(a, b) {
  return a / b / HALF;
}
export default {
  async run(event, step, env) {
    return await step.do("math", async () => ratio(4, 2));
  }
};`;
		expect(
			validateWorkflowSource(source, "scripts/workflow.ts", manifest),
		).toEqual([]);
	});

	it("still sees replay-unsafe fetch inside a template interpolation", () => {
		const source = `
export default {
  async run(event, step, env) {
    const label = \`status: \${await fetch("https://example.com").then((r) => r.status)}\`;
    return label;
  }
};`;
		expect(
			validateWorkflowSource(source, "scripts/workflow.ts", {
				network: true,
				mcp: {},
			}).map((issue) => issue.code),
		).toContain("WORKFLOW_NETWORK_OUTSIDE_STEP");
	});
});

describe("computeSkillRepairs", () => {
	it("resolves MCP tool metadata into UUID toolIds", async () => {
		const entry = makeRepairEntry({
			content: `---
metadata:
  "io.modelcontextprotocol/tools": ["notion_fetch", "cms_create_post"]
---

# CMS Transfer`,
		});

		const result = await computeSkillRepairs(
			makeRepairDb([
				{ id: "tool-id-1", toolId: "notion_fetch" },
				{ id: "tool-id-2", toolId: "cms_create_post" },
			]),
			entry,
		);

		expect(result.patch).toEqual({ toolIds: ["tool-id-1", "tool-id-2"] });
		expect(result.changes).toContainEqual({
			code: "RESOLVE_MCP_TOOL_METADATA",
			field: "toolIds",
			before: [],
			after: ["tool-id-1", "tool-id-2"],
			note: "resolved 2 metadata tool names to UUIDs",
		});
	});

	it("merges resolved MCP metadata with existing toolIds and reports unresolved names", async () => {
		const entry = makeRepairEntry({
			toolIds: ["existing-tool-id"],
			content: `---
metadata:
  "io.modelcontextprotocol/tools":
    - notion_fetch
    - missing_tool
---

# CMS Transfer`,
		});

		const result = await computeSkillRepairs(
			makeRepairDb([{ id: "tool-id-1", toolId: "notion_fetch" }]),
			entry,
		);

		expect(result.patch).toEqual({
			toolIds: ["existing-tool-id", "tool-id-1"],
		});
		expect(result.changes).toEqual([
			expect.objectContaining({
				code: "RESOLVE_MCP_TOOL_METADATA",
				before: ["existing-tool-id"],
				after: ["existing-tool-id", "tool-id-1"],
				note: "resolved 1; unresolved metadata tools: missing_tool",
			}),
		]);
	});

	it("leaves a well-formed skill with no MCP metadata as a true no-op", async () => {
		const result = await computeSkillRepairs(
			makeRepairDb([]),
			makeRepairEntry(),
		);

		expect(result).toEqual({ changes: [], patch: {} });
	});

	it("reports unresolved MCP metadata without patching when the app has no tools", async () => {
		const entry = makeRepairEntry({
			content: `---
metadata:
  "io.modelcontextprotocol/tools": ["notion_fetch", "cms_create_post"]
---

# CMS Transfer`,
		});

		const result = await computeSkillRepairs(makeRepairDb([]), entry);

		expect(result.patch).toEqual({});
		expect(result.changes).toEqual([
			{
				code: "UNRESOLVED_MCP_TOOL_METADATA",
				field: "metadata.io.modelcontextprotocol/tools",
				before: ["notion_fetch", "cms_create_post"],
				note: "unresolved metadata tools: notion_fetch, cms_create_post",
			},
		]);
	});

	it("reports unresolved MCP metadata without patching when the skill has no app scope", async () => {
		const entry = makeRepairEntry({
			appId: null,
			content: `---
metadata:
  "io.modelcontextprotocol/tools": ["notion_fetch"]
---

# CMS Transfer`,
		});

		const result = await computeSkillRepairs(makeRepairDb([]), entry);

		expect(result.patch).toEqual({});
		expect(result.changes).toEqual([
			{
				code: "UNRESOLVED_MCP_TOOL_METADATA",
				field: "metadata.io.modelcontextprotocol/tools",
				before: ["notion_fetch"],
				note: "skill has MCP tool metadata but no appId scope, so tool names cannot be resolved",
			},
		]);
	});
});

describe("computeSkillPromotion", () => {
	it("promotes a tedi-scoped draft into a baseline org skill", () => {
		const result = computeSkillPromotion(
			{
				tediId: "tedi-a",
				visibility: "private",
				lifecycleState: "draft",
				supersedesId: null,
				revision: 4,
			},
			{ revisionReasoning: "Accepted as an org baseline procedure." },
		);

		expect(result.patch).toEqual({
			tediId: null,
			visibility: "org",
			lifecycleState: "active",
			revisionReasoning: "Accepted as an org baseline procedure.",
			revision: 5,
		});
		expect(result.changes).toContainEqual(
			expect.objectContaining({
				code: "PROMOTE_TO_BASELINE",
				field: "tediId",
				before: "tedi-a",
				after: null,
			}),
		);
	});

	it("keeps proven and crystallized lifecycle states unless the caller overrides them", () => {
		expect(
			computeSkillPromotion({
				tediId: "tedi-a",
				visibility: "shared",
				lifecycleState: "proven",
				supersedesId: null,
				revision: 2,
			}).patch,
		).not.toHaveProperty("lifecycleState");

		expect(
			computeSkillPromotion(
				{
					tediId: "tedi-a",
					visibility: "shared",
					lifecycleState: "crystallized",
					supersedesId: null,
					revision: 2,
				},
				{ lifecycleState: "active" },
			).patch,
		).toMatchObject({ lifecycleState: "active" });
	});

	it("is a no-op for an already-promoted baseline skill with matching defaults", () => {
		expect(
			computeSkillPromotion({
				tediId: null,
				visibility: "org",
				lifecycleState: "active",
				supersedesId: null,
				revision: 1,
			}),
		).toEqual({ changes: [], patch: {} });
	});

	it("can attach a supersedes chain during promotion", () => {
		const result = computeSkillPromotion(
			{
				tediId: "tedi-a",
				visibility: "org",
				lifecycleState: "active",
				supersedesId: null,
				revision: 3,
			},
			{ supersedesId: "baseline-old" },
		);

		expect(result.patch).toMatchObject({
			tediId: null,
			supersedesId: "baseline-old",
			revision: 4,
		});
		expect(result.changes).toContainEqual({
			code: "SET_SUPERSEDES",
			field: "supersedesId",
			before: null,
			after: "baseline-old",
		});
	});
});

describe("computeSkillPromotionBlockers", () => {
	it("blocks promotion when SKILL.md MCP tool metadata cannot be resolved", async () => {
		const entry = makePromotionEntry({
			content: `---
metadata:
  "io.modelcontextprotocol/tools": ["notion_fetch", "cms_posts_create"]
---

# CMS Transfer`,
		});

		const blockers = await computeSkillPromotionBlockers(
			makePromotionDb([{ id: "tool-1", toolId: "cms_posts_create" }], []),
			entry,
		);

		expect(blockers).toEqual([
			{
				code: "UNRESOLVED_MCP_TOOL_METADATA",
				field: "metadata.io.modelcontextprotocol/tools",
				before: ["notion_fetch", "cms_posts_create"],
				after: ["notion_fetch"],
				note: "unresolved metadata tools: notion_fetch",
			},
		]);
	});

	it("blocks promotion when metadata names exist without an app scope", async () => {
		const blockers = await computeSkillPromotionBlockers(
			makePromotionDb([]),
			makePromotionEntry({
				appId: null,
				content: `---
metadata:
  "io.modelcontextprotocol/tools": ["cms_posts_create"]
---

# CMS Transfer`,
			}),
		);

		expect(blockers).toEqual([
			{
				code: "UNRESOLVED_MCP_TOOL_METADATA",
				field: "metadata.io.modelcontextprotocol/tools",
				before: ["cms_posts_create"],
				note: "skill has MCP tool metadata but no appId scope, so tool names cannot be resolved before promotion",
			},
		]);
	});

	it("returns a structured blocker when a baseline skill already owns the slug", async () => {
		const blockers = await computeSkillPromotionBlockers(
			makePromotionDb([{ id: "baseline-1" }]),
			makePromotionEntry({ content: "# CMS Transfer" }),
		);

		expect(blockers).toEqual([
			{
				code: "BASELINE_SLUG_EXISTS",
				field: "slug",
				before: "cms-transfer",
				after: "baseline-1",
				note: 'baseline skill baseline-1 already uses slug "cms-transfer"',
			},
		]);
	});

	it("allows promotion when metadata resolves and no baseline slug collision exists", async () => {
		const entry = makePromotionEntry({
			content: `---
metadata:
  "io.modelcontextprotocol/tools": ["cms_posts_create"]
---

# CMS Transfer`,
		});

		await expect(
			computeSkillPromotionBlockers(
				makePromotionDb([{ id: "tool-1", toolId: "cms_posts_create" }], []),
				entry,
			),
		).resolves.toEqual([]);
	});
});

describe("normalizeSkillSearchTerms", () => {
	it("bounds long policy blobs to meaningful deduped search terms", () => {
		const terms = normalizeSkillSearchTerms(`# Retail agent policy

As a retail agent, you can help users:

- **cancel or modify pending orders**
- **return or exchange delivered orders**
- **modify their default user address**
- **provide information about their own profile, orders, and related products**

At the beginning of the conversation, you have to authenticate the user identity by locating their user id via email.`);

		expect(terms).toEqual([
			"retail",
			"agent",
			"policy",
			"users",
			"cancel",
			"modify",
			"pending",
			"orders",
		]);
	});

	it("filters punctuation and stop words without dropping useful short product terms", () => {
		expect(normalizeSkillSearchTerms("Can the UI use D1/R2 API data?")).toEqual(
			["ui", "d1", "r2", "api", "data"],
		);
	});
});

describe("isSkillReadableByTedi", () => {
	const tediA = "tedi-a";
	const tediB = "tedi-b";

	it("baseline non-private skills are readable by any tedi and by anonymous callers", () => {
		const baselineOrg = makeEntry({ tediId: null, visibility: "org" });
		const baselineShared = makeEntry({ tediId: null, visibility: "shared" });
		expect(isSkillReadableByTedi(baselineOrg, tediA)).toBe(true);
		expect(isSkillReadableByTedi(baselineShared, tediA)).toBe(true);
		expect(isSkillReadableByTedi(baselineOrg)).toBe(true);
	});

	it("baseline private skills are hidden from everyone", () => {
		const baselinePrivate = makeEntry({ tediId: null, visibility: "private" });
		expect(isSkillReadableByTedi(baselinePrivate, tediA)).toBe(false);
		expect(isSkillReadableByTedi(baselinePrivate)).toBe(false);
	});

	it("a tedi can read its own skills at every visibility", () => {
		for (const visibility of ["private", "shared", "org"] as const) {
			const own = makeEntry({ tediId: tediA, visibility });
			expect(isSkillReadableByTedi(own, tediA)).toBe(true);
		}
	});

	it("another tedi's skills are never readable — even shared/org — until promoted to baseline", () => {
		for (const visibility of ["private", "shared", "org"] as const) {
			const other = makeEntry({ tediId: tediB, visibility });
			expect(isSkillReadableByTedi(other, tediA)).toBe(false);
		}
	});

	it("anonymous callers cannot read any tedi-scoped skills", () => {
		const tediScoped = makeEntry({ tediId: tediA, visibility: "org" });
		expect(isSkillReadableByTedi(tediScoped)).toBe(false);
	});
});

// Lifecycle advancement/demotion tests live in ./skill-lifecycle.test.ts
// (execute-to-promote engine).
