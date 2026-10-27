import { QueryClient } from "@tanstack/react-query";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userPreferencesQueryOptions,
	userProfileQueryOptions,
	workAppsQueryOptions,
} from "./os-query-options";
import { FOCUS_HISTORY_SURFACES } from "@tedix/api-contract/utils/focus-feed";
import { prefetchWorkDeck } from "./prefetch-work-deck";

const reads = vi.hoisted(() => ({
	approvals: vi.fn(),
	workApprovals: vi.fn(),
	interactions: vi.fn(),
	profile: vi.fn(),
	projects: vi.fn(),
	model: vi.fn(),
	feedback: vi.fn(),
	apps: vi.fn(),
}));
// Activity-only reads, warmed only when Work lands on Activity.
const activity = vi.hoisted(() => ({
	preferences: vi.fn(),
	deckCards: vi.fn(),
	output: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		tediApprovals: { list: reads.approvals },
		workApprovals: { listInbox: reads.workApprovals },
		workInteractions: { listInbox: reads.interactions },
		userProfile: { getMine: reads.profile },
		projects: { list: reads.projects },
		learningFeedback: { model: reads.model, listInteractions: reads.feedback },
		osWorkspaces: {
			gadgets: { workApps: reads.apps },
			outputs: { get: activity.output },
		},
		userSettings: { getPreferences: activity.preferences },
		attention: { listDeckCards: activity.deckCards },
	},
}));
vi.mock("@/components/decision-deck-app", () => ({}));
vi.mock("@/components/activity-feed-app", () => ({}));

const projectId = "00000000-0000-4000-8000-000000000001";
const viewerOptions = () => [
	pendingApprovalsQueryOptions(),
	osQuery.workApprovals.listInbox.queryOptions({
		input: { limit: 50, statuses: ["pending"] },
	}),
	osQuery.workInteractions.listInbox.queryOptions({
		input: { limit: 50, states: ["open"] },
	}),
	userProfileQueryOptions(),
	projectListQueryOptions(100),
	osQuery.learningFeedback.model.queryOptions({ input: {} }),
	osQuery.learningFeedback.listInteractions.queryOptions({
		input: { scopeKind: "personal", limit: 200 },
	}),
];
const deck = (config: unknown) => ({
	currentRevision: { manifest: { entry: "tedix:app/decision-deck", config } },
});
let client: QueryClient;

