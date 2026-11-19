import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { homeConversationChargesQueryOptions } from "@/lib/os-query-options";
import {
	ConversationUsageLine,
	conversationUsageText,
} from "./chat-usage-line";

function render(
	data?: { chargedMicros: number; chargeCount: number } | undefined,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false, retry: false } },
	});
	if (data)
		client.setQueryData(
			homeConversationChargesQueryOptions("home:fictional").queryKey,
			{ currency: "eur", runCount: 3, ...data },
		);
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
	it("states the settled credits of the conversation", () => {
		expect(conversationUsageText(1_250_000)).toBe(
			"125 credits used in this conversation",
		);
		const html = render({ chargedMicros: 1_250_000, chargeCount: 4 });
		expect(html).toContain("125 credits used in this conversation");
		expect(html).toContain("pending usage appears once settled");
	});

	it("rounds a part credit up rather than showing zero", () => {
		expect(conversationUsageText(4_200)).toBe(
			"1 credit used in this conversation",
		);
	});

	it("stays silent while loading or before anything has settled", () => {
		expect(render()).toBe("");
		expect(render({ chargedMicros: 0, chargeCount: 0 })).toBe("");
	});
});
