import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

// Exercise EmDash's resolved transitive dependency, including on a clean install.
const cmsRequire = createRequire(
	new URL("../../apps/cms/package.json", import.meta.url),
);
const sanitizeHtml = createRequire(cmsRequire.resolve("emdash"))(
	"sanitize-html",
);

describe("EmDash sanitize-html security regressions", () => {
	test("CVE-2026-113654: implied closes cannot expose noscript contents", () => {
		expect(
			sanitizeHtml(
				'<div><noscript></div><img src="https://evil.example/t.gif"></noscript>',
				{
					allowedTags: ["div", "img"],
					allowedAttributes: { img: ["src"] },
					nonTextTags: ["script", "style", "textarea", "option", "noscript"],
				},
			),
		).toBe("<div></div>");
	});

	test("CVE-2026-113661: meta refresh destinations obey scheme restrictions", () => {
		const options = {
			allowedTags: ["meta"],
			allowedAttributes: { meta: ["http-equiv", "content"] },
		};
		for (const url of ["javascript:alert(1)", "data:text/html,unsafe"])
			expect(
				sanitizeHtml(
					`<meta http-equiv="refresh" content="0;url=${url}">`,
					options,
				),
			).not.toContain("content=");
		expect(
			sanitizeHtml(
				'<meta http-equiv="refresh" content="0;url=https://example.com">',
				options,
			),
		).toContain("https://example.com");
	});

	test("CVE-2026-113657: namespace-prefixed SMIL cannot rewrite URL attributes", () => {
		for (const tag of ["svg:animate", "xlink:set", "xml:animateTransform"])
			expect(
				sanitizeHtml(
					`<svg><a href="#safe"><${tag} attributeName="href" values="#safe;javascript:alert(1)" dur=".01s" fill="freeze"/><text>Click</text></a></svg>`,
					{
						allowedTags: false,
						allowedAttributes: false,
						allowedSchemes: ["http", "https"],
						allowVulnerableTags: true,
					},
				),
			).toBe('<svg><a href="#safe"><text>Click</text></a></svg>');
	});
});
