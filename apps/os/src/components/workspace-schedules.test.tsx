import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspaceSchedule } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	allow: vi.fn(),
	revoke: vi.fn(),
	link: vi.fn(),
	unlink: vi.fn(),
	linkFactorySkills: vi.fn(),
	skills: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			resources: { list: vi.fn() },
			schedules: {
				list: mocks.list,
				allowPersonalRead: mocks.allow,
				link: mocks.link,
				unlink: mocks.unlink,
				linkFactorySkills: mocks.linkFactorySkills,
			},
		},
		personalResourceDelegations: { list: vi.fn(), revoke: mocks.revoke },
		skills: { listByOrg: mocks.skills },
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
		tediName: "Inbox Tedi",
		hasWorkflow: true,
	};
}
const gmail = {
	providerId: "google-gmail",
	providerName: "Gmail",
	toolIds: ["search_threads"],
	grantId: null,
	level: "none" as const,
	canAllow: true,
};

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
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
	it("renders full schedule names without adding headings to the tab order", async () => {
		const longName =
			"Review every newly received supplier invoice before the weekly close";
		mocks.list.mockResolvedValue({
			items: [{ ...schedule(gmail), name: longName }],
		});
		const view = await mount();
		try {
			const heading = view.node.querySelector("h3");
			expect(heading?.textContent).toBe(longName);
			expect(heading?.tabIndex).toBe(-1);
			expect(heading?.classList.contains("line-clamp-1")).toBe(false);
		} finally {
			await view.close();
		}
	});

	it("lets the owner allow a read-only Gmail read with one click", async () => {
		mocks.list
			.mockResolvedValueOnce({ items: [schedule(gmail)] })
			.mockResolvedValue({
				items: [schedule({ ...gmail, grantId: GRANT_ID, level: "read" })],
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
				items: [schedule({ ...gmail, grantId: GRANT_ID, level: "read" })],
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

	it("shows when the owner let it organise the account too", async () => {
		mocks.list.mockResolvedValue({
			items: [schedule({ ...gmail, grantId: GRANT_ID, level: "organise" })],
		});
		const view = await mount();
		try {
			expect(view.node.textContent).toContain(
				"Reads and organises your Gmail (never sends or deletes)",
			);
		} finally {
			await view.close();
		}
	});

	it("shows nothing about the read to anyone but the owner", async () => {
		mocks.list.mockResolvedValue({
			items: [
				schedule({
					...gmail,
					grantId: GRANT_ID,
					level: "read",
					canAllow: false,
				}),
			],
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

it("leaves the session grant absent until the owner presses the named tedi button", async () => {
	mocks.list.mockResolvedValue({
		items: [
			schedule({
				...gmail,
				providerId: "tedix-session-activity",
				providerName: "session activity",
				workerName: "CTO",
				toolIds: ["list_agent_session_activity"],
			}),
		],
	});
	mocks.allow.mockResolvedValue({ status: "allowed", grantId: GRANT_ID });
	const view = await mount();
	try {
		expect(mocks.allow).not.toHaveBeenCalled();
		const button = view.button(
			"Let the CTO tedi read my session activity (read-only)",
		);
		expect(button).toBeDefined();
		await act(async () => button!.click());
		await settle();
		expect(mocks.allow).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: RESOURCE_ID,
		});
	} finally {
		await view.close();
	}
});

it("tells a refused run in plain words and keeps the exception under Technical details", async () => {
	const refused =
		"Error: WorkflowToolsRefused: WORKFLOW_TOOLS_REFUSED: a tool capability in step gather was wholly refused";
	mocks.list.mockResolvedValue({
		items: [
			{
				...schedule({
					providerId: "tedix-session-activity",
					providerName: "session activity",
					workerName: "CTO",
					toolIds: ["list_agent_session_activity"],
					grantId: null,
					level: "none" as const,
					canAllow: true,
				}),
				lastRun: {
					runId: "run-refused",
					status: "failed" as const,
					startedAt: "2026-07-01T11:17:00.000Z",
					completedAt: "2026-07-01T11:19:00.000Z",
					cards: null,
					summary: null,
					error: refused,
				},
			},
		],
	});
	const view = await mount();
	try {
		expect(
			view.node.querySelector("[data-schedule-last-run]")?.textContent,
		).toBe(
			"Last run failed: The run could not read session activity because " +
				"access was refused. You can allow it below.",
		);
		const details = view.button("Technical details");
		expect(details).toBeDefined();
		expect(details?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => details!.click());
		expect(details?.getAttribute("aria-expanded")).toBe("true");
		expect(
			view.node.querySelector("[data-schedule-last-run-details]")?.textContent,
		).toContain(refused);
	} finally {
		await view.close();
	}
});

describe("linking skills to the workspace", () => {
	it("shows who runs each linked skill and unlinks it", async () => {
		mocks.list
			.mockResolvedValueOnce({ items: [schedule(null)] })
			.mockResolvedValue({ items: [] });
		mocks.unlink.mockResolvedValue({ removed: true });
		const view = await mount();
		try {
			expect(
				view.node.querySelector("[data-schedule-runs-by]")?.textContent,
			).toBe("Run by Inbox Tedi · Automation");
			const unlink = view.node.querySelector<HTMLButtonElement>(
				'button[aria-label="Unlink Inbox cards from this workspace"]',
			);
			await act(async () => unlink!.click());
			await settle();
			expect(mocks.unlink).toHaveBeenCalledWith({
				workspaceId: WORKSPACE_ID,
				skillId: "skill-inbox",
			});
			expect(view.node.textContent).toContain(
				"No skills run this workspace yet",
			);
		} finally {
			await view.close();
		}
	});

	it("links the suggested skills in one step, and any other skill by search", async () => {
		mocks.list.mockResolvedValue({ items: [] });
		mocks.linkFactorySkills.mockImplementation(
			async ({ dryRun }: { dryRun: boolean }) => ({
				dryRun,
				items: [
					{
						skillId: "skill-research",
						name: "Daily research",
						reason: "factory_project",
						status: dryRun ? "would_link" : "linked",
					},
				],
			}),
		);
		mocks.skills.mockResolvedValue({
			entries: [
				{ id: "skill-digest", title: "Weekly digest", description: "Sums up" },
			],
			total: 1,
		});
		mocks.link.mockResolvedValue({
			resourceId: RESOURCE_ID,
			created: true,
		});
		const view = await mount();
		try {
			await act(async () => view.button("Link skill")!.click());
			await settle();
			const dialog = document.body.querySelector(
				"[data-workspace-skill-link-dialog]",
			);
			expect(dialog?.textContent).toContain("Daily research");
			expect(dialog?.textContent).toContain(
				"Its factory belongs to this workspace",
			);
			const linkIt = [...dialog!.querySelectorAll("button")].find(
				(button) => button.textContent === "Link it",
			);
			await act(async () => linkIt!.click());
			await settle();
			expect(mocks.linkFactorySkills).toHaveBeenCalledWith({
				workspaceId: WORKSPACE_ID,
				dryRun: false,
			});
			const linkDigest = dialog!.querySelector<HTMLButtonElement>(
				'button[aria-label="Link Weekly digest"]',
			);
			await act(async () => linkDigest!.click());
			await settle();
			expect(mocks.link).toHaveBeenCalledWith({
				workspaceId: WORKSPACE_ID,
				skillId: "skill-digest",
			});
		} finally {
			await view.close();
		}
	});
});
