import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDecisionInbox } from "./use-decision-inbox";

const clock = vi.hoisted(() => ({ now: new Date("2026-10-18T12:00:00Z") }));
const listInbox = vi.hoisted(() => vi.fn());
vi.mock("./use-card-schedule", () => ({
	useCardSchedule: () => ({ now: clock.now, timeZone: "Europe/Berlin" }),
}));
vi.mock("./use-factory-card-count", () => ({
	useFactoryCardCount: () => ({
		count: 0,
		cards: [],
		pending: false,
		failed: false,
		more: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("./api", async (original) => {
	const actual = await original<typeof import("./api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workInteractions"
					? { listInbox }
					: key === "workApprovals"
						? { listInbox: async () => ({ data: [] }) }
						: key === "tediApprovals"
							? {
									list: async () => ({
										data: [],
										pagination: { hasMore: false },
									}),
								}
							: Reflect.get(target, key),
		}),
	};
});

const config = DecisionDeckConfigSchema.parse({ version: 1 });
const cursor = (id: string) => ({ at: "2026-10-18T10:00:00Z", id });
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const reminder = {
	request: {
		id: "33333333-3333-4333-8333-333333333333",
		orgId: "44444444-4444-4444-8444-444444444444",
		kind: "coordination",
		subject: "Follow up with Morgan",
		metadata: {},
		dueAt: "2026-10-28T08:00:00Z",
	},
	effectiveState: "open",
	canRespond: true,
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	listInbox.mockReset();
});
function Probe() {
	const inbox = useDecisionInbox(config);
	return (
		<output>
			{inbox.queuePending ? "loading" : "ready"}:{inbox.requests.length}:
			{inbox.scheduledIds.size}
		</output>
	);
}
it("reads older recipient-scoped pages and releases their reminder on the viewer's date", async () => {
	listInbox.mockImplementation(
		async (input: { decisionKind?: string; cursor?: { id: string } }) => {
			if (input.decisionKind)
				return { data: [], hasMore: false, nextCursor: null };
			if (!input.cursor)
				return { data: [], hasMore: true, nextCursor: cursor(first) };
			if (input.cursor.id === first)
				return { data: [], hasMore: true, nextCursor: cursor(second) };
			return { data: [reminder], hasMore: false, nextCursor: null };
		},
	);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const render = () =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
	await act(async () => render());
	await vi.waitFor(async () => {
		await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
		expect(host.textContent).toBe("ready:0:0");
	});
	expect(
		listInbox.mock.calls.some(([input]) => input.cursor?.id === second),
	).toBe(true);
	clock.now = new Date("2026-10-27T23:00:00Z");
	await act(async () => render());
	expect(host.textContent).toBe("ready:1:1");
});

it("retains typed message approvals and valuable proposals while routing ordinary questions to Feed", async () => {
	const rows = [
		{
			...reminder,
			request: {
				...reminder.request,
				id: first,
				kind: "question",
				dueAt: null,
				metadata: {
					approvalOperation: "gmail.send",
					approvalTarget: "fictional-recipient",
				},
			},
		},
		{
			...reminder,
			request: {
				...reminder.request,
				id: second,
				kind: "question",
				dueAt: null,
				metadata: { decisionClass: "opportunity.lead" },
			},
		},
		{
			...reminder,
			request: {
				...reminder.request,
				id: "55555555-5555-4555-8555-555555555555",
				kind: "question",
				dueAt: null,
				metadata: {},
			},
		},
		{
			...reminder,
			request: {
				...reminder.request,
				id: "66666666-6666-4666-8666-666666666666",
				kind: "input",
				dueAt: null,
				metadata: { schema: "tedix.outbound.v1" },
			},
		},
	];
	listInbox.mockResolvedValue({ data: rows, hasMore: false, nextCursor: null });
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		),
	);
	await vi.waitFor(async () => {
		await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
		expect(host.textContent).toBe("ready:3:0");
	});
});
