import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const reads = vi.hoisted(() => ({
	fn: vi.fn<(projectId: string) => Promise<unknown>>(),
}));

vi.mock("@/lib/os-query-options", () => ({
	workProjectContributorsQueryOptions: (projectId: string) => ({
		queryKey: ["project-contributors", projectId],
		queryFn: () => reads.fn(projectId),
	}),
}));

import { WorkProjectContributors } from "./work-project-contributors";

const PROJECT_ID = "00000076-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "00000076-0000-4000-8000-000000000002";
const WORK_ITEM_ID = "00000070-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-12T12:00:00.000Z");
const ago = (minutes: number) =>
	new Date(NOW.getTime() - minutes * 60_000).toISOString();

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const session = (key: string, overrides: Record<string, unknown> = {}) => ({
	sessionKey: key,
	harness: "claude-code",
	name: `${key} name`,
	state: "working",
	summary: "Running tests",
	lastActivityAt: ago(5),
	workItemId: null,
	workItemTitle: null,
	attempts: 0,
	...overrides,
});

function newClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
}

function render(contributors: unknown[] | undefined) {
	const client = newClient();
	if (contributors)
		client.setQueryData(["project-contributors", PROJECT_ID], {
			contributors,
		} as never);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkProjectContributors projectId={PROJECT_ID} now={NOW} />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

async function mount() {
	const client = newClient();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const show = async (id: string) => {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkProjectContributors projectId={id} now={NOW} />
				</QueryClientProvider>,
			),
		);
		await settle();
	};
	await show(PROJECT_ID);
	return {
		host,
		show,
		cleanup: async () => {
			await act(async () => root.unmount());
			host.remove();
			client.clear();
		},
		retry: () => {
			const button = [...host.querySelectorAll("button")].find(
				(candidate) =>
					candidate.getAttribute("aria-label") === "Retry loading contributors",
			);
			if (!button) throw new Error("Retry button missing");
			return button;
		},
		refetch: async () => {
			await act(async () =>
				client.refetchQueries({ queryKey: ["project-contributors"] }),
			);
			await settle();
		},
	};
}

describe("Project contributors", () => {
	it("renders one row per session with state, Work item link and attempts", () => {
		const doc = render([
			session("claude-code:session-1", {
				name: "billing · invoices",
				workItemId: WORK_ITEM_ID,
				workItemTitle: "Rebuild the invoice export",
				attempts: 2,
			}),
			session("codex:session-2", {
				harness: "codex",
				name: "docs · refresh",
				state: "ended",
				summary: "Session closed.",
				lastActivityAt: ago(60 * 3),
			}),
		]);
		const rows = [...doc.querySelectorAll("li[data-contributor-state]")];
		expect(
			rows.map((row) => row.getAttribute("data-contributor-state")),
		).toEqual(["working", "ended"]);
		expect(rows[0]?.textContent).toContain("Local session (Claude)");
		expect(rows[0]?.textContent).toContain("Running");
		expect(rows[0]?.textContent).toContain("2 attempts");
		expect(rows[0]?.textContent).toContain("5m ago");
		expect(
			rows[0]?.querySelector(`a[href="/work/items/${WORK_ITEM_ID}"]`)
				?.textContent,
		).toBe("Rebuild the invoice export");
		expect(rows[1]?.textContent).toContain("Codex");
		expect(rows[1]?.textContent).toContain("Ended");
		expect(rows[1]?.textContent).not.toContain("attempt");
		expect(rows[1]?.querySelector("a")).toBeNull();
		expect(doc.body.textContent).toContain("Contributors (2)");
	});

	it("explains when no session has worked on the project", () => {
		const doc = render([]);
		expect(doc.body.textContent).toContain(
			"No sessions have worked on this project yet.",
		);
		expect(doc.querySelector("li")).toBeNull();
	});
});

