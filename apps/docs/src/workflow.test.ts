import {
	afterEach,
	beforeEach,
	describe,
	it,
	expect,
	vi,
} from "vite-plus/test";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
const namespace = vi.hoisted(() => ({ getByName: vi.fn() }));
vi.mock("./registry", () => ({
	completeBuild: vi.fn(),
	getBuild: vi.fn(),
	getSiteById: vi.fn(),
	updateBuildProgress: vi.fn(),
}));
import type { AppBindings, DocsSite } from "./types";
vi.mock("./ai-search", () => ({ indexPublicDocsBuild: vi.fn() }));
import { indexPublicDocsBuild } from "./ai-search";
import {
	getBuild,
	getSiteById,
	updateBuildProgress,
	completeBuild,
} from "./registry";
import {
	DocsBuildWorkflow,
	checkoutAndBuild,
	stageDocsBuildFile,
	stageDocsBuildFiles,
} from "./workflow";
afterEach(() => vi.unstubAllGlobals());
function file(size: number, bytes = new Uint8Array([0, 255, 128, 10])) {
	const readFile = vi.fn(async () => ({
		success: true as const,
		content: bytes,
		size,
	}));
	return {
		sandbox: { readFile } as unknown as Parameters<
			typeof stageDocsBuildFile
		>[0],
		readFile,
		cancel: vi.fn(),
	};
}
function fixedLength() {
	vi.stubGlobal(
		"FixedLengthStream",
		class extends TransformStream<Uint8Array, Uint8Array> {
			constructor(expected: number) {
				let seen = 0;
				super({
					transform(chunk, c) {
						seen += chunk.byteLength;
						if (seen > expected) throw new Error("length mismatch");
						c.enqueue(chunk);
					},
					flush() {
						if (seen !== expected) throw new Error("length mismatch");
					},
				});
			}
		},
	);
}
describe("Docs native binary staging", () => {
	it("pipes raw binary bytes directly into R2", async () => {
		fixedLength();
		const f = file(4);
		let received: ArrayBuffer | undefined;
		const put = vi.fn(
			async (_key: string, stream: ReadableStream<Uint8Array>) => {
				received = await new Response(stream).arrayBuffer();
			},
		);
		expect(
			await stageDocsBuildFile(
				f.sandbox,
				{ put } as unknown as R2Bucket,
				"/dist/file.bin",
				"build/file.bin",
				10,
			),
		).toBe(4);
		expect(new Uint8Array(received!)).toEqual(
			new Uint8Array([0, 255, 128, 10]),
		);
		expect(f.readFile).toHaveBeenCalledWith("/dist/file.bin", {
			encoding: "none",
		});
	});
	it("stages RSS with a feed media type", async () => {
		fixedLength();
		const f = file(4);
		const put = vi.fn(
			async (_key: string, stream: ReadableStream<Uint8Array>) => {
				await new Response(stream).arrayBuffer();
			},
		);
		await stageDocsBuildFile(
			f.sandbox,
			{ put } as unknown as R2Bucket,
			"/dist/updates/rss.xml",
			"build/updates/rss.xml",
			10,
		);
		expect(put).toHaveBeenCalledWith(
			"build/updates/rss.xml",
			expect.anything(),
			{ httpMetadata: { contentType: "application/rss+xml; charset=utf-8" } },
		);
	});
	it.each([
		[-1, 100],
		[11 * 1024 * 1024, 20 * 1024 * 1024],
		[5, 4],
	])("rejects size %s before R2 upload", async (size, remaining) => {
		const f = file(size);
		const put = vi.fn();
		await expect(
			stageDocsBuildFile(
				f.sandbox,
				{ put } as unknown as R2Bucket,
				"/dist/file.bin",
				"key",
				remaining,
			),
		).rejects.toThrow("byte limits");
		expect(put).not.toHaveBeenCalled();
	});
	it("uploads the exact buffered bytes", async () => {
		const f = file(3, new Uint8Array([1, 2, 3]));
		const put = vi.fn(async () => undefined);
		await expect(
			stageDocsBuildFile(
				f.sandbox,
				{ put } as unknown as R2Bucket,
				"/dist/file.bin",
				"key",
				10,
			),
		).resolves.toBe(3);
		expect(put).toHaveBeenCalledWith(
			"key",
			new Uint8Array([1, 2, 3]),
			expect.anything(),
		);
	});
});

