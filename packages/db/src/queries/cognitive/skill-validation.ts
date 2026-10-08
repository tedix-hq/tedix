import { WORKFLOW_PLATFORM_MCP_METHODS } from "@tedix/api-contract/utils/skill-manifest";
import { validateSkillSchedulePolicy } from "@tedix/api-contract/utils/skill-schedule";
import { eq, inArray } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import type { DbClient } from "../../client";
import { apps } from "../../schema/apps";
import { chunkForBoundParams } from "../../utils/batch";
import { appTools } from "../../schema/tools";
import {
	parseSkillFrontmatterCapabilities,
	resolveToolSlugsForApp,
	validateSkillGroundingPolicy,
	validateSkillReliabilityPolicy,
	type WorkflowCapabilities,
} from "./skill-tool-metadata";

export function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
}

// ============================================================================
// Skill Validation + Tool Slug Resolution
// ============================================================================

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillValidationIssue {
	code: string;
	message: string;
	path?: string;
}

export interface SkillValidationResult {
	valid: boolean;
	errors: SkillValidationIssue[];
	warnings: SkillValidationIssue[];
}

export interface SkillValidationInput {
	title?: string;
	description?: string;
	summary?: string;
	content?: string;
	files?: Record<string, string> | null;
	toolSlugs?: string[];
	metadataToolSlugs?: string[];
}

