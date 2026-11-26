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
	userPreferencesQueryOptions,
	workAppsQueryOptions,
} from "./os-query-options";
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
	output: vi.fn(),
	work: vi.fn(),
	results: vi.fn(),
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
		workItems: {
			listActivity: activity.work,
			listAttemptProjection: activity.results,
		},
	},
}));
vi.mock("@/components/decision-deck-app", () => ({}));
vi.mock("@/components/activity-feed-app", () => ({}));

const projectId = "00000000-0000-4000-8000-000000000001";
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
	it("waits for inventory before starting app reads and tolerates denied access", async () => {
		let rejectInventory!: (error: Error) => void;
		reads.apps.mockReturnValue(
			new Promise((_, reject) => {
				rejectInventory = reject;
			}),
		);
		prefetchWorkDeck(client, "feed");
		for (const [name, read] of Object.entries(reads))
			if (name !== "apps") expect(read).not.toHaveBeenCalled();
		for (const read of Object.values(activity))
			expect(read).not.toHaveBeenCalled();
		rejectInventory(new Error("Forbidden"));
		await settled();
		expect(client.getQueryState(workAppsQueryOptions().queryKey)?.status).toBe(
			"error",
		);
		for (const read of Object.values(activity))
			expect(read).not.toHaveBeenCalled();
	});

	const feedReads = (outputId: string) => [
		userPreferencesQueryOptions(),
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
		for (const [name, read] of Object.entries(reads))
			if (name !== "apps") expect(read).not.toHaveBeenCalled();
	});

	it("keeps prefetched work and results within the selected project", async () => {
		reads.apps.mockResolvedValue({ items: [feed(true)] });
		prefetchWorkDeck(client, "feed", projectId);
		await activityWarmed();
		for (const read of [activity.work, activity.results]) {
			expect(read).toHaveBeenCalledTimes(1);
			expect(read.mock.calls[0]?.[0]).toMatchObject({ projectId, limit: 20 });
		}
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
});
