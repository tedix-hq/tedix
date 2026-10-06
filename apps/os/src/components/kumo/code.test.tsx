import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	CodeBlock,
	CodeBlockContent,
	CodeInline,
	CodeSyntaxProvider,
} from "./code";

describe("Kumo Code adapters", () => {
	it("renders inline code as a semantic <code> element", () => {
		const html = renderToStaticMarkup(<CodeInline>run_skill</CodeInline>);

		expect(html).toMatch(/^<code/);
		expect(html).toContain('data-slot="code-inline"');
		expect(html).toContain("run_skill");
	});

	it("renders blocks as readable plain text before Shiki resolves, one <pre> per block", () => {
		const html = renderToStaticMarkup(
			<CodeSyntaxProvider>
				<CodeBlock code="bun run test" lang="bash" />
				<CodeBlockContent code="a: 1" lang="yaml" />
			</CodeSyntaxProvider>,
		);

		expect(html.match(/<pre/g)).toHaveLength(2);
		expect(html).toContain("bun run test");
		expect(html).toContain("a: 1");
	});
});
