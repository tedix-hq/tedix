import {
	QueryClient,
	QueryClientProvider,
	type QueryKey,
} from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { handleLocalRpc } from "../../dev/local-fixtures";
import {
	agentSessionRequestsQueryOptions,
	notebookLessonsQueryOptions,
	tediRosterQueryOptions,
	userProfileQueryOptions,
	workInteractionDetailQueryOptions,
	workOfficeKnocksQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import { OfficeApp } from "./work-office-page";

function seeded() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	function seed(queryKey: QueryKey, endpoint: string, input: unknown = {}) {
		const result = handleLocalRpc(`/api/rpc/${endpoint}`, "POST", {
			json: input,
		});
		expect(result?.status).toBe(200);
		const data = (result?.body as { json: unknown }).json;
		client.setQueryData(queryKey, data);
		return data;
	}
	const knocks = seed(
		workOfficeKnocksQueryOptions().queryKey,
		"workInteractions/listInbox",
		{ limit: 100 },
	) as { data: { request: { id: string } }[] };
	seed(
		workUrgentInteractionsQueryOptions().queryKey,
		"workInteractions/listInbox",
		{ limit: 100, states: ["open"], urgency: "now" },
	);
	seed(tediRosterQueryOptions(100).queryKey, "tedis/list", { limit: 100 });
	seed(notebookLessonsQueryOptions().queryKey, "agentTurnTriage/listLessons", {
		limit: 50,
	});
	client.setQueryData(userProfileQueryOptions().queryKey, { name: "Robin" });
	client.setQueryData(agentSessionRequestsQueryOptions().queryKey, {
		data: [
			{
				id: "request",
				harness: "codex",
				repository: "demo",
				text: "Review the plan",
				status: "open",
				sourceAt: new Date().toISOString(),
			},
		],
	});
	for (const row of knocks.data)
		seed(
			workInteractionDetailQueryOptions(row.request.id).queryKey,
			"workInteractions/get",
			{ requestId: row.request.id },
		);
	return client;
}

describe("Office ledger rendering", () => {
	it("keeps the For you, answered, notebook and request collections", () => {
		const client = seeded();
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<OfficeApp />
				</QueryClientProvider>,
			),
			"text/html",
		);
		expect(doc.querySelector('[aria-label="For you"] li')).not.toBeNull();
		const answered = doc.querySelector(
			'[aria-labelledby="office-answered-title"]',
		)!;
		expect(answered.textContent).toContain("Answered for you");
		expect(answered.querySelector('[data-slot="card-action"]')).not.toBeNull();
		expect(
			answered.querySelector('ul[data-appearance="inline"] li'),
		).not.toBeNull();
		const notebook = doc.querySelector(
			'[aria-labelledby="office-notebook-title"]',
		)!;
		expect(
			notebook.querySelector('ul[data-appearance="inline"] li'),
		).not.toBeNull();
		expect(
			doc.querySelector('[aria-label="Your requests"] [data-request-status]'),
		).not.toBeNull();
		for (const item of doc.querySelectorAll(
			'[aria-label="For you"] li, [aria-labelledby="office-answered-title"] li, [aria-labelledby="office-notebook-title"] li',
		))
			expect(item.className).toContain("px-4 py-3");
		client.clear();
	});
});
