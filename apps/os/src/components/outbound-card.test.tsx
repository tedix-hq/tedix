import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OutboundRecord } from "@tedix/api-contract/schemas/outbound";
import { LOCAL_OUTBOUND } from "../../dev/outbound-fixture";
import { osQuery, tediRosterQueryOptions } from "@/lib/os-query-options";
import { OutboundStyleProfile, OutboundReviewCard } from "./outbound-card";

function card(record = LOCAL_OUTBOUND) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(
		osQuery.workInteractions.outbound.accounts.queryOptions({ input: {} })
			.queryKey,
		[],
	);
	client.setQueryData(tediRosterQueryOptions(100).queryKey, {
		data: [],
		pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
	});
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<OutboundReviewCard record={record} />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

function button(doc: Document, name: string) {
	return [...doc.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === name,
	);
}

describe("outbound human review card", () => {
	it("shows draft, reasoning and reviewer notes with Gmail sending disabled until an account is chosen", () => {
		const doc = card();
		expect(doc.body.textContent).toContain("Hi Lina");
		expect(doc.body.textContent).toContain("Ready for your review");
		expect(doc.body.textContent).toContain("Why this?");
		expect(doc.querySelector("input, textarea, [role=combobox]")).toBeNull();
		expect(button(doc, "Send")?.disabled).toBe(false);
		expect(button(doc, "Approve, I'll send")?.disabled).toBe(false);
	});
	it("requires review again when the draft revision changes", () => {
		const doc = card({
			...LOCAL_OUTBOUND,
			outbound: { ...LOCAL_OUTBOUND.outbound, draftRevision: 2 },
		});
		expect(button(doc, "Approve, I'll send")?.disabled).toBe(true);
	});
	it("explains that an edited card does not replace the original provider draft", () => {
		const doc = card({
			...LOCAL_OUTBOUND,
			outbound: {
				...LOCAL_OUTBOUND.outbound,
				draftRevision: 2,
				draft: {
					...LOCAL_OUTBOUND.outbound.draft,
					providerDraftUrl: "https://mail.google.com/mail/u/0/#drafts",
				},
			},
		});
		expect(doc.body.textContent).toContain(
			"source draft opens the original wording",
		);
		expect(doc.body.textContent).toContain("check the recipient and subject");
	});
	it("never offers another send after an uncertain provider result", () => {
		const doc = card({
			...LOCAL_OUTBOUND,
			outbound: { ...LOCAL_OUTBOUND.outbound, status: "send_unknown" },
		});
		expect(button(doc, "Send")).toBeUndefined();
		expect(doc.body.textContent).toContain("Sending is locked");
	});
	it("uses the same card for other channels and keeps raw HTML inert", () => {
		const record: OutboundRecord = {
			...LOCAL_OUTBOUND,
			outbound: {
				...LOCAL_OUTBOUND.outbound,
				draft: {
					...LOCAL_OUTBOUND.outbound.draft,
					channel: "linkedin",
					body: "Hi Lina\n\n<script>alert('fictional')</script>",
				},
			},
		};
		const doc = card(record);
		expect(button(doc, "Send")).toBeUndefined();
		expect(button(doc, "Copy text")).toBeDefined();
		expect(doc.querySelector("script")).toBeNull();
	});
});

