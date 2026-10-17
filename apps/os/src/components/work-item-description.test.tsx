import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { osQuery, workItemDetailQueryOptions } from "@/lib/os-query-options";
import { workChecklist } from "@/lib/work-detail";
import { WorkItemDescription } from "./work-item-description";

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	const workItems = new Proxy(actual.osApi.workItems, {
		get: (target, key) =>
			key === "addComment" ? add : Reflect.get(target, key),
	});
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workItems" ? workItems : Reflect.get(target, key),
		}),
	};
});

const id = "11111111-1111-4111-8111-111111111111";
const description =
	"## Plan\n- [ ] Write the brief\n  - Supporting notes\n- [x] Choose a date\n\nhttps://app.notion.com/p/22222222222242228222222222222222\nGmail thread: 1a10ba56c82bc95b — Team catch-up";
const item = { id, description };

afterEach(() => add.mockReset());

function setup() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData<unknown>(
		osQuery.workItems.listWorkItemSources.queryOptions({
			input: { workItemId: id, limit: 100 },
		}).queryKey,
		{
			data: [
				{
					externalUrl:
						"https://app.notion.com/p/22222222222242228222222222222222",
					title: "Discovery meeting notes",
				},
			],
		},
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	return {
		client,
		host,
		root,
		close: () => {
			act(() => root.unmount());
			host.remove();
			client.clear();
		},
	};
}

describe("Work description", () => {
	it("renders real headings, titled links and checkboxes with nested content", async () => {
		const { client, host, root, close } = setup();
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<WorkItemDescription item={item} comments={[]} />
					</QueryClientProvider>,
				),
			);
			expect(host.querySelector("h2")?.textContent).toBe("Plan");
			expect(host.textContent).toContain("Supporting notes");
			expect(host.textContent).toContain("Discovery meeting notes");
			expect(host.textContent).toContain("Team catch-up");
			expect(host.textContent).not.toContain("1a10ba56c82bc95b");
			expect(host.textContent).not.toContain("https://");
			const boxes = host.querySelectorAll<HTMLInputElement>(
				'input[type="checkbox"]',
			);
			expect(boxes).toHaveLength(2);
			expect(boxes[0]?.disabled).toBe(false);
			expect(boxes[1]?.checked).toBe(true);
		} finally {
			close();
		}
	});

	it("resolves linked Work titles and keeps unavailable sources readable", async () => {
		const { client, host, root, close } = setup();
		const linkedId = "44444444-4444-4444-8444-444444444444";
		client.setQueryData<unknown>(
			workItemDetailQueryOptions(linkedId).queryKey,
			{ workItem: { title: "Arrange the customer visit" } },
		);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<WorkItemDescription
							item={item}
							comments={[]}
							content={`https://app.notion.com/p/33333333333343338333333333333333\n\n[Linked task](/work/items/${linkedId})\n\n[Unsafe](javascript:alert(1))`}
							interactive={false}
						/>
					</QueryClientProvider>,
				),
			);
			expect(host.textContent).toContain("Notion page");
			expect(host.textContent).toContain("Arrange the customer visit");
			expect(host.textContent).not.toContain(
				"33333333333343338333333333333333",
			);
			expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
		} finally {
			close();
		}
	});

	it("saves the checkbox as a Work update and restores its saved state", async () => {
		const { client, host, root, close } = setup();
		add.mockResolvedValue({});
		const key = workChecklist(description)[0]!.key;
		const comments = [{ metadata: { workChecklist: { key, checked: true } } }];
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<WorkItemDescription item={item} comments={[]} />
					</QueryClientProvider>,
				),
			);
			await act(async () =>
				host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
			);
			expect(add).toHaveBeenCalledWith({
				id,
				body: "Completed: Write the brief",
				metadata: { workChecklist: { key, checked: true } },
			});
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<WorkItemDescription item={item} comments={comments} />
					</QueryClientProvider>,
				),
			);
			expect(
				host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
			).toBe(true);
			expect(item.description).toBe(description);
		} finally {
			close();
		}
	});

	it("leaves a failed save unchecked and explains how to retry", async () => {
		const { client, host, root, close } = setup();
		add.mockRejectedValue(new Error("Unavailable"));
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<WorkItemDescription item={item} comments={[]} />
					</QueryClientProvider>,
				),
			);
			await act(async () =>
				host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
			);
			await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
			expect(host.textContent).toContain("Could not save this checkbox");
			expect(
				host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
			).toBe(false);
		} finally {
			close();
		}
	});
});
