import { describe, expect, it, vi } from "vite-plus/test";
import type { ServerContext } from "../server-context";
import { registerDesignWidgetUiTool } from "./design-widget-ui";

vi.mock("../codemode-auth", () => ({
	enforceMcpToolScopeAuthorization: () => null,
}));

vi.mock("../tedi-enrichment", () => ({
	buildEnrichmentRequest: () => ({}),
	invokeTediEnrichment: async () => {
		throw new Error("private-provider-response-canary");
	},
}));

type InvokeDesign = (input: {
	toolId: string;
	appId: string;
	designGoal?: string;
}) => Promise<unknown>;

function registeredHandler(options: {
	lookup: () => Promise<unknown>;
	loadedTool?: Record<string, unknown>;
	tediId?: string;
}): InvokeDesign {
	const registerTool = vi.fn(
		(_name: unknown, _definition: unknown, _handler: unknown) => ({}),
	);
	const loadedTools = new Map<string, unknown>();
	if (options.loadedTool)
		loadedTools.set("private-tool-input-canary", options.loadedTool);
	registerDesignWidgetUiTool({
		server: { registerTool },
		registeredTools: new Map(),
		appToolIds: new Set(),
		loadedTools,
		apiClient: { appTools: { get: options.lookup } },
		appMetadata: {
			mcpConfig: { tediPolicy: { tediId: options.tediId } },
		},
		appSlug: "private-app-input-canary",
		env: {},
	} as unknown as ServerContext);
	return registerTool.mock.calls[0]![2] as InvokeDesign;
}

describe("design widget failure diagnostics", () => {
	it("hides lookup error text and caller-supplied tool ID while preserving not-found behavior", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const invoke = registeredHandler({
				lookup: async () => {
					throw new Error("private-provider-response-canary");
				},
			});
			const result = await invoke({
				toolId: "private-tool-input-canary",
				appId: "00000000-0000-0000-0000-000000000000",
			});
			expect(result).toMatchObject({ isError: true });
			const logged = JSON.stringify(warn.mock.calls);
			expect(logged).toContain("widget.design_tool_lookup_failed");
			expect(logged).not.toContain("private-provider-response-canary");
			expect(logged).not.toContain("private-tool-input-canary");
		} finally {
			warn.mockRestore();
		}
	});

	it("hides enrichment failure text and retains the failed-design response", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const invoke = registeredHandler({
				lookup: async () => null,
				loadedTool: {
					toolId: "private-tool-input-canary",
					title: "Private Tool",
				},
				tediId: "00000000-0000-0000-0000-000000000000",
			});
			const result = await invoke({
				toolId: "private-tool-input-canary",
				appId: "00000000-0000-0000-0000-000000000000",
				designGoal: "private-prompt-canary",
			});
			expect(result).toMatchObject({ isError: true });
			const logged = JSON.stringify(warn.mock.calls);
			expect(logged).toContain("widget.design_enrichment_failed");
			expect(logged).not.toContain("private-provider-response-canary");
			expect(logged).not.toContain("private-tool-input-canary");
			expect(logged).not.toContain("private-prompt-canary");
		} finally {
			warn.mockRestore();
		}
	});
});
