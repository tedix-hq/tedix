import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const reviseCard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
	osApi: {
		workInteractions: { reviseCard },
		attention: {},
		workItems: {},
		learningFeedback: {},
		workAgentSessions: {},
	},
}));
import { InternalDecisionUndo } from "./internal-decision-undo";
import { osQuery } from "@/lib/os-query-options";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target = {
	requestId: "10000000-0000-4000-8000-000000000001",
	expectedRequestVersion: 4,
	expectedRevision: 2,
	restoreRevision: 1,
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => reviseCard.mockReset().mockResolvedValue({}));
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	host?.remove();
	client?.clear();
});
async function mount(disabled = false) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<InternalDecisionUndo target={target} disabled={disabled} />
			</QueryClientProvider>,
		),
	);
}
async function click() {
	await act(async () => {
		host.querySelector<HTMLButtonElement>("button")!.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

describe("InternalDecisionUndo", () => {
	it("restores the exact revision, refreshes canonical state, and prevents a second undo", async () => {
		await mount();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await click();
		expect(reviseCard).toHaveBeenCalledExactlyOnceWith(target);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQuery.workInteractions.key(),
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQuery.attention.key(),
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQuery.workItems.key(),
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQuery.learningFeedback.key(),
		});
		expect(host.querySelector("button")?.textContent).toBe("Undone");
		await click();
		expect(reviseCard).toHaveBeenCalledTimes(1);
	});

	it("shows a stale revision conflict and permits retry without claiming success", async () => {
		reviseCard.mockRejectedValueOnce(
			new Error("This card changed. Refresh and try again."),
		);
		await mount();
		await click();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"This card changed",
		);
		expect(host.querySelector("button")?.textContent).toBe("Undo");
		await click();
		expect(reviseCard).toHaveBeenCalledTimes(2);
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(host.querySelector("button")?.textContent).toBe("Undone");
	});

	it("does not restore while the feed is busy", async () => {
		await mount(true);
		await click();
		expect(reviseCard).not.toHaveBeenCalled();
	});
});
