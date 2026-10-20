import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		apps: {
			getGatewayMembership: mocks.read,
			setGatewayMembership: mocks.write,
		},
	},
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<span>{children}</span>
	),
}));
import { AppGatewayMembership } from "./app-gateway-membership";
import { appGatewayMembershipQueryOptions } from "@/lib/os-query-options";
const initial = {
	gateway: { id: "gateway", name: "Globex", slug: "globex-unified" },
	enabled: false,
	unavailableReason: null,
};
beforeEach(() => {
	mocks.read.mockReset().mockResolvedValue(initial);
	mocks.write.mockReset();
});
async function mount(canManage = true, appId = "app") {
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	client.setQueryData(
		appGatewayMembershipQueryOptions(appId).queryKey,
		initial,
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AppGatewayMembership appId={appId} canManage={canManage} />
			</QueryClientProvider>,
		),
	);
	return {
		node,
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
			node.remove();
		},
	};
}
describe("gateway membership control", () => {
	it("explains gateway self-membership without offering a membership change", async () => {
		const view = await mount(true, "gateway");
		try {
			expect(view.node.textContent).toContain(
				"This app is the unified gateway",
			);
			expect(view.node.textContent).toContain("Self-membership does not apply");
			expect(view.node.textContent).not.toContain("Not included");
			expect(view.node.querySelector('[role="switch"]')).toBeNull();
			expect(mocks.write).not.toHaveBeenCalled();
		} finally {
			await view.close();
		}
	});
	it("is read-only without app management permission", async () => {
		const view = await mount(false);
		try {
			const control =
				view.node.querySelector<HTMLButtonElement>('[role="switch"]')!;
			expect(control.disabled).toBe(true);
			expect(view.node.textContent).toContain("stays installed");
		} finally {
			await view.close();
		}
	});
	it("saves membership and reads back server state", async () => {
		mocks.write.mockResolvedValue({ success: true });
		mocks.read.mockResolvedValue({ ...initial, enabled: true });
		const view = await mount();
		try {
			const control =
				view.node.querySelector<HTMLButtonElement>('[role="switch"]')!;
			await act(async () => control.click());
			await act(async () => {
				await new Promise((done) => setTimeout(done, 10));
			});
			expect(mocks.write).toHaveBeenCalledWith({ appId: "app", enabled: true });
			expect(control.getAttribute("aria-checked")).toBe("true");
		} finally {
			await view.close();
		}
	});
	it("shows a failed save without claiming inclusion", async () => {
		mocks.write.mockRejectedValue(new Error("Permission changed"));
		const view = await mount();
		try {
			await act(async () =>
				view.node.querySelector<HTMLButtonElement>('[role="switch"]')!.click(),
			);
			await act(async () => {
				await new Promise((done) => setTimeout(done, 10));
			});
			expect(view.node.textContent).toContain("Permission changed");
			expect(
				view.node
					.querySelector('[role="switch"]')
					?.getAttribute("aria-checked"),
			).toBe("false");
		} finally {
			await view.close();
		}
	});
});
