import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { workInteractionDetailQueryOptions } from "@/lib/os-query-options";
import { WorkInteractionDecisionCard } from "./work-interaction-decision-card";
import { DecisionAttentionContext } from "./decision-attention-context";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";

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
	expect(host.querySelector("textarea")).toBeNull();
	expect(host.querySelectorAll("[data-decision-actions] button")).toHaveLength(
		0,
	);
	expect(attention).not.toHaveBeenCalled();
	const key = workInteractionDetailQueryOptions(preview.request.id).queryKey;
	expect(client.getQueryData(key)).toBeUndefined();
	expect(respond).not.toHaveBeenCalled();
	const visibleBox = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue(new DOMRect(0, 0, 600, 400));
	const visibleTab = vi
		.spyOn(document, "visibilityState", "get")
		.mockReturnValue("visible");
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
	expect(host.querySelector("textarea")?.disabled).toBe(false);
	expect(host.querySelector("textarea")?.value).toBe("Tuesday works for us.");
	expect(attention).toHaveBeenCalledTimes(1);
	await act(async () => render("44444444-4444-4444-8444-444444444444"));
	expect(host.textContent).not.toContain(preview.request.prompt);
	expect(host.querySelector('[aria-label="Loading request"]')).not.toBeNull();
	visibleBox.mockRestore();
	visibleTab.mockRestore();
});