const { actOutbound, importSentStyle } = vi.hoisted(() => ({
	actOutbound: vi.fn(),
	importSentStyle: vi.fn(),
}));
vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	const outbound = new Proxy(actual.osApi.workInteractions.outbound, {
		get: (target, key) =>
			key === "act"
				? actOutbound
				: key === "importSentStyle"
					? importSentStyle
					: Reflect.get(target, key),
	});
	const interactions = new Proxy(actual.osApi.workInteractions, {
		get: (target, key) =>
			key === "outbound" ? outbound : Reflect.get(target, key),
	});
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workInteractions" ? interactions : Reflect.get(target, key),
		}),
	};
});

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
const connectionId = "22222222-2222-4222-8222-222222222222";
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
	actOutbound.mockReset();
});
async function mountOutbound() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(
		osQuery.workInteractions.outbound.accounts.queryOptions({ input: {} })
			.queryKey,
		[{ id: connectionId, label: "Rosa Gmail" }],
	);
	client.setQueryData(tediRosterQueryOptions(100).queryKey, {
		data: [],
		pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
	});
	vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
	actOutbound.mockResolvedValue(LOCAL_OUTBOUND);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client}>
				<OutboundReviewCard record={LOCAL_OUTBOUND} />
			</QueryClientProvider>,
		),
	);
}
async function pressButton(label: string) {
	const target = [...document.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === label,
	);
	expect(target).toBeDefined();
	await act(async () => target!.click());
}
async function enter(label: string, value: string) {
	const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		`[aria-label="${label}"]`,
	)!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("outbound decisions through the shared card", () => {
	it("keeps Send behind explicit connection consent", async () => {
		await mountOutbound();
		await pressButton("Send");
		expect(actOutbound).not.toHaveBeenCalled();
		const confirm = [...document.querySelectorAll("button")].find(
			(element) => element.textContent === "Confirm",
		)!;
		expect(confirm.disabled).toBe(true);
		await act(async () =>
			document
				.querySelector<HTMLButtonElement>('[aria-label="Your Gmail account"]')!
				.click(),
		);
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((element) => element.textContent?.includes("Rosa Gmail"));
		expect(option).toBeDefined();
		await act(async () => option!.click());
		await pressButton("Confirm");
		expect(actOutbound).toHaveBeenCalledWith({
			workItemId: LOCAL_OUTBOUND.workItemId,
			expectedVersion: 3,
			action: "approve_send",
			connectionInstanceId: connectionId,
			elapsedMs: expect.any(Number),
		});
	});
	it("saves edited wording for review without sending it", async () => {
		await mountOutbound();
		await pressButton("Change");
		await enter("Edit draft", "Hi Lina, thanks. Shall we plan a workshop?");
		expect(
			[...document.querySelectorAll("button")].some(
				(element) => element.textContent === "Send",
			),
		).toBe(false);
		await pressButton("Save for review");
		expect(actOutbound).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedVersion: 3,
				action: "edit",
				draft: expect.objectContaining({
					body: "Hi Lina, thanks. Shall we plan a workshop?",
					recipient: "lina@example.test",
				}),
			}),
		);
	});
	it("captures a reason chip without approving or sending", async () => {
		await mountOutbound();
		await pressButton("Not this");
		expect(actOutbound).not.toHaveBeenCalled();
		await pressButton("wrong tone");
		expect(actOutbound).toHaveBeenCalledWith({
			workItemId: LOCAL_OUTBOUND.workItemId,
			expectedVersion: 3,
			action: "reject",
			feedback: "wrong tone",
			elapsedMs: expect.any(Number),
		});
	});
	it("sends free-text feedback as feedback, never as approval", async () => {
		await mountOutbound();
		await pressButton("Give feedback");
		await enter("Optional feedback", "Keep this to two short paragraphs.");
		await pressButton("Send feedback");
		expect(actOutbound).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "feedback",
				feedback: "Keep this to two short paragraphs.",
			}),
		);
	});
});

it("shows Deck learning, private style hints and the selected Gmail address instead of its id", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(
		osQuery.workInteractions.outbound.accounts.queryOptions({ input: {} })
			.queryKey,
		[{ id: connectionId, label: "rosa@example.test" }],
	);
	client.setQueryData(
		osQuery.workInteractions.outbound.profile.queryOptions({ input: {} })
			.queryKey,
		{
			approvals: [],
			lessons: [],
			preferences: ["Use short replies."],
			decisionCount: 1,
			sentExamples: 10,
			sentStyleHints: [
				"Observed across 10 sent emails: about 40 words and 2 paragraphs per email.",
			],
		},
	);
	vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
	importSentStyle.mockResolvedValue({ imported: 10 });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client}>
				<OutboundStyleProfile />
			</QueryClientProvider>,
		),
	);
	expect(host.textContent).toContain(
		"Your profile includes 1 recent decision.",
	);
	expect(host.textContent).toContain("Use short replies.");
	expect(host.textContent).toContain(
		"10 sent-mail examples are saved privately for you.",
	);
	expect(host.textContent).not.toContain("No approvals yet");
	await act(async () =>
		document
			.querySelector<HTMLButtonElement>(
				'[aria-label="Gmail account for style examples"]',
			)!
			.click(),
	);
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((el) => el.textContent?.includes("rosa@example.test"));
	expect(option).toBeDefined();
	await act(async () => option!.click());
	const trigger = document.querySelector(
		'[aria-label="Gmail account for style examples"]',
	)!;
	expect(trigger.textContent).toContain("rosa@example.test");
	expect(trigger.textContent).not.toContain(connectionId);
	await pressButton("Learn from my last 10 sent emails");
	expect(importSentStyle).toHaveBeenCalledWith({
		connectionInstanceId: connectionId,
	});
	expect(client.invalidateQueries).toHaveBeenCalledWith({
		queryKey: osQuery.workInteractions.outbound.key({ type: "query" }),
	});
});
