/**
 * The AST primitives the repo-wide lint gates share.
 *
 * These gates used TypeScript's legacy compiler API until TypeScript 7 removed
 * it: 7 ships no source-text parser, and its `unstable/sync` route to a
 * SourceFile spawns the Go server over a channel Bun cannot open. oxc is the
 * parser the rest of the toolchain already runs on — `vp lint` and `vp fmt` are
 * oxlint and oxfmt — so the gates now read the same AST their linter does.
 *
 * The shapes here are deliberately narrow. Each gate matches a handful of node
 * types, so a structural subset of ESTree is enough and keeps the gates honest
 * about what they actually read.
 */

import { parseSync } from "oxc-parser";

/** Any ESTree node. Gates narrow by `type` before reading further fields. */
export interface AstNode {
	type: string;
	start: number;
	end: number;
	[field: string]: unknown;
}

export interface Program extends AstNode {
	body: AstNode[];
}

/**
 * Parse one module, or throw.
 *
 * A parse failure is an error rather than an empty program: oxc parses every
 * file these gates walk, so a failure means malformed source, and a silent
 * empty body would drop that file out of the contract with no signal.
 */
export function parseModule(path: string, source: string): Program {
	const parsed = parseSync(path, source, { lang: languageOf(path) });
	const failure = parsed.errors[0];
	if (failure) throw new Error(`${path}: ${failure.message}`);
	return parsed.program as unknown as Program;
}

function languageOf(path: string): "ts" | "tsx" | "js" | "jsx" {
	if (path.endsWith(".tsx")) return "tsx";
	if (path.endsWith(".jsx")) return "jsx";
	if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
		return "js";
	}
	return "ts";
}

/**
 * Visit `node` and every descendant, in source order.
 *
 * Replaces `ts.forEachChild` recursion. Children are found structurally — any
 * object with a string `type`, and any array of them — which visits the same
 * nodes the TypeScript walk did for every construct these gates match.
 */
export function walk(node: AstNode, visit: (node: AstNode) => void): void {
	visit(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isNode(item)) walk(item, visit);
			}
			continue;
		}
		if (isNode(value)) walk(value, visit);
	}
}

/**
 * The direct children of `node`, in source order.
 *
 * `ts.forEachChild` for gates that carry state down the tree and therefore
 * cannot use {@link walk}. Array holes (`[, x]`) are skipped: ESTree models
 * them as `null` elements.
 */
export function childNodes(node: AstNode): AstNode[] {
	const children: AstNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) children.push(item);
			continue;
		}
		if (isNode(value)) children.push(value);
	}
	return children.sort((left, right) => left.start - right.start);
}

function isNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** 1-based line number of a source offset, matching editor and tsc output. */
export function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < source.length; index++) {
		if (source.charCodeAt(index) === 10) line++;
	}
	return line;
}

/**
 * The constant string a node denotes, or `undefined` when it is not one.
 *
 * Covers what `ts.isStringLiteralLike` covered: a string literal, or a
 * template literal with no interpolation.
 */
export function stringValue(node: unknown): string | undefined {
	if (!isNode(node)) return undefined;
	if (node.type === "Literal") {
		return typeof node.value === "string" ? node.value : undefined;
	}
	if (node.type === "TemplateLiteral") {
		const expressions = node.expressions as unknown[] | undefined;
		if (expressions && expressions.length > 0) return undefined;
		const quasis = node.quasis as
			| Array<{ value?: { cooked?: string | null } }>
			| undefined;
		if (!quasis || quasis.length !== 1) return undefined;
		return quasis[0]?.value?.cooked ?? undefined;
	}
	return undefined;
}

/**
 * The static property name a key denotes, or `undefined`.
 *
 * A computed key (`{ [name]: … }`) is never static, matching TypeScript, where
 * a computed name is a ComputedPropertyName rather than an identifier.
 */
export function propertyKeyName(property: AstNode): string | undefined {
	if (property.computed === true) return undefined;
	const key = property.key;
	if (!isNode(key)) return undefined;
	if (key.type === "Identifier") {
		return typeof key.name === "string" ? key.name : undefined;
	}
	return stringValue(key);
}

/**
 * The module specifier of an import, re-export or `export * from`, when it is
 * a static string. `export { x }` with no `from` clause has none.
 */
export function moduleSpecifier(node: AstNode): string | undefined {
	return stringValue(node.source);
}

/**
 * Whether an import declaration is fully erased at compile time.
 *
 * `import "x"` is a value side effect, a default or namespace binding is a
 * value, and a named import is erased only when every binding is type-only.
 * oxc reports `import "x"` and `import {} from "x"` with the same empty
 * specifier list, so the `from` clause is what separates them — the source
 * between the keyword and the specifier.
 */
export function isTypeOnlyImport(node: AstNode, source: string): boolean {
	if (node.importKind === "type") return true;
	const specifiers = (node.specifiers ?? []) as AstNode[];
	if (specifiers.length === 0) {
		const specifierNode = node.source;
		if (!isNode(specifierNode)) return false;
		const clause = source.slice(node.start, specifierNode.start);
		return clause.includes("from");
	}
	return specifiers.every(
		(specifier) =>
			specifier.type === "ImportSpecifier" && specifier.importKind === "type",
	);
}
