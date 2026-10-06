import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	fields,
	pages,
} from "../templates/tedix/src/plugins/tedix-site-builder/admin";
import { createPlugin } from "../templates/tedix/src/plugins/tedix-site-builder/index";

vi.mock("emdash", () => ({ definePlugin: (plugin: unknown) => plugin }));

describe("native generated search text widget", () => {
	it("renders generated text collapsed and read-only without calling onChange", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			createElement(fields["derived-search-text"], {
				value: "<script>not executable</script>",
				onChange,
			} as never),
		);
		expect(markup).toContain("<details>");
		expect(markup).toContain("&lt;script&gt;not executable&lt;/script&gt;");
		expect(markup).not.toMatch(
			/<(input|textarea)|contenteditable|<details open/,
		);
		expect(onChange).not.toHaveBeenCalled();
	});
	it("registers the text widget in the plugin and both native descriptors", () => {
		expect(createPlugin().admin?.fieldWidgets).toContainEqual({
			name: "derived-search-text",
			label: "Generated search text",
			fieldTypes: ["text"],
		});
		for (const template of ["tedix", "marketing"]) {
			const config = readFileSync(
				new URL(`../templates/${template}/astro.config.mjs`, import.meta.url),
				"utf8",
			);
			expect(config).toMatch(
				/fieldWidgets:\s*\[\s*\{\s*name:\s*"derived-search-text"/,
			);
		}
	});
});

describe("native editing navigation", () => {
	it("keeps code management separate from native preview and editing", () => {
		const markup = renderToStaticMarkup(createElement(pages["/development"]));
		expect(markup).toContain("Code and deployments");
		expect(markup).toContain("https://os.tedix.dev/sites");
		expect(markup).not.toContain("<iframe");
		expect(createPlugin().admin?.pages).toEqual([
			{ path: "/development", label: "Code and deployments", icon: "code" },
		]);
		expect(createPlugin().admin).not.toHaveProperty("widgets");
	});
});
