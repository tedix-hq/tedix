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
import {
	approvalHistoryQueryOptions,
	operationalContextQueryOptions,
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
	recentToolActivityQueryOptions,
	tediNamesQueryOptions,
	workPendingApprovalsQueryOptions,
} from "@/lib/os-query-options";
import { unreadSummaryQueryOptions } from "@/lib/workspace-unread";
import { ActivityPanel, type ActivityTab } from "./approval-notifications";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "8a076b09-73c8-4c07-975a-258c65c36fed";

const request = (id: string, title: string, status = "pending") => ({
	id,
	tediId: "example-worker",
	orgId: "org",
	actionType: "tool_write",
	description: title,
	payload: {},
	status,
	createdAt: "2026-11-08T10:00:00Z",
	expiresAt: "2099-01-01T00:00:00Z",
	resolvedAt: status === "pending" ? null : "2026-11-08T10:05:00Z",
	resolvedBy: status === "pending" ? null : "person",
	resolution: null,
	workflowId: null,
	review: {
		summary: title,
		intent: "tool_write",
		decisionMode: status === "pending" ? "approve_or_reject" : "no_action",
		timeout: { expired: false },
		evidenceRefs: [],
	},
});

let client: QueryClient;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
	// Every read is seeded; anything else must not reach the network.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected request");
		}),
	);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const seed = (key: readonly unknown[], data: unknown) =>
		client.setQueryData<unknown>(key, data);
	seed(operationalContextQueryOptions().queryKey, {
		authority: { role: "admin", permissions: ["os:approve"] },
	});
	seed(workPendingApprovalsQueryOptions().queryKey, { data: [] });
	seed(tediNamesQueryOptions().queryKey, { data: [] });
	seed(unreadSummaryQueryOptions().queryKey, { total: 0, workspaces: [] });
	const empty = { runSet: { runs: [], approvalMirrors: {} } };
	seed(pendingHomeDelegationsQueryOptions().queryKey, empty);
	seed(pendingHomeDelegationsQueryOptions(WORKSPACE).queryKey, empty);
	seed(pendingApprovalsQueryOptions().queryKey, {
		data: [
			request("here", "Rename the launch plan"),
			request("elsewhere", "Send the weekly report"),
		],
	});
	seed(pendingApprovalsQueryOptions(WORKSPACE).queryKey, {
		data: [request("here", "Rename the launch plan")],
	});
	const page = { limit: 50, offset: 0, total: 1, hasMore: false };
	seed(approvalHistoryQueryOptions().queryKey, {
		data: [
			request("past-here", "Archive the old brief", "approved"),
			request("past-elsewhere", "Publish the newsletter", "rejected"),
		],
		pagination: { ...page, total: 2 },
	});
	seed(approvalHistoryQueryOptions(WORKSPACE).queryKey, {
		data: [request("past-here", "Archive the old brief", "approved")],
		pagination: page,
	});
	seed(recentToolActivityQueryOptions().queryKey, { items: [] });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client.clear();
	vi.unstubAllGlobals();
});

async function render(tab: ActivityTab, workspaceId: string | null) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ActivityPanel
					heading={(summary) => <p data-summary="">{summary}</p>}
					onClose={() => {}}
					onTabChange={() => {}}
					tab={tab}
					workspaceId={workspaceId}
				/>
			</QueryClientProvider>,
		),
	);
}

const scopeButton = (name: string) =>
	[...host.querySelectorAll("button")].find(
		(button) => button.textContent === name,
	);

describe("activity panel scope", () => {
	it("starts Needs you on this workspace and switches to everywhere", async () => {
		await render("review", WORKSPACE);
		expect(host.textContent).toContain("Rename the launch plan");
		expect(host.textContent).not.toContain("Send the weekly report");
		expect(host.querySelector("[data-summary]")?.textContent).toBe(
			"1 waiting for your decision in this workspace",
		);
		expect(host.textContent).toContain("1 more waiting elsewhere");
		expect(scopeButton("This workspace")?.getAttribute("aria-pressed")).toBe(
			"true",
		);

		await act(async () => scopeButton("Everywhere")?.click());
		expect(host.textContent).toContain("Rename the launch plan");
		expect(host.textContent).toContain("Send the weekly report");
		expect(host.querySelector("[data-summary]")?.textContent).toBe(
			"2 waiting for your decision",
		);
		expect(scopeButton("Everywhere")?.getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("starts History on this workspace and switches to everywhere", async () => {
		await render("history", WORKSPACE);
		expect(host.textContent).toContain("Archive the old brief");
		expect(host.textContent).not.toContain("Publish the newsletter");
		expect(host.textContent).toContain("requests made in this workspace");
		// Tool calls do not record a workspace, so that filter is not offered.
		expect(scopeButton("Actions")).toBeUndefined();

		await act(async () => scopeButton("Everywhere")?.click());
		expect(host.textContent).toContain("Publish the newsletter");
		expect(scopeButton("Actions")).toBeDefined();
	});

	it.each(["decisions", "actions"] as const)(
		"shows available history while %s are still loading",
		async (pending) => {
			vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
			client.setQueryData<unknown>(recentToolActivityQueryOptions().queryKey, {
				items: [
					{
						timestamp: "2026-11-08T10:05:00Z",
						action: "mcp.tool.execute",
						toolName: "crm.add_note",
						success: true,
						actor: { label: "Example agent" },
						securityDecision: { disposition: "executed" },
					},
				],
			});
			const pendingKey =
				pending === "decisions"
					? approvalHistoryQueryOptions().queryKey
					: recentToolActivityQueryOptions().queryKey;
			client.removeQueries({ queryKey: pendingKey, exact: true });
			await render("history", null);
			expect(host.textContent).toContain(
				pending === "decisions" ? "Add note" : "Archive the old brief",
			);
			expect(host.textContent).toContain(`Loading ${pending}…`);
			expect(host.textContent).not.toContain("No activity yet");
			await act(async () => {
				client.setQueryData<unknown>(
					pendingKey,
					pending === "decisions" ? { data: [] } : { items: [] },
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(host.textContent).not.toContain(`Loading ${pending}…`);
		},
	);

	it("says so when nothing waits in this workspace", async () => {
		client.setQueryData<unknown>(
			pendingApprovalsQueryOptions(WORKSPACE).queryKey,
			{ data: [] },
		);
		await render("review", WORKSPACE);
		expect(host.textContent).toContain(
			"No approvals waiting in this workspace",
		);
		expect(host.textContent).toContain("2 more waiting elsewhere");
	});

	it("offers no switch outside a workspace", async () => {
		await render("review", null);
		expect(scopeButton("This workspace")).toBeUndefined();
		expect(host.textContent).toContain("Send the weekly report");
	});
});
