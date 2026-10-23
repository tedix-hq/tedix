import { parse as parseSource } from "@babel/parser";
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
		.slice(0, 64)
		.replace(/-$/, "");
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
	/** Improve only: the skill's stored namespace → appId bindings, so a namespace whose app was renamed still resolves. */
	mcpAppBindings?: unknown;
	/** Owning organization; a binding counts only for its own or a public app. */
	organizationId?: string;
}

/** Only the structural AST fields used by the authoring checks. */
interface WorkflowAstNode {
	type: string;
	[key: string]: unknown;
}

function isAstNode(value: unknown): value is WorkflowAstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		// Attached comment trivia (leadingComments & friends) never holds code.
		!(value as { type: string }).type.startsWith("Comment")
	);
}

function childAstNodes(node: WorkflowAstNode): WorkflowAstNode[] {
	const children: WorkflowAstNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) if (isAstNode(item)) children.push(item);
		} else if (isAstNode(value)) {
			children.push(value);
		}
	}
	return children;
}

function walkAst(
	node: WorkflowAstNode,
	visit: (node: WorkflowAstNode) => void,
) {
	visit(node);
	for (const child of childAstNodes(node)) walkAst(child, visit);
}

function nodeArray(node: WorkflowAstNode | undefined, field: string) {
	const value = node?.[field];
	if (!Array.isArray(value)) return [] as WorkflowAstNode[];
	return value.filter(isAstNode);
}

