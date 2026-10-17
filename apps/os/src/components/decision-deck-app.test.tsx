import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import { DecisionDeckApp } from "./decision-deck-app";
import {
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";

vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("./work-decision-stack", () => ({
	ApprovalDecisionCard: () => <p>Live approval</p>,
}));
vi.mock("./work-interaction-decision-card", () => ({
	WorkInteractionDecisionCard: () => <p>Live request</p>,
}));
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	vi.restoreAllMocks();
});
async function mount() {
	client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	for (const state of ["open", "resolved"] as const)
		client.setQueryData(
			osQuery.workInteractions.listInbox.queryOptions({
				input: { projectId: undefined, limit: 50, states: [state] },
			}).queryKey,
			{
				data: [],
				hasMore: false,
				nextCursor: null,
				observedAt: "2026-10-17T10:00:00.000Z",
			},
		);
	client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
		data: [],
		pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
	});
	client.setQueryData(projectListQueryOptions(100).queryKey, {
		data: [],
		pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
	});
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "fictional-acme-user",
		email: "morgan@example.com",
		name: "Morgan",
		avatarUrl: null,
		revision: 0,
		updatedAt: null,
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DecisionDeckApp
					config={DecisionDeckConfigSchema.parse({
						version: 1,
						examples: DECISION_DECK_EXAMPLES,
					})}
				/>
			</QueryClientProvider>,
		),
	);
}
async function click(text: string) {
	const button = [...host.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === text,
	);
	expect(button).toBeDefined();
	await act(async () => button!.click());
}
async function key(key: string) {
	await act(async () =>
		host
			.querySelector("section")!
			.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
	);
}

it("browses all six practice kinds, explains the choice and never submits a real decision", async () => {
	const respond = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Unexpected network in practice"));
	await mount();
	await click("Try examples");
	expect(host.textContent).toContain("Practice only");
	expect(
		host.querySelector('[aria-label="Decision kind"]')?.textContent,
	).toContain("All kinds");
	expect(
		host.querySelector('[aria-label="Decision project"]')?.textContent,
	).toContain("All projects");
	expect(
		host.querySelector('[aria-label="Decision urgency"]')?.textContent,
	).toContain("Any urgency");
	for (const example of DECISION_DECK_EXAMPLES) {
		expect(host.textContent).toContain(example.proposal);
		expect(host.textContent).toContain(`${example.classId}: 0/5`);
		await key("j");
	}
	await click("Why this?");
	expect(host.textContent).toContain(
		"Prefer a bounded next step with evidence",
	);
	await key("ArrowLeft");
	expect(host.textContent).not.toContain("1 practice choices");
	await click("wrong tone");
	expect(host.textContent).toContain("1 practice choices");
	expect(respond).not.toHaveBeenCalled();
});

it("requires confirmation after a consequential right swipe or keyboard approval", async () => {
	const respond = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Unexpected network in practice"));
	await mount();
	await click("Try examples");
	await key("ArrowRight");
	expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
	expect(host.textContent).not.toContain("1 practice choices");
	expect(respond).not.toHaveBeenCalled();
});
