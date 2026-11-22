import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { BROWSER_SIGN_IN_ENTRY } from "@tedix/api-contract/schemas/os-browser-sign-in";
import { osApi } from "@/lib/api";
import { WorkspaceAppRenderer } from "./workspace-app-renderer";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { organization: { id: "org" } } }),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		tediApprovals: {
			getBrowserLoginSession: vi.fn(),
			endBrowserLoginSession: vi.fn(),
		},
		tedis: { list: vi.fn(), get: vi.fn() },
		members: { listMembers: vi.fn() },
	},
}));

const tediId = "00000000-0000-4000-8000-000000000001";
const login = {
	approvalRequestId: "approval",
	tediId,
	orgId: "org",
	principal: "person-sub",
	reason: "Sign in to the supplier portal",
	siteHosts: ["portal.example.test"],
	approvedAt: "2026-11-22T08:00:00.000Z",
	expiresAt: "2026-11-22T16:00:00.000Z",
};

it("shows the tedi's browser sign-in from its per-org config and ends it", async () => {
	vi.mocked(osApi.tedis.list).mockResolvedValue({
		data: [{ id: tediId, name: "ops", displayName: "Ops tedi" }],
	} as unknown as Awaited<ReturnType<typeof osApi.tedis.list>>);
	vi.mocked(osApi.members.listMembers).mockResolvedValue({
		data: [{ userId: "person", descopeUserId: "person-sub", name: "Person" }],
	} as unknown as Awaited<ReturnType<typeof osApi.members.listMembers>>);
	vi.mocked(osApi.tediApprovals.getBrowserLoginSession).mockResolvedValue({
		login,
	});
	vi.mocked(osApi.tediApprovals.endBrowserLoginSession).mockResolvedValue({
		ended: login,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const flush = () =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkspaceAppRenderer
						manifest={{
							entry: BROWSER_SIGN_IN_ENTRY,
							capabilities: [],
							config: { version: 1, tediId },
						}}
					/>
				</QueryClientProvider>,
			),
		);
		for (let i = 0; i < 50 && !host.textContent?.includes("Expires"); i++)
			await flush();
		expect(osApi.tediApprovals.getBrowserLoginSession).toHaveBeenCalledWith(
			{ tediId },
			expect.anything(),
		);
		expect(host.textContent).toContain("Ops tedi can reuse a sign-in");
		expect(host.textContent).toContain("Person");
		expect(host.textContent).toContain("portal.example.test");
		expect(host.textContent).toContain("Expires");
		const button = Array.from(host.querySelectorAll("button")).find(
			(b) => b.textContent === "End session",
		)!;
		await act(async () => button.click());
		await flush();
		expect(osApi.tediApprovals.endBrowserLoginSession).toHaveBeenCalledWith({
			tediId,
		});
		expect(host.textContent).toContain("Sign-in ended.");
		expect(host.textContent).not.toContain("portal.example.test");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		client.clear();
	}
});