it("renders usable actions and the draft from the same authorized inbox payload while detail is stalled", async () => {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const withDraft = {
		...preview,
		latestDraft: {
			id: "33333333-3333-4333-8333-333333333333",
			body: "Tuesday works for us.",
			rationale: "The date fits.",
			drafterId: "fictional-tedi",
			drafterName: "Supply",
			createdAt: "2026-10-18T08:01:00Z",
			turnType: "reply",
			delivery: "review" as const,
			gate: null,
		},
	};
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkInteractionDecisionCard
					requestId={preview.request.id}
					preview={withDraft}
				/>
			</QueryClientProvider>,
		),
	);
	expect(host.querySelector("textarea")?.value).toBe("Tuesday works for us.");
	expect(host.querySelector("textarea")?.disabled).toBe(false);
	expect(
		host.querySelectorAll("[data-decision-actions] button").length,
	).toBeGreaterThan(0);
	expect(host.textContent).not.toContain("Loading request");
	expect(respond).not.toHaveBeenCalled();
	const answer = host.querySelector("textarea")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(answer, "Keep this preview answer");
		answer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const query = client
		.getQueryCache()
		.find(workInteractionDetailQueryOptions(preview.request.id))!;
	await act(async () => {
		query.setState({
			status: "error",
			fetchStatus: "idle",
			fetchFailureCount: 4,
			error: new Error("unavailable"),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(host.querySelector("textarea")).toBe(answer);
	expect(answer.value).toBe("Keep this preview answer");
	expect(answer.disabled).toBe(false);
	expect(client.getQueryData(query.queryKey)).toBeUndefined();
	expect(host.textContent).toContain("Some items couldn't load");
});

it("retains the last successful detail and typed answer when a refresh fails, then recovers", async () => {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const options = workInteractionDetailQueryOptions(preview.request.id);
	const data = {
		request: preview.request,
		effectiveState: "open" as const,
		canRespond: true,
		canCancel: false,
		latestDraft: null,
		responses: { data: [], nextCursor: null, hasMore: false },
	};
	client.setQueryData(options.queryKey, data);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkInteractionDecisionCard
					requestId={preview.request.id}
					preview={preview}
				/>
			</QueryClientProvider>,
		),
	);
	const answer = host.querySelector("textarea")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(answer, "Friday works");
		answer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		await client
			.fetchQuery({
				...options,
				retry: false,
				staleTime: 0,
				queryFn: async () => {
					throw new Error("backend slow");
				},
			})
			.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(client.getQueryData(options.queryKey)).toEqual(data);
	expect(host.textContent).toContain(preview.request.subject);
	expect(host.querySelector("textarea")).toBe(answer);
	expect(answer.value).toBe("Friday works");
	expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
	expect(host.textContent).toContain("Some items couldn't load");
	await act(async () => {
		await client.fetchQuery({
			...options,
			retry: false,
			staleTime: 0,
			queryFn: async () => data,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(host.textContent).not.toContain("couldn't load");
});

it("shows the complete outbound envelope draft inline before and after details arrive", async () => {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const row = structuredClone(preview);
	row.request.metadata = {
		decisionDeck: {
			...DECISION_DECK_EXAMPLES[0]!,
			preview: { body: "Hello Morgan,\n\nThe exact proposed reply." },
		},
		cardPresentation: {
			version: 2,
			title: "Send the reply?",
			body: "Generated summary only.",
			recommendation: "Review it.",
		},
	};
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkInteractionDecisionCard requestId={row.request.id} preview={row} />
			</QueryClientProvider>,
		),
	);
	expect(host.querySelector(".chat-markdown")?.textContent).toContain(
		"The exact proposed reply.",
	);
	expect(host.querySelector(".fd-proposal-more")).toBeNull();
	await act(async () => {
		client.setQueryData(
			workInteractionDetailQueryOptions(row.request.id).queryKey,
			{
				request: row.request,
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				latestDraft: null,
				responses: { data: [], hasMore: false, nextCursor: null },
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(
		host.querySelector(".fd-proposal-body .chat-markdown")?.textContent,
	).toContain("The exact proposed reply.");
	expect(host.querySelector(".fd-proposal-more")).toBeNull();
});

it("keeps an overdue open Answer card answerable after a curator revision", async () => {
	client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, retry: false, staleTime: Infinity },
		},
	});
	const row = structuredClone(preview);
	row.request.dueAt = "2026-01-01T08:30:00Z";
	row.request.version = 2;
	row.request.subject = "Retire the expired test sign-in request?";
	row.request.metadata = {
		cardContent:
			"The test request is obsolete. Retiring it approves no sign-in.",
	};
	client.setQueryData(
		workInteractionDetailQueryOptions(row.request.id).queryKey,
		{
			request: row.request,
			effectiveState: "open",
			canRespond: true,
			canCancel: false,
			latestDraft: null,
			responses: { data: [], nextCursor: null, hasMore: false },
		},
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkInteractionDecisionCard requestId={row.request.id} />
			</QueryClientProvider>,
		),
	);
	const answer = host.querySelector("textarea");
	expect(answer).not.toBeNull();
	expect(answer?.disabled).toBe(false);
	const button = host.querySelector<HTMLButtonElement>(
		"[data-decision-actions] button",
	);
	expect(button?.textContent).toContain("Answer");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(answer, "Retire this request.");
		answer!.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(button?.disabled).toBe(false);
	expect(respond).not.toHaveBeenCalled();
});

it.each([false, true])(
	"saves a decline with no typed answer (prepared draft: %s)",
	async (withDraft) => {
		client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(
			workInteractionDetailQueryOptions(preview.request.id).queryKey,
			{
				request: preview.request,
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				latestDraft: withDraft
					? {
							id: "33333333-3333-4333-8333-333333333333",
							body: "Tuesday works for us.",
							rationale: "The date fits the plan.",
							drafterId: "fictional-tedi",
							drafterName: "Supply",
							createdAt: "2026-10-18T08:01:00Z",
							turnType: "reply",
							delivery: "review",
						}
					: null,
				responses: { data: [], nextCursor: null, hasMore: false },
			},
		);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		respond.mockResolvedValue({});
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkInteractionDecisionCard requestId={preview.request.id} />
				</QueryClientProvider>,
			),
		);
		const no = host.querySelector<HTMLButtonElement>(
			"[data-decision-intent=reject]",
		);
		expect(no?.textContent).toBe("No / Not needed");
		expect(no?.disabled).toBe(false);
		await act(async () => no!.click());
		expect(respond).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "No / Not needed.",
				resolvesRequest: true,
				metadata: expect.objectContaining({
					decisionChoice: "reject",
					feedbackSignal: "rejected",
				}),
			}),
		);
	},
);
