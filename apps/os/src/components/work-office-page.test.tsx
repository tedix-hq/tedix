import {
	QueryClient,
	QueryClientProvider,
	type QueryKey,
} from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
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

const FIXTURE_NOW = new Date("2026-10-22T12:00:00Z");

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
	client.setQueryData(userProfileQueryOptions().queryKey, { name: "Operator" });
	client.setQueryData(agentSessionRequestsQueryOptions().queryKey, {
		data: [
			{
				id: "request",
				harness: "codex",
				repository: "demo",
				text: "Review the plan",
				status: "open",
				sourceAt: FIXTURE_NOW.toISOString(),
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

function renderOffice(client: QueryClient) {
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<OfficeApp />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("Office ledger rendering", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Fixtures age knocks relative to Date.now(); keep them within one day.
		vi.setSystemTime(FIXTURE_NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps the For you, answered, notebook and request collections", () => {
		const client = seeded();
		const doc = renderOffice(client);
		const app = doc.querySelector('[data-workspace-app-entry="office"]')!;
		expect(app.firstElementChild?.querySelector("h1")?.textContent).toBe(
			"Office",
		);
		const activity = app.querySelector("#office-activity-title")!;
		const today = app.querySelector('[aria-label="Loading today"]')!;
		expect(
			activity.compareDocumentPosition(today) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const context = [...app.querySelectorAll("button")].find(
			(button) => button.textContent === "Decision context",
		)!;
		expect(context.getAttribute("aria-expanded")).toBe("false");
		expect(app.querySelector('[aria-label="Decision attention"]')).toBeNull();
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

	it("renders complete activity titles without React title warnings", () => {
		const errors = vi.spyOn(console, "error");
		const client = seeded();
		const titles = [...renderOffice(client).querySelectorAll("svg rect title")];
		expect(titles).toHaveLength(24);
		expect(titles[0]?.textContent).toBe("0 knocks, 23h ago");
		expect(titles[22]?.textContent).toBe("1 knock, 1h ago");
		expect(titles[23]?.textContent).toBe("4 knocks, this hour");
		expect(
			errors.mock.calls.filter((args) => args.join(" ").includes("<title>")),
		).toEqual([]);
		client.clear();
	});

	it("keeps yesterday's knocks out of today but in the rolling activity chart", () => {
		const client = seeded();
		const key = workOfficeKnocksQueryOptions().queryKey;
		const knocks = client.getQueryData<{
			data: { request: { requestedAt: string; subject: string } }[];
		}>(key)!;
		const yesterday = knocks.data[0]!;
		const today = knocks.data[2]!;
		const midnight = new Date(2026, 9, 22);
		yesterday.request.requestedAt = new Date(
			midnight.getTime() - 60_000,
		).toISOString();
		today.request.requestedAt = new Date(
			midnight.getTime() + 10_000,
		).toISOString();
		client.setQueryData(key, { ...knocks, data: [yesterday, today] });
		vi.setSystemTime(new Date(midnight.getTime() + 30_000));
		const doc = renderOffice(client);
		const answered = doc.querySelector(
			'[aria-labelledby="office-answered-title"]',
		)!;
		expect(answered.textContent).toContain(today.request.subject);
		expect(answered.textContent).not.toContain(yesterday.request.subject);
		expect(answered.querySelectorAll("li")).toHaveLength(1);
		expect(doc.querySelector("svg rect:last-child title")?.textContent).toBe(
			"2 knocks, this hour",
		);
		client.clear();
	});
});
