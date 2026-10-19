import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import { DecisionDeckApp } from "./decision-deck-app";
import {
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userProfileQueryOptions,
	userPreferencesQueryOptions,
} from "@/lib/os-query-options";

vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workInteractions"
					? new Proxy(actual.osApi.workInteractions, {
							get: (target, key) =>
								key === "refreshDecisionSources"
									? async () => ({ created: 0, scanned: 0, hasMore: false })
									: Reflect.get(target, key),
						})
					: key === "agentTurnTriage"
						? { listLessons: vi.fn(async () => ({ lessons: [] })) }
						: key === "learningFeedback"
							? {
									recordInteraction: vi.fn(async () => ({})),
									recordExposure: vi.fn(async () => ({
										id: "fictional-exposure",
									})),
									listInteractions: vi.fn(async () => ({ events: [] })),
									getCalibration: actual.osApi.learningFeedback.getCalibration,
									getInstrumentation:
										actual.osApi.learningFeedback.getInstrumentation,
									model: vi.fn(),
									correct: vi.fn(),
								}
							: Reflect.get(target, key),
		}),
	};
});
vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("./work-decision-stack", () => ({
	ApprovalDecisionCard: () => <p>Live approval</p>,
}));
vi.mock("./work-interaction-decision-card", () => ({
	WorkInteractionDecisionCard: ({
		requestId,
		onNext,
	}: {
		requestId: string;
		onNext: () => void;
	}) => (
		<>
			<p>Live request {requestId}</p>
			<button onClick={onNext}>Skip linked preview</button>
		</>
	),
}));
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	sessionStorage.clear();
	localStorage.clear();
	globalThis.history.replaceState(null, "", globalThis.location.pathname);
	host?.remove();
	vi.restoreAllMocks();
});
async function mount(
	input: {
		rows?: ReturnType<typeof WorkInteractionInboxRowSchema.parse>[];
		budget?: number;
	} = {},
) {
	client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData(userPreferencesQueryOptions().queryKey, {
		preferences: { ...DEFAULT_OS_USER_PREFERENCES, timezone: "Europe/Berlin" },
		source: "stored",
		revision: 1,
		updatedAt: null,
	});
	client.setQueryData(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}).queryKey,
		{ events: [] },
	);
	client.setQueryData(
		osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
		learnDecisions({
			organizationId: "fictional-acme",
			personId: "fictional-acme-user",
			events: [],
			config: DecisionLearningConfigSchema.parse({}),
			now: new Date(),
		}),
	);
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: undefined,
				limit: 50,
				states: ["open"],
				decisionKind: "approval",
			},
		}).queryKey,
		{
			data: [],
			hasMore: false,
			nextCursor: null,
			observedAt: new Date().toISOString(),
		},
	);
	for (const state of ["open", "resolved"] as const)
		client.setQueryData(
			osQuery.workInteractions.listInbox.queryOptions({
				input: { projectId: undefined, limit: 50, states: [state] },
			}).queryKey,
			{
				data: state === "open" ? (input.rows ?? []) : [],
				hasMore: false,
				nextCursor: null,
				observedAt: "2026-10-17T10:00:00.000Z",
			},
		);
	client.setQueryData(
		osQuery.workApprovals.listInbox.queryOptions({
			input: { projectId: undefined, limit: 50, statuses: ["pending"] },
		}).queryKey,
		{
			data: [],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-10-17T12:00:00Z",
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
						dailyAttentionBudget: input.budget,
					})}
				/>
			</QueryClientProvider>,
		),
	);
}
async function click(text: string) {
	if (["Try examples", "What you decided"].includes(text)) {
		const chip = [...host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Kind",
		);
		await act(async () => chip!.click());
	}
	const button = [...document.querySelectorAll("button")].find(
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
	for (const example of DECISION_DECK_EXAMPLES) {
		expect(host.textContent).toContain(example.proposal);
		expect(host.textContent).not.toContain("unchanged approvals");
		expect(host.textContent).not.toContain("Target:");
		await click("Why this");
		expect(
			document.querySelector("[data-decision-context]")?.textContent,
		).toContain("Prefer a bounded next step with evidence");
		await act(async () =>
			document
				.querySelector<HTMLButtonElement>(
					'[aria-label="Close decision context"]',
				)!
				.click(),
		);
		await key("j");
	}
	expect(host.textContent).toContain("All clear");
	expect(host.textContent).not.toContain("0 decided today");
	expect(host.querySelector(".fd-decision")).toBeNull();
	expect(host.querySelector(".fd-closure")).not.toBeNull();
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

it("starts collapsed, opens Why in context, and remembers closure for this person", async () => {
	await mount();
	const toggle = () =>
		host.querySelector<HTMLButtonElement>('[aria-label="Decision context"]')!;
	expect(toggle().getAttribute("aria-expanded")).toBe("false");
	await act(async () => toggle().click());
	expect(toggle().getAttribute("aria-expanded")).toBe("true");
	await act(async () =>
		document
			.querySelector<HTMLButtonElement>(
				'[aria-label="Close decision context"]',
			)!
			.click(),
	);
	await click("Try examples");
	expect(toggle().getAttribute("aria-expanded")).toBe("false");
	await click("Why this");
	expect(toggle().getAttribute("aria-expanded")).toBe("true");
	expect(
		document.querySelector(
			'[data-decision-context] [data-context-section="why"]',
		)?.textContent,
	).toContain("Prefer a bounded next step");
	expect(
		host.querySelector('.fd-context-main [data-context-section="why"]'),
	).toBeNull();

	const context = document.querySelector<HTMLElement>(
		'[data-decision-context] [data-context-section="why"] h3',
	)!;
	await act(async () => {
		context.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
		);
		const start = new Event("touchstart", { bubbles: true });
		Object.defineProperty(start, "touches", {
			value: [{ clientX: 100, clientY: 100 }],
		});
		context.dispatchEvent(start);
		const end = new Event("touchend", { bubbles: true });
		Object.defineProperty(end, "changedTouches", {
			value: [{ clientX: 300, clientY: 100 }],
		});
		context.dispatchEvent(end);
	});
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
	await act(async () =>
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "i", bubbles: true }),
		),
	);
	expect(toggle().getAttribute("aria-expanded")).toBe("false");
	expect(
		localStorage.getItem("tedix:decision-context:fictional-acme-user"),
	).toBe("closed");
	const escape = new KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	await act(async () => document.dispatchEvent(escape));
	expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

