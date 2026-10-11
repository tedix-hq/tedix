/**
 * The static runtime import edges of one TypeScript module, lexed from
 * comment-stripped source with anchored regexes.
 *
 * Type-only imports/exports (`import type`, `export type ... from`) and
 * `await import()` are not edges: the first is erased before the module runs,
 * the second does not load at module evaluation. `import { type A } from "x"`
 * IS an edge, conservatively, since `verbatimModuleSyntax` keeps it as a bare
 * `import "x"`.
 *
 * Shared by `lint-import-cycles.ts` and `ci/preflight-db-targets.mjs`. Plain
 * `.mjs` so the Node-run pre-push preflight can import it too.
 */

/**
 * Blank out comment bodies so a commented-out import is not counted.
 * @param {string} source
 */
export function stripComments(source) {
	// Replace comment bodies with spaces rather than deleting them, so the
	// anchored `^\s*` matches below cannot be fooled into joining two lines.
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(m, lead) => lead + " ".repeat(m.length - lead.length),
		);
}

/**
 * Every specifier, relative or bare, carrying a STATIC runtime edge.
 * @param {string} source
 * @returns {string[]}
 */
export function runtimeImportSpecifiers(source) {
	const text = stripComments(source);
	/** @type {string[]} */
	const specifiers = [];

	// `import ... from "x"` / `export ... from "x"`, rejecting the type-only
	// forms. `[^;]*?` keeps the match inside one statement.
	const fromRe =
		/^[ \t]*(?:import|export)[ \t]+(?!type[ \t])[^;]*?from[ \t]*["']([^"']+)["']/gm;
	// Side-effect import: `import "x";`
	const bareRe = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;

	for (const re of [fromRe, bareRe]) {
		let match = re.exec(text);
		while (match !== null) {
			const specifier = match[1];
			if (specifier) specifiers.push(specifier);
			match = re.exec(text);
		}
	}
	return specifiers;
}
