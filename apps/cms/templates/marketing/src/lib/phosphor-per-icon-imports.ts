import type { Plugin } from "vite";
import MagicString from "magic-string";

const PHOSPHOR_IMPORT =
	/import\s*\{([^}]+)\}\s*from\s*["']@phosphor-icons\/react["'];?/g;

export function phosphorPerIconImports(): Plugin {
	return {
		name: "tedix-phosphor-per-icon-imports",
		enforce: "pre",
		transform(code) {
			if (!code.includes("@phosphor-icons/react")) return;

			const transformed = new MagicString(code);
			let changed = false;
			for (const match of code.matchAll(PHOSPHOR_IMPORT)) {
				const imported = match[1];
				if (match.index === undefined || imported === undefined) continue;
				const replacement = imported
					.split(",")
					.map((specifier) => specifier.trim())
					.filter(
						(specifier) =>
							specifier.length > 0 && !specifier.startsWith("type "),
					)
					.map((specifier) => {
						const [name, alias] = specifier.split(/\s+as\s+/) as [
							string,
							string?,
						];
						if (name === "IconContext") {
							return 'import { IconContext } from "@phosphor-icons/react/dist/lib/context";';
						}
						const moduleName = name.endsWith("Icon") ? name.slice(0, -4) : name;
						const binding = alias ? `${name} as ${alias}` : name;
						return `import { ${binding} } from "@phosphor-icons/react/dist/csr/${moduleName}";`;
					})
					.join("\n");
				transformed.overwrite(
					match.index,
					match.index + match[0].length,
					replacement,
				);
				changed = true;
			}

			if (!changed) return;
			return {
				code: transformed.toString(),
				map: transformed.generateMap({ hires: true }),
			};
		},
	};
}
