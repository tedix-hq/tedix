import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	registerTool: vi.fn(),
	getSiteById: vi.fn(),
	getBuild: vi.fn(),
	activateBuild: vi.fn(),
	indexPublicDocsBuild: vi.fn(),
	getDocsFile: vi.fn(),
}));
vi.mock("@tedix/mcp-shared/server", () => ({
	createMcpServer: () => ({ registerTool: mocks.registerTool }),
}));
vi.mock("./registry", () => mocks);
vi.mock("./ai-search", () => ({
	indexPublicDocsBuild: mocks.indexPublicDocsBuild,
	searchPublicDocs: vi.fn(),
}));
vi.mock("./sandbox", () => ({}));
vi.mock("./authoring", async (importOriginal) => ({
	...(await importOriginal<typeof import("./authoring")>()),
	getDocsFile: mocks.getDocsFile,
}));
import { READ_OBSERVATION_META_KEY } from "@tedix/mcp-shared/read-observation-receipt";
import { buildDocsMcpServer, type DocsToolContext } from "./tools";

const site = {
	id: "00000000-0000-4000-8000-000000000002",
	orgSlug: "test",
	branch: "main",
	accessMode: "public",
};
const build = {
	id: "build",
	siteId: site.id,
	sourceBranch: "main",
	proposalId: null,
};
const release = { id: "release", siteId: site.id, buildId: build.id };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSiteById.mockResolvedValue(site);
	mocks.getBuild.mockResolvedValue(build);
	mocks.activateBuild.mockResolvedValue({ site, release });
	mocks.getDocsFile.mockResolvedValue({
		content: "hello\n",
		path: "index.md",
		revision: "b".repeat(40),
		contentSha256: "a".repeat(64),
		byteLength: 6,
	});
	// The old request path would never return with unresolved indexing.
	mocks.indexPublicDocsBuild.mockReturnValue(new Promise(() => {}));
});

function tool(
	name: string,
	create = vi.fn().mockResolvedValue({ id: "search-release" }),
) {
	buildDocsMcpServer({
		env: { DB: {}, DOCS_BUILD_WORKFLOW: { create } },
		orgSlug: "test",
		scopes: ["mcp:content.read", "mcp:content.write", "mcp:content.admin"],
		actor: { type: "user", id: "owner", sessionId: null },
		platformAdmin: false,
		providerAuthorization: null,
	} as unknown as DocsToolContext);
	const entry = mocks.registerTool.mock.calls.find(([id]) => id === name)!;
	return {
		invoke: () => entry[2]({ siteId: site.id, buildId: build.id }),
		create,
	};
}

it("attests a tenant-owned Docs read in metadata beside exact content", async () => {
	const { invoke } = tool("get_docs_file");
	const result = await invoke();
	expect(result.structuredContent).toMatchObject({
		content: "hello\n",
		path: "index.md",
	});
	expect(result._meta?.[READ_OBSERVATION_META_KEY]).toMatchObject({
		kind: "docs_file_observation",
		provider: { appSlug: "docs", toolName: "get_docs_file" },
		resource: { organizationSlug: "test", siteId: site.id, path: "index.md" },
		evidence: {
			contentSha256: "a".repeat(64),
			byteLength: 6,
			observedGitRevision: "b".repeat(40),
		},
	});
});

describe.each(["publish_docs_build", "rollback_docs_build"])(
	"%s receipt",
	(name) => {
		it("returns the confirmed release after queuing, without awaiting indexing", async () => {
			const { invoke, create } = tool(name);
			const result = await invoke();
			expect(result.structuredContent).toEqual({
				site,
				release,
				searchProjection: { status: "queued", workflowId: "search-release" },
			});
			expect(create).toHaveBeenCalledWith({
				id: "search-release",
				params: { operation: "index", siteId: site.id, buildId: build.id },
			});
			expect(mocks.indexPublicDocsBuild).not.toHaveBeenCalled();
		});

		it("preserves publication success when enqueue fails", async () => {
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const { invoke } = tool(
					name,
					vi
						.fn()
						.mockRejectedValue(new Error("unavailable: private tenant token")),
				);
				const result = await invoke();
				expect(result.isError).toBeUndefined();
				expect(result.structuredContent).toEqual({
					site,
					release,
					searchProjection: {
						status: "failed",
						error: "unavailable: private tenant token",
					},
				});
				expect(log).toHaveBeenCalledExactlyOnceWith({
					component: "docs",
					event: "docs.search_index_queue_failed",
					exception: { name: "Error" },
				});
			} finally {
				log.mockRestore();
			}
		});

		it("does not queue private documentation", async () => {
			mocks.activateBuild.mockResolvedValue({
				site: { ...site, accessMode: "organization" },
				release,
			});
			const { invoke, create } = tool(name);
			expect((await invoke()).structuredContent.searchProjection).toBeNull();
			expect(create).not.toHaveBeenCalled();
		});

		it("does not queue when activation fails", async () => {
			mocks.activateBuild.mockRejectedValue(new Error("activation failed"));
			const { invoke, create } = tool(name);
			expect((await invoke()).isError).toBe(true);
			expect(create).not.toHaveBeenCalled();
		});
	},
);
