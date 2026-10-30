import { isRecord } from "@tedix/api-contract/utils/is-record";

const CODEMODE_BUILTIN_GLOBALS = new Set([
	"Array",
	"BigInt",
	"Boolean",
	"Date",
	"Error",
	"JSON",
	"Map",
	"Math",
	"Number",
	"Object",
	"Promise",
	"Reflect",
	"RegExp",
	"Set",
	"String",
	"Symbol",
	"console",
	"globalThis",
]);

const JS_RESERVED_WORDS = new Set(
	(
		"async await break case catch class const continue debugger default delete do " +
		"else export extends false finally for function if import in instanceof let new " +
		"null of return super switch this throw true try typeof undefined var void while " +
		"with yield NaN Infinity arguments"
	).split(" "),
);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The program with comments and string literals blanked out, plus the values
 * of its plain string literals. Template literals are blanked whole.
 */
function maskCodeModeLiterals(
	code: string,
	preserveQuotes = false,
): {
	masked: string;
	strings: string[];
	dynamicTemplate: boolean;
} {
	let masked = "";
	let dynamicTemplate = false;
	const strings: string[] = [];
	let index = 0;
	while (index < code.length) {
		const char = code[index]!;
		const next = code[index + 1];
		if (char === "/" && (next === "/" || next === "*")) {
			const end =
				next === "/"
					? code.indexOf("\n", index)
					: code.indexOf("*/", index + 2) + 2;
			const stop = end <= index ? code.length : end;
			masked += " ".repeat(stop - index);
			index = stop;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let cursor = index + 1;
			let value = "";
			while (cursor < code.length && code[cursor] !== char) {
				if (code[cursor] === "\\") {
					value += code[cursor + 1] ?? "";
					cursor += 2;
				} else {
					value += code[cursor];
					cursor++;
				}
			}
			if (char !== "`") strings.push(value);
			const stop = Math.min(cursor + 1, code.length);
			if (char === "`" && value.includes("${")) dynamicTemplate = true;
			masked += preserveQuotes
				? char + " ".repeat(Math.max(0, stop - index - 2)) + char
				: " ".repeat(stop - index);
			index = stop;
			continue;
		}
		masked += char;
		index++;
	}
	return { masked, strings, dynamicTemplate };
}

