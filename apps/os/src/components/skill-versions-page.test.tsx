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
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			listWorkflowRevisions: read,
			get: () => Promise.resolve({ entry: skill }),
		},
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	read.mockReset();
});
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
async function mount(rows?: SkillWorkflowRevision[], mayBeTruncated = false) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const options = skillRevisionsQueryOptions("example-skill");
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
		read.mockReturnValueOnce(new Promise(() => {}));
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
		await act(async () => node.querySelector("button")!.click());
		expect(node.textContent).toContain("example-workflow");
		expect(node.textContent).toContain("example-instructions");
	});
	it("shows an empty state only after revisions have loaded", async () => {
		const { node } = await mount([]);
		expect(node.textContent).toContain("No versions have run yet.");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});
	it("reports an error and recovers with a read retry", async () => {
		read.mockRejectedValueOnce(new Error("Versions read failed"));
		const { node } = await mount();
		expect(node.textContent).toContain("Versions unavailable");
		expect(node.textContent).toContain("Versions read failed");
		expect(node.textContent).not.toContain("No versions have run");
		read.mockResolvedValueOnce({
			revisions: [revision],
			sampledRunCount: 4,
			mayBeTruncated: false,
		});
		await act(async () => node.querySelector("button")!.click());
		await act(async () => {
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(node.textContent).toContain("Revision 3");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});
	it("keeps a cached version and warns when a refresh fails", async () => {
		const { node, client, options } = await mount([revision]);
		read.mockRejectedValueOnce(new Error("Refresh failed"));
		await act(async () => {
			await client.refetchQueries(options);
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(node.textContent).toContain("Versions unavailable");
		expect(node.textContent).toContain("Revision 3");
	});
	it("keeps the sample limitation visible", async () => {
		const { node } = await mount([revision], true);
		expect(node.textContent).toContain("may omit older executions");
	});
});
