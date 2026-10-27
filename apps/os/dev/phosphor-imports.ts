import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

const packageName = "@phosphor-icons/react";

/** Keep the icon barrel's SSR catalog out of every development page load. */
export function phosphorImports() {
	const source = readFileSync(
		new URL(import.meta.resolve(packageName)),
		"utf8",
	);
	const program = parseSync("phosphor.js", source).program;
	const imports = new Map<string, { name: string; path: string }>();
	const exports = new Map<string, { name: string; path: string }>();
	for (const node of program.body) {
		if (node.type !== "ImportDeclaration") continue;
		for (const specifier of node.specifiers) {
			if (specifier.type === "ImportNamespaceSpecifier") continue;
			imports.set(specifier.local.name, {
				name:
					specifier.type === "ImportDefaultSpecifier"
						? "default"
						: specifier.imported.type === "Identifier"
							? specifier.imported.name
							: specifier.imported.value,
				path: node.source.value
					.replace(/^\.\//, `${packageName}/dist/`)
					.replace(/\.es\.js$/, ""),
			});
		}
	}
	for (const node of program.body) {
		if (node.type !== "ExportNamedDeclaration") continue;
		for (const specifier of node.specifiers) {
			if (
				specifier.local.type !== "Identifier" ||
				specifier.exported.type !== "Identifier"
			)
				continue;
			const entry = imports.get(specifier.local.name);
			if (entry) exports.set(specifier.exported.name, entry);
		}
	}
	return {
		name: "os-phosphor-imports",
		transform(code: string, id: string) {
			if (!code.includes(packageName)) return null;
			const parsed = parseSync(id.split("?")[0]!, code);
			if (parsed.errors.length) return null;
			let result = code;
			for (const node of [...parsed.program.body].reverse()) {
				if (
					node.type !== "ImportDeclaration" ||
					node.source.value !== packageName ||
					node.importKind === "type"
				)
					continue;
				const replacements: string[] = [];
				for (const specifier of node.specifiers) {
					if (specifier.type !== "ImportSpecifier") break;
					const name =
						specifier.imported.type === "Identifier"
							? specifier.imported.name
							: specifier.imported.value;
					const entry = exports.get(name);
					if (!entry || specifier.importKind === "type") break;
					replacements.push(
						entry.name === "default"
							? `import ${specifier.local.name} from ${JSON.stringify(entry.path)};`
							: `import { ${entry.name} as ${specifier.local.name} } from ${JSON.stringify(entry.path)};`,
					);
				}
				// Namespace imports and unknown exports retain the package's semantics.
				if (
					!replacements.length ||
					replacements.length !== node.specifiers.length
				)
					continue;
				result =
					result.slice(0, node.start) +
					replacements.join(" ") +
					result.slice(node.end);
			}
			return result === code ? null : { code: result, map: null };
		},
	};
}
