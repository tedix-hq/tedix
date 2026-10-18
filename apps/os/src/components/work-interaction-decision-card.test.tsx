import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { workInteractionDetailQueryOptions } from "@/lib/os-query-options";
import { WorkInteractionDecisionCard } from "./work-interaction-decision-card";
import { DecisionAttentionContext } from "./decision-attention-context";

const { get, respond } = vi.hoisted(() => ({
	get: vi.fn(() => new Promise<never>(() => {})),
	respond: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workInteractions"
					? new Proxy(target.workInteractions, {
							get: (interactions, name) =>
								name === "get"
									? get
									: name === "respond"
										? respond
										: Reflect.get(interactions, name),
						})
					: Reflect.get(target, key),
		}),
	};
});
vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));

let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	vi.clearAllMocks();
});

const preview = WorkInteractionInboxRowSchema.parse({
	request: {
		id: "11111111-1111-4111-8111-111111111111",
		orgId: "22222222-2222-4222-8222-222222222222",
		workItemId: null,
		caseId: null,
		projectId: null,
		creatorSessionId: null,
		state: "open",
		requestedAt: "2026-10-18T08:00:00Z",
		dueAt: null,
		expiresAt: null,
		resolvedAt: null,
		metadata: {},
		subject: "Review the supplier reply?",
		prompt:
			"The supplier offered delivery on Tuesday. Please review the proposal.",
		kind: "question",
		version: 3,
		creatorType: "user",
		creatorId: "fictional-asker",
		requestedFromType: "user",
		requestedFromId: "fictional-person",
	},
	effectiveState: "open",
	canRespond: true,
	canCancel: false,
	workItem: null,
	responseCount: 0,
});

it("shows the authorized inbox proposal before details, without caching invented details or enabling a decision", async () => {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const attention = vi.fn();
	const render = (requestId = preview.request.id) =>
		root.render(
			<QueryClientProvider client={client}>
				<DecisionAttentionContext.Provider value={attention}>
					<WorkInteractionDecisionCard
						requestId={requestId}
						preview={preview}
					/>
				</DecisionAttentionContext.Provider>
			</QueryClientProvider>,
		);
	await act(async () => render());
	expect(host.textContent).toContain(preview.request.subject);
	expect(host.textContent).toContain(preview.request.prompt);
	expect(host.querySelector("input")).toBeNull();
	expect(host.querySelectorAll("[data-decision-actions] button")).toHaveLength(
		0,
	);
	expect(attention).not.toHaveBeenCalled();
	const key = workInteractionDetailQueryOptions(preview.request.id).queryKey;
	expect(client.getQueryData(key)).toBeUndefined();
	expect(respond).not.toHaveBeenCalled();
	await act(async () => {
		client.setQueryData(key, {
			request: preview.request,
			effectiveState: "open",
			canRespond: true,
			canCancel: false,
			latestDraft: {
				id: "33333333-3333-4333-8333-333333333333",
				body: "Tuesday works for us.",
				rationale: "The date fits the plan.",
				drafterId: "fictional-tedi",
				drafterName: "Supply",
				createdAt: "2026-10-18T08:01:00Z",
				turnType: "reply",
				delivery: "review",
			},
			responses: { data: [], hasMore: false, nextCursor: null },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(host.querySelector("input")?.disabled).toBe(false);
	expect(host.querySelector("input")?.value).toBe("Tuesday works for us.");
	expect(attention).toHaveBeenCalledTimes(1);
	await act(async () => render("44444444-4444-4444-8444-444444444444"));
	expect(host.textContent).not.toContain(preview.request.prompt);
	expect(host.querySelector('[aria-label="Loading request"]')).not.toBeNull();
});
