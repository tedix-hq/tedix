import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { RunStepResult } from "./run-step-result";

describe("step result presentation", () => {
	it("renders dates semantically and keeps numeric IDs intact", () => {
		const html = renderToStaticMarkup(
			<RunStepResult value={{ createdAt: 1793178000000, id: 1793178000000 }} />,
		);
		expect(html).toContain('<time dateTime="2026-10-28T09:00:00.000Z">');
		expect(html).toContain("1793178000000");
	});
	it("links safe URLs while keeping unsafe schemes and markup inert", () => {
		const html = renderToStaticMarkup(
			<RunStepResult
				value={{
					url: "https://example.com/thread?x=1",
					unsafe: "javascript:alert(1)",
					markup: "<script>alert(1)</script>",
				}}
			/>,
		);
		expect(html).toContain('href="https://example.com/thread?x=1"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain("&lt;script&gt;");
	});
	it("uses the Kumo code block for fenced snippets and deep structured values", () => {
		const html = renderToStaticMarkup(
			<RunStepResult value={"```sql\nselect 1;\n```"} />,
		);
		expect(html).toContain("<pre");
		expect(html).toContain("select 1;");
		expect(html).not.toContain("```sql");
		const nested = renderToStaticMarkup(
			<RunStepResult value={{ answer: true }} depth={6} />,
		);
		expect(nested).toContain("<pre");
		expect(nested).toContain("answer");
	});
});
