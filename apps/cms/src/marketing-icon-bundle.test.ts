import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { phosphorPerIconImports as marketingIcons } from "../templates/marketing/src/lib/phosphor-per-icon-imports";
import { phosphorPerIconImports as tedixIcons } from "../templates/tedix/src/lib/phosphor-per-icon-imports";

describe.each([
	["marketing", marketingIcons],
	["tedix", tedixIcons],
] as const)("%s template icon bundling", (slug, phosphorPerIconImports) => {
	it("rewrites package-root imports to tree-shakeable icon modules", async () => {
		const transform = phosphorPerIconImports().transform;
		if (typeof transform !== "function") throw new Error("Missing transform");

		const result = await transform.call(
			{} as never,
			' import { CheckIcon, Image as ImageIcon, type Icon, IconContext } from "@phosphor-icons/react";',
			"example.tsx",
		);
		expect(typeof result === "string" ? result : result?.code).toBe(
			' import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";\n' +
				'import { Image as ImageIcon } from "@phosphor-icons/react/dist/csr/Image";\n' +
				'import { IconContext } from "@phosphor-icons/react/dist/lib/context";',
		);
	});

	it("applies the rewrite before dependency optimization", () => {
		const config = readFileSync(
			new URL(`../templates/${slug}/astro.config.mjs`, import.meta.url),
			"utf8",
		);

		expect(config).toMatch(
			/plugins:\s*\[phosphorPerIconImports\(\),\s*tailwindcss\(\)\]/,
		);
		expect(config).toMatch(
			/optimizeDeps:\s*\{\s*exclude:\s*\["@phosphor-icons\/react"\]/,
		);
	});
});
