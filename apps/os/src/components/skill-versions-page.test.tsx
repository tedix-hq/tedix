import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	SkillEntry,
	SkillWorkflowRevision,
} from "@tedix/api-contract/contracts/cognitive";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	skillDetailQueryOptions,
	skillRevisionsQueryOptions,
} from "@/lib/os-query-options";
import { SkillVersionsPage } from "./skill-versions-page";
vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "example-skill" }),
}));
const reads = vi.hoisted(() => ({
	get: vi.fn(),
	listWorkflowRevisions: vi.fn(),
	getWorkflowRevision: vi.fn(),
	compareWorkflowRevisions: vi.fn(),
	permissions: [] as string[],
	drafts: [] as unknown[],
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			listWorkflowRevisions: reads.listWorkflowRevisions,
			get: reads.get,
			getWorkflowRevision: reads.getWorkflowRevision,
			compareWorkflowRevisions: reads.compareWorkflowRevisions,
			listByOrg: () =>
				Promise.resolve({ entries: reads.drafts, total: reads.drafts.length }),
		},
		// The drafts section reads the viewer's permissions; a member without
		// tedis:update sees no draft controls, which these cases rely on.
		userSettings: {
			getContext: () =>
				Promise.resolve({
					authority: { permissions: reads.permissions },
					organization: { id: "example-org" },
				}),
		},
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	reads.get.mockReset();
	reads.listWorkflowRevisions.mockReset();
	reads.getWorkflowRevision.mockReset();
	reads.compareWorkflowRevisions.mockReset();
	reads.permissions = [];
	reads.drafts = [];
});
function button(node: Element, name: string) {
	const found = [...node.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name,
	);
	if (!found) throw new Error(`Missing button: ${name}`);
	return found;
}
async function settle() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
}
const skill: SkillEntry = {
	id: "example-skill",
	organizationId: "example-org",
	title: "Example procedure",
	content: "Instructions",
	successCount: 0,
	failureCount: 0,
	visibility: "org",
	paceLayer: "innovation",
	revision: 3,
	revisionReasoning: "Clearer instructions",
};
const revision: SkillWorkflowRevision = {
	skillId: "example-skill",
	tediId: "example-worker",
	status: "completed",
	firstObservedAt: "2026-10-21T12:00:00Z",
	runtimeDriftObserved: false,
	runtimeDriftBlocked: false,
	workerVersionId: null,
	workerVersionTag: null,
	workerVersionTimestamp: null,
	executionCompatibilityHash: null,
	dispatchShimVersion: null,
	compatibilityDate: null,
	dynamicWorkflowsVersion: null,
	loaderConfigHash: null,
	tenantCpuMs: null,
	tenantSubRequests: null,
	runId: "example-run",
	revision: 3,
	observedRunCount: 4,
	completedCount: 3,
	failedCount: 1,
	canceledCount: 0,
	lastObservedAt: "2026-10-21T12:00:00Z",
	runtimeVariants: [],
	workflowSourceSha256: "example-workflow",
	skillDocSha256: "example-instructions",
};
async function mount(
	rows?: SkillWorkflowRevision[],
	mayBeTruncated = false,
	cacheDetail = true,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const options = skillRevisionsQueryOptions("example-skill");
	if (cacheDetail)
		client.setQueryData(skillDetailQueryOptions("example-skill").queryKey, {
			entry: skill,
		});
	if (rows)
		client.setQueryData(options.queryKey, {
			revisions: rows,
			provenance: "observed_executed_runs",
			sampledRunCount: 4,
			mayBeTruncated,
		});
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		node.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<SkillVersionsPage />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
	return { node, client, options };
}
describe("skill versions", () => {
	it("shows loading without claiming the list is empty", async () => {
		reads.listWorkflowRevisions.mockReturnValueOnce(new Promise(() => {}));
		const { node } = await mount();
		expect(node.querySelector('[data-slot="skeleton"]')).not.toBeNull();
		expect(node.querySelector('[data-slot="empty"]')).toBeNull();
	});
	it("sorts observed revisions and identifies the current version and its evidence", async () => {
		const { node } = await mount([
			{ ...revision, runId: "older-run", revision: 2 },
			revision,
		]);
		expect(node.textContent!.indexOf("Revision 3")).toBeLessThan(
			node.textContent!.indexOf("Revision 2"),
		);
		expect(node.textContent).toContain("Current");
		expect(node.textContent).toContain("Clearer instructions");
		expect(node.querySelector("time")?.dateTime).toBe("2026-10-21T12:00:00Z");
		expect(node.querySelector("time")?.title).toContain("2026");
		const current = node.querySelector('[aria-current="true"]')!;
		expect(current.textContent).toContain("Revision 3");
		expect(node.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
		await act(async () => button(current, "Technical details").click());
		expect(node.textContent).toContain("example-workflow");
		expect(node.textContent).toContain("example-instructions");
	});
	it("shows the current version even before it has run", async () => {
		const { node } = await mount([]);
		expect(node.textContent).toContain("Revision 3");
		expect(node.textContent).toContain("Current");
		expect(node.textContent).toContain("No runs yet");
		expect(node.textContent).not.toContain("No versions have run yet.");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});
	it("shows an empty state only after revisions have loaded", async () => {
		reads.get.mockReturnValue(new Promise(() => {}));
		const { node } = await mount([], false, false);
		expect(node.textContent).toContain("No versions have run yet.");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});
	it("reads as a history: short message, compact run evidence, cleanup only in details", async () => {
		const cleanup =
			"Removed 1 workflow improvement copy (11111111-2222-4333-8444-555555555555): abandoned";
		const { node, client } = await mount([
			{ ...revision, runId: "older-run", revision: 2, failedCount: 0 },
			revision,
		]);
		await act(async () => {
			client.setQueryData(skillDetailQueryOptions("example-skill").queryKey, {
				entry: {
					...skill,
					revisionReasoning: `Clearer instructions\n${cleanup}\n${cleanup}`,
				},
			});
		});
		const [first, second] = [
			...node.querySelectorAll<HTMLElement>("[data-version-row]"),
		];
		expect(first!.querySelector("[data-version-message]")!.textContent).toBe(
			"Clearer instructions",
		);
		expect(
			first!.querySelector("[data-version-evidence]")!.textContent,
		).toContain("4 runs · 75% completed · 1 failed");
		expect(
			second!.querySelector("[data-version-evidence]")!.textContent,
		).toContain("4 runs · 100% completed");
		expect(node.textContent).not.toContain("workflow improvement copy");
		expect(node.textContent).not.toContain("Observed");
		await act(async () => button(first!, "Technical details").click());
		expect(first!.textContent).toContain("2 from automatic cleanup");
		expect(first!.textContent).toContain("workflow improvement copy");
	});
	it("takes a version's message, date and test result from the draft it was adopted from", async () => {
		reads.permissions = ["tedis:update"];
		reads.drafts = [
			{
				...skill,
				id: "adopted-draft",
				lifecycleState: "archived",
				sourceSkillId: skill.id,
				revisionReasoning:
					"Workflow improvement proposed from run 11111111-2222-4333-8444-555555555555 at baseline revision 1. Skip duplicate requests\nBaseline aaa; candidate bbb.",
				improvementAdoption: {
					activatedIntoRevision: 2,
					certificationRunId: "passed-run",
					adoptedAt: "2026-10-20T09:00:00Z",
					reason:
						"Switched on after test run 11111111-2222-4333-8444-555555555555",
				},
			},
		];
		const { node } = await mount([
			{ ...revision, runId: "older-run", revision: 2 },
			revision,
		]);
		await settle();
		const older = node.querySelector<HTMLElement>('[data-version-row="2"]')!;
		expect(older.querySelector("[data-version-message]")!.textContent).toBe(
			"Skip duplicate requests",
		);
		expect(older.textContent).toContain("Adopted");
		expect(older.querySelector("time")!.dateTime).toBe("2026-10-20T09:00:00Z");
		expect(older.textContent).toContain("Test passed");
		expect(
			older.querySelector('a[href="/work/runs/passed-run"]'),
		).not.toBeNull();
		expect(node.textContent).not.toContain("11111111-2222");
	});
	it("opens a version's source and its comparison with the previous version", async () => {
		reads.getWorkflowRevision.mockResolvedValue({
			revision: { ...revision, revision: 2 },
			skillDoc: "Older instructions",
			workflowSource: "export default 1;",
		});
		reads.compareWorkflowRevisions.mockResolvedValue({
			baselineSkillDoc: "Shared line\nOlder line",
			candidateSkillDoc: "Shared line\nNewer line",
			baselineSource: "export default 1;",
			candidateSource: "export default 1;",
		});
		const { node } = await mount([
			{ ...revision, runId: "older-run", revision: 2 },
			revision,
		]);
		const [first, second] = [
			...node.querySelectorAll<HTMLElement>("[data-version-row]"),
		];
		// The oldest version has nothing earlier to compare with.
		expect(second!.textContent).not.toContain("Compare with previous");
		// A member who cannot change the skill gets no "Make current".
		expect(node.textContent).not.toContain("Make current");
		await act(async () => button(second!, "View source").click());
		await settle();
		expect(reads.getWorkflowRevision.mock.calls[0]![0]).toMatchObject({
			runId: "older-run",
			includeSource: true,
		});
		const source = document.querySelector('[role="dialog"]')!;
		expect(source.textContent).toContain("Source of revision 2");
		expect(source.textContent).toContain("Older instructions");
		await act(async () =>
			source.querySelector<HTMLElement>('[aria-label="Close"]')!.click(),
		);
		await settle();
		await act(async () => button(first!, "Compare with previous").click());
		await settle();
		expect(reads.compareWorkflowRevisions.mock.calls[0]![0]).toMatchObject({
			baselineRunId: "older-run",
			candidateRunId: "example-run",
			includeSource: true,
		});
		const compare = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
		expect(compare.textContent).toContain(
			"Revision 3 compared with revision 2",
		);
		expect(compare.textContent).toContain("1 line added");
		expect(compare.textContent).toContain("Newer line");
		expect(
			compare.querySelector('[aria-label="Automation"]')!.textContent,
		).toContain("No change.");
	});
	it("shows the current version's source from the page without another read", async () => {
		const { node } = await mount([revision]);
		await act(async () => button(node, "View source").click());
		await settle();
		expect(reads.getWorkflowRevision).not.toHaveBeenCalled();
		const source = document.querySelector('[role="dialog"]')!;
		expect(source.textContent).toContain("Source of revision 3");
		expect(source.textContent).toContain("Instructions");
	});
	it("offers Make current on an older version to someone who may change the skill", async () => {
		reads.permissions = ["tedis:update"];
		const { node, client } = await mount([
			{ ...revision, runId: "older-run", revision: 2 },
			revision,
		]);
		await act(async () => {
			client.setQueryData(skillDetailQueryOptions("example-skill").queryKey, {
				entry: {
					...skill,
					files: { "scripts/workflow.ts": "export default 2;" },
				},
			});
		});
		await settle();
		const [first, second] = [
			...node.querySelectorAll<HTMLElement>("[data-version-row]"),
		];
		expect(first!.textContent).not.toContain("Make current");
		expect(button(second!, "Make current")).toBeDefined();
	});
	it("reports an error and recovers with a read retry", async () => {
		reads.listWorkflowRevisions.mockRejectedValueOnce(
			new Error("Versions read failed"),
		);
		const { node } = await mount();
		expect(node.textContent).toContain("Versions unavailable");
		expect(node.textContent).toContain("Versions read failed");
		expect(node.textContent).not.toContain("No versions have run");
		reads.listWorkflowRevisions.mockResolvedValueOnce({
			revisions: [revision],
			sampledRunCount: 4,
			mayBeTruncated: false,
		});
		const retry = [...node.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Retry",
		)!;
		await act(async () => retry.click());
		await act(async () => {
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(node.textContent).toContain("Revision 3");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});
	it("keeps a cached version and warns when a refresh fails", async () => {
		const { node, client, options } = await mount([revision]);
		reads.listWorkflowRevisions.mockRejectedValueOnce(
			new Error("Refresh failed"),
		);
		await act(async () => {
			await client.refetchQueries(options);
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(node.textContent).toContain("Versions could not refresh");
		expect(node.textContent).toContain("Showing the versions loaded earlier");
		expect(node.textContent).toContain("Revision 3");
	});
	it("recovers skill details independently before verifying Current", async () => {
		reads.get
			.mockRejectedValueOnce(new Error("Details read failed"))
			.mockResolvedValueOnce({ entry: skill });
		const { node } = await mount([revision], false, false);
		expect(node.textContent).toContain(
			"Could not check which version is current",
		);
		expect(node.textContent).toContain("Revision 3");
		expect(node.textContent).not.toContain("Clearer instructions");
		expect(node.querySelector('[data-slot="badge"]')).toBeNull();
		const retry = [...node.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry",
		);
		expect(retry).toBeDefined();
		await act(async () => retry!.click());
		await act(async () => {
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(reads.get).toHaveBeenCalledTimes(2);
		expect(reads.listWorkflowRevisions).not.toHaveBeenCalled();
		expect(node.textContent).toContain("Current");
		expect(node.textContent).toContain("Clearer instructions");
	});
	it("keeps the sample limitation visible", async () => {
		const { node } = await mount([revision], true);
		expect(node.textContent).toContain(
			"Run counts cover the latest 4 runs; older runs are not counted.",
		);
	});
	it("says nothing about a sample when every run was counted", async () => {
		const { node } = await mount([revision]);
		expect(node.textContent).not.toContain("Run counts cover");
	});
});