/** Dynamic calls and namespace aliases cannot safely bound catalog hydration. */
function hasOpaqueNamespaceCalls(
	code: string,
	builtins: ReadonlySet<string>,
): boolean {
	const aliases = new Set<string>();
	for (const match of code.matchAll(
		/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?!=)\s*\(*\s*([A-Za-z_$][\w$]*)\s*\)*\s*(?=[;,)\n}]|$)/g,
	)) {
		if (!builtins.has(match[2]!)) aliases.add(match[1]!);
	}
	for (const match of code.matchAll(
		/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?(\[|\.|\()/g,
	)) {
		const name = match[1]!;
		if (aliases.has(name)) return true;
		if (builtins.has(name) || match[2] !== "[") continue;
		const start = match.index + match[0].length;
		let depth = 1;
		let end = start;
		for (; end < code.length && depth > 0; end++) {
			if (code[end] === "[") depth++;
			else if (code[end] === "]") depth--;
		}
		if (depth !== 0) return true;
		if (
			/^\s*(?:\?\.\s*)?\(/.test(code.slice(end)) &&
			!/^\s*(?:"[^"]*"|'[^']*')\s*$/.test(code.slice(start, end - 1))
		)
			return true;
	}
	return false;
}

/**
 * Namespaces a program reaches without a literal `ns.tool(` call site: a bare
 * reference (`const api = acme_unified; api.list()`), `globalThis.ns`, or
 * `globalThis[...]`. Locally declared names are left out. Over-inclusion is
 * harmless: only names that match a configured aggregate entry hydrate.
 */
function referencedCodeModeNamespaces(code: string): Set<string> {
	const { masked, strings } = maskCodeModeLiterals(code);
	const declared = new Set<string>();
	const addIdentifiers = (text: string) => {
		for (const name of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
			declared.add(name);
		}
	};
	for (const match of masked.matchAll(
		/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		declared.add(match[1]!);
	}
	for (const match of masked.matchAll(/\b(?:const|let|var)\s*([{[][^=]*)=/g)) {
		addIdentifiers(match[1]!);
	}
	for (const match of masked.matchAll(/\(([^()]*)\)\s*=>/g)) {
		addIdentifiers(match[1]!);
	}
	for (const match of masked.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) {
		declared.add(match[1]!);
	}
	for (const match of masked.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
		declared.add(match[1]!);
	}

	const namespaces = new Set<string>();
	for (const match of masked.matchAll(
		/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g,
	)) {
		const name = match[1]!;
		if (
			!declared.has(name) &&
			!JS_RESERVED_WORDS.has(name) &&
			!CODEMODE_BUILTIN_GLOBALS.has(name)
		) {
			namespaces.add(name);
		}
	}
	for (const match of masked.matchAll(
		/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)/g,
	)) {
		namespaces.add(match[1]!);
	}
	if (/\bglobalThis\s*\[/.test(masked)) {
		// The key may be any string the program holds; take every identifier-shaped one.
		for (const value of strings) {
			if (IDENTIFIER.test(value)) namespaces.add(value);
		}
	}
	return namespaces;
}

/**
 * Namespaces named by the program's `discover` calls, or null when any call
 * cannot be bounded statically. A program without discovery yields an empty set.
 */
function literalDiscoveryNamespaces(
	code: string,
	masked: string,
): Set<string> | null {
	const namespaces = new Set<string>();
	const callStart = /\bdiscover\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
	let match = callStart.exec(masked);
	while (match !== null) {
		const method = match[1];
		const argument = balancedArgument(code, callStart.lastIndex);
		if (argument === null) return null;
		let input: unknown;
		try {
			input = JSON.parse(argument);
		} catch {
			return null;
		}
		if (method === "search") {
			const namespace = isRecord(input) ? input.namespace : undefined;
			if (
				typeof namespace !== "string" ||
				!/^[A-Za-z_$][\w$]*$/.test(namespace)
			) {
				return null;
			}
			namespaces.add(namespace);
		} else if (method === "describe") {
			const callable =
				typeof input === "string"
					? input
					: isRecord(input)
						? input.callable
						: undefined;
			const named =
				typeof callable === "string"
					? /^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/.exec(callable)
					: null;
			if (!named) return null;
			namespaces.add(named[1]!);
		} else {
			return null;
		}
		match = callStart.exec(masked);
	}
	// A `discover` reference that is not a call (aliasing, passing it around)
	// cannot be bounded.
	const references = masked.match(/\bdiscover\b/g)?.length ?? 0;
	const calls =
		masked.match(/\bdiscover\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g)?.length ?? 0;
	return references === calls ? namespaces : null;
}

/** Text between an opening parenthesis (already consumed) and its match. */
function balancedArgument(code: string, from: number): string | null {
	let depth = 1;
	let quote: string | null = null;
	for (let index = from; index < code.length; index++) {
		const char = code[index]!;
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return code.slice(from, index);
	}
	return null;
}

export function extractCodeModeProviderNamespacesFromCode(
	code: string,
	includeDiscoveryTargets = true,
): Set<string> | null {
	// Discovery normally needs the whole catalog. When every `discover` call in
	// the program names its target with a JSON literal (describe("ns.tool"),
	// search({namespace})), only those namespaces plus the ones the program calls
	// directly are hydrated. On Connect an unbounded program loads every selected
	// organization (13k+ tools) and can exhaust the Worker CPU limit. Anything
	// else — dynamic arguments, list_namespaces, a namespace-less search — keeps
	// the full catalog. This changes loading, never selection or dispatch gates.
	const { masked, dynamicTemplate } = maskCodeModeLiterals(code, true);
	if (
		dynamicTemplate ||
		hasOpaqueNamespaceCalls(masked, CODEMODE_BUILTIN_GLOBALS)
	)
		return null;
	const discoveryNamespaces = includeDiscoveryTargets
		? literalDiscoveryNamespaces(code, masked)
		: new Set<string>();
	if (discoveryNamespaces === null) return null;
	const namespaces = new Set<string>();
	const callPattern =
		/(?:^|[^A-Za-z0-9_$])([A-Za-z_$][\w$]*)\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\])\s*\(/g;
	let match = callPattern.exec(masked);
	while (match !== null) {
		const namespace = match[1];
		if (namespace && !CODEMODE_BUILTIN_GLOBALS.has(namespace)) {
			namespaces.add(namespace);
		}
		match = callPattern.exec(masked);
	}
	for (const namespace of referencedCodeModeNamespaces(code)) {
		namespaces.add(namespace);
	}
	namespaces.delete("discover");
	for (const namespace of discoveryNamespaces) namespaces.add(namespace);
	// The built-in `flow.*` provider dispatches through other namespaces at
	// execute time (skills.record_skills + <tedi>.run_skill_workflow/status/
	// inspect), which this pre-execution scan cannot see — a snippet like
	// `flow.status({ runId })` mentions no tedi at all, so the lazy hydrator
	// would mount nothing and the dispatch would fail with "not mounted".
	// When flow is requested, hydrate its
	// dependencies: the skills namespace, the default flow tedi, and any tedi
	// named by a literal tediSlug argument.
	if (namespaces.has("flow")) {
		namespaces.add("skills");
		namespaces.add("cto");
		const slugPattern = /tediSlug\s*:\s*["']([A-Za-z0-9_-]{1,64})["']/g;
		let slug = slugPattern.exec(code);
		while (slug !== null) {
			const literal = slug[1];
			if (literal) namespaces.add(literal.replace(/-/g, "_"));
			slug = slugPattern.exec(code);
		}
	}
	return namespaces;
}

/** Discovery reads catalog rows; it does not need every executable SDK binding. */
export function extractCodeModeExecutionNamespacesFromCode(
	code: string,
): Set<string> | null {
	const { masked } = maskCodeModeLiterals(code, true);
	// Keep every binding when execution can select a namespace indirectly, or
	// when flow chooses a runner at runtime. This is an allocation optimization,
	// never an authorization boundary.
	if (/\b(?:globalThis|eval|Function)\b|\bflow\b/.test(masked)) return null;
	return extractCodeModeProviderNamespacesFromCode(code, false);
}
