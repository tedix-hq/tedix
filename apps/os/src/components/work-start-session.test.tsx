import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { osQuery, userProfileQueryOptions } from "@/lib/os-query-options";
import { WorkExecutorChoice } from "./work-dispatch-app";

const id = "00000001-0000-4000-8000-000000000001";

function render({
	owner = true,
	active = false,
	disposition = "accepted",
} = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "owner",
	} as never);
	client.setQueryData(
		osQuery.workItems.listAttempts.queryOptions({ input: { id, limit: 1 } })
			.queryKey,
		{
			data: active
				? [
						{
							id: "00000002-0000-4000-8000-000000000002",
							runtimeState: "running",
							finishedAt: null,
							heartbeatAt: "2026-10-18T17:00:00Z",
							outcome: null,
						},
					]
				: [],
			nextCursor: null,
		} as never,
	);
	const item = {
		id,
		version: 3,
		disposition,
		accountableOwnerType: "user",
		accountableOwnerId: owner ? "owner" : "another-user",
		metadata: { executor: "claude-code", laneDispatch: { state: "ready" } },
	} as unknown as WorkItem;
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<WorkExecutorChoice item={item} />
		</QueryClientProvider>,
	);
	client.clear();
	return new DOMParser().parseFromString(html, "text/html");
}

describe("Start session", () => {
	it("offers the owner a start action for accepted local Work", () => {
		const doc = render();
		const button = [...doc.querySelectorAll("button")].find(
			(row) => row.textContent === "Start session",
		);
		expect(button).toBeDefined();
		expect(button?.hasAttribute("disabled")).toBe(false);
		expect(doc.body.textContent).toContain("Waiting for a connected Mac.");
	});
	it("does not offer a start action for another owner's Work or proposed Work", () => {
		expect(render({ owner: false }).body.textContent).not.toContain(
			"Start session",
		);
		expect(render({ disposition: "proposed" }).body.textContent).not.toContain(
			"Start session",
		);
	});
	it("shows the observed Attempt and prevents starting a duplicate live session", () => {
		const doc = render({ active: true });
		const button = [...doc.querySelectorAll("button")].find(
			(row) => row.textContent === "Start session",
		);
		expect(button?.hasAttribute("disabled")).toBe(true);
		expect(doc.body.textContent).toContain("Attempt 00000002 · running");
		expect(doc.body.textContent).toContain("Last update");
	});
});
