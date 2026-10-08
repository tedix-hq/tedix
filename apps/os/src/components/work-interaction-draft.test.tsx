import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	membersListQueryOptions,
	tediRosterQueryOptions,
	workExternalPrincipalsQueryOptions,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	draftAnswerMetadata,
	editRatio,
	InteractionDraftReply,
	isAutoDelivered,
	latestDraftOf,
} from "./work-interaction-draft";
import { WorkInteractionPage } from "./work-operations-pages";

const { respond } = vi.hoisted(() => ({
	// Never settles, so success invalidation never refetches over the network.
	respond: vi.fn((_input: unknown) => new Promise<never>(() => {})),
}));
vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	const interactions = new Proxy(actual.osApi.workInteractions, {
		get: (target, key) =>
			key === "respond" ? respond : Reflect.get(target, key),
	});
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workInteractions" ? interactions : Reflect.get(target, key),
		}),
	};
});

const DRAFT = {
	id: "abababab-abab-4bab-8bab-abababababab",
	body: "Yes, tidy the docs and push.",
	rationale: "Docs drift after a push.",
	drafterId: "33333333-3333-4333-8333-333333333333",
	createdAt: "2026-10-06T00:00:00Z",
	turnType: "approve",
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
	if (root) act(() => root?.unmount());
	root = undefined;
	respond.mockClear();
});

function click(container: HTMLElement, label: string) {
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === label,
	);
	if (!button) throw new Error(`No ${label} button`);
	act(() => button.click());
}