describe("Docs build output staging", () => {
	it("limits concurrent Sandbox reads and R2 writes to four files", async () => {
		fixedLength();
		let active = 0;
		let peak = 0;
		const readFile = vi.fn(async () => ({
			success: true as const,
			path: "/workspace/dist/file",
			content: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([42]));
					controller.close();
				},
			}),
			size: 1,
			mimeType: "application/octet-stream",
			timestamp: "now",
		}));
		const put = vi.fn(
			async (_key: string, stream: ReadableStream<Uint8Array>) => {
				await new Response(stream).arrayBuffer();
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active--;
			},
		);
		await stageDocsBuildFiles(
			{ readFile } as unknown as Parameters<typeof stageDocsBuildFiles>[0],
			{ put } as unknown as R2Bucket,
			"/workspace",
			"build",
			Array.from({ length: 9 }, (_, index) => ({
				relativePath: `file-${index}.html`,
				size: 1,
			})),
		);
		expect(peak).toBe(4);
		expect(readFile).toHaveBeenCalledTimes(9);
		expect(put).toHaveBeenCalledTimes(9);
	});

	it("rejects an oversized output before any R2 write", async () => {
		const readFile = vi.fn();
		const put = vi.fn();
		await expect(
			stageDocsBuildFiles(
				{ readFile } as unknown as Parameters<typeof stageDocsBuildFiles>[0],
				{ put } as unknown as R2Bucket,
				"/workspace",
				"build",
				Array.from({ length: 11 }, (_, index) => ({
					relativePath: `file-${index}.html`,
					size: 10 * 1024 * 1024,
				})),
			),
		).rejects.toThrow("Documentation build exceeded 104857600 bytes");
		expect(readFile).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it("rejects a file that grew after the output listing", async () => {
		const f = file(4);
		const put = vi.fn();
		await expect(
			stageDocsBuildFiles(
				f.sandbox,
				{ put } as unknown as R2Bucket,
				"/workspace",
				"build",
				[{ relativePath: "file.bin", size: 3 }],
			),
		).rejects.toThrow("byte limits");
		expect(put).not.toHaveBeenCalled();
	});
});

describe("Docs native build outcomes", () => {
	function setup(
		build: { timedOut?: boolean; truncated?: boolean },
		cloneTruncated = false,
	) {
		const outputs = [
			{
				stdout: "a".repeat(40),
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: cloneTruncated,
			},
			{
				stdout: "/index",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
			},
			{
				stdout: "done",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
				...build,
			},
		];
		const exec = vi.fn(async (..._args: unknown[]) => ({
			output: async () => outputs.shift(),
		}));
		const listFiles = vi.fn();
		namespace.getByName.mockReturnValue({ exec, listFiles });
		const site = {
			id: "site",
			slug: "platform",
			sourceProvider: "github",
			sourceAuthMode: "public",
			repositoryUrl: "https://github.com/example/docs",
			branch: "main",
			contentRoot: ".",
			canonicalUrl: "https://docs.example",
			title: "Docs",
			description: "Public docs",
			locale: "en",
		} as DocsSite;
		return {
			exec,
			listFiles,
			site,
			env: {
				ENVIRONMENT: "production",
				DOCS_BUILD_SANDBOX: { getByName: namespace.getByName },
				SECRET: "never-forward",
			} as unknown as AppBindings,
		};
	}
	it("rejects native timeout even if the root process exits zero", async () => {
		const f = setup({ timedOut: true });
		await expect(checkoutAndBuild(f.env, f.site, "build")).rejects.toThrow(
			"Documentation build failed",
		);
		expect(f.listFiles).not.toHaveBeenCalled();
		expect(f.exec.mock.calls[2]).toEqual([
			["bun", "run", "build"],
			{
				cwd: "/tmp/tedix-docs-workspace-build",
				timeout: 600000,
				env: {
					TEDIX_DOCS_SITE_SLUG: "platform",
					TEDIX_DOCS_SITE_URL: "https://docs.example",
					TEDIX_DOCS_ENTRY_PATH: "/index",
					TEDIX_DOCS_TITLE: "Docs",
					TEDIX_DOCS_DESCRIPTION: "Public docs",
					TEDIX_DOCS_LOCALE: "en",
					TEDIX_DOCS_REPOSITORY_URL: "https://github.com/example/docs",
				},
			},
		]);
		const prepareArgs = f.exec.mock.calls[1]?.[0] as string[] | undefined;
		const prepareScript = prepareArgs?.[2] ?? "";
		expect(prepareScript).toContain("! -path './.tedix/*'");
		expect(prepareScript).toContain("if [ -f .tedix/docs-provenance.json ]");
		expect(prepareScript).toContain(
			"/tmp/tedix-docs-workspace-build/.tedix/docs-provenance.json",
		);
		expect(prepareScript).not.toContain("noindex");
		expect(prepareScript).toContain("echo /generated-index");
	});
	it("rejects truncated revision output instead of parsing a partial result", async () => {
		const f = setup({}, true);
		await expect(checkoutAndBuild(f.env, f.site, "build")).rejects.toThrow(
			"Git checkout failed",
		);
		expect(f.exec).toHaveBeenCalledOnce();
	});
});

