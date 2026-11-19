import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CreditUsage } from "@/lib/billing-credits";
import {
	billingOverviewQueryOptions,
	homeConversationChargesQueryOptions,
} from "@/lib/os-query-options";
import {
	ConversationUsageLine,
	conversationUsage,
	conversationUsageText,
} from "./chat-usage-line";

const credits: CreditUsage = {
	periodStart: "2026-11-01T00:00:00.000Z",
	periodEnd: "2026-12-01T00:00:00.000Z",
	includedCredits: 1_000,
	usedCredits: 400,
	remainingIncludedCredits: 600,
	topUpCredits: 0,
	breakdown: { ai: 400, codeRuns: 0, services: 0 },
	notices: [],
	payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
	tedis: [],
	members: [],
};

function render(
	data?: { chargedMicros: number; chargeCount: number } | undefined,
	withCredits = true,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false, retry: false } },
	});
	if (data)
		client.setQueryData(
			homeConversationChargesQueryOptions("home:fictional").queryKey,
			{ currency: "eur", runCount: 3, ...data },
		);
	if (withCredits)
		client.setQueryData(billingOverviewQueryOptions().queryKey, {
			credits,
		} as never);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ConversationUsageLine
				conversationId="home:fictional"
				settledRunCount={3}
			/>
		</QueryClientProvider>,
	);
}

describe("ConversationUsageLine", () => {
	it("states the conversation's share of this month's credits, not a count", () => {
		const usage = conversationUsage(1_250_000, credits);
		expect(usage).toEqual({ percent: 12, label: "12%" });
		expect(conversationUsageText(usage)).toBe(
			"12% of this month's credits used in this conversation",
		);
		const html = render({ chargedMicros: 1_250_000, chargeCount: 4 });
		expect(html).toContain(
			"12% of this month&#x27;s credits used in this conversation",
		);
		expect(html).toContain('role="meter"');
		expect(html).toContain("pending usage appears once settled");
		expect(html).not.toMatch(/\d credits?\b/);
	});

	it("shows <1% for a small charge rather than zero", () => {
		expect(conversationUsage(4_200, credits).label).toBe("<1%");
	});

	it("stays silent while loading, before anything has settled, or without billing access", () => {
		expect(render()).toBe("");
		expect(render({ chargedMicros: 0, chargeCount: 0 })).toBe("");
		expect(render({ chargedMicros: 4_200, chargeCount: 1 }, false)).toBe("");
	});
});
