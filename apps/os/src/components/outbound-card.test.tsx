import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OutboundRecord } from "@tedix/api-contract/schemas/outbound";
import { LOCAL_OUTBOUND } from "../../dev/outbound-fixture";
import { osQuery, tediRosterQueryOptions } from "@/lib/os-query-options";
import { OutboundReviewCard } from "./outbound-card";

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

const { actOutbound } = vi.hoisted(() => ({ actOutbound: vi.fn() }));
vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	const outbound = new Proxy(actual.osApi.workInteractions.outbound, {
		get: (target, key) =>
			key === "act" ? actOutbound : Reflect.get(target, key),
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
