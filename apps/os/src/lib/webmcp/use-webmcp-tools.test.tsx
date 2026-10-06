import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import { webMcpResult } from "@tedix/webmcp-core/model-context";
import {
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";
import { useWebMcpTools } from "./use-webmcp-tools";

function Probe({ scope, name }: { scope: string; name: string }) {
	useWebMcpTools(
		scope,
		() => [
			{
				name,
				description: `${name} description`,
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true, untrustedContentHint: false },
				execute: async () => webMcpResult({}),
			},
		],
		[name],
	);
	return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(element: React.ReactElement) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(element));
}

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	setModelContextResolverForTests(null);
});

describe("useWebMcpTools", () => {
	it("registers on mount and disposes on unmount", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);

		mount(createElement(Probe, { scope: "work", name: "list_work_items" }));
		expect(webMcpRegisteredToolNames()).toEqual(["list_work_items"]);

		act(() => root?.render(createElement("div")));
		expect(webMcpRegisteredToolNames()).toEqual([]);
	});

	it("re-registers when a dependency changes", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);

		mount(createElement(Probe, { scope: "work", name: "list_work_items" }));
		act(() =>
			root?.render(
				createElement(Probe, { scope: "work", name: "get_work_item" }),
			),
		);
		expect(webMcpRegisteredToolNames()).toEqual(["get_work_item"]);
	});

	it("mounts as a no-op without a WebMCP surface", () => {
		setModelContextResolverForTests(() => null);
		mount(createElement(Probe, { scope: "work", name: "list_work_items" }));
		expect(webMcpRegisteredToolNames()).toEqual([]);
	});
});