it("does not announce All clear while decision history is loading", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
	await mount();
	await act(async () =>
		host
			.querySelector<HTMLButtonElement>('[aria-label="Decision context"]')!
			.click(),
	);
	client.removeQueries({
		queryKey: osQuery.workInteractions.listInbox.queryOptions({
			input: { projectId: undefined, limit: 50, states: ["resolved"] },
		}).queryKey,
		exact: true,
	});
	await click("What you decided");
	expect(host.querySelector(".fd-closure")).toBeNull();
	expect(
		client.getQueryState(
			osQuery.workInteractions.listInbox.queryOptions({
				input: { projectId: undefined, limit: 50, states: ["resolved"] },
			}).queryKey,
		)?.status,
	).toBe("pending");
});

const linkedRow = (id: string, subject: string, canRespond = true) =>
	WorkInteractionInboxRowSchema.parse({
		request: {
			id,
			orgId: "22222222-2222-4222-8222-222222222222",
			workItemId: null,
			caseId: null,
			projectId: null,
			creatorSessionId: null,
			state: "open",
			requestedAt: id.startsWith("1")
				? "2026-10-17T10:00:00Z"
				: "2026-10-17T09:00:00Z",
			dueAt: null,
			expiresAt: null,
			resolvedAt: null,
			metadata: { decisionClass: "opportunity.supplier" },
			subject,
			prompt: "Review this fictional supplier proposal.",
			kind: "question",
			version: 1,
			creatorType: "user",
			creatorId: "fictional-asker",
			requestedFromType: "user",
			requestedFromId: "fictional-acme-user",
		},
		effectiveState: "open",
		canRespond,
		canCancel: false,
		workItem: null,
		responseCount: 0,
	});

it("opens an authorized linked request outside the saved automatic batch and returns to that batch on next", async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("No live requests in the fixture"),
	);
	const first = linkedRow(
		"11111111-1111-4111-8111-111111111111",
		"First fictional supplier",
	);
	const target = linkedRow(
		"33333333-3333-4333-8333-333333333333",
		"Linked fictional supplier",
	);
	globalThis.history.replaceState(null, "", `#card=${target.request.id}`);
	await mount({ rows: [first, target], budget: 1 });
	expect(host.textContent).toContain(`Live request ${target.request.id}`);
	expect(host.textContent).not.toContain(`Live request ${first.request.id}`);
	expect(host.textContent).toContain("2 of 2");
	const saved = Object.keys(sessionStorage).find((key) =>
		key.startsWith("decision-deck:"),
	)!;
	expect(JSON.parse(sessionStorage.getItem(saved)!).ids).toEqual([
		first.request.id,
	]);
	await click("Skip linked preview");
	expect(globalThis.location.hash).toBe("");
	expect(host.textContent).toContain(`Live request ${first.request.id}`);
	expect(JSON.parse(sessionStorage.getItem(saved)!).ids).toEqual([
		first.request.id,
	]);
});

it("does not substitute another card when the linked request is not actionable for this person", async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("No live requests in the fixture"),
	);
	const first = linkedRow(
		"11111111-1111-4111-8111-111111111111",
		"First fictional supplier",
	);
	const target = linkedRow(
		"33333333-3333-4333-8333-333333333333",
		"Unavailable fictional supplier",
		false,
	);
	globalThis.history.replaceState(null, "", `#card=${target.request.id}`);
	await mount({ rows: [first, target], budget: 1 });
	expect(host.textContent).toContain(
		"That decision is no longer available in this view.",
	);
	expect(host.textContent).not.toContain("Live request");
});

it("keeps critical approvals outside the valuable-card batch allowance", async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("No live requests in the fixture"),
	);
	const critical = linkedRow(
		"11111111-1111-4111-8111-111111111111",
		"Allow the fictional message",
	);
	critical.request.metadata = {
		approvalOperation: "gmail.send",
		approvalTarget: "fictional-recipient",
	};
	const valuable = linkedRow(
		"33333333-3333-4333-8333-333333333333",
		"Review the fictional partnership",
	);
	await mount({ rows: [critical, valuable], budget: 1 });
	expect(host.textContent).toContain("1 of 2");
	const saved = Object.keys(sessionStorage).find((key) =>
		key.startsWith("decision-deck:"),
	)!;
	expect(JSON.parse(sessionStorage.getItem(saved)!).ids).toEqual([
		valuable.request.id,
	]);
});