describe("Project contributors read recovery", () => {
	it("shows a cold failure with a retry and never says no sessions", async () => {
		reads.fn.mockReset().mockRejectedValue(new Error("read down"));
		const view = await mount();
		try {
			expect(view.host.textContent).toContain("Contributors unavailable");
			expect(view.host.textContent).not.toContain("No sessions have worked");
			reads.fn.mockResolvedValue({ contributors: [session("a:1")] });
			await act(async () => view.retry().click());
			await settle();
			expect(
				view.host.querySelectorAll("li[data-contributor-state]"),
			).toHaveLength(1);
			expect(view.host.textContent).toContain("Contributors (1)");
			expect(view.host.querySelector("[data-contributors-stale]")).toBeNull();
		} finally {
			await view.cleanup();
		}
	});

	it("keeps cached rows but marks them stale and drops the count when a refresh fails", async () => {
		reads.fn
			.mockReset()
			.mockResolvedValueOnce({
				contributors: [session("a:1"), session("b:2", { state: "ended" })],
			})
			.mockRejectedValue(new Error("refresh down"));
		const view = await mount();
		try {
			expect(view.host.textContent).toContain("Contributors (2)");
			await view.refetch();
			expect(
				view.host.querySelector("[data-contributors-stale]"),
			).not.toBeNull();
			expect(view.host.textContent).toContain("could not be refreshed");
			expect(view.host.textContent).toContain("may be out of date");
			expect(view.host.textContent).not.toContain("Contributors (2)");
			expect(
				[...view.host.querySelectorAll("li[data-contributor-state]")].map(
					(row) => row.getAttribute("data-contributor-state"),
				),
			).toEqual(["working", "ended"]);
			reads.fn.mockResolvedValue({ contributors: [session("a:1")] });
			await act(async () => view.retry().click());
			await settle();
			expect(view.host.querySelector("[data-contributors-stale]")).toBeNull();
			expect(view.host.textContent).toContain("Contributors (1)");
		} finally {
			await view.cleanup();
		}
	});

	it("does not call an unverified empty result a confirmed empty project", async () => {
		reads.fn
			.mockReset()
			.mockResolvedValueOnce({ contributors: [] })
			.mockRejectedValue(new Error("refresh down"));
		const view = await mount();
		try {
			expect(view.host.textContent).toContain("No sessions have worked");
			await view.refetch();
			expect(view.host.textContent).toContain("could not be refreshed");
			expect(view.host.textContent).not.toContain("No sessions have worked");
			expect(view.host.textContent).not.toContain("Contributors (0)");
		} finally {
			await view.cleanup();
		}
	});

	it("fences duplicate retries while one read is in flight", async () => {
		let release: (value: unknown) => void = () => {};
		reads.fn
			.mockReset()
			.mockResolvedValueOnce({ contributors: [session("a:1")] })
			.mockRejectedValueOnce(new Error("refresh down"));
		const view = await mount();
		try {
			await view.refetch();
			expect(reads.fn).toHaveBeenCalledTimes(2);
			reads.fn.mockImplementation(
				() => new Promise((resolve) => (release = resolve)),
			);
			const button = view.retry();
			await act(async () => {
				button.click();
				button.click();
			});
			expect(reads.fn).toHaveBeenCalledTimes(3);
			expect(view.retry().hasAttribute("disabled")).toBe(true);
			expect(view.host.textContent).toContain("Retrying");
			await act(async () => release({ contributors: [session("a:1")] }));
			await settle();
			expect(view.host.querySelector("[data-contributors-stale]")).toBeNull();
			expect(view.host.textContent).toContain("Contributors (1)");
		} finally {
			await view.cleanup();
		}
	});

	it("reads the new project after the project id changes", async () => {
		reads.fn
			.mockReset()
			.mockResolvedValueOnce({ contributors: [session("a:1")] })
			.mockRejectedValueOnce(new Error("other project down"));
		const view = await mount();
		try {
			expect(view.host.textContent).toContain("Contributors (1)");
			await view.show(OTHER_PROJECT_ID);
			expect(reads.fn).toHaveBeenLastCalledWith(OTHER_PROJECT_ID);
			expect(view.host.textContent).toContain("Contributors unavailable");
			expect(view.host.querySelector("li[data-contributor-state]")).toBeNull();
		} finally {
			await view.cleanup();
		}
	});
});
