import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import { webMcpResult } from "@tedix/webmcp-core/model-context";
import {
	setModelContextResolverForTests,
	setWebMcpInvocationObserver,
	webMcpRegistrationStatus,
} from "@tedix/webmcp-core/registry";
import { useAppWebMcpTools } from "./use-app-webmcp-tools";

let tools: WebMcpToolDef[] = [];

function App({ count }: { count: number }) {
	useAppWebMcpTools(
		"counter",
		{ count },
		(current) => [
			{
				name: "counter_read",
				description: "Read the count",
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true, untrustedContentHint: false },
				execute: async () => webMcpResult({ count: current().count }),
			},
		],
		[],
	);
	return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(element: React.ReactElement) {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	act(() => root?.render(element));
}

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	tools = [];
	setModelContextResolverForTests(null);
});

describe("useAppWebMcpTools", () => {
	it("registers while mounted, reads live state, and unregisters on close", async () => {
		// Invocation telemetry posts to the network; it has its own suite.
		setWebMcpInvocationObserver(null);
		setModelContextResolverForTests(() => ({
			provideContext: (context) => {
				tools = context.tools;
			},
		}));

		render(createElement(App, { count: 1 }));
		expect(tools.map((t) => t.name)).toEqual(["counter_read"]);
		const generation = webMcpRegistrationStatus().generation;

		render(createElement(App, { count: 2 }));
		expect(webMcpRegistrationStatus().generation).toBe(generation);
		const result = await tools[0]!.execute({});
		expect(result.structuredContent).toEqual({ count: 2 });

		render(createElement("div"));
		expect(tools).toEqual([]);
	});
});
