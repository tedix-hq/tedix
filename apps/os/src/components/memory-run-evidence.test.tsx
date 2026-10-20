import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CardRunLinkProps } from "./chat-cards";
import { MemoryRunEvidence } from "./memory-browser";

function RunLink(props: CardRunLinkProps) {
	return (
		<a
			href={props.to.replace("$runId", props.params.runId)}
			className={props.className}
		>
			{props.children}
		</a>
	);
}

describe("Memory detail run evidence", () => {
	it("keeps canonical workflow run evidence navigable", () => {
		const id = "55555555-5555-4555-8555-555555555555";
		const html = renderToStaticMarkup(
			<MemoryRunEvidence runId={id} LinkComponent={RunLink} />,
		);
		expect(html).toContain(`href="/work/runs/${id}"`);
		expect(html).toContain("Run details");
	});
	it("retains compound runtime evidence without a false workflow link", () => {
		const id = "tedi:mcp:66666666-6666-4666-8666-666666666666_delegate:tedi";
		const html = renderToStaticMarkup(
			<MemoryRunEvidence runId={id} LinkComponent={RunLink} />,
		);
		expect(html).toContain(id);
		expect(html).not.toContain("href=");
	});
	it("does not invent a run when none was recorded", () => {
		expect(
			renderToStaticMarkup(
				<MemoryRunEvidence runId={null} LinkComponent={RunLink} />,
			),
		).toBe("");
	});
});
