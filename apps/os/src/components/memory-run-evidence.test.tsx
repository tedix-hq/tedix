import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CardRunLinkProps } from "./chat-cards";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memoryHealthFindingsQueryOptions } from "@/lib/os-query-options";
import { memorySearchSchema } from "@/lib/memory-browser";
import { MemoryBrowser, MemoryRunEvidence } from "./memory-browser";

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

describe("Memory Health tab", () => {
	it("renders main's health findings in the tab without record controls", () => {
		const client = new QueryClient();
		client.setQueryData(memoryHealthFindingsQueryOptions().queryKey, {
			checkedAt: "2026-10-20T12:00:00.000Z",
			unusedDays: 60,
			staleDays: 90,
			orphanWindow: 2000,
			findings: [{ kind: "unused", count: 38, capped: false, samples: [] }],
			graphLayer: { configured: false },
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<MemoryBrowser
					search={memorySearchSchema.parse({ tab: "health" })}
					onSearch={() => {}}
				/>
			</QueryClientProvider>,
		);
		expect(html).toContain('aria-label="Memory health findings"');
		expect(html).toContain("38 facts were not retrieved in the last 60 days");
		expect(html).toContain("Graph layer (Neo4j)");
		expect(html).not.toContain("20 rows per page");
		expect(html).not.toContain("Search memories");
	});
});
