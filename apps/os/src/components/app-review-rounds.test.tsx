import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	listShares: vi.fn(),
	listFeedback: vi.fn(),
	getContext: vi.fn(),
	getGadget: vi.fn(),
	listOutputs: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osShares: {
			shares: { list: api.listShares },
			reviews: { listFeedback: api.listFeedback },
		},
		osWorkspaces: {
			gadgets: { get: api.getGadget },
			outputs: { list: api.listOutputs },
		},
		userSettings: { getContext: api.getContext },
	},
}));

import { AppReviewRounds } from "./app-review-rounds";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GADGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function useLink(overrides: Record<string, unknown> = {}) {
	return {
		id: "share-use",
		resourceType: "gadget",
		resourceId: GADGET_ID,
		role: "use",
		revisionMode: "living",
		expiresAt: null,
		revokedAt: null,
		...overrides,
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.clearAllMocks();
});

async function render(): Promise<HTMLElement> {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<AppReviewRounds gadgetId={GADGET_ID} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container;
}

describe("AppReviewRounds", () => {
	it("gives the owner the review form when the app has a use link", async () => {
		api.getContext.mockResolvedValue({ authority: { role: "owner" } });
		api.listShares.mockResolvedValue({ items: [useLink()] });
		api.listFeedback.mockResolvedValue({ batches: [] });
		api.getGadget.mockResolvedValue({ gadget: { workspaceId: "ws-1" } });
		api.listOutputs.mockResolvedValue({ items: [] });
		const container = await render();
		expect(container.textContent).toContain("Ask people to review items");
		expect(container.textContent).toContain("Items come from");
	});

	it("asks for a use link first when the app has none working", async () => {
		api.getContext.mockResolvedValue({ authority: { role: "owner" } });
		api.listShares.mockResolvedValue({
			items: [useLink({ revokedAt: "2026-10-01T00:00:00.000Z" })],
		});
		const container = await render();
		expect(container.textContent).toContain("First use Share to make a link");
		expect(container.textContent).not.toContain("Items come from");
	});

	it("shows nothing to people who are not the organization owner", async () => {
		api.getContext.mockResolvedValue({ authority: { role: "member" } });
		const container = await render();
		expect(container.textContent).toBe("");
		expect(api.listShares).not.toHaveBeenCalled();
	});
});
