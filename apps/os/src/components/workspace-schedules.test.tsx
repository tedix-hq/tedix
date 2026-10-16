import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspaceSchedule } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	allow: vi.fn(),
	revoke: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			resources: { list: vi.fn() },
			schedules: { list: mocks.list, allowPersonalRead: mocks.allow },
		},
		personalResourceDelegations: { list: vi.fn(), revoke: mocks.revoke },
	},
}));
import { WorkspaceSchedules } from "./workspace-schedules";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";

function schedule(
	personalRead: OsWorkspaceSchedule["personalRead"],
): OsWorkspaceSchedule {
	return {
		resourceId: RESOURCE_ID,
		skillId: "skill-inbox",
		name: "Inbox cards",
		purpose: "Reads your inbox and writes action cards.",
		enabled: true,
		cron: "17 6 * * *",
		dailyTimes: [],
		nextRunAt: null,
		lastRun: null,
		personalRead,
	};
}
const gmail = {
	providerId: "google-gmail",
	providerName: "Gmail",
	toolIds: ["search_threads"],
	grantId: null,
	canAllow: true,
};

beforeEach(() => {
	mocks.list.mockReset();
	mocks.allow.mockReset();
	mocks.revoke.mockReset();
});

async function settle() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 10));
	});
}

async function mount() {
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceSchedules workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		),
	);
	await settle();
	return {
		node,
		button: (label: string) =>
			[...node.querySelectorAll("button")].find(
				(button) => button.textContent?.trim() === label,
			),
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
			node.remove();
		},
	};
}

describe("personal read on a scheduled skill", () => {
	it("lets the owner allow a read-only Gmail read with one click", async () => {
		mocks.list
			.mockResolvedValueOnce({ items: [schedule(gmail)] })
			.mockResolvedValue({
				items: [schedule({ ...gmail, grantId: GRANT_ID })],
			});
		mocks.allow.mockResolvedValue({ status: "allowed", grantId: GRANT_ID });
		const view = await mount();
		try {
			const allow = view.button("Let this read my Gmail (read-only)");
			expect(allow).toBeDefined();
			await act(async () => allow!.click());
			await settle();
			expect(mocks.allow).toHaveBeenCalledWith({
				workspaceId: WORKSPACE_ID,
				resourceId: RESOURCE_ID,
			});
			expect(view.node.textContent).toContain("Reads your Gmail (read-only) ·");
		} finally {
			await view.close();
		}
	});

	it("stops an active read by revoking the owner's grant", async () => {
		mocks.list
			.mockResolvedValueOnce({
				items: [schedule({ ...gmail, grantId: GRANT_ID })],
			})
			.mockResolvedValue({ items: [schedule(gmail)] });
		mocks.revoke.mockResolvedValue({});
		const view = await mount();
		try {
			await act(async () => view.button("Stop")!.click());
			await settle();
			expect(mocks.revoke).toHaveBeenCalledWith({ id: GRANT_ID });
			expect(view.button("Let this read my Gmail (read-only)")).toBeDefined();
		} finally {
			await view.close();
		}
	});

	it("sends an owner without a connected account to Settings → Connections", async () => {
		mocks.list.mockResolvedValue({ items: [schedule(gmail)] });
		mocks.allow.mockResolvedValue({
			status: "not_connected",
			providerId: "google-gmail",
		});
		const view = await mount();
		try {
			await act(async () =>
				view.button("Let this read my Gmail (read-only)")!.click(),
			);
			await settle();
			expect(
				view.node.querySelector('a[href="/account/connections"]')?.textContent,
			).toBe("Settings → Connections");
		} finally {
			await view.close();
		}
	});

	it("shows nothing about the read to anyone but the owner", async () => {
		mocks.list.mockResolvedValue({
			items: [schedule({ ...gmail, grantId: GRANT_ID, canAllow: false })],
		});
		const view = await mount();
		try {
			expect(view.node.textContent).toContain("Inbox cards");
			expect(view.node.querySelector("[data-schedule-personal-read]")).toBe(
				null,
			);
		} finally {
			await view.close();
		}
	});
});
