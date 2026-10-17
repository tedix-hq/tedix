import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: vi.fn() }),
	useQuery: ({ enabled }: { enabled?: boolean }) =>
		enabled === undefined
			? { data: { canReview: true, items: [receipt] } }
			: {
					data: [{ receipt, mirrorWorkItemId: "platform-mirror", draft: null }],
				},
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		support: {
			mine: { queryOptions: () => ({}) },
			queue: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@/lib/api", () => ({ osApi: { support: { publish: vi.fn() } } }));
import { SupportAttention } from "./support-attention";
const receipt = {
	ticketId: "ticket",
	title: "Connection failed",
	statusUrl: "/work/items/tenant-source",
	owner: "Support",
	status: "received",
	waitingOn: "support",
	nextUpdateDue: "2026-10-17T12:00:00.000Z",
	reporterVerification: "unconfirmed",
	publicUpdates: [],
};
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("Support Attention organization links", () => {
	it("opens the tenant source for reporters and the platform mirror for reviewers", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<SupportAttention />));
			expect(container.querySelector("a")?.getAttribute("href")).toBe(
				"/work/items/tenant-source",
			);
			await act(async () =>
				Array.from(container.querySelectorAll("button"))
					.find((x) => x.textContent === "Review support queue")!
					.click(),
			);
			expect(container.querySelector("a")?.getAttribute("href")).toBe(
				"/work/items/platform-mirror",
			);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
