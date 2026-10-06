import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	mkdtemp,
	readdir,
	mkdir,
	writeFile,
	readFile,
	cp,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	prepareAuthoringWorkspace,
	AUTHORING_TOOLS,
} from "./authoring-workspace";
import { materializeEditableThemeSource } from "./source-provenance";
vi.mock("./source-provenance", () => ({
	materializeEditableThemeSource: vi.fn(async () => undefined),
}));
function fixture(state = "pristine", main = "a".repeat(40)) {
	const scripts: string[] = [];
	const writes: Array<[string, string]> = [];
	const sandbox = {
		exec: async (args: string[]) => {
			const script = args[2]!;
			scripts.push(script);
			return {
				output: async () => ({
					exitCode: 0,
					stderr: "",
					stdout: script.includes("elif diff")
						? state
						: script.includes("git ls-remote")
							? `${main}\trefs/heads/main`
							: "",
				}),
			};
		},
		writeFile: async (path: string, content: string) => {
			writes.push([path, content]);
		},
		readFile: async (_path: string) => ({ content: "", size: 0 }),
		listFiles: async () => [],
		mkdir: async () => undefined,
	};
	return { sandbox, scripts, writes };
}
beforeEach(() => vi.clearAllMocks());
describe("authoring workspace restart hydration", () => {
	it("hydrates the authoring main into a private prepared marketing workspace", async () => {
		const f = fixture();
		await prepareAuthoringWorkspace(f.sandbox, {
			templateSlug: "marketing",
			existingSite: true,
			source: { remote: "https://example.test/repo.git", token: "private" },
		});
		expect(f.scripts.some((s) => s.includes("refs/heads/main"))).toBe(true);
		expect(
			f.scripts.some((s) =>
				s.includes("cp -a /workspace-templates/marketing/"),
			),
		).toBe(true);
		expect(materializeEditableThemeSource).toHaveBeenCalledWith(
			f.sandbox,
			expect.objectContaining({
				commit: "a".repeat(40),
				templateSlug: "marketing",
				workspace: expect.stringMatching(/^\/tmp\/cms-authoring-/),
			}),
		);
		expect(f.writes.some(([p]) => p.endsWith(".tedix-authoring-ready"))).toBe(
			true,
		);
		expect(
			f.scripts.some(
				(s) => s.includes("diff -qr") && s.includes("mv /workspace"),
			),
		).toBe(true);
	});
	it("refreshes an already-ready workspace's locked files once without replacing tenant source", async () => {
		const f = fixture("ready");
		const files = new Map<string, string>([
			["/workspace/src/pages/index.astro", "tenant draft"],
			["/workspace/public/custom.svg", "asset"],
		]);
		f.sandbox.readFile = async (path: string) => ({
			content: files.get(path) ?? "",
			size: 0,
		});
		f.sandbox.writeFile = async (path: string, content: string) => {
			f.writes.push([path, content]);
			files.set(path, content);
		};
		await prepareAuthoringWorkspace(f.sandbox, {
			templateSlug: "marketing",
			existingSite: true,
		});
		expect(
			files.get("/workspace/src/plugins/tedix-seo-aeo/metadata.ts"),
		).toContain("seoAeoPluginMetadata");
		expect(files.get("/workspace/src/pages/index.astro")).toBe("tenant draft");
		expect(files.get("/workspace/public/custom.svg")).toBe("asset");
		expect(materializeEditableThemeSource).not.toHaveBeenCalled();
		const count = f.writes.length;
		await prepareAuthoringWorkspace(f.sandbox, {
			templateSlug: "marketing",
			existingSite: true,
		});
		expect(f.writes).toHaveLength(count);
		expect(
			f.scripts.filter((script) => script.includes("bun install")),
		).toHaveLength(1);
	});
	it.each(["modified"])(
		"preserves %s source without fetching or writing",
		async (state) => {
			const f = fixture(state);
			expect(
				await prepareAuthoringWorkspace(f.sandbox, {
					templateSlug: "marketing",
					existingSite: true,
				}),
			).toBe(state);
			expect(f.writes).toEqual([]);
			expect(materializeEditableThemeSource).not.toHaveBeenCalled();
		},
	);
	it("selects the configured starter only for a new site", async () => {
		const f = fixture();
		expect(
			await prepareAuthoringWorkspace(f.sandbox, {
				templateSlug: "marketing",
				existingSite: false,
			}),
		).toBe("starter");
		expect(
			f.scripts.some((s) => s.includes("/workspace-templates/marketing/")),
		).toBe(true);
	});
	it("refuses missing source for an existing site before changing the workspace", async () => {
		const f = fixture();
		await expect(
			prepareAuthoringWorkspace(f.sandbox, {
				templateSlug: "tedix",
				existingSite: true,
			}),
		).rejects.toThrow("no recoverable");
		expect(f.scripts.some((s) => s.includes("mv /workspace"))).toBe(false);
	});
	it("failed source validation never swaps the authoring workspace", async () => {
		vi.mocked(materializeEditableThemeSource).mockRejectedValueOnce(
			new Error("missing migration marker"),
		);
		const f = fixture();
		await expect(
			prepareAuthoringWorkspace(f.sandbox, {
				templateSlug: "tedix",
				existingSite: true,
				source: { remote: "https://example.test/repo.git", token: "private" },
			}),
		).rejects.toThrow("missing migration marker");
		expect(f.scripts.some((s) => s.includes("mv /workspace"))).toBe(false);
		expect(f.writes.some(([p]) => p.endsWith(".tedix-authoring-ready"))).toBe(
			false,
		);
	});
	it("covers editing and preview without hydrating discovery or immutable deployments", () => {
		for (const tool of [
			"theme_read_file",
			"theme_write_file",
			"theme_write_files",
			"theme_delete_file",
			"theme_build",
			"theme_preview_start",
			"theme_preview_exec",
		])
			expect(AUTHORING_TOOLS.has(tool)).toBe(true);
		for (const tool of [
			"theme_workspace_status",
			"theme_deploy",
			"content_update",
		])
			expect(AUTHORING_TOOLS.has(tool)).toBe(false);
	});
});

