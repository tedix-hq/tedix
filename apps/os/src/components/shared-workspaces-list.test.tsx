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

const collaborators = vi.hoisted(() => ({
	access: vi.fn(),
	leave: vi.fn(),
	listShared: vi.fn(),
	dismissShared: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osCollaborators: collaborators,
		osWorkspaces: { workspaces: { list: vi.fn() } },
	},
}));

import { SharedWorkspacesList } from "./shared-workspaces-list";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NEW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPENED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const cleanups: Array<() => void> = [];

async function renderList(): Promise<HTMLElement> {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<SharedWorkspacesList />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await act(async () => {
		for (let tick = 0; tick < 6; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container;
}

function row(container: Element, title: string): HTMLElement {
	const match = [...container.querySelectorAll("li")].find((item) =>
		item.textContent?.includes(title),
	);
	if (!match) throw new Error(`row not found: ${title}`);
	return match;
}

beforeEach(() => {
	for (const mock of Object.values(collaborators)) mock.mockReset();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("Shared with you", () => {
	it("marks a workspace the person was added to and has not opened as New", async () => {
		const recently = new Date(Date.now() - 5 * 60_000).toISOString();
		collaborators.listShared.mockResolvedValue({
			items: [
				{
					workspaceId: NEW_ID,
					title: "Launch plan",
					ownerName: "Robin Fictional",
					firstOpenedAt: recently,
					lastOpenedAt: recently,
					isNew: true,
				},
				{
					workspaceId: OPENED_ID,
					title: "Reddit research",
					ownerName: "Kai Fictional",
					firstOpenedAt: "2020-03-04T10:00:00.000Z",
					lastOpenedAt: "2020-03-04T10:00:00.000Z",
					isNew: false,
				},
			],
		});
		const container = await renderList();

		const fresh = row(container, "Launch plan");
		expect(fresh.querySelector("[data-shared-new]")?.textContent).toBe("New");
		expect(fresh.textContent).toContain("Robin Fictional");
		expect(fresh.textContent).toContain("not opened yet");
		expect(fresh.textContent).not.toContain("opened 5");
		expect(fresh.querySelector("a")?.getAttribute("href")).toBe(
			`/shared/workspace/${NEW_ID}`,
		);

		const opened = row(container, "Reddit research");
		expect(opened.querySelector("[data-shared-new]")).toBeNull();
		expect(opened.textContent).toContain("Kai Fictional · opened");
		expect(container.querySelectorAll("[data-shared-new]")).toHaveLength(1);
	});

	it("shows nothing when no workspace is shared with the person", async () => {
		collaborators.listShared.mockResolvedValue({ items: [] });
		const container = await renderList();
		expect(container.textContent).toBe("");
	});
});
