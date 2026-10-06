import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import {
	activeOutputLibraryQueryOptions,
	artifactReleaseTargetQueryOptions,
	apiKeyListQueryOptions,
	APP_TOOLS_PAGE_SIZE,
	appToolsListQueryOptions,
	blueprintListQueryOptions,
	osQuery,
	osQueryKeys,
	osSharesQueryOptions,
	outputDetailQueryOptions,
	projectMilestonesQueryOptions,
	workAttemptProjectionQueryOptions,
	workRecoveryProjectionQueryOptions,
	workReadinessProjectionQueryOptions,
	workEvidencePreviewQueryOptions,
	userPreferencesQueryOptions,
} from "@/lib/os-query-options";

const ORG = "00000000-0000-4000-8000-000000000001";
const APP = "00000000-0000-4000-8000-0000000000a1";

describe("canonical OS Query definitions", () => {
	it("keys private artifact review targets by tedi and exact artifact", () => {
		const first = artifactReleaseTargetQueryOptions(
			"tedi-a",
			"artifact-a",
		).queryKey;
		const second = artifactReleaseTargetQueryOptions(
			"tedi-a",
			"artifact-b",
		).queryKey;
		expect(first).not.toEqual(second);
		expect(JSON.stringify(first)).toContain('"sourceArtifactId":"artifact-a"');
	});
	it("encodes the complete blueprint input in the generated key", () => {
		const compact = blueprintListQueryOptions(3).queryKey;
		const library = blueprintListQueryOptions(100).queryKey;

		expect(compact).not.toEqual(library);
		expect(JSON.stringify(compact)).toContain('"limit":3');
		expect(JSON.stringify(library)).toContain('"limit":100');
	});

	it("keys every server-owned tools page and search independently", () => {
		const first = JSON.stringify(appToolsListQueryOptions(APP).queryKey);
		const second = JSON.stringify(
			appToolsListQueryOptions(APP, { page: 2 }).queryKey,
		);
		const searched = JSON.stringify(
			appToolsListQueryOptions(APP, { query: "list issues" }).queryKey,
		);

		expect(first).toContain(`"limit":${APP_TOOLS_PAGE_SIZE}`);
		expect(first).toContain('"offset":0');
		expect(second).toContain(`"offset":${APP_TOOLS_PAGE_SIZE}`);
		expect(searched).toContain('"query":"list issues"');
		expect(new Set([first, second, searched]).size).toBe(3);
	});

	it("invalidates output library and Canvas variants through one domain key", async () => {
		const queryClient = new QueryClient();
		const libraryKey = activeOutputLibraryQueryOptions().queryKey;
		const canvasKey = osQuery.osWorkspaces.outputs.list.queryOptions({
			input: { workspaceId: "00000000-0000-4000-8000-000000000001" },
		}).queryKey;
		queryClient.setQueryData(libraryKey, { items: [], truncated: false });
		queryClient.setQueryData(canvasKey, { items: [], truncated: false });

		await queryClient.invalidateQueries({
			queryKey: osQueryKeys.outputs(),
			refetchType: "none",
		});

		expect(queryClient.getQueryState(libraryKey)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(canvasKey)?.isInvalidated).toBe(true);
	});

	it("reaches a single open document through the same domain key", async () => {
		// The Canvas document panel used to cache under a hand-written
		// `["os-output", id]` literal while `artifact.created` invalidated the
		// GENERATED outputs prefix. Those namespaces are disjoint, so an open
		// document silently kept rendering the revision it loaded with. This
		// asserts the per-document entry is inside the prefix realtime actually
		// fires, which a literal key can never be.
		const queryClient = new QueryClient();
		const detailKey = outputDetailQueryOptions(
			"00000000-0000-4000-8000-0000000000aa",
		).queryKey;
		// Only the presence of the entry matters here; the payload shape is the
		// contract's business and asserting it would duplicate contract tests.
		// (`undefined` would store nothing at all, leaving no state to invalidate.)
		queryClient.setQueryData(detailKey, { output: { id: "aa" } } as never);

		await queryClient.invalidateQueries({
			queryKey: osQueryKeys.outputs(),
			refetchType: "none",
		});

		expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
	});

	it("invalidates every API-key page through the domain key", async () => {
		// Paging is part of the generated key, so a mutation's invalidation must
		// come through the input-less prefix or a non-current page stays stale.
		const queryClient = new QueryClient();
		const pageOne = apiKeyListQueryOptions({
			organizationId: ORG,
			limit: 25,
			offset: 0,
		}).queryKey;
		const pageTwo = apiKeyListQueryOptions({
			organizationId: ORG,
			limit: 25,
			offset: 25,
		}).queryKey;
		expect(pageOne).not.toEqual(pageTwo);
		queryClient.setQueryData(pageOne, { data: [], pagination: {} } as never);
		queryClient.setQueryData(pageTwo, { data: [], pagination: {} } as never);

		await queryClient.invalidateQueries({
			queryKey: osQueryKeys.apiKeys(),
			refetchType: "none",
		});

		expect(queryClient.getQueryState(pageOne)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(pageTwo)?.isInvalidated).toBe(true);
	});

	it("keeps two different documents in separate cache entries", () => {
		// Guards the other half: one domain prefix must not collapse distinct
		// documents into a shared entry.
		expect(
			outputDetailQueryOptions("00000000-0000-4000-8000-0000000000aa").queryKey,
		).not.toEqual(
			outputDetailQueryOptions("00000000-0000-4000-8000-0000000000bb").queryKey,
		);
	});

	it("keys shares by their complete resource identity", () => {
		const output = osSharesQueryOptions({
			resourceType: "output",
			resourceId: "00000000-0000-4000-8000-0000000000aa",
		}).queryKey;
		const workspace = osSharesQueryOptions({
			resourceType: "workspace",
			resourceId: "00000000-0000-4000-8000-0000000000bb",
		}).queryKey;

		expect(output).not.toEqual(workspace);
		expect(JSON.stringify(output)).toContain('"resourceType":"output"');
		expect(JSON.stringify(workspace)).toContain('"resourceType":"workspace"');
	});

	it("keeps durable preferences in the generated user-settings namespace", () => {
		const key = userPreferencesQueryOptions().queryKey;
		expect(key).toEqual(
			osQuery.userSettings.getPreferences.queryOptions({ input: {} }).queryKey,
		);
	});

	it("keeps each org-wide Work factory projection in its own generated key", () => {
		const readiness = workReadinessProjectionQueryOptions().queryKey;
		const attempts = workAttemptProjectionQueryOptions().queryKey;
		const recovery = workRecoveryProjectionQueryOptions().queryKey;

		expect(readiness).not.toEqual(attempts);
		expect(attempts).not.toEqual(recovery);
		expect(JSON.stringify(attempts)).toContain('"limit":100');
		expect(JSON.stringify(recovery)).toContain('"limit":100');
		expect(JSON.stringify(readiness)).toContain('"limit":25');
	});

	it("keys evidence previews by exact Work and evidence identity", () => {
		const first = workEvidencePreviewQueryOptions(ORG, APP).queryKey;
		const second = workEvidencePreviewQueryOptions(
			ORG,
			"00000000-0000-4000-8000-0000000000b2",
		).queryKey;
		expect(first).not.toEqual(second);
		expect(JSON.stringify(first)).toContain(`\"evidenceId\":\"${APP}\"`);
	});

	it("keys every Work queue continuation separately from its first page", () => {
		const cursor = {
			at: "2026-08-20T00:00:00.000Z",
			id: "00000000-0000-4000-8000-0000000000aa",
		};
		expect(workReadinessProjectionQueryOptions().queryKey).not.toEqual(
			workReadinessProjectionQueryOptions(cursor).queryKey,
		);
	});

	it("keys every Work factory continuation separately from its bounded first page", () => {
		const cursor = {
			at: "2026-08-20T00:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		};
		const projectId = "22222222-2222-4222-8222-222222222222";
		const continuations = [
			[
				workAttemptProjectionQueryOptions().queryKey,
				workAttemptProjectionQueryOptions(cursor).queryKey,
			],
			[
				workRecoveryProjectionQueryOptions().queryKey,
				workRecoveryProjectionQueryOptions(cursor).queryKey,
			],
			[
				projectMilestonesQueryOptions(projectId).queryKey,
				projectMilestonesQueryOptions(projectId, cursor.id).queryKey,
			],
		] as const;

		for (const [first, next] of continuations) {
			expect(next).not.toEqual(first);
			expect(JSON.stringify(next)).toContain(cursor.id);
		}
	});

	it("invalidates every milestone cursor page through the generated domain key", async () => {
		const queryClient = new QueryClient();
		const projectId = "22222222-2222-4222-8222-222222222222";
		const first = projectMilestonesQueryOptions(projectId).queryKey;
		const next = projectMilestonesQueryOptions(
			projectId,
			"11111111-1111-4111-8111-111111111111",
		).queryKey;
		queryClient.setQueryData(first, { data: [], nextCursor: null });
		queryClient.setQueryData(next, { data: [], nextCursor: null });

		await queryClient.invalidateQueries({
			queryKey: osQueryKeys.projectMilestones(),
			refetchType: "none",
		});

		expect(queryClient.getQueryState(first)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(next)?.isInvalidated).toBe(true);
	});
});