it("swaps a prepared marketing source on disk and preserves subsequent edits", async () => {
	const root = await mkdtemp(join(tmpdir(), "cms-hydration-"));
	const workspace = join(root, "site");
	const templates = join(root, "templates");
	const exec = promisify(execFile);
	try {
		for (const slug of ["tedix", "marketing"]) {
			await mkdir(join(templates, slug, "src"), { recursive: true });
			await writeFile(join(templates, slug, "src", "index.astro"), slug);
		}
		await cp(join(templates, "tedix"), workspace, { recursive: true });
		await mkdir(join(workspace, "public"));
		await writeFile(join(workspace, "public", "custom.svg"), "custom asset");
		expect(
			await prepareAuthoringWorkspace(
				{
					exec: async (args: string[]) => ({
						output: async () => {
							const script = args[2]!
								.replaceAll("/workspace-templates", templates)
								.replaceAll("/workspace", workspace)
								.replaceAll("/tmp/cms-authoring-", join(root, "prepared-"));
							const result = await exec("sh", ["-c", script]);
							return { ...result, exitCode: 0 };
						},
					}),
					writeFile: async () => {
						throw new Error("must not write");
					},
					readFile: async (_path: string) => ({ content: "", size: 0 }),
					listFiles: async () => [],
					mkdir: async () => undefined,
				},
				{ templateSlug: "marketing", existingSite: false },
			),
		).toBe("modified");
		expect(
			await readFile(join(workspace, "public", "custom.svg"), "utf8"),
		).toBe("custom asset");
		await rm(join(workspace, "public"), { recursive: true });

		const map = (s: string) =>
			s
				.replaceAll("/workspace-templates", templates)
				.replaceAll("/workspace", workspace)
				.replaceAll("/tmp/cms-authoring-", join(root, "prepared-"));
		const sandbox = {
			exec: async (args: string[]) => ({
				output: async () => {
					try {
						const result = await exec("sh", [
							"-c",
							map(args[2]!).replace("bun install --frozen-lockfile", "true"),
						]);
						return { ...result, exitCode: 0 };
					} catch (error) {
						const e = error as { stdout: string; stderr: string; code: number };
						return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
					}
				},
			}),
			writeFile: async (path: string, content: string) =>
				writeFile(map(path), content),
			readFile: async (path: string) => ({
				content: await readFile(map(path), "utf8"),
				size: 0,
			}),
			listFiles: async () => [],
			mkdir: async (path: string) => {
				await mkdir(map(path), { recursive: true });
			},
		};
		await prepareAuthoringWorkspace(sandbox, {
			templateSlug: "marketing",
			existingSite: false,
		});
		expect(await readFile(join(workspace, "src", "index.astro"), "utf8")).toBe(
			"marketing",
		);
		await writeFile(join(workspace, "src", "index.astro"), "unsaved draft");
		expect(
			await prepareAuthoringWorkspace(sandbox, {
				templateSlug: "marketing",
				existingSite: true,
			}),
		).toBe("ready");
		expect(await readFile(join(workspace, "src", "index.astro"), "utf8")).toBe(
			"unsaved draft",
		);
		// A new container loses its local marker and source; it must prepare again.
		await rm(workspace, { recursive: true });
		await cp(join(templates, "tedix"), workspace, { recursive: true });
		await prepareAuthoringWorkspace(sandbox, {
			templateSlug: "marketing",
			existingSite: false,
		});
		expect(await readFile(join(workspace, "src", "index.astro"), "utf8")).toBe(
			"marketing",
		);

		expect(
			(await readdir(root)).some((name) => name.endsWith(".previous")),
		).toBe(true);
		await rm(workspace, { recursive: true });
		await cp(join(templates, "tedix"), workspace, { recursive: true });
		const racing = {
			...sandbox,
			writeFile: async (path: string, content: string) => {
				await writeFile(map(path), content);
				if (path.endsWith(".tedix-authoring-ready")) {
					await mkdir(join(workspace, "public"));
					await writeFile(
						join(workspace, "public", "during-prepare.svg"),
						"keep this",
					);
				}
			},
		};
		await expect(
			prepareAuthoringWorkspace(racing, {
				templateSlug: "marketing",
				existingSite: false,
			}),
		).rejects.toThrow("existing source was preserved");
		expect(
			await readFile(join(workspace, "public", "during-prepare.svg"), "utf8"),
		).toBe("keep this");
		expect(await readFile(join(workspace, "src", "index.astro"), "utf8")).toBe(
			"tedix",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