/** Parse a workflow snapshot as a TypeScript module, tolerating recovery. */
function parseWorkflowModule(source: string): {
	body: WorkflowAstNode[];
	syntaxError: string | null;
} {
	try {
		const file = parseSource(source, {
			sourceType: "module",
			plugins: ["typescript"],
			errorRecovery: true,
			allowUndeclaredExports: true,
		});
		return {
			body: nodeArray(file.program as unknown as WorkflowAstNode, "body"),
			syntaxError: file.errors?.[0]?.message ?? null,
		};
	} catch (error) {
		return {
			body: [],
			syntaxError: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Unwrap expressions the runtime erases: `as T`, `satisfies T`, `x!`. */
function unwrapExpression(node: WorkflowAstNode): WorkflowAstNode {
	let current = node;
	while (
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSNonNullExpression" ||
		current.type === "ParenthesizedExpression"
	) {
		const inner = current.expression;
		if (!isAstNode(inner)) return current;
		current = inner;
	}
	return current;
}

/** Top-level `const x = …` / `function x()` bindings, for resolving identifiers. */
function collectTopLevelBindings(body: WorkflowAstNode[]) {
	const bindings = new Map<string, WorkflowAstNode>();
	for (const stmt of body) {
		if (stmt.type === "VariableDeclaration") {
			for (const decl of nodeArray(stmt, "declarations")) {
				const id = decl.id;
				if (isAstNode(id) && id.type === "Identifier" && isAstNode(decl.init)) {
					bindings.set(id.name as string, decl.init);
				}
			}
		} else if (
			(stmt.type === "FunctionDeclaration" ||
				stmt.type === "ClassDeclaration") &&
			isAstNode(stmt.id)
		) {
			bindings.set(stmt.id.name as string, stmt);
		}
	}
	return bindings;
}

function resolveBinding(
	node: WorkflowAstNode,
	bindings: Map<string, WorkflowAstNode>,
	depth = 0,
): WorkflowAstNode {
	const unwrapped = unwrapExpression(node);
	if (unwrapped.type !== "Identifier" || depth > 4) return unwrapped;
	const bound = bindings.get(unwrapped.name as string);
	if (!bound || bound === unwrapped) return unwrapped;
	return resolveBinding(bound, bindings, depth + 1);
}

function resolveObjectExpression(
	node: WorkflowAstNode,
	bindings: Map<string, WorkflowAstNode>,
): WorkflowAstNode | null {
	const resolved = resolveBinding(node, bindings);
	return resolved.type === "ObjectExpression" ? resolved : null;
}

function isFunctionNode(node: WorkflowAstNode): boolean {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression" ||
		node.type === "ObjectMethod" ||
		node.type === "ClassMethod" ||
		node.type === "ClassPrivateMethod"
	);
}

function resolveFunctionValue(
	node: WorkflowAstNode,
	bindings: Map<string, WorkflowAstNode>,
): WorkflowAstNode | null {
	const resolved = resolveBinding(node, bindings);
	return isFunctionNode(resolved) ? resolved : null;
}

/** The static name of an object member key, or null for computed keys. */
function staticMemberName(member: WorkflowAstNode): string | null {
	if (member.computed === true) return null;
	const key = member.key;
	if (!isAstNode(key)) return null;
	if (key.type === "Identifier") return key.name as string;
	if (key.type === "StringLiteral" || key.type === "NumericLiteral") {
		return String(key.value);
	}
	return null;
}

/**
 * Find the provable `run` function on the default-export object. Resolves
 * identifier spreads and `run: someFn` references through top-level bindings —
 * an unresolvable member simply leaves `run` unproven (same verdict the old
 * text scan produced).
 */
function findRunFunction(
	objectNode: WorkflowAstNode,
	bindings: Map<string, WorkflowAstNode>,
	depth = 0,
): WorkflowAstNode | null {
	for (const member of nodeArray(objectNode, "properties")) {
		if (member.type === "SpreadElement") {
			if (depth >= 4) continue;
			const spread = resolveObjectExpression(
				member.argument as WorkflowAstNode,
				bindings,
			);
			const nested = spread && findRunFunction(spread, bindings, depth + 1);
			if (nested) return nested;
			continue;
		}
		if (staticMemberName(member) !== "run") continue;
		if (member.type === "ObjectMethod") return member;
		if (member.type === "ObjectProperty" && isAstNode(member.value)) {
			const fn = resolveFunctionValue(member.value, bindings);
			return fn; // a `run` member that is not a provable function fails shape
		}
	}
	return null;
}

/**
 * The default-exported expression: `export default <expr>`,
 * `export { x as default }`, or the CJS assignments `module.exports =` /
 * `exports.default =` — the same set the regexes accepted.
 */
function findDefaultExportValue(
	body: WorkflowAstNode[],
): WorkflowAstNode | null {
	for (const stmt of body) {
		if (
			stmt.type === "ExportDefaultDeclaration" &&
			isAstNode(stmt.declaration)
		) {
			return stmt.declaration;
		}
		if (stmt.type === "ExportNamedDeclaration" && !isAstNode(stmt.source)) {
			for (const spec of nodeArray(stmt, "specifiers")) {
				const exported = spec.exported;
				if (
					isAstNode(exported) &&
					exported.type === "Identifier" &&
					exported.name === "default" &&
					isAstNode(spec.local)
				) {
					return spec.local;
				}
			}
		}
		if (stmt.type === "ExpressionStatement") {
			const expr = stmt.expression;
			if (!isAstNode(expr) || expr.type !== "AssignmentExpression") continue;
			if (isCjsDefaultTarget(expr.left)) {
				return expr.right as WorkflowAstNode;
			}
		}
	}
	return null;

	function isCjsDefaultTarget(node: unknown): boolean {
		if (!isAstNode(node) || node.type !== "MemberExpression") return false;
		if (node.computed === true) return false;
		const object = node.object;
		const property = node.property;
		if (!isAstNode(object) || !isAstNode(property)) return false;
		if (object.type !== "Identifier" || property.type !== "Identifier") {
			return false;
		}
		return (
			(object.name === "module" && property.name === "exports") ||
			(object.name === "exports" && property.name === "default")
		);
	}
}

/** Bare globals and globalThis members, excluding ordinary object methods. */
function ambientGlobalCallName(node: WorkflowAstNode): string | null {
	if (node.type !== "CallExpression" && node.type !== "NewExpression")
		return null;
	const callee = node.callee;
	if (!isAstNode(callee)) return null;
	if (callee.type === "Identifier") return callee.name as string;
	if (callee.type === "MemberExpression" && callee.computed !== true) {
		const object = callee.object;
		const property = callee.property;
		if (
			isAstNode(object) &&
			object.type === "Identifier" &&
			object.name === "globalThis" &&
			isAstNode(property) &&
			property.type === "Identifier"
		)
			return property.name as string;
	}
	return null;
}

/** `step.do(…)` calls — any chain ending in `.step.do(` counts, as before. */
function isStepDoCall(node: WorkflowAstNode): boolean {
	if (node.type !== "CallExpression" || node.optional === true) return false;
	const callee = node.callee;
	if (
		!isAstNode(callee) ||
		callee.type !== "MemberExpression" ||
		callee.computed === true
	) {
		return false;
	}
	const property = callee.property;
	const object = callee.object;
	if (!isAstNode(property) || !isAstNode(object)) return false;
	const isDo =
		property.type === "Identifier"
			? property.name === "do"
			: property.type === "StringLiteral" && property.value === "do";
	if (!isDo) return false;
	if (object.type === "Identifier") return object.name === "step";
	if (object.type === "MemberExpression" && object.computed !== true) {
		const inner = object.property;
		return (
			isAstNode(inner) && inner.type === "Identifier" && inner.name === "step"
		);
	}
	return false;
}

/** An import/export-from declaration erased entirely at compile time. */
function isTypeOnlyModuleTransfer(node: WorkflowAstNode): boolean {
	if (node.importKind === "type" || node.exportKind === "type") return true;
	const specifiers = nodeArray(node, "specifiers");
	return (
		specifiers.length > 0 &&
		specifiers.every(
			(spec) => spec.importKind === "type" || spec.exportKind === "type",
		)
	);
}

/**
 * Node types whose contents never evaluate at module load: function bodies
 * (unless invoked immediately), class member initializers, and type-only
 * declarations.
 */
const NOT_EAGER_NODES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
	"ClassProperty",
	"ClassPrivateProperty",
	"ClassAccessorProperty",
	"TSInterfaceDeclaration",
	"TSTypeAliasDeclaration",
	"TSTypeAnnotation",
	"TSTypeParameterDeclaration",
	"TSTypeParameterInstantiation",
	"TSTypeParameter",
	"TSDeclareFunction",
	"TSDeclareMethod",
]);

