import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
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
	client.setQueryData(tediRosterQueryOptions(100).queryKey, { data: [] });
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
		expect(doc.body.textContent).toContain("Reasoning and sources");
		expect(button(doc, "Approve & send")?.disabled).toBe(true);
		expect(button(doc, "Approve (I'll send)")?.disabled).toBe(false);
	});
	it("requires review again when the draft revision changes", () => {
		const doc = card({
			...LOCAL_OUTBOUND,
			outbound: { ...LOCAL_OUTBOUND.outbound, draftRevision: 2 },
		});
		expect(button(doc, "Approve (I'll send)")?.disabled).toBe(true);
	});
	it("never offers another send after an uncertain provider result", () => {
		const doc = card({
			...LOCAL_OUTBOUND,
			outbound: { ...LOCAL_OUTBOUND.outbound, status: "send_unknown" },
		});
		expect(button(doc, "Approve & send")).toBeUndefined();
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
		expect(button(doc, "Approve & send")).toBeUndefined();
		expect(button(doc, "Copy text")).toBeDefined();
		expect(doc.querySelector("script")).toBeNull();
	});
});
