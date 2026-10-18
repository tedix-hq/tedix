import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WorkInteractionDecisionCard } from "./work-interaction-decision-card";
import { DeckFooterContext } from "./deck-presentation-context";
import { workInteractionDetailQueryOptions } from "@/lib/os-query-options";
import { osApi } from "@/lib/api";
vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: { listEvidence: vi.fn(), previewEvidence: vi.fn() },
		learningFeedback: { model: vi.fn() },
		workScheduler: { listReady: vi.fn() },
		workFleet: { getControlTower: vi.fn() },
		workAgentSessions: { attention: vi.fn(), listRequests: vi.fn() },
		workInteractions: {
			get: vi.fn(),
			listInbox: vi.fn(),
			respond: vi.fn().mockResolvedValue({}),
			cancel: vi.fn(),
		},
	},
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	vi.clearAllMocks();
});
async function mount() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, retry: false, staleTime: Infinity },
		},
	});
	client.setQueryData(workInteractionDetailQueryOptions("request").queryKey, {
		request: {
			id: "request",
			orgId: "11111111-1111-4111-8111-111111111111",
			workItemId: null,
			caseId: null,
			projectId: null,
			requestedFromType: "user",
			requestedFromId: "morgan",
			creatorId: "codex",
			creatorSessionId: null,
			state: "open",
			dueAt: null,
			expiresAt: null,
			resolvedAt: null,
			version: 1,
			kind: "question",
			subject: "Approve test login",
			prompt:
				"Exact test-only operation. This returns a non-delivered test-only link. Prepared args: target=viewer@example.com",
			requestedAt: new Date().toISOString(),
			creatorType: "external_agent",
			metadata: {
				approvalOperation: "tests_write.GenerateMagicLinkForTestUser",
				approvalTarget: "viewer@example.com",
				agentHarness: "codex",
				originChatId: "chat",
			},
		},
		effectiveState: "open",
		canRespond: true,
		canCancel: false,
		responses: { data: [], nextCursor: null, hasMore: false },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DeckFooterContext.Provider value={<button>Later</button>}>
					<WorkInteractionDecisionCard requestId="request" />
				</DeckFooterContext.Provider>
			</QueryClientProvider>,
		),
	);
}
it("renders an actionable approval, keeps raw arguments collapsed and never delegates it", async () => {
	await mount();
	expect(host.querySelector('[aria-label="Your answer"]')).toBeNull();
	const buttons = [...host.querySelectorAll("button")];
	expect(buttons.find((b) => b.textContent === "Approve")?.disabled).toBe(
		false,
	);
	expect(buttons.some((b) => b.textContent === "Not this")).toBe(true);
	expect(buttons.some((b) => b.textContent === "Later")).toBe(true);
	expect(buttons.find((b) => b.textContent === "Decide for me")?.disabled).toBe(
		true,
	);
	expect(host.textContent).toContain("made-up test user");
	expect(host.textContent).not.toContain("Prepared args");
	expect(osApi.workInteractions.respond).not.toHaveBeenCalled();
	await act(async () =>
		buttons.find((b) => b.textContent === "Details")!.click(),
	);
	expect(host.textContent).toContain("Prepared args");
});
it("binds approval to the exact stored operation and target", async () => {
	await mount();
	await act(async () =>
		[...host.querySelectorAll("button")]
			.find((b) => b.textContent === "Approve")!
			.click(),
	);
	expect(osApi.workInteractions.respond).toHaveBeenCalledWith(
		expect.objectContaining({
			requestId: "request",
			expectedRequestVersion: 1,
			responseKind: "answer",
			body: "Approve tests_write.GenerateMagicLinkForTestUser for viewer@example.com.",
			resolvesRequest: true,
		}),
	);
});
