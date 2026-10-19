import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { projectListQueryOptions } from "@/lib/os-query-options";
import { WorkItemCreateForm } from "./work-item-create";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	return {
		...actual,
		osApi: {
			projects: { list: actual.osApi.projects.list },
			workItems: { create },
		},
	};
});
afterEach(() => create.mockReset());

it("preserves a failed proposal draft and returns the canonical receipt after success", async () => {
	const projectId = "11111111-1111-4111-8111-111111111111";
	const itemId = "22222222-2222-4222-8222-222222222222";
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	client.setQueryData(projectListQueryOptions(100, { search: "" }).queryKey, {
		data: [
			{
				id: projectId,
				name: "Cedar project",
				orgId: "33333333-3333-4333-8333-333333333333",
				key: "CEDAR",
				description: null,
				status: "active",
				leadTediId: null,
				ownerUserId: null,
				objectiveId: null,
				targetDate: null,
				metadata: null,
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: null,
				archivedAt: null,
			},
		],
		pagination: { hasMore: false, total: 1, limit: 100, offset: 0 },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkItemCreateForm projectId={projectId} />
				</QueryClientProvider>,
			),
		);
		const title = host.querySelector('input[id$="-title"]') as HTMLInputElement;
		const description = host.querySelector("textarea")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(title, "Cedar test finding");
			title.dispatchEvent(new Event("input", { bubbles: true }));
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!.call(description, "Stable key cedar-finding-01");
			description.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const submit = async () =>
			act(async () => {
				host
					.querySelector("form")!
					.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					);
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		create.mockRejectedValueOnce(new Error("Access denied"));
		await submit();
		expect(create).toHaveBeenCalledExactlyOnceWith({
			title: "Cedar test finding",
			description: "Stable key cedar-finding-01",
			projectId,
		});
		expect(title.value).toBe("Cedar test finding");
		expect(description.value).toBe("Stable key cedar-finding-01");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"Access denied",
		);
		create.mockResolvedValueOnce({
			id: itemId,
			title: "Cedar test finding",
			disposition: "proposed",
		});
		await submit();
		expect(create).toHaveBeenCalledTimes(2);
		expect(host.querySelector('[role="status"]')?.textContent).toContain(
			itemId,
		);
		expect(host.querySelector("a")?.getAttribute("href")).toBe(
			`/work/items/${itemId}`,
		);
		expect(host.querySelector("form")).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		client.clear();
	}
});
