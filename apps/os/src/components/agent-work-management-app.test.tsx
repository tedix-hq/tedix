import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AgentWorkManagementApp } from "./agent-work-management-app";

const mocks = vi.hoisted(() => ({
	role: "owner",
	list: vi.fn(),
	set: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		externalAgentIdentity: {
			listPrincipals: mocks.list,
			setWorkManagement: mocks.set,
		},
		projects: { list: vi.fn(async () => ({ data: [] })) },
	},
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: {
			organization: { id: "org-example" },
			authority: { role: mocks.role },
		},
	}),
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: QueryClient;
beforeEach(() => {
	mocks.role = "owner";
	mocks.list.mockReset();
	mocks.list.mockResolvedValue([
		{
			id: "agent-example",
			displayName: "Example agent",
			status: "active",
			updatedAt: "now",
			metadata: {},
		},
	]);
	mocks.set.mockReset();
	mocks.set.mockResolvedValue({});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	cache = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	cache.clear();
});
async function render() {
	await act(async () => {
		root.render(
			<QueryClientProvider client={cache}>
				<AgentWorkManagementApp organizationId="org-example" />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
async function click(label: string) {
	const button = [...host.querySelectorAll("button")].find(
		(entry) => entry.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => button!.click());
}
it("saves an organization grant and refreshes the principal list", async () => {
	await render();
	await click("Save grant");
	expect(mocks.set).toHaveBeenCalledWith({
		organizationId: "org-example",
		principalId: "agent-example",
		grant: {
			scope: "organization",
			actions: ["specification", "cancellation"],
		},
	});
	expect(mocks.list.mock.calls.length).toBeGreaterThan(1);
});
it("revokes the selected agent's grant", async () => {
	mocks.list.mockResolvedValue([
		{
			id: "agent-example",
			displayName: "Example agent",
			status: "active",
			updatedAt: "now",
			metadata: {
				workManagement: { scope: "organization", actions: ["specification"] },
			},
		},
	]);
	await render();
	await click("Revoke grant");
	expect(mocks.set).toHaveBeenCalledWith({
		organizationId: "org-example",
		principalId: "agent-example",
		grant: null,
	});
});
it("keeps owner controls and principal reads unavailable to members", async () => {
	mocks.role = "member";
	await render();
	expect(host.textContent).toContain("Only an organization owner or admin");
	expect(mocks.list).not.toHaveBeenCalled();
	expect(host.querySelector("button")).toBeNull();
});
