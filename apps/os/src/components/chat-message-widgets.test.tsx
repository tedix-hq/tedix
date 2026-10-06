import type { HomeMessage } from "@tedix/api-contract/schemas/kernel-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/components/widget-frame", () => ({
	WidgetFrame: ({
		appSlug,
		resourceUri,
		toolResult,
	}: {
		appSlug: string;
		resourceUri: string;
		toolResult?: Record<string, unknown>;
	}) => (
		<div
			data-widget={`${appSlug}:${resourceUri}`}
			data-result={toolResult ? JSON.stringify(toolResult) : undefined}
		/>
	),
}));

import { ChatMessageWidgets, StructuredReadResult } from "./chat-thread";

const message: HomeMessage = {
	id: "message-1",
	organizationId: "33333333-3333-4333-8333-333333333333",
	conversationId: "home:main",
	role: "assistant",
	status: "completed",
	content: "Here is the dashboard.",
	createdAt: "2026-08-20T12:00:00.000Z",
	metadata: {
		delegatedResult: {
			version: 1,
			widgets: [
				{
					resourceUri: "ui://widgets/mcp-app/metabase/dashboard.html",
					toolResult: {
						rows: [{ name: "Revenue", value: 42 }],
						_meta: {
							ui: {
								resourceUri: "ui://widgets/mcp-app/metabase/dashboard.html",
							},
						},
					},
				},
			],
		},
	},
};

describe("ChatMessageWidgets", () => {
	it("mounts a validated MCP App immediately after its assistant turn", () => {
		const html = renderToStaticMarkup(<ChatMessageWidgets message={message} />);
		expect(html).toContain('data-slot="mcp-app-widget"');
		expect(html).toContain(
			'class="flex min-w-0 max-w-full justify-start overflow-hidden"',
		);
		expect(html).toContain('class="min-w-0 max-w-full flex-1 overflow-hidden"');
		expect(html).toContain(
			'data-widget="metabase:ui://widgets/mcp-app/metabase/dashboard.html"',
		);
		expect(html).toContain("Revenue");
	});

	it("never renders widgets under a user turn", () => {
		const html = renderToStaticMarkup(
			<ChatMessageWidgets message={{ ...message, role: "user" }} />,
		);
		expect(html).toBe("");
	});
});

/**
 * Direct-read results are MCP tool output rendered inside the transcript, in
 * the transcript's own voice. React escapes markup on this path, so what has
 * to be stripped is the INVISIBLE layer: a RIGHT-TO-LEFT OVERRIDE reorders
 * what the operator reads without changing the string, which is exactly the
 * bypass `@/lib/untrusted-text` was written to make impossible to forget.
 */
describe("StructuredReadResult sanitizes tool-authored strings", () => {
	const RLO = "‮";
	const LRI = "⁦";

	it("strips direction controls from scalar values", () => {
		const html = renderToStaticMarkup(
			<StructuredReadResult value={`report${RLO}txt.exe`} />,
		);
		expect(html).not.toContain(RLO);
		expect(html).toContain("reporttxt.exe");
	});

	it("strips direction controls from object KEYS as well as values", () => {
		const html = renderToStaticMarkup(
			<StructuredReadResult
				value={{ [`status${RLO}`]: `ok${LRI}`, plain: "fine" }}
			/>,
		);
		expect(html).not.toContain(RLO);
		expect(html).not.toContain(LRI);
		expect(html).toContain("fine");
	});

	it("strips them at every depth, including inside arrays", () => {
		const html = renderToStaticMarkup(
			<StructuredReadResult
				value={[{ nested: { deep: `a${RLO}b` } }, `top${LRI}`]}
			/>,
		);
		expect(html).not.toContain(RLO);
		expect(html).not.toContain(LRI);
	});

	it("leaves ordinary content untouched", () => {
		const html = renderToStaticMarkup(
			<StructuredReadResult value={{ name: "Café — 100% ✓" }} />,
		);
		expect(html).toContain("100%");
		expect(html).toContain("Caf");
	});
});