/**
 * Scan a top-level statement for side-effect calls that evaluate when the
 * module loads. Descends into everything an evaluator would run — `if`/`for`/
 * `try` bodies, object literals, static blocks, and immediately-invoked
 * functions — but never into a dormant function body. This closes the
 * brace-deletion gap where `if (x) { fetch() }` scanned clean.
 */
function collectEagerSideEffects(
	stmt: WorkflowAstNode,
	hits: Set<string>,
	ambient: ReadonlySet<string>,
	labels: Readonly<Record<string, string>>,
) {
	const visit = (node: WorkflowAstNode) => {
		// Boundaries stop entry too: a dormant function or class-member body
		// never evaluates at module load. The callee special-case below is the
		// only eager re-entry (an immediately-invoked function).
		if (NOT_EAGER_NODES.has(unwrapExpression(node).type)) return;
		const name = ambientGlobalCallName(node);
		if (name && ambient.has(name)) hits.add(labels[name] ?? name);
		for (const child of childAstNodes(node)) {
			const unwrapped = unwrapExpression(child);
			if (!NOT_EAGER_NODES.has(unwrapped.type)) {
				visit(child);
				continue;
			}
			// A function that is the direct callee still executes its body now.
			if (
				(node.type === "CallExpression" || node.type === "NewExpression") &&
				child === node.callee
			) {
				for (const inner of childAstNodes(unwrapped)) visit(inner);
			}
		}
	};
	visit(stmt);
}