beforeEach(() => {
	vi.resetAllMocks();
	for (const read of [...Object.values(reads), ...Object.values(activity)])
		read.mockResolvedValue({ items: [] });
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

async function settled() {
	await vi.waitFor(() => expect(client.isFetching()).toBe(0));
}

describe("prefetchWorkDeck", () => {
	it("primes every canonical viewer key and the app inventory once", async () => {
		expect(prefetchWorkDeck(client)).toBeUndefined();
		await settled();
		const keys = [...viewerOptions(), workAppsQueryOptions()].map(
			({ queryKey }) => queryKey,
		);
		expect(
			client
				.getQueryCache()
				.getAll()
				.map((query) => query.queryKey),
		).toEqual(keys);
		for (const key of keys)
			expect(client.getQueryState(key)?.status).toBe("success");
		for (const read of Object.values(reads))
			expect(read).toHaveBeenCalledTimes(1);
	});

	it("warms project-scoped inboxes using the installed Deck limit", async () => {
		reads.apps.mockResolvedValue({
			items: [
				{
					currentRevision: {
						manifest: {
							entry: "tedix:app/other",
							config: { version: 1, limit: 3 },
						},
					},
				},
				deck({ version: 1, projectId, limit: 12 }),
			],
		});
		prefetchWorkDeck(client);
		await settled();
		for (const options of [
			osQuery.workApprovals.listInbox.queryOptions({
				input: { projectId, limit: 12, statuses: ["pending"] },
			}),
			osQuery.workInteractions.listInbox.queryOptions({
				input: { projectId, limit: 12, states: ["open"] },
			}),
		])
			expect(client.getQueryState(options.queryKey)?.status).toBe("success");
		expect(client.getQueryCache().getAll()).toHaveLength(10);
		expect(reads.workApprovals).toHaveBeenCalledTimes(2);
		expect(reads.interactions).toHaveBeenCalledTimes(2);
		expect(reads.approvals).toHaveBeenCalledTimes(1);
	});

	it.each([
		{},
		{ version: 2 },
		{ version: 1, limit: 0 },
		{ version: 1, projectId: "invalid" },
	])("ignores invalid Deck configuration %j", async (config) => {
		reads.apps.mockResolvedValue({ items: [deck(config)] });
		prefetchWorkDeck(client);
		await settled();
		expect(client.getQueryCache().getAll()).toHaveLength(8);
		for (const read of Object.values(reads))
			expect(read).toHaveBeenCalledTimes(1);
	});

	it("tolerates a failed app inventory fetch and still warms viewer queries", async () => {
		reads.apps.mockRejectedValue(new Error("Inventory unavailable"));
		expect(() => prefetchWorkDeck(client)).not.toThrow();
		await settled();
		expect(client.getQueryState(workAppsQueryOptions().queryKey)?.status).toBe(
			"error",
		);
		for (const { queryKey } of viewerOptions())
			expect(client.getQueryState(queryKey)?.status).toBe("success");
		expect(reads.apps).toHaveBeenCalledTimes(1);
	});

	it("isolates a failed viewer fetch from the remaining queries", async () => {
		reads.approvals.mockRejectedValue(new Error("Approvals unavailable"));
		prefetchWorkDeck(client);
		await settled();
		expect(
			client.getQueryState(pendingApprovalsQueryOptions().queryKey)?.status,
		).toBe("error");
		for (const { queryKey } of viewerOptions().slice(1))
			expect(client.getQueryState(queryKey)?.status).toBe("success");
		for (const read of Object.values(reads))
			expect(read).toHaveBeenCalledTimes(1);
	});

	const feedReads = (outputId: string) => [
		userPreferencesQueryOptions(),
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: {
				scopeKind: "personal",
				limit: 200,
				surfaces: FOCUS_HISTORY_SURFACES,
			},
		}),
		osQuery.attention.listDeckCards.queryOptions({ input: { limit: 100 } }),
		osQuery.osWorkspaces.outputs.get.queryOptions({ input: { outputId } }),
	];
	// Activity reads start after the app inventory resolves, so wait for them.
	const activityWarmed = () =>
		vi.waitFor(() => {
			for (const { queryKey } of feedReads(projectId))
				expect(client.getQueryState(queryKey)?.status).toBe("success");
		});
	const feed = (workDefault: boolean) => ({
		currentRevision: {
			manifest: {
				entry: "tedix:app/activity-feed",
				navigation: { work: "feed", workDefault },
				config: {
					version: 1,
					scope: "organization",
					projects: [],
					today: {
						outputId: projectId,
						skillId: projectId,
						tediId: projectId,
						personId: "person",
					},
				},
			},
		},
	});

	it("warms Activity's first-paint reads when Work lands on Activity", async () => {
		reads.apps.mockResolvedValue({ items: [feed(true)] });
		prefetchWorkDeck(client);
		await activityWarmed();
		for (const read of Object.values(activity))
			expect(read).toHaveBeenCalledTimes(1);
	});

	it("leaves Activity's reads to the app when Work lands on Decisions", async () => {
		reads.apps.mockResolvedValue({
			items: [
				feed(false),
				{
					currentRevision: {
						manifest: {
							entry: "tedix:app/decision-deck",
							navigation: { work: "deck", workDefault: true },
							config: { version: 1 },
						},
					},
				},
			],
		});
		prefetchWorkDeck(client);
		await vi.waitFor(() => expect(reads.interactions).toHaveBeenCalledTimes(1));
		await settled();
		for (const read of Object.values(activity)) expect(read).not.toBeCalled();
		prefetchWorkDeck(client, "feed");
		await activityWarmed();
	});

	it("fetches each default unscoped Deck query only once", async () => {
		reads.apps.mockResolvedValue({ items: [deck({ version: 1 })] });
		prefetchWorkDeck(client);
		await settled();
		expect(client.getQueryCache().getAll()).toHaveLength(8);
		for (const read of Object.values(reads))
			expect(read).toHaveBeenCalledTimes(1);
	});
});
