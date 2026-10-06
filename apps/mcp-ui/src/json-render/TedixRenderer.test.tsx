// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({
	call: vi.fn(),
	persist: vi.fn(),
	state: {},
	open: vi.fn(),
	followUp: vi.fn(),
	displayMode: vi.fn(),
	modal: vi.fn(),
	comparison: {} as any,
}));
vi.mock("@tedix/widget-ui/layouts", async (original) => ({
	...(await original<any>()),
	ComparisonLayout: (props: any) => {
		host.comparison = props;
		return null;
	},
}));
vi.mock("../components/WidgetWrapper", () => ({
	WidgetWrapper: ({ children }: any) => children,
}));
vi.mock("../lib/widget-host-hooks", () => ({
	WidgetModelContext: ({ children }: any) => children,
	callHostTool: host.call,
	useWidgetCallTool: () => ({ callTool: vi.fn(), isPending: false }),
	useWidgetDisplayMode: () => ["inline", host.displayMode],
	useWidgetOpenExternal: () => host.open,
	useWidgetModal: () => ({ open: host.modal }),
	useWidgetSendFollowUp: () => host.followUp,
	useWidgetSetOpenInAppUrl: () => vi.fn(),
	useWidgetToolInfo: () => ({ isSuccess: true }),
	useWidgetUser: () => ({
		locale: "en",
		userAgent: { device: { type: "desktop" } },
	}),
	useWidgetViewState: () => [host.state, host.persist],
}));
import { TedixRenderer } from "./TedixRenderer";

it("shows a rejected action, skips persistence, then clears the error after a successful retry", async () => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	host.call
		.mockRejectedValueOnce(new Error("Not authorized"))
		.mockResolvedValueOnce({ content: [] });
	try {
		await act(async () =>
			root.render(
				<TedixRenderer
					spec={{
						root: "action",
						state: {},
						elements: {
							action: {
								type: "ActionButton",
								props: { label: "Save" },
								on: {
									press: {
										action: "call_tool",
										params: { tool: "record_skill" },
									},
								},
							},
						},
					}}
				/>,
			),
		);
		await act(async () => node.querySelector("button")!.click());
		expect(host.call).toHaveBeenCalledWith("record_skill", {});
		expect(node.querySelector('[role="alert"]')?.textContent).toContain(
			"Not authorized",
		);
		expect(host.persist).not.toHaveBeenCalled();
		await act(async () => node.querySelector("button")!.click());
		// First button is the alert dismiss control; dismissing does not retry a write.
		expect(node.querySelector('[role="alert"]')).toBeNull();
		expect(host.call).toHaveBeenCalledTimes(1);
		await act(async () => node.querySelector("button")!.click());
		expect(host.call).toHaveBeenCalledTimes(2);
		expect(host.persist).toHaveBeenCalledOnce();
		expect(node.querySelector('[role="alert"]')).toBeNull();
	} finally {
		await act(async () => root.unmount());
		node.remove();
		log.mockRestore();
	}
});

for (const action of ["open_external", "open_url"]) {
	it(`${action} waits for host acknowledgement and shows rejection without persisting success`, async () => {
		vi.clearAllMocks();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const node = document.createElement("div");
		document.body.appendChild(node);
		const root = createRoot(node);
		let reject!: (error: Error) => void;
		host.open.mockReturnValueOnce(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		try {
			await act(async () =>
				root.render(
					<TedixRenderer
						spec={{
							root: "link",
							state: { _utmParams: { source: "tedix" } },
							elements: {
								link: {
									type: "ActionButton",
									props: { label: "Open" },
									on: {
										press: { action, params: { url: "https://example.com" } },
									},
								},
							},
						}}
					/>,
				),
			);
			await act(async () => node.querySelector("button")!.click());
			expect(host.open).toHaveBeenCalledExactlyOnceWith(
				"https://example.com/?utm_source=tedix",
			);
			expect(host.persist).not.toHaveBeenCalled();
			await act(async () => reject(new Error("Host denied link")));
			expect(node.querySelector('[role="alert"]')?.textContent).toContain(
				"Host denied link",
			);
			expect(host.persist).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			node.remove();
			log.mockRestore();
		}
	});
}
for (const bound of [true, false]) {
	it(`comparison callbacks dispatch once with ${bound ? "bound actions" : "direct fallbacks"}`, async () => {
		vi.clearAllMocks();
		host.open.mockResolvedValue(undefined);
		host.followUp.mockResolvedValue(undefined);
		host.displayMode.mockResolvedValue(undefined);
		host.modal.mockResolvedValue(undefined);
		const node = document.createElement("div");
		document.body.appendChild(node);
		const root = createRoot(node);
		const item = { id: "one", title: "One", url: "https://example.com" };
		const bindings = {
			externalRedirect: {
				action: "open_external",
				params: { url: { $state: "/_event/externalRedirect/url" } },
			},
			requestComparison: {
				action: "follow_up",
				params: { query: { $state: "/_event/requestComparison/query" } },
			},
			requestDetail: {
				action: "request_modal",
				params: { item: { $state: "/_event/requestDetail/item" } },
			},
			displayModeChange: {
				action: "request_display_mode",
				params: { mode: { $state: "/_event/displayModeChange/mode" } },
			},
		};
		try {
			await act(async () =>
				root.render(
					<TedixRenderer
						spec={{
							root: "comparison",
							state: { _detailTemplate: "detail" },
							elements: {
								comparison: {
									type: "ComparisonLayout",
									props: { results: [item] },
									...(bound ? { on: bindings } : {}),
								},
							},
						}}
					/>,
				),
			);
			await act(async () => host.comparison.onExternalRedirect(item));
			expect(host.open).toHaveBeenCalledExactlyOnceWith(item.url);
			await act(async () => host.comparison.onRequestAIComparison([item]));
			expect(host.followUp).toHaveBeenCalledExactlyOnceWith(
				"Compare these results: One",
			);
			await act(async () => host.comparison.onRequestDetail(item));
			expect(host.modal).toHaveBeenCalledExactlyOnceWith({
				template: "detail",
				params: { _detailItem: item },
				title: "One",
			});
			await act(async () => host.comparison.onDisplayModeChange("fullscreen"));
			expect(host.displayMode).toHaveBeenCalledExactlyOnceWith("fullscreen");
		} finally {
			await act(async () => root.unmount());
			node.remove();
		}
	});
}
