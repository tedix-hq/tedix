#!/usr/bin/env bun

/**
 * Tedix OS source contracts (`bun scripts/lint-os.ts`, part of `lint:repo`): the query-key namespace and
 * the WebMCP tool-module rules below. Either gate's finding exits 1.
 */

/**
 * QUERY KEYS: every Tedix OS server read uses the generated `osQuery` keys, never
 * a hand-written array literal (`queryKey: [...]`, `setQueryData([...])`, or a
 * string-headed array in a declaration named as a key). React Query matches by
 * prefix, so the two namespaces never invalidate each other. Tests are exempt.
 */

/**
 * WEBMCP TOOLS: `apps/os/src/components/*-webmcp-tools.ts` modules must not
 * value-import app-bootstrap modules (`@/lib/api`, `@/router`, ...) at module scope
 * (use `import type` or `await import()` inside `execute`), and must not register
 * agent-invocable admission/approval tools (`accept_`, `decide_`, `approve_`,
 * `settle_`, `start_attempt`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AstNode,
	childNodes,
	isTypeOnlyImport,
	lineAt,
	moduleSpecifier,
	parseModule,
	propertyKeyName,
	stringValue,
	walk,
} from "./oxc-ast.ts";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── Query keys ──────────────────────────────────────────────────────────────

const OS_SRC = join(REPO_ROOT, "apps/os/src");

/** Where the generated keys live — named in every failure message. */
const QUERY_OPTIONS_MODULE = "apps/os/src/lib/os-query-options.ts";

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export type QueryKeyFinding = {
	readonly file: string;
	readonly line: number;
	readonly head: string;
	readonly text: string;
};

const SKIP = [
	/\/node_modules\//,
	/\/dist\//,
	/\.d\.ts$/,
	/\.test\.(?:browser\.)?[jt]sx?$/,
	/\.stories\.[jt]sx?$/,
	/routeTree\.gen\.ts$/,
];

export function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (SKIP.some((pattern) => pattern.test(path))) return [];
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(path) ? [path] : [];
	});
}

/** Strip `as const`, `satisfies`, and parentheses to reach the real initializer. */
const TRANSPARENT_EXPRESSIONS = new Set([
	"TSAsExpression",
	"TSSatisfiesExpression",
	"ParenthesizedExpression",
	"TSTypeAssertion",
]);

function unwrap(node: AstNode): AstNode {
	let current = node;
	for (;;) {
		if (!TRANSPARENT_EXPRESSIONS.has(current.type)) return current;
		const inner = current.expression;
		if (!isAstNode(inner)) return current;
		current = inner;
	}
}

function isAstNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/**
 * The literal's namespace head: its first element when that is a string. A key
 * that opens with a spread or an expression has no stable head, so it is
 * reported as `<spread>` / `<dynamic>`.
 */
function headOf(literal: AstNode): string {
	const first = (literal.elements as Array<AstNode | null>)[0];
	if (!first) return "<empty>";
	if (first.type === "SpreadElement") return "<spread>";
	return stringValue(unwrap(first)) ?? "<dynamic>";
}

/**
 * A declaration that exists to BE a query key: `const queryKey = [...]`,
 * `const APPROVALS_QUERY_KEY = [...]`, `const homeRunSetKey = (id) => [...]`,
 * `function workspaceQueryKeys(scope) { … }`. Anything named this way and
 * holding a string-headed array literal is a hand-written key by construction,
 * so hoisting a literal out of the `queryKey:` position is not an escape.
 */
const KEY_NAME_RE = /(?:^queryKeys?$|_QUERY_KEYS?$|Keys?$)/;

/**
 * TanStack methods that take the key POSITIONALLY rather than in an options
 * object, so a literal there never appears after a `queryKey:`.
 */
const POSITIONAL_KEY_METHODS = new Set([
	"setQueryData",
	"setQueriesData",
	"getQueryData",
	"getQueryState",
	"setQueryDefaults",
	"getQueryDefaults",
]);

/**
 * Expressions that resolve to an array literal: `[…]`, `[…] as const`, and both
 * branches of a ternary — `queryKey: isGadget ? ["os-gadget", id] : opts.queryKey`
 * hides a literal from a naive initializer check.
 */