export function validateWorkflowSource(
	source: string,
	filePath: string,
	capabilities: WorkflowCapabilities,
): SkillValidationIssue[] {
	const errors: SkillValidationIssue[] = [];
	const path = `files["${filePath}"]`;

	// 0. WORKFLOW_HEADER_COMMENT_CLOSED_EARLY — a leading `/* tedix ... */`
	// manifest comment ends at the FIRST close marker, so a cron such as
	// "*/5 * * * *" inside it turns the rest of the header into code and the
	// run dies with `SyntaxError: Unexpected token`.
	const headerIssue = detectPrematureHeaderClose(source);
	if (headerIssue) {
		errors.push({
			code: "WORKFLOW_HEADER_COMMENT_CLOSED_EARLY",
			message: headerIssue,
			path,
		});
	}

	// Strip line and block comments + string literals so identifiers inside
	// them don't trigger false positives. Uses a single-pass scanner.
	const stripped = stripCommentsAndStrings(source);

	// 1. WORKFLOW_NO_DEFAULT_EXPORT
	const hasDefaultExport =
		/\bexport\s+default\b/.test(stripped) ||
		/\bmodule\.exports\s*=/.test(stripped) ||
		/\bexports\.default\s*=/.test(stripped);
	if (!hasDefaultExport) {
		errors.push({
			code: "WORKFLOW_NO_DEFAULT_EXPORT",
			message:
				"Workflow module must have a default export (the workflow object).",
			path,
		});
	}

	// 2. WORKFLOW_DEFAULT_NOT_OBJECT — default export must be an object literal
	// with an async `run` method. Match `export default {...}` or
	// `export default <ident>` where <ident> is later assigned to an object.
	let runMatch: RegExpMatchArray | null = null;
	const defaultObjectRe = /export\s+default\s*\{([\s\S]*)\}\s*;?\s*$/m;
	const defaultObj = stripped.match(defaultObjectRe);
	if (defaultObj?.[1]) {
		runMatch = defaultObj[1].match(
			/(?:async\s+)?run\s*(?:\([^)]*\)|=\s*(?:async\s*)?\([^)]*\)\s*=>)/,
		);
		if (!runMatch) {
			errors.push({
				code: "WORKFLOW_DEFAULT_NOT_OBJECT",
				message: "Default export must be an object with an async `run` method.",
				path,
			});
		}
	} else if (hasDefaultExport) {
		// Could not statically prove the default-export shape — flag.
		errors.push({
			code: "WORKFLOW_DEFAULT_NOT_OBJECT",
			message:
				"Could not statically verify default export is an object literal with `run`. Inline the object: `export default { async run(event, step, env) { ... } }`.",
			path,
		});
	}

	// 3. WORKFLOW_RUN_SIGNATURE_INVALID — accept (event, step) or (event, step, env)
	// Each param may carry an optional TS type annotation (`event: WorkflowEvent<T>`).
	// The annotation can include generics (`<...>`), unions/intersections, dotted
	// type refs, and array brackets — but no nested parens or commas at depth 0.
	const paramRe = String.raw`[A-Za-z_$][\w$]*(?:\s*:\s*[^,)]+)?`;
	const runSigRe = new RegExp(
		String.raw`(?:async\s+)?run\s*\(\s*${paramRe}\s*,\s*${paramRe}(?:\s*,\s*${paramRe})?\s*\)`,
	);
	const runSig = stripped.match(runSigRe);
	if (defaultObj && runMatch && !runSig) {
		errors.push({
			code: "WORKFLOW_RUN_SIGNATURE_INVALID",
			message:
				"`run` method must take (event, step) or (event, step, env). Other signatures are rejected.",
			path,
		});
	}

	// 4. WORKFLOW_DYNAMIC_IMPORT — `import(...)` calls
	if (/\bimport\s*\(/.test(stripped)) {
		errors.push({
			code: "WORKFLOW_DYNAMIC_IMPORT",
			message: "Dynamic `import(...)` calls are not allowed in workflow code.",
			path,
		});
	}

	// Runtime imports cross the Worker Loader boundary. Tenant code may import
	// Cloudflare's workflow error primitive, but it must never import the loader
	// environment (`cloudflare:workers`), raw sockets, Node builtins, or arbitrary
	// packages. `import type` is erased by sucrase and is therefore safe.
	const runtimeImports = [
		...source.matchAll(
			/^\s*import\s+(?!type\b)(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gm,
		),
		...source.matchAll(/^\s*export\s+[^"'`]*?\s+from\s+["']([^"']+)["']/gm),
	];
	for (const match of runtimeImports) {
		const specifier = match[1];
		if (specifier === "cloudflare:workflows") continue;
		errors.push({
			code: "WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED",
			message: `Runtime import "${specifier ?? "unknown"}" is not allowed. Tenant workflows may import runtime values only from "cloudflare:workflows"; use erased \`import type\` declarations for types.`,
			path,
		});
	}
	if (/\brequire\s*\(/.test(stripped)) {
		errors.push({
			code: "WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED",
			message: "CommonJS require() is not allowed in tenant workflow source.",
			path,
		});
	}

	// 5. WORKFLOW_EVAL_OR_FUNCTION — eval() or new Function()
	if (/\beval\s*\(/.test(stripped) || /\bnew\s+Function\s*\(/.test(stripped)) {
		errors.push({
			code: "WORKFLOW_EVAL_OR_FUNCTION",
			message:
				"`eval()` and `new Function()` are not allowed anywhere in workflow code.",
			path,
		});
	}

	// 6. WORKFLOW_TOP_LEVEL_SIDE_EFFECT — fetch/setTimeout/setInterval/Worker/
	// XMLHttpRequest/EventSource at top level (outside any function body).
	const topLevel = extractTopLevel(stripped);
	const sideEffectPatterns: Array<[RegExp, string]> = [
		[/\bfetch\s*\(/, "fetch()"],
		[/\bsetTimeout\s*\(/, "setTimeout()"],
		[/\bsetInterval\s*\(/, "setInterval()"],
		[/\bnew\s+Worker\s*\(/, "new Worker()"],
		[/\bnew\s+XMLHttpRequest\s*\(/, "new XMLHttpRequest()"],
		[/\bnew\s+EventSource\s*\(/, "new EventSource()"],
	];
	for (const [re, label] of sideEffectPatterns) {
		if (re.test(topLevel)) {
			errors.push({
				code: "WORKFLOW_TOP_LEVEL_SIDE_EFFECT",
				message: `Top-level ${label} is not allowed. Move side effects inside the \`run\` function or a helper called from \`run\`.`,
				path,
			});
		}
	}

	// 7. Ambient fetch needs BOTH explicit network authority and a durable
	// `step.do` boundary. The lexical placement check is intentionally
	// conservative: helpers containing fetch cannot be proven to run only from a
	// step and should instead receive already-fetched data or inline the call.
	const hasFetch = /\bfetch\s*\(/.test(stripped);
	const hasFetchOutsideStep = /\bfetch\s*\(/.test(stripStepDoArms(stripped));
	if (hasFetch && !capabilities.network) {
		errors.push({
			code: "WORKFLOW_NETWORK_WITHOUT_CAPABILITY",
			message:
				"Direct `fetch()` requires `capabilities.network: true` in SKILL.md and must run inside `step.do(...)`.",
			path,
		});
	}
	if (hasFetchOutsideStep) {
		errors.push({
			code: "WORKFLOW_NETWORK_OUTSIDE_STEP",
			message:
				"Direct `fetch()` must be lexically contained in `step.do(...)` so retries and replay stay durable. Fetching from top-level run code or an unprovable helper is rejected.",
			path,
		});
	}

	return errors;
}

/**
 * A leading block comment must close only at the end of a line. A close marker
 * followed by more text on the same line (a cron step like `*` + `/5`) ended
 * the comment early.
 */
export function detectPrematureHeaderClose(source: string): string | null {
	const trimmed = source.trimStart();
	if (!/^\/\*\s*tedix\b/.test(trimmed)) return null;
	const close = trimmed.indexOf("*/", 2);
	if (close === -1) return null;
	const lineEnd = trimmed.indexOf("\n", close);
	const rest = trimmed.slice(close + 2, lineEnd === -1 ? undefined : lineEnd);
	if (rest.trim().length === 0) return null;
	return "The leading workflow header comment closes early: a `*/` (usually a cron step such as `*/5`) is followed by more text on the same line, so the rest is parsed as code (SyntaxError at run time). Write the cron as an explicit list (`0,5,10,...`) or a range with a step (`0-59/5`), or drop the header and declare capabilities in SKILL.md frontmatter, which is the manifest of record for recorded skills.";
}

/**
 * Remove // line comments, /* block * / comments, string/template literal
 * contents, and regex literal bodies.
 *
 * Template literals are interpolation-aware: code inside `${...}` stays
 * visible (it IS code — capability and fetch-placement checks must see it),
 * and nested templates inside interpolations re-enter string mode correctly.
 * Regex literals are consumed as literals so a quote or `//` inside a pattern
 * (`/"/g`, `/^https?:\/\//`) cannot desync the scanner — both previously
 * caused false WORKFLOW_NO_DEFAULT_EXPORT rejections of valid workflows.
 */
function stripCommentsAndStrings(src: string): string {
	let out = "";
	let i = 0;
	const n = src.length;
	// Scanner mode stack: the base frame is code; a template frame blanks
	// content until its closing backtick; each `${` pushes a code frame whose
	// `braces` counter finds the matching `}`.
	type Frame = { kind: "code"; braces: number } | { kind: "template" };
	const stack: Frame[] = [{ kind: "code", braces: 0 }];

	// A `/` starts a regex (not division) when the previous meaningful token
	// cannot end an expression: operators/openers, or an expression keyword.
	const REGEX_PREV_WORDS = new Set([
		"return",
		"typeof",
		"case",
		"of",
		"in",
		"do",
		"else",
		"void",
		"delete",
		"instanceof",
		"new",
		"yield",
		"await",
	]);
	const regexCanStart = (): boolean => {
		let j = out.length - 1;
		while (j >= 0 && /\s/.test(out[j] ?? "")) j--;
		if (j < 0) return true;
		const ch = out[j] ?? "";
		if (/[A-Za-z0-9$_]/.test(ch)) {
			let k = j;
			while (k >= 0 && /[A-Za-z0-9$_]/.test(out[k] ?? "")) k--;
			return REGEX_PREV_WORDS.has(out.slice(k + 1, j + 1));
		}
		// `)` / `]` / quote ends an expression → division; anything else opens one.
		return !")]'\"`".includes(ch);
	};

	while (i < n) {
		const top = stack[stack.length - 1];
		if (!top) break; // stack invariant: always non-empty; satisfies noUncheckedIndexedAccess
		const c = src[i];
		if (top.kind === "template") {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "`") {
				out += "`";
				stack.pop();
				i++;
				continue;
			}
			if (c === "$" && src[i + 1] === "{") {
				out += "${";
				stack.push({ kind: "code", braces: 0 });
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		const next = src[i + 1];
		// Line comment
		if (c === "/" && next === "/") {
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		// Block comment
		if (c === "/" && next === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		// Regex literal — consume body (escapes + char classes) and flags.
		if (c === "/" && regexCanStart()) {
			i++;
			let inClass = false;
			while (i < n) {
				const rc = src[i];
				if (rc === "\\") {
					i += 2;
					continue;
				}
				if (rc === "\n") break; // unterminated — bail without desync
				if (rc === "[") inClass = true;
				else if (rc === "]") inClass = false;
				else if (rc === "/" && !inClass) break;
				i++;
			}
			i++; // closing slash (or newline bail)
			while (i < n && /[a-z]/i.test(src[i] ?? "")) i++; // flags
			out += "/./";
			continue;
		}
		// Plain strings — preserve quotes but blank contents
		if (c === '"' || c === "'") {
			out += c;
			i++;
			while (i < n && src[i] !== c) {
				if (src[i] === "\\") i++; // skip escape
				i++;
			}
			out += c;
			i++;
			continue;
		}
		// Template literal opens
		if (c === "`") {
			out += "`";
			stack.push({ kind: "template" });
			i++;
			continue;
		}
		if (c === "{") {
			top.braces++;
		} else if (c === "}") {
			if (top.braces === 0 && stack.length > 1) {
				// End of a `${...}` interpolation — resume the template below.
				out += "}";
				stack.pop();
				i++;
				continue;
			}
			top.braces--;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * Extract code that runs at module top level — i.e. outside any function or
 * arrow body. Approximated by deleting balanced `{...}` blocks from the
 * source. Crude but adequate: anything inside `function` / `=>` / object
 * methods is removed, leaving raw module statements.
 */
function extractTopLevel(src: string): string {
	let depth = 0;
	let out = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "{") {
			depth++;
			continue;
		}
		if (c === "}") {
			if (depth > 0) depth--;
			continue;
		}
		if (depth === 0) out += c;
	}
	return out;
}

/** Remove balanced `step.do(...)` argument lists so callers can scan the rest. */
function stripStepDoArms(src: string): string {
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const slice = src.slice(i, i + 8);
		if (/^step\.do\s*\(/.test(slice)) {
			// Advance to opening paren
			i += slice.indexOf("(") + 1;
			let depth = 1;
			while (i < n && depth > 0) {
				if (src[i] === "(") depth++;
				else if (src[i] === ")") depth--;
				i++;
			}
			continue;
		}
		out += src[i];
		i++;
	}
	return out;
}

/**
 * Secret-shaped literal patterns that must never be persisted into durable D1
 * skill rows. Heuristic by design (a doc example can match), so hits surface
 * as `SKILL_SECRET_LITERAL` warnings rather than write rejections; wire real
 * credentials through connections/app secrets and reference them by label.
 */
const SECRET_LITERAL_PATTERNS: Array<{ kind: string; re: RegExp }> = [
	{ kind: "API key (sk_...)", re: /\bsk_[A-Za-z0-9]{16,}\b/ },
	{ kind: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
	{ kind: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
	{ kind: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ kind: "Descope key (K2...)", re: /\bK2[A-Za-z0-9]{24,}\b/ },
];

/** Scan skill text columns for secret-looking literals. Never echoes the match. */
function scanForSecretLiterals(
	content: string,
	files: Record<string, string> | null | undefined,
): SkillValidationIssue[] {
	const issues: SkillValidationIssue[] = [];
	const scan = (text: string, path: string) => {
		for (const { kind, re } of SECRET_LITERAL_PATTERNS) {
			if (re.test(text)) {
				issues.push({
					code: "SKILL_SECRET_LITERAL",
					message: `Possible ${kind} literal in ${path} — skills are durable D1 rows; replace the credential with a placeholder and wire secrets through connections or app secrets`,
					path,
				});
			}
		}
	};
	scan(content, "content");
	for (const [filePath, fileContent] of Object.entries(files ?? {})) {
		scan(fileContent, `files["${filePath}"]`);
	}
	return issues;
}

/**
 * Reserved aggregate namespaces always resolve at dispatch — see
 * `AGGREGATE_NAMESPACES` in apps/skill-runtime/src/mcp-bridge-utils.ts.
 */
const RESERVED_CAPABILITY_NAMESPACES = new Set([
	"home",
	"kernel",
	"tedi",
	// Platform gateway namespace injected by the aggregate runtime. It is not
	// represented by an apps row, but `cognitive__record_artifact` is resolved
	// live by the same aggregate bridge used at workflow dispatch.
	"cognitive",
	// Same category: a gateway-native control-plane namespace with no apps row.
	// `env.MCP.rationale.create_rationale_records` is the canonical way a skill
	// workflow writes its operating receipt and resolves fine at dispatch — the
	// executive daily loops record every cycle through it. Without this entry
	// the write-time lint warned UNKNOWN_NAMESPACE on every correct executive
	// skill, which trains authors to ignore capability warnings wholesale.
	"rationale",
]);
const RESERVED_CAPABILITY_METHODS: Record<string, ReadonlySet<string>> = {
	cognitive: new Set(WORKFLOW_PLATFORM_MCP_METHODS.cognitive),
};

/**
 * Write-time lint over the executable-skill capability manifest. Resolves each
 * declared `capabilities.mcp` namespace the same way the skill-runtime does at
 * dispatch (`resolveNamespaceSlugs`: exact app slug → `${ns}-tedix` →
 * underscore→dash), then checks declared methods against the resolved app's
 * materialized `app_tools` rows. Warn-only by design: a namespace may target a
 * surface this control plane cannot see, and upstream-proxy or zero-tool
 * (dynamic/code-mode) apps resolve their tools at execution time.
 */
async function lintCapabilityManifest(
	db: DbClient,
	capabilities: WorkflowCapabilities,
): Promise<SkillValidationIssue[]> {
	const issues: SkillValidationIssue[] = [];
	for (const [namespace, knownMethods] of Object.entries(
		RESERVED_CAPABILITY_METHODS,
	)) {
		const declared = capabilities.mcp[namespace] ?? [];
		const unknown = declared.filter((method) => !knownMethods.has(method));
		if (unknown.length > 0) {
			issues.push({
				code: "SKILL_CAPABILITY_UNKNOWN_METHOD",
				message: `capabilities.mcp.${namespace} declares methods not provided by the workflow runtime: ${unknown.join(", ")}`,
				path: `capabilities.mcp.${namespace}`,
			});
		}
	}
	const namespaces = Object.keys(capabilities.mcp).filter(
		(namespace) => !RESERVED_CAPABILITY_NAMESPACES.has(namespace),
	);
	if (!namespaces.length) return issues;

	const candidates = new Set<string>();
	for (const namespace of namespaces) {
		candidates.add(namespace);
		candidates.add(`${namespace}-tedix`);
		candidates.add(namespace.replace(/_/g, "-"));
	}
	const appRows: Array<{
		id: string;
		slug: string;
		metadata: (typeof apps.$inferSelect)["metadata"];
	}> = [];
	// D1 caps bound parameters at 100 per statement; chunk the slug IN() list.
	for (const chunk of chunkForBoundParams([...candidates], 50)) {
		appRows.push(
			...(await db
				.select({ id: apps.id, slug: apps.slug, metadata: apps.metadata })
				.from(apps)
				.where(inArray(apps.slug, chunk))),
		);
	}
	const bySlug = new Map(appRows.map((row) => [row.slug, row]));

	for (const namespace of namespaces) {
		const path = `capabilities.mcp.${namespace}`;
		const resolved =
			bySlug.get(namespace) ??
			bySlug.get(`${namespace}-tedix`) ??
			bySlug.get(namespace.replace(/_/g, "-"));
		if (!resolved) {
			issues.push({
				code: "SKILL_CAPABILITY_UNKNOWN_NAMESPACE",
				message: `capabilities.mcp namespace "${namespace}" resolves to no app slug ("${namespace}", "${namespace}-tedix", "${namespace.replace(/_/g, "-")}") — env.MCP.${namespace}.* calls will fail at dispatch unless the namespace targets a surface outside this control plane`,
				path,
			});
			continue;
		}

		const methods = capabilities.mcp[namespace] ?? [];
		if (!methods.length) continue;
		const mcpConfig = (
			resolved.metadata as { mcpConfig?: Record<string, unknown> } | null
		)?.mcpConfig;
		// Proxy apps materialize no local rows; their tool inventory lives upstream.
		if (mcpConfig?.upstreamMcpUrl) continue;
		const toolRows = await db
			.select({ toolId: appTools.toolId })
			.from(appTools)
			.where(eq(appTools.appId, resolved.id));
		// Zero materialized tools = dynamic/code-mode surface — nothing to check.
		if (!toolRows.length) continue;
		const known = new Set(toolRows.map((row) => row.toolId));
		// `isMethodAllowed` also accepts a declared method head for dotted calls,
		// so a declared head that matches a real tool id stays clean.
		const unknown = methods.filter((method) => {
			if (known.has(method)) return false;
			const head = method.split(".")[0];
			return !(head && known.has(head));
		});
		if (unknown.length) {
			issues.push({
				code: "SKILL_CAPABILITY_UNKNOWN_METHOD",
				message: `capabilities.mcp.${namespace} declares methods with no matching app_tools.tool_id on app "${resolved.slug}": ${unknown.join(", ")}`,
				path,
			});
		}
	}
	return issues;
}

/**
 * Validate skill input shape (used by both contract validate endpoint and pre-mutation gate).
 * `appId` is optional — if provided, runs app-scoped checks (toolSlug resolution, stale upstream-without-tools).
 */
export async function validateSkillInput(
	db: DbClient,
	input: SkillValidationInput,
	appId?: string | null,
): Promise<SkillValidationResult> {
	const errors: SkillValidationIssue[] = [];
	const warnings: SkillValidationIssue[] = [];

	const description = input.description?.trim() ?? "";
	const summary = input.summary?.trim() ?? "";
	const title = input.title?.trim() ?? "";
	const content = input.content ?? "";

	// MISSING_DESCRIPTION
	if (!description && !summary && !title) {
		errors.push({
			code: "MISSING_DESCRIPTION",
			message: "One of description, summary, or title is required",
			path: "description",
		});
	}

	// INVALID_NAME — slug derived from title must match pattern
	if (title) {
		const slug = slugify(title);
		if (!slug || slug.length < 1 || slug.length > 64 || !SLUG_RE.test(slug)) {
			errors.push({
				code: "INVALID_NAME",
				message: `Slug derived from title is invalid: "${slug}". Must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ and be 1-64 chars.`,
				path: "title",
			});
		}
	}

	// EMPTY_BODY
	if (content.trim().length === 0) {
		errors.push({
			code: "EMPTY_BODY",
			message:
				"content must not be empty (canonical skill body lives in content)",
			path: "content",
		});
	}

	// File-related errors
	if (input.files) {
		for (const filePath of Object.keys(input.files)) {
			if (filePath === "SKILL.md") {
				errors.push({
					code: "FILES_HAS_SKILL_MD",
					message:
						"files['SKILL.md'] is reserved — canonical body lives in `content`",
					path: `files["${filePath}"]`,
				});
				continue;
			}
			if (
				filePath.includes("..") ||
				filePath.startsWith("/") ||
				filePath.includes("\\") ||
				/^\w+:/.test(filePath)
			) {
				errors.push({
					code: "FILE_PATH_TRAVERSAL",
					message: `File path "${filePath}" is unsafe (path traversal, absolute, or URL/scheme prefix)`,
					path: `files["${filePath}"]`,
				});
			}
			if (filePath.endsWith("/SKILL.md")) {
				errors.push({
					code: "FILE_PATH_NESTED_SKILL_MD",
					message: `Nested "${filePath}" not allowed — skills don't nest`,
					path: `files["${filePath}"]`,
				});
			}
		}

		// Workflow validation gates the only executable skill path. The runner
		// loads TypeScript snapshots from files["scripts/workflow.ts"]. Reject
		// executable-lookalike paths so callers don't ship dead code that looks
		// runnable; supporting scripts under other paths remain allowed.
		for (const lookalike of [
			"scripts/workflow.js",
			"scripts/workflow.mjs",
			"scripts/workflow.cjs",
		]) {
			if (lookalike in input.files) {
				errors.push({
					code: "UNSUPPORTED_WORKFLOW_JS",
					message: `Executable skill workflows must use files['scripts/workflow.ts']; ${lookalike} is not supported by run_skill_workflow`,
					path: `files["${lookalike}"]`,
				});
			}
		}
		const workflowKey = "scripts/workflow.ts";
		if (workflowKey in input.files) {
			const source = input.files[workflowKey] ?? "";
			// Capability manifest comes from SKILL.md frontmatter (in `content`).
			const capabilities = parseSkillFrontmatterCapabilities(content);
			const workflowIssues = validateWorkflowSource(
				source,
				workflowKey,
				capabilities,
			);
			errors.push(...workflowIssues);
		}
	}

	// SKILL_GROUNDING_INVALID — a malformed grounding policy is an ERROR, not a
	// warning. Accepting it would ship a skill that believes it declared a
	// standard of proof while the runtime reads "none required".
	errors.push(...validateSkillGroundingPolicy(content));

	// Warnings
	if (description && description.length < 20) {
		warnings.push({
			code: "SHORT_DESCRIPTION",
			message: `description is very short (${description.length} chars) — aim for >=20 chars for discoverability`,
			path: "description",
		});
	}

	if (content.length > 8000) {
		warnings.push({
			code: "LONG_BODY",
			message: `content is large (${content.length} chars) — consider moving reference material to files["references/..."]`,
			path: "content",
		});
	}

	if (!summary) {
		warnings.push({
			code: "MISSING_SUMMARY",
			message:
				"no summary provided — adding one improves progressive-disclosure UX",
			path: "summary",
		});
	}

	const declaredToolSlugs = [
		...new Set([
			...(input.toolSlugs ?? []),
			...(input.metadataToolSlugs ?? []),
		]),
	].filter(Boolean);
	const workflowCapabilities = input.files?.["scripts/workflow.ts"]
		? parseSkillFrontmatterCapabilities(content)
		: null;
	const hasWorkflowMcpCapabilities = Object.values(
		workflowCapabilities?.mcp ?? {},
	).some((methods) => methods.length > 0);
	if (declaredToolSlugs.length === 0 && !hasWorkflowMcpCapabilities) {
		warnings.push({
			code: "MISSING_TOOL_ASSOCIATION",
			message:
				"no tool association declared — add toolSlugs, metadata.io.modelcontextprotocol/tools, or executable-workflow capabilities.mcp so tools can be audited as skill-covered",
			path: "metadata.io.modelcontextprotocol/tools",
		});
	}
	if (input.metadataToolSlugs?.length && !appId) {
		warnings.push({
			code: "MCP_TOOL_METADATA_UNSCOPED",
			message:
				"metadata.io.modelcontextprotocol/tools is present but no appId/appSlug scope was provided, so tool names cannot be resolved to app_tools.id values",
			path: "metadata.io.modelcontextprotocol/tools",
		});
	}

	// SKILL_SECRET_LITERAL — heuristic secret scan over the durable text columns.
	warnings.push(...scanForSecretLiterals(content, input.files));

	// SKILL_CAPABILITY_UNKNOWN_NAMESPACE / SKILL_CAPABILITY_UNKNOWN_METHOD —
	// resolve capability-manifest refs against real apps/app_tools rows so a
	// typo'd namespace or method is caught at record/improve time instead of
	// failing at dispatch via `isMethodAllowed`.
	const manifestCapabilities =
		workflowCapabilities ?? parseSkillFrontmatterCapabilities(content);
	errors.push(...validateSkillReliabilityPolicy(content));
	// SKILL_SCHEDULE_INVALID — the same parser the API scheduler fires from, so
	// a cron it cannot schedule is an error here rather than a vanished row.
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	if (frontmatter !== undefined) {
		try {
			parseYaml(frontmatter);
		} catch (error) {
			warnings.push({
				code: "SKILL_FRONTMATTER_INVALID_YAML",
				message: `SKILL.md frontmatter is not valid YAML, so its capabilities manifest is ignored: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. Quote values that contain ": " or start with a special character.`,
				path: "content",
			});
		}
	}
	const scheduleCheck = validateSkillSchedulePolicy(content);
	for (const issue of scheduleCheck.issues) {
		errors.push({
			code: issue.code,
			message: `${issue.message}. Supported cron syntax: five UTC fields (minute hour day-of-month month day-of-week), each a number, a-b range, * wildcard, an optional /step, or a comma list (for example 0-59/5, */15, 0 9 * * 1-5); names such as MON are not supported.`,
			path: issue.path,
		});
	}
	if (scheduleCheck.schedule) {
		warnings.push({
			code: "SKILL_SCHEDULE_PROJECTED_WHEN_ACTIVE",
			message:
				"capabilities.schedule only creates a skill_schedules row once the skill is active (not draft, stale or archived) and has an owning tediId; check skill_schedules after publishing.",
			path: "capabilities.schedule",
		});
	}
	if (Object.keys(manifestCapabilities.mcp).length) {
		warnings.push(...(await lintCapabilityManifest(db, manifestCapabilities)));
	}

	// App-scoped checks
	if (appId) {
		// UNRESOLVED_TOOL_SLUGS
		if (declaredToolSlugs.length) {
			const { unresolved } = await resolveToolSlugsForApp(
				db,
				appId,
				declaredToolSlugs,
			);
			if (unresolved.length) {
				warnings.push({
					code: "UNRESOLVED_TOOL_SLUGS",
					message: `toolSlugs not found in app_tools for appId ${appId}: ${unresolved.join(", ")}`,
					path: "metadata.io.modelcontextprotocol/tools",
				});
			}
		}

		// APP_STALE_UPSTREAM_NO_TOOLS — stale upstreamMcpUrl with 0 D1 tools
		const app = await db.query.apps.findFirst({ where: { id: appId } });
		if (app) {
			const mcpConfig = app.metadata?.mcpConfig as
				| Record<string, unknown>
				| undefined;
			if (mcpConfig?.upstreamMcpUrl) {
				const toolCountRows = await db
					.select({ id: appTools.id })
					.from(appTools)
					.where(eq(appTools.appId, appId));
				if (toolCountRows.length === 0) {
					warnings.push({
						code: "APP_STALE_UPSTREAM_NO_TOOLS",
						message: `App ${appId} has stale upstreamMcpUrl config with 0 D1 tools — materialize upstream tools before binding skills`,
						path: "appId",
					});
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}
