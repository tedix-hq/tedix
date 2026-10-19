import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WorkItemCommentComposer } from "./work-item-comment-composer";

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	osApi: { workItems: { addComment: add } },
}));
afterEach(() => add.mockReset());

it("posts one comment, preserves a denied draft and clears it only after success", async () => {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkItemCommentComposer itemId="task" />
				</QueryClientProvider>,
			),
		);
		const textarea = host.querySelector("textarea")!;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		await act(async () => {
			setter.call(textarea, "Delegated to Codex yesterday.");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		add.mockRejectedValueOnce(new Error("Access denied"));
		await act(async () => {
			host
				.querySelector("form")!
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(add).toHaveBeenCalledExactlyOnceWith({
			id: "task",
			body: "Delegated to Codex yesterday.",
		});
		expect(textarea.value).toBe("Delegated to Codex yesterday.");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"Access denied",
		);
		add.mockResolvedValueOnce({ id: "comment" });
		await act(async () => {
			host
				.querySelector("form")!
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(add).toHaveBeenCalledTimes(2);
		expect(textarea.value).toBe("");
	} finally {
		act(() => root.unmount());
		host.remove();
		client.clear();
	}
});