function arrayLiteralsIn(node: unknown): AstNode[] {
	if (!isAstNode(node)) return [];
	const inner = unwrap(node);
	if (inner.type === "ArrayExpression") return [inner];
	if (inner.type === "ConditionalExpression") {
		return [
			...arrayLiteralsIn(inner.consequent),
			...arrayLiteralsIn(inner.alternate),
		];
	}
	return [];
}

function declaredName(node: AstNode): string | undefined {
	// `const queryKey = …` / `function workspaceQueryKeys() {}`: the binding.
	if (
		node.type === "VariableDeclarator" ||
		node.type === "FunctionDeclaration"
	) {
		const name = node.id;
		if (isAstNode(name) && name.type === "Identifier") {
			return typeof name.name === "string" ? name.name : undefined;
		}
		return undefined;
	}
	// A method, on a class or in an object literal — TypeScript treated both as
	// a method declaration carrying the name.
	if (
		node.type === "MethodDefinition" ||
		(node.type === "Property" && node.method === true)
	) {
		return propertyKeyName(node);
	}
	return undefined;
}

export function scanQueryKeySource(
	fileName: string,
	source: string,
): QueryKeyFinding[] {
	const program = parseModule(fileName, source);
	const findings = new Map<number, QueryKeyFinding>();

	const record = (literal: AstNode, label?: string) => {
		const start = literal.start;
		if (findings.has(start)) return;
		const text = source
			.slice(start, literal.end)
			.replace(/\s+/g, " ")
			.slice(0, 80);
		findings.set(start, {
			file: fileName,
			line: lineAt(source, start),
			head: headOf(literal),
			text: label ? `${label} = ${text}` : text,
		});
	};

	/** True while inside a declaration whose NAME says it holds a query key. */
	const visit = (node: AstNode, inKeyDeclaration: boolean): void => {
		// `queryKey: [...]`, including `as const` and either ternary branch.
		if (
			node.type === "Property" &&
			node.method !== true &&
			propertyKeyName(node) === "queryKey"
		) {
			for (const literal of arrayLiteralsIn(node.value)) record(literal);
		}

		// `queryClient.setQueryData([...], next)` — key in argument position.
		if (node.type === "CallExpression") {
			const callee = node.callee;
			// `qc["setQueryData"]` is an element access, which TypeScript never
			// treated as a property access either — only a plain `a.b` counts.
			const method =
				isAstNode(callee) &&
				callee.type === "MemberExpression" &&
				callee.computed !== true &&
				isAstNode(callee.property) &&
				callee.property.type === "Identifier"
					? (callee.property.name as string)
					: isAstNode(callee) && callee.type === "Identifier"
						? (callee.name as string)
						: undefined;
			const first = (node.arguments as unknown[])[0];
			if (method && POSITIONAL_KEY_METHODS.has(method) && first) {
				for (const literal of arrayLiteralsIn(first)) record(literal);
			}
		}

		const name = declaredName(node);
		const keyScope = name !== undefined ? KEY_NAME_RE.test(name) : false;

		// Inside a key-named declaration, a STRING-HEADED array literal is that
		// declaration's key — `const homeRunSetKey = (id) => ["os-home-run-set", id]`
		// and `keys.push(["os-canvas-gadget", …])` alike. The string head is what
		// keeps this narrow: `opaqueKey()` spreading a `Uint8Array` is not a key
		// namespace, and only the `queryKey:` and positional rules above — where
		// the shape is proven by position, not by name — accept any other head.
		const head =
			node.type === "ArrayExpression"
				? (node.elements as Array<AstNode | null>)[0]
				: undefined;
		if (
			(inKeyDeclaration || keyScope) &&
			head != null &&
			stringValue(unwrap(head)) !== undefined
		) {
			record(node, keyScope ? name : undefined);
		}

		for (const child of childNodes(node)) {
			visit(child, name === undefined ? inKeyDeclaration : keyScope);
		}
	};

	visit(program, false);
	return [...findings.values()].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const QUERY_KEY_REMEDY = [
	`  React Query invalidation is PREFIX-based, and a hand-written key sits in a`,
	`  namespace no generated prefix can reach. A partial key such as`,
	`  osQueryKeys.outputs() will NEVER match ["os-outputs", …], so the moment`,
	`  realtime or a mutation invalidates the generated prefix, this read renders`,
	`  stale data forever — no error, no retry, no refetch.`,
	``,
	`  Fix: use the contract-derived option from ${QUERY_OPTIONS_MODULE},`,
	`  adding a factory there if the endpoint has none:`,
	``,
	`      const q = useQuery({ ...thingQueryOptions(id), enabled: isOpen });`,
	`      queryClient.invalidateQueries({ queryKey: osQueryKeys.things() });`,
	``,
	`  Spread the generated option FIRST so every per-site option (enabled,`,
	`  staleTime, select, placeholderData, …) still wins.`,
	``,
].join("\n");

function queryKeysMain(): number {
	try {
		statSync(OS_SRC);
	} catch {
		// The OSS export subsets the repo. Absent is not "clean" — say which.
		console.log("os query keys: SKIP — apps/os/src absent");
		return 0;
	}

	const findings = sourceFiles(OS_SRC)
		.sort()
		.flatMap((path) =>
			scanQueryKeySource(relative(REPO_ROOT, path), readFileSync(path, "utf8")),
		);

	if (findings.length === 0) {
		console.log("os query keys: OK — every server read is contract-derived");
		return 0;
	}

	console.error("FAIL os query keys: handwritten queryKey literals remain:");
	for (const finding of findings) {
		console.error(`  ${finding.file}:${finding.line}  ${finding.text}`);
	}
	console.error(QUERY_KEY_REMEDY);

	return 1;
}

// ── WebMCP tools ────────────────────────────────────────────────────────────

const OS_COMPONENTS = join(REPO_ROOT, "apps/os/src/components");
const USE_WEBMCP_TOOLS = join(
	REPO_ROOT,
	"apps/os/src/lib/webmcp/use-webmcp-tools.ts",
);

/**
 * Modules whose module-scope evaluation is unsafe in a node test environment.
 * `@/lib/os-query-options` and `@/components/chat-sidebar` are banned because
 * their import chains reach `@/lib/api` / `@/router`, not on their own merits.
 */
export const BANNED_MODULE_SCOPE_IMPORTS = new Set([
	"@/lib/api",
	"@/router",
	"@/lib/os-query-options",
	"@/components/chat-sidebar",
]);

/** Human-only decision verbs a WebMCP tool name must never open with. */
export const HUMAN_ONLY_TOOL_PREFIXES = [
	"accept_",
	"decide_",
	"approve_",
	"settle_",
	"start_attempt",
] as const;

export type WebMcpFinding = {
	readonly file: string;
	readonly line: number;
	readonly rule: "module-scope-import" | "human-only-tool";
	readonly message: string;
};

/**
 * The WebMCP tool modules under gate: every `*-webmcp-tools.ts` in
 * `apps/os/src/components` plus the registration hook. Absent paths are
 * skipped — a mid-refactor tree (tools moving into `@tedix/webmcp-core`) must
 * not fail on files that no longer exist.
 */
export function toolModuleFiles(): string[] {
	const files: string[] = [];
	try {
		for (const entry of readdirSync(OS_COMPONENTS)) {
			if (entry.endsWith("-webmcp-tools.ts")) {
				files.push(join(OS_COMPONENTS, entry));
			}
		}
	} catch {
		// apps/os/src/components absent (OSS export subset) — nothing to scan.
	}
	try {
		statSync(USE_WEBMCP_TOOLS);
		files.push(USE_WEBMCP_TOOLS);
	} catch {
		// Hook moved or absent — the components glob still covers tool modules.
	}
	return files.sort();
}

export function scanWebMcpSource(
	fileName: string,
	source: string,
): WebMcpFinding[] {
	const program = parseModule(fileName, source);
	const findings: WebMcpFinding[] = [];

	const lineOf = (node: AstNode): number => lineAt(source, node.start);

	const visit = (node: AstNode): void => {
		// Rule 1: module-scope value import of a banned app-bootstrap module.
		// Static `import` declarations only exist at module scope, so every
		// match is by definition a module-scope evaluation; execute-time
		// `await import("…")` is a CallExpression and is never visited here.
		const imported =
			node.type === "ImportDeclaration" ? moduleSpecifier(node) : undefined;
		if (
			imported !== undefined &&
			BANNED_MODULE_SCOPE_IMPORTS.has(imported) &&
			!isTypeOnlyImport(node, source)
		) {
			findings.push({
				file: fileName,
				line: lineOf(node),
				rule: "module-scope-import",
				message: `module-scope value import of "${imported}"`,
			});
		}

		// A re-export is a value import too: `export { x } from "@/lib/api"`.
		const reExported =
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration"
				? moduleSpecifier(node)
				: undefined;
		if (
			reExported !== undefined &&
			BANNED_MODULE_SCOPE_IMPORTS.has(reExported) &&
			node.exportKind !== "type"
		) {
			findings.push({
				file: fileName,
				line: lineOf(node),
				rule: "module-scope-import",
				message: `module-scope re-export from "${reExported}"`,
			});
		}

		// Rule 2: a tool definition's `name:` opening with a human-only verb.
		const toolName =
			node.type === "Property" && propertyKeyName(node) === "name"
				? stringValue(node.value)
				: undefined;
		if (toolName !== undefined) {
			const prefix = HUMAN_ONLY_TOOL_PREFIXES.find((candidate) =>
				toolName.startsWith(candidate),
			);
			if (prefix !== undefined) {
				findings.push({
					file: fileName,
					line: lineOf(node),
					rule: "human-only-tool",
					message: `tool "${toolName}" uses human-only decision prefix "${prefix}"`,
				});
			}
		}
	};

	walk(program, visit);
	return findings.sort((a, b) => a.line - b.line);
}

const WEBMCP_REMEDY: Record<WebMcpFinding["rule"], string> = {
	"module-scope-import": [
		`  @/lib/api reads window.location at module scope and @/router drags the`,
		`  entire route tree, so a module-scope value import here makes every`,
		`  node-environment test that imports a host component fail far from the`,
		`  cause.`,
		``,
		`  Fix: keep the module import-inert. Use \`import type\` for types and load`,
		`  the value at execute time inside the tool's handler:`,
		``,
		`      const [{ osApi }, { router }] = await Promise.all([`,
		`          import("@/lib/api"),`,
		`          import("@/router"),`,
		`      ]);`,
		``,
		`  \`vi.mock\` still intercepts the dynamic imports, so tests keep working.`,
		`  Pure modules (e.g. @tedix/webmcp-core/*) may stay at module scope.`,
	].join("\n"),
	"human-only-tool": [
		`  Admission and approval decisions are human-only in agent scopes: a`,
		`  WebMCP tool must not let a model accept, approve, decide, settle, or`,
		`  start an attempt on a Work Item. Expose reads (list_/get_) and`,
		`  non-deciding writes (comment_/create_) instead, and leave the decision`,
		`  verb to the human UI. If the verb is genuinely not a decision, rename`,
		`  the tool so its name does not open with a decision prefix.`,
	].join("\n"),
};

function webMcpMain(): number {
	const files = toolModuleFiles();
	if (files.length === 0) {
		// The OSS export subsets the repo. Absent is not "clean" — say which.
		console.log("webmcp tools: SKIP — no WebMCP tool modules present");
		return 0;
	}

	const findings = files.flatMap((path) =>
		scanWebMcpSource(relative(REPO_ROOT, path), readFileSync(path, "utf8")),
	);

	if (findings.length === 0) {
		console.log(
			`webmcp tools: OK — ${files.length} tool module(s) import-inert at module scope, no human-only decision tools registered`,
		);
		return 0;
	}

	console.error(
		`FAIL webmcp tools: ${findings.length} violation(s) in WebMCP tool modules:`,
	);
	const rulesHit = new Set<WebMcpFinding["rule"]>();
	for (const finding of findings) {
		rulesHit.add(finding.rule);
		console.error(
			`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.message}`,
		);
	}
	for (const rule of rulesHit) {
		console.error("");
		console.error(WEBMCP_REMEDY[rule]);
	}
	return 1;
}

if (import.meta.main) {
	const queryKeys = queryKeysMain();
	const webMcp = webMcpMain();
	process.exit(queryKeys || webMcp);
}
