import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { WorkAttemptRepository } from "@tedix/api-contract/schemas/work-items";
const mocks = vi.hoisted(() => ({
	log: vi.fn(),
	tree: vi.fn(),
	file: vi.fn(),
	authority: { role: "owner", permissions: ["secrets:manage"] },
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority: mocks.authority } }),
}));
vi.mock("@/lib/api", () => ({
	osApi: { workItems: { readAttemptRepository: mocks.file } },
}));
vi.mock("@/components/canvas-proposals", () => ({ ProposalDiff: () => null }));
vi.mock("@/components/workstation-inspection-panel", () => ({
	decodeWorkstationInspectionText: (input: string) => atob(input),
}));
vi.mock("@/lib/os-query-options", () => ({
	attemptRepositoryLogQueryOptions: (
		id: string,
		attemptId: string,
		ref?: string,
	) => ({
		queryKey: ["snapshot-log-test", id, attemptId, ref],
		queryFn: () => mocks.log(ref),
	}),
	attemptRepositoryTreeQueryOptions: (
		id: string,
		attemptId: string,
		ref: string,
		path?: string,
	) => ({
		queryKey: ["snapshot-tree-test", id, attemptId, ref, path],
		queryFn: () => mocks.tree(ref, path),
	}),
}));
import { WorkAttemptRepositoryPanel } from "./work-attempt-repository-panel";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const head = "a".repeat(40),
	newer = "b".repeat(40);
const repository: WorkAttemptRepository = {
	version: 1,
	provider: "cloudflare_artifacts",
	status: "ready",
	mode: "create",
	repositoryName: "work-example",
	repositoryId: "example",
	remote: "https://example.test/repo.git",
	defaultBranch: "main",
	sourceRepositoryName: null,
	sourceRef: null,
	baseRevision: null,
	workItemId: "11111111-1111-4111-8111-111111111111",
	workItemVersion: 1,
	admissionSpecRevision: "spec",
	admissionId: "22222222-2222-4222-8222-222222222222",
	attemptId: "33333333-3333-4333-8333-333333333333",
	observedAt: "2026-11-03T00:00:00.000Z",
	reason: null,
};
let host: HTMLDivElement,
	root: ReturnType<typeof createRoot>,
	client: QueryClient;
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkAttemptRepositoryPanel
					workItemId={repository.workItemId}
					attemptId={repository.attemptId}
					repository={repository}
				/>
			</QueryClientProvider>,
		),
	);
}
async function click(label: string) {
	await act(async () =>
		[...host.querySelectorAll("button")]
			.find((node) => node.textContent?.trim() === label)!
			.click(),
	);
	await flush();
	await flush();
}
beforeEach(() => {
	mocks.authority.role = "owner";
	mocks.log.mockReset().mockImplementation(async (ref) => ({
		operation: "log",
		resolvedRevision: ref ?? head,
		commits: [],
	}));
	mocks.tree.mockReset().mockResolvedValue({
		operation: "tree",
		exists: true,
		entries: [{ name: "file.ts", path: "file.ts", type: "blob" }],
	});
	mocks.file.mockReset().mockResolvedValue({
		operation: "file",
		exists: true,
		dataBase64: btoa("source"),
		binary: false,
	});
});
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	host?.remove();
	client?.clear();
});
it("pins file reads while branch head changes, and resolves a fresh head on reopen", async () => {
	await mount();
	expect(mocks.log).not.toHaveBeenCalled();
	await click("Repository");
	expect(mocks.tree).toHaveBeenLastCalledWith(head, undefined);
	mocks.log.mockImplementation(async (ref) => ({
		operation: "log",
		resolvedRevision: ref ?? newer,
		commits: [],
	}));
	await act(async () => {
		await client.invalidateQueries();
	});
	await flush();
	await click("file.ts");
	expect(mocks.file).toHaveBeenLastCalledWith({
		id: repository.workItemId,
		attemptId: repository.attemptId,
		operation: "file",
		ref: head,
		path: "file.ts",
	});
	await click("Hide repository");
	await click("Repository");
	expect(mocks.tree).toHaveBeenLastCalledWith(newer, undefined);
});
it("does not request repository data for a member", async () => {
	mocks.authority.role = "member";
	await mount();
	expect(host.textContent).toContain("secrets management");
	expect(mocks.log).not.toHaveBeenCalled();
	expect(mocks.tree).not.toHaveBeenCalled();
});
