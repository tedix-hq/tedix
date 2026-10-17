import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ list: vi.fn(), allow: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		personalResourceDelegations: { list: mocks.list },
		osWorkspaces: {
			schedules: { allowPersonalRead: mocks.allow, list: vi.fn() },
			resources: { list: vi.fn() },
		},
	},
}));
import { PersonalReadConsentApp } from "./personal-read-consent-app";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const config = {
	version: 1 as const,
	skillId: "22222222-2222-4222-8222-222222222222",
	resourceId: "33333333-3333-4333-8333-333333333333",
	workerName: "research tedi",
	providers: [
		{ id: "google-gmail", name: "Gmail" },
		{ id: "google-calendar", name: "Calendar" },
	],
};
beforeEach(() => {
	mocks.list.mockReset().mockResolvedValue([]);
	mocks.allow
		.mockReset()
		.mockResolvedValue({ status: "allowed", grantId: "grant-1" });
});
async function settle() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 10));
	});
}
async function mount() {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<PersonalReadConsentApp workspaceId={workspaceId} config={config} />
			</QueryClientProvider>,
		),
	);
	await settle();
	return {
		node,
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
			node.remove();
		},
	};
}
it("grants both declared providers only after the person clicks", async () => {
	const view = await mount();
	try {
		expect(mocks.allow).not.toHaveBeenCalled();
		expect(view.node.textContent).toContain(
			"Let the research tedi read my Gmail and Calendar (read-only)",
		);
		await act(async () => view.node.querySelector("button")!.click());
		await settle();
		expect(mocks.allow.mock.calls.map(([input]) => input)).toEqual(
			config.providers.map((provider) => ({
				workspaceId,
				resourceId: config.resourceId,
				providerId: provider.id,
			})),
		);
	} finally {
		await view.close();
	}
});
it("keeps a missing connection visible without claiming both accounts are allowed", async () => {
	mocks.allow.mockResolvedValue({
		status: "not_connected",
		providerId: "google-calendar",
	});
	const view = await mount();
	try {
		await act(async () => view.node.querySelector("button")!.click());
		await settle();
		expect(view.node.textContent).toContain("Connect your Gmail and Calendar");
		expect(view.node.textContent).not.toContain("Read-only access is allowed.");
	} finally {
		await view.close();
	}
});