describe("tedi-drafted replies", () => {
	it("reads latestDraft defensively", () => {
		expect(latestDraftOf({ latestDraft: DRAFT })?.id).toBe(DRAFT.id);
		expect(latestDraftOf({ latestDraft: null })).toBeNull();
		expect(latestDraftOf({})).toBeNull();
		expect(latestDraftOf({ latestDraft: { id: "x", body: " " } })).toBeNull();
		expect(latestDraftOf(null)).toBeNull();
	});

	it("measures edits like the CLI", () => {
		expect(editRatio("same", " same ")).toBe(0);
		expect(editRatio("kitten", "sitting")).toBe(0.429);
		expect(editRatio("abc", "")).toBe(1);
		const draft = latestDraftOf({ latestDraft: DRAFT })!;
		expect(draftAnswerMetadata(draft, DRAFT.body)).toEqual({
			draftId: DRAFT.id,
			draftOutcome: "accepted",
			editRatio: 0,
			source: "os-inbox",
		});
		expect(
			draftAnswerMetadata(draft, "Yes, tidy the docs and push it.")
				.draftOutcome,
		).toBe("edited");
		expect(
			draftAnswerMetadata(draft, "No, revert the deploy first.").draftOutcome,
		).toBe("replaced");
	});

	it("shows the codex delivery hint only for Codex", () => {
		const draft = latestDraftOf({ latestDraft: DRAFT })!;
		const codex = renderToStaticMarkup(
			<InteractionDraftReply
				draft={draft}
				drafterName="Docs"
				host="codex"
				pending={false}
				onAnswer={() => {}}
			/>,
		);
		expect(codex).toContain("Recommended answer from Docs");
		expect(codex).toContain("Docs drift after a push.");
		expect(codex).toContain("Codex receives your answer with its next prompt");
		expect(
			renderToStaticMarkup(
				<InteractionDraftReply
					draft={draft}
					drafterName="Docs"
					host="claude-code"
					pending={false}
					onAnswer={() => {}}
				/>,
			),
		).not.toContain("Codex");
	});

	it("an auto draft shows as sent, without Accept, and an override replaces it", () => {
		const draft = latestDraftOf({
			latestDraft: { ...DRAFT, delivery: "auto" },
		})!;
		expect(isAutoDelivered(draft)).toBe(true);
		const onAnswer = vi.fn();
		const container = document.createElement("div");
		root = createRoot(container);
		act(() =>
			root?.render(
				<InteractionDraftReply
					draft={draft}
					drafterName="Docs"
					pending={false}
					onAnswer={onAnswer}
				/>,
			),
		);
		expect(container.textContent).toContain("Sent automatically by Docs");
		expect(container.textContent).toContain(DRAFT.body);
		const labels = [...container.querySelectorAll("button")].map((button) =>
			button.textContent?.trim(),
		);
		expect(labels).not.toContain("Send this");
		expect(labels).not.toContain("Write my own");
		const override = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Override",
		)!;
		expect(override.disabled).toBe(true);
		const textarea = container.querySelector("textarea")!;
		expect(textarea.value).toBe("");
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		act(() => {
			setter.call(textarea, "No, leave the docs for now.");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		click(container, "Override");
		expect(onAnswer).toHaveBeenCalledWith(
			"No, leave the docs for now.",
			expect.objectContaining({
				draftId: DRAFT.id,
				draftOutcome: "replaced",
				source: "os-inbox",
			}),
		);
	});

	it("review, absent or unknown delivery keeps Accept", () => {
		for (const delivery of ["review", undefined, null, "later"]) {
			const draft = latestDraftOf({ latestDraft: { ...DRAFT, delivery } })!;
			expect(isAutoDelivered(draft)).toBe(false);
			const html = renderToStaticMarkup(
				<InteractionDraftReply
					draft={draft}
					drafterName="Docs"
					pending={false}
					onAnswer={() => {}}
				/>,
			);
			expect(html).toContain("Send this");
			expect(html).not.toContain("Sent automatically");
		}
	});

	it("edit prefills the draft and submits the computed outcome", () => {
		const draft = latestDraftOf({ latestDraft: DRAFT })!;
		const onAnswer = vi.fn();
		const container = document.createElement("div");
		root = createRoot(container);
		act(() =>
			root?.render(
				<InteractionDraftReply
					draft={draft}
					drafterName="Docs"
					pending={false}
					onAnswer={onAnswer}
				/>,
			),
		);
		click(container, "Write my own");
		const textarea = container.querySelector("textarea")!;
		expect(textarea.value).toBe(DRAFT.body);
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		act(() => {
			setter.call(textarea, "Yes, tidy the docs and push it.");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		click(container, "Send edited reply");
		expect(onAnswer).toHaveBeenCalledWith(
			"Yes, tidy the docs and push it.",
			expect.objectContaining({ draftId: DRAFT.id, draftOutcome: "edited" }),
		);
	});

	it("Accept on the detail page answers with the draft and cites it", async () => {
		const requestId = "9b3cbf40-9b22-46c9-8913-c9643bf9a7be";
		const orgId = "22222222-2222-4222-8222-222222222222";
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData<unknown>(
			workInteractionDetailQueryOptions(requestId).queryKey,
			{
				request: {
					id: requestId,
					orgId,
					workItemId: null,
					caseId: null,
					projectId: "66666666-6666-4666-8666-666666666666",
					creatorSessionId: null,
					state: "open",
					requestedAt: "2026-10-03T14:00:00Z",
					dueAt: null,
					expiresAt: null,
					resolvedAt: null,
					metadata: { host: "codex", schema: "tedix.decision-capture.v1" },
					subject: "repo · codex waiting: Tidy the docs?",
					kind: "question",
					version: 3,
					creatorType: "user",
					creatorId: "user-1",
					requestedFromType: "user",
					requestedFromId: "user-1",
					prompt: "Pushed. Tidy the docs too?",
				},
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				latestDraft: DRAFT,
				responses: { data: [], hasMore: false, nextCursor: null },
			},
		);
		client.setQueryData<unknown>(tediRosterQueryOptions(100).queryKey, {
			data: [],
		});
		client.setQueryData<unknown>(
			membersListQueryOptions({ organizationId: orgId, limit: 100, offset: 0 })
				.queryKey,
			{ data: [] },
		);
		client.setQueryData<unknown>(
			workExternalPrincipalsQueryOptions(orgId).queryKey,
			[],
		);
		const routeRoot = createRootRoute();
		const detail = createRoute({
			getParentRoute: () => routeRoot,
			path: "/work/interactions/$requestId",
			component: () => <WorkInteractionPage requestId={requestId} />,
		});
		const router = createRouter({
			routeTree: routeRoot.addChildren([detail]),
			history: createMemoryHistory({
				initialEntries: [`/work/interactions/${requestId}`],
			}),
		});
		await router.load();
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			),
		);
		expect(container.textContent).toContain("Recommended answer from");
		expect(container.textContent).toContain(DRAFT.body);
		expect(container.textContent).toContain("Codex receives your answer");
		await act(async () => click(container, "Send this"));
		expect(respond).toHaveBeenCalledWith({
			requestId,
			expectedRequestVersion: 3,
			responseKind: "answer",
			body: DRAFT.body,
			resolvesRequest: true,
			metadata: {
				draftId: DRAFT.id,
				draftOutcome: "accepted",
				editRatio: 0,
				source: "os-inbox",
			},
		});
	});
});