describe("Docs durable search indexing", () => {
	const site = { id: "site", accessMode: "public" };
	const build = { id: "build", siteId: "site", status: "complete" };
	const env = { DB: {} };
	const indexed = { accepted: 2, buildId: "build", sourceRevision: "revision" };
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSiteById).mockResolvedValue(site as never);
		vi.mocked(getBuild).mockResolvedValue(build as never);
		vi.mocked(indexPublicDocsBuild).mockResolvedValue(indexed);
	});
	function run() {
		const step = { do: vi.fn(async (_name, _options, fn) => fn()) };
		return {
			step,
			result: DocsBuildWorkflow.prototype.run.call(
				{ env } as unknown as DocsBuildWorkflow,
				{
					payload: { operation: "index", siteId: "site", buildId: "build" },
				} as never,
				step as never,
			),
		};
	}
	it("indexes in a durable step without entering the build lifecycle", async () => {
		const { step, result } = run();
		expect(await result).toEqual(indexed);
		expect(step.do).toHaveBeenCalledWith(
			"index-public-build",
			expect.objectContaining({ timeout: "15 minutes" }),
			expect.any(Function),
		);
		expect(indexPublicDocsBuild).toHaveBeenCalledWith(env, site, build);
		expect(updateBuildProgress).not.toHaveBeenCalled();
		expect(completeBuild).not.toHaveBeenCalled();
		expect(namespace.getByName).not.toHaveBeenCalled();
	});
	it("leaves the completed build untouched when indexing fails", async () => {
		vi.mocked(indexPublicDocsBuild).mockRejectedValue(
			new Error("search unavailable"),
		);
		await expect(run().result).rejects.toThrow("search unavailable");
		expect(updateBuildProgress).not.toHaveBeenCalled();
		expect(completeBuild).not.toHaveBeenCalled();
		expect(namespace.getByName).not.toHaveBeenCalled();
	});
	it.each(["private", "incomplete", "wrong-site"])(
		"rejects %s indexing",
		async (mode) => {
			if (mode === "private")
				vi.mocked(getSiteById).mockResolvedValue({
					...site,
					accessMode: "organization",
				} as never);
			else
				vi.mocked(getBuild).mockResolvedValue({
					...build,
					...(mode === "incomplete"
						? { status: "running" }
						: { siteId: "another" }),
				} as never);
			await expect(run().result).rejects.toThrow();
			expect(indexPublicDocsBuild).not.toHaveBeenCalled();
			expect(updateBuildProgress).not.toHaveBeenCalled();
			expect(namespace.getByName).not.toHaveBeenCalled();
		},
	);
});

it("persists a failed build and rethrows without logging source content", async () => {
	vi.clearAllMocks();
	vi.mocked(getSiteById).mockResolvedValue({ id: "site" } as never);
	vi.mocked(getBuild).mockResolvedValue({
		id: "build",
		siteId: "site",
		status: "queued",
	} as never);
	const deleteFile = vi.fn().mockResolvedValue(undefined);
	namespace.getByName.mockReturnValue({ deleteFile });
	const failure = new Error("private source /tenant/acme/docs/token.md");
	const step = { do: vi.fn().mockRejectedValue(failure) };
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await expect(
			DocsBuildWorkflow.prototype.run.call(
				{
					env: {
						DB: {},
						DOCS_BUILD_SANDBOX: { getByName: namespace.getByName },
					},
				} as unknown as DocsBuildWorkflow,
				{
					payload: { operation: "build", siteId: "site", buildId: "build" },
				} as never,
				step as never,
			),
		).rejects.toBe(failure);
		expect(updateBuildProgress).toHaveBeenNthCalledWith(2, {}, "build", {
			status: "failed",
			phase: "failed",
			error: failure.message,
		});
		expect(log).toHaveBeenCalledExactlyOnceWith({
			component: "docs",
			event: "docs.build_failed",
			exception: { name: "Error" },
		});
		expect(deleteFile).toHaveBeenCalled();
	} finally {
		log.mockRestore();
	}
});
