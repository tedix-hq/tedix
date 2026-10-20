import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Badge } from "./badge";

describe("Kumo Badge adapter", () => {
	it("mirrors every installed Kumo variant, with the documented outline fill exception", () => {
		const chunks = new URL(
			"../chunks/",
			import.meta.resolve("@cloudflare/kumo/components/badge"),
		);
		const chunk = readdirSync(chunks).find((name) =>
			/^badge-.*\.js$/.test(name),
		);
		expect(chunk).toBeDefined();
		const upstream = readFileSync(new URL(chunk!, chunks), "utf8")
			.split("const KUMO_BADGE_VARIANTS = {")[1]!
			.split("appearance:")[0]!;
		const upstreamClasses = Object.fromEntries(
			[
				...upstream.matchAll(
					/(?:"([\w-]+)"|([\w-]+)):\s*\{\s*classes: "([^"]+)"/g,
				),
			].map(([, quoted, key, classes]) => [quoted ?? key, classes]),
		);
		const local = readFileSync("src/components/kumo/badge.tsx", "utf8")
			.split("const VARIANT_CLASSES:")[1]!
			.split("};")[0]!;
		const localClasses = Object.fromEntries(
			[...local.matchAll(/(?:"([\w-]+)"|([\w-]+)):\s*"([^"]+)"/g)].map(
				([, quoted, key, classes]) => [quoted ?? key, classes],
			),
		);

		expect(Object.keys(upstreamClasses)).toContain("primary");
		expect(Object.keys(upstreamClasses)).toContain("blue");
		expect(localClasses).toEqual({
			...upstreamClasses,
			outline: upstreamClasses.outline.replace(
				"bg-kumo-base",
				"bg-transparent",
			),
		});
	});

	it("renders one semantic badge root carrying its label", () => {
		const html = renderToStaticMarkup(<Badge variant="info">Connected</Badge>);

		expect(html).toMatch(/^<span/);
		expect(html.match(/<span/g)).toHaveLength(1);
		expect(html).toContain("Connected");
	});
});