/**
 * Validate a workflow source file. Checks run over the TypeScript AST from
 * `@babel/parser` (pure JS, safe inside the Worker bundle); they remain
 * authoring feedback, not the runtime trust boundary — the Loader capability
 * sandbox and injected step-context gates stay authoritative for execution.
 */
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
	// run dies with `SyntaxError: Unexpected token`. Comment trivia is not
	// part of the AST, so this check stays lexical.
	const headerIssue = detectPrematureHeaderClose(source);
	if (headerIssue) {
		errors.push({
			code: "WORKFLOW_HEADER_COMMENT_CLOSED_EARLY",
			message: headerIssue,
			path,
		});
	}

	const { body, syntaxError } = parseWorkflowModule(source);
	if (syntaxError) {
		// The runner compiles this snapshot with sucrase; a source that cannot
		// parse can never execute, so surface it as an authoring diagnostic.
		errors.push({
			code: "WORKFLOW_SOURCE_SYNTAX_ERROR",
			message: `Workflow source does not parse as a TypeScript module: ${syntaxError}`,
			path,
		});
	}

	const bindings = collectTopLevelBindings(body);

	// 1. WORKFLOW_NO_DEFAULT_EXPORT / 2. WORKFLOW_DEFAULT_NOT_OBJECT — the
	// default export must be an object with a callable `run`. Identifier
	// references resolve through top-level bindings, so `export default
	// workflow` on a literal object no longer reads as unverifiable.
	const exported = findDefaultExportValue(body);
	if (!exported) {
		errors.push({
			code: "WORKFLOW_NO_DEFAULT_EXPORT",
			message:
				"Workflow module must have a default export (the workflow object).",
			path,
		});
	} else {
		const defaultObject = resolveObjectExpression(exported, bindings);
		if (!defaultObject) {
			errors.push({
				code: "WORKFLOW_DEFAULT_NOT_OBJECT",
				message:
					"Could not statically verify default export is an object literal with `run`. Inline the object: `export default { async run(event, step, env) { ... } }`.",
				path,
			});
		} else {
			const run = findRunFunction(defaultObject, bindings);
			if (!run) {
				errors.push({
					code: "WORKFLOW_DEFAULT_NOT_OBJECT",
					message:
						"Default export must be an object with an async `run` method.",
					path,
				});
			} else {
				// 3. WORKFLOW_RUN_SIGNATURE_INVALID — (event, step) or
				// (event, step, env); destructured/rest params are rejected.
				const params = nodeArray(run, "params");
				const validArity = params.length === 2 || params.length === 3;
				if (!validArity || params.some((p) => p.type !== "Identifier")) {
					errors.push({
						code: "WORKFLOW_RUN_SIGNATURE_INVALID",
						message:
							"`run` method must take (event, step) or (event, step, env). Other signatures are rejected.",
						path,
					});
				}
			}
		}
	}

	// 4. WORKFLOW_DYNAMIC_IMPORT — value-position `import(...)` calls. The
	// type-position `import("…")` annotation is a TSImportType node, which
	// correctly no longer trips this check.
	let hasDynamicImport = false;
	for (const stmt of body) {
		walkAst(stmt, (node) => {
			if (
				node.type === "ImportExpression" ||
				(node.type === "CallExpression" &&
					isAstNode(node.callee) &&
					node.callee.type === "Import")
			) {
				hasDynamicImport = true;
			}
		});
	}
	if (hasDynamicImport) {
		errors.push({
			code: "WORKFLOW_DYNAMIC_IMPORT",
			message: "Dynamic `import(...)` calls are not allowed in workflow code.",
			path,
		});
	}

	// Runtime imports cross the Worker Loader boundary. Tenant code may import
	// Cloudflare's workflow error primitive, but it must never import the loader
	// environment (`cloudflare:workers`), raw sockets, Node builtins, or arbitrary
	// packages. `import type` is erased by sucrase and is therefore safe — as is
	// a declaration whose specifiers are all type-only.
	for (const stmt of body) {
		walkAst(stmt, (node) => {
			if (
				node.type !== "ImportDeclaration" &&
				node.type !== "ExportNamedDeclaration" &&
				node.type !== "ExportAllDeclaration"
			) {
				return;
			}
			const specifier = node.source;
			if (!isAstNode(specifier) || specifier.type !== "StringLiteral") return;
			if (isTypeOnlyModuleTransfer(node)) return;
			if (specifier.value === "cloudflare:workflows") return;
			errors.push({
				code: "WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED",
				message: `Runtime import "${String(specifier.value)}" is not allowed. Tenant workflows may import runtime values only from "cloudflare:workflows"; use erased \`import type\` declarations for types.`,
				path,
			});
		});
	}
	let hasCommonJsRequire = false;
	let hasEvalOrFunction = false;
	for (const stmt of body) {
		walkAst(stmt, (node) => {
			if (ambientGlobalCallName(node) === "require") {
				hasCommonJsRequire = true;
			}
			if (
				ambientGlobalCallName(node) === "eval" ||
				(node.type === "NewExpression" &&
					ambientGlobalCallName(node) === "Function")
			) {
				hasEvalOrFunction = true;
			}
		});
	}
	if (hasCommonJsRequire) {
		errors.push({
			code: "WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED",
			message: "CommonJS require() is not allowed in tenant workflow source.",
			path,
		});
	}

	// 5. WORKFLOW_EVAL_OR_FUNCTION — eval() or new Function()
	if (hasEvalOrFunction) {
		errors.push({
			code: "WORKFLOW_EVAL_OR_FUNCTION",
			message:
				"`eval()` and `new Function()` are not allowed anywhere in workflow code.",
			path,
		});
	}

	// 6. WORKFLOW_TOP_LEVEL_SIDE_EFFECT — fetch/setTimeout/setInterval/Worker/
	// XMLHttpRequest/EventSource evaluated at module load.
	const sideEffectLabels: Record<string, string> = {
		fetch: "fetch()",
		setTimeout: "setTimeout()",
		setInterval: "setInterval()",
		Worker: "new Worker()",
		XMLHttpRequest: "new XMLHttpRequest()",
		EventSource: "new EventSource()",
	};
	const sideEffectHits = new Set<string>();
	for (const stmt of body) {
		collectEagerSideEffects(
			stmt,
			sideEffectHits,
			new Set(Object.keys(sideEffectLabels)),
			sideEffectLabels,
		);
	}
	for (const label of Object.values(sideEffectLabels)) {
		if (sideEffectHits.has(label)) {
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
	let hasFetch = false;
	let hasFetchOutsideStep = false;
	const scanFetch = (node: WorkflowAstNode, insideStepDo: boolean) => {
		const inside = insideStepDo || isStepDoCall(node);
		if (
			node.type === "CallExpression" &&
			ambientGlobalCallName(node) === "fetch"
		) {
			hasFetch = true;
			if (!inside) hasFetchOutsideStep = true;
		}
		for (const child of childAstNodes(node)) scanFetch(child, inside);
	};
	for (const stmt of body) scanFetch(stmt, false);
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
 * Apps a skill's stored bindings point at, keyed by namespace. Mirrors the
 * runtime: a binding counts only while its app exists and belongs to the
 * skill's organization or is public, so a renamed app still resolves.
 */
async function listBoundApps(
	db: DbClient,
	namespaces: string[],
	binding?: { mcpAppBindings?: unknown; organizationId?: string },
): Promise<
	Map<
		string,
		{
			id: string;
			slug: string;
			metadata: (typeof apps.$inferSelect)["metadata"];
		}
	>
> {
	const out = new Map<
		string,
		{
			id: string;
			slug: string;
			metadata: (typeof apps.$inferSelect)["metadata"];
		}
	>();
	const stored = binding?.mcpAppBindings;
	if (!binding?.organizationId || !stored || typeof stored !== "object")
		return out;
	const bound = namespaces.flatMap((namespace) => {
		const appId = (stored as Record<string, unknown>)[namespace];
		return typeof appId === "string" && appId
			? [[namespace, appId] as const]
			: [];
	});
	if (!bound.length) return out;
	const rows: Array<{
		id: string;
		slug: string;
		metadata: (typeof apps.$inferSelect)["metadata"];
		organizationId: string | null;
		visibility: (typeof apps.$inferSelect)["visibility"];
	}> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(bound.map(([, appId]) => appId))],
		50,
	)) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					metadata: apps.metadata,
					organizationId: apps.organizationId,
					visibility: apps.visibility,
				})
				.from(apps)
				.where(inArray(apps.id, chunk))),
		);
	}
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const [namespace, appId] of bound) {
		const app = byId.get(appId);
		if (
			app &&
			(app.organizationId === binding.organizationId ||
				app.visibility === "public")
		)
			out.set(namespace, {
				id: app.id,
				slug: app.slug,
				metadata: app.metadata,
			});
	}
	return out;
}

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
	binding?: { mcpAppBindings?: unknown; organizationId?: string },
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
	const boundById = await listBoundApps(db, namespaces, binding);

	for (const namespace of namespaces) {
		const path = `capabilities.mcp.${namespace}`;
		const resolved =
			boundById.get(namespace) ??
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

function hasWorkflowEligibility(source: string): boolean | null {
	if (!source.trim()) return false;
	const { body } = parseWorkflowModule(source);
	const bindings = collectTopLevelBindings(body);
	const exported = findDefaultExportValue(body);
	if (!exported) return null;
	const object = resolveObjectExpression(exported, bindings);
	if (!object) return null;
	for (const member of nodeArray(object, "properties")) {
		if (staticMemberName(member) === "eligibility") return true;
		// Spreads/computed keys can supply the hook; leave uncertain shapes to runtime.
		if (member.type === "SpreadElement" || member.computed === true) {
			return null;
		}
	}
	return false;
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
		if (
			scheduleCheck.schedule.executionKind === "inference" &&
			hasWorkflowEligibility(input.files?.["scripts/workflow.ts"] ?? "") ===
				false
		) {
			errors.push({
				code: "BACKGROUND_ELIGIBILITY_REQUIRED",
				message:
					"Inference schedules must export eligibility(event, step, env) on the default workflow object. Return status (eligible, no_work or unavailable), a non-empty inputWatermark and non-empty evidenceRefs; run must return backgroundOutcome after eligible work.",
				path: 'files["scripts/workflow.ts"]',
			});
		}
		warnings.push({
			code: "SKILL_SCHEDULE_PROJECTED_WHEN_ACTIVE",
			message:
				"capabilities.schedule only creates a skill_schedules row once the skill is active (not draft, stale or archived) and has an owning tediId; check skill_schedules after publishing.",
			path: "capabilities.schedule",
		});
	}
	if (Object.keys(manifestCapabilities.mcp).length) {
		warnings.push(
			...(await lintCapabilityManifest(db, manifestCapabilities, input)),
		);
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
