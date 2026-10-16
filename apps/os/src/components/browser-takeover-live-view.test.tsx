import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
const api = vi.hoisted(() => ({ getBrowserTakeoverStatus: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { tediApprovals: api } }));
import { BrowserTakeoverLiveView } from "./browser-takeover-live-view";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	vi.restoreAllMocks();
	api.getBrowserTakeoverStatus.mockReset();
});

async function mount() {
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { mutations: { retry: false } } })
				}
			>
				<BrowserTakeoverLiveView approvalId="approval-1" />
			</QueryClientProvider>,
		),
	);
}
async function click() {
	await act(async () => {
		host.querySelector("button")!.click();
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}
it("fetches a fresh URL on every click instead of using the approval's expired URL", async () => {
	const view = { location: { replace: vi.fn() }, close: vi.fn(), opener: {} };
	vi.spyOn(window, "open").mockReturnValue(view as unknown as Window);
	api.getBrowserTakeoverStatus
		.mockResolvedValueOnce({
			status: "pending",
			sameSession: true,
			targets: [
				{ targetId: "tab-1", url: "https://live.browser.run/ui/view?fresh=1" },
			],
		})
		.mockResolvedValueOnce({
			status: "pending",
			sameSession: true,
			targets: [
				{ targetId: "tab-1", url: "https://live.browser.run/ui/view?fresh=2" },
			],
		});
	await mount();
	await click();
	await click();
	expect(api.getBrowserTakeoverStatus).toHaveBeenCalledTimes(2);
	expect(api.getBrowserTakeoverStatus).toHaveBeenCalledWith({
		id: "approval-1",
	});
	expect(view.location.replace.mock.calls).toEqual([
		["https://live.browser.run/ui/view?fresh=1"],
		["https://live.browser.run/ui/view?fresh=2"],
	]);
	expect(view.opener).toBeNull();
});
it.each([
	{ sameSession: false, targets: [] },
	{
		sameSession: true,
		targets: [{ targetId: "tab-1", url: "https://attacker.example/" }],
	},
])(
	"closes the blank tab and displays unavailable or unsafe results",
	async (result) => {
		const view = { location: { replace: vi.fn() }, close: vi.fn() };
		vi.spyOn(window, "open").mockReturnValue(view as unknown as Window);
		api.getBrowserTakeoverStatus.mockResolvedValue({
			status: "pending",
			...result,
		});
		await mount();
		await click();
		expect(view.location.replace).not.toHaveBeenCalled();
		expect(view.close).toHaveBeenCalled();
		expect(host.textContent).not.toBe("Open live view");
	},
);
