import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportPortableTedi,
	gatewayPortableTediDestination,
	importPortableTedi,
	type PortableTediDestination,
	gatewayPortableTediSource,
	type PortableTediSource,
} from "./portable-tedi";

const tediId = "a4d6765f-786b-446b-b9d1-3573b4330b9a";

function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args]);
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
	return new TextDecoder().decode(result.stdout).trim();
}

async function sourceRepo(base: string, secretInHistory = false) {
	const repo = join(base, "source");
	git("init", "-b", "main", repo);
	await writeFile(
		join(repo, "SOUL.md"),
		secretInHistory ? `sk_${"a".repeat(32)}\n` : "Original identity\n",
	);
	git("-C", repo, "add", "SOUL.md");
	git(
		"-C",
		repo,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"first operating file",
	);
	await writeFile(join(repo, "SOUL.md"), "Current identity\n");
	git("-C", repo, "add", "SOUL.md");
	git(
		"-C",
		repo,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"second operating file",
	);
	return repo;
}

function mockSource(remote: string, factContent = "A remembered fact") {
	return {
		gitAccess: async () => ({
			repoFound: true,
			remote,
			token: "test-token",
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			snapshot: {
				url: "https://api.tedix.dev/portable/tedis/a4d6765f-786b-446b-b9d1-3573b4330b9a/snapshot",
				token: "test-snapshot-token",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			},
			identity: {
				name: "Tedi A",
				slug: "tedi-a",
				displayName: null,
				personality: null,
				avatar: null,
				timezone: null,
				language: null,
				tags: [],
				installedSkills: [],
				installedPlugins: [],
			},
			bindings: {
				runtimeProfile: null,
				policyPack: null,
				workspaceTemplateSet: null,
				apps: [],
			},
		}),
		readPage: async (input: { section: string; afterId?: string }) => {
			if (input.section !== "memoryFacts" || input.afterId) {
				return { text: "", nextAfterId: null, rowCount: 0 };
			}
			const row = JSON.stringify({
				id: "fact-one",
				content: factContent,
				factType: "fact",
				confidence: 1,
				accessCount: 0,
				usageCount: 0,
			});
			return {
				text: row,
				nextAfterId: null,
				rowCount: 1,
			};
		},
	} as never;
}

describe("portable tedi Git bundle", () => {
	test("reports destination conflicts from Code Mode without parsing them as access", async () => {
		const destination = gatewayPortableTediDestination({
			runCode: async () => ({
				result: {
					ok: false,
					error: { message: "A tedi with this slug already exists" },
				},
			}),
		} as never);
		await expect(destination.begin({} as never, "taken-slug")).rejects.toThrow(
			"A tedi with this slug already exists",
		);
	});

	test("downloads a bulk page with the scoped bearer", async () => {
		const originalFetch = globalThis.fetch;
		let observedUrl = "";
		let observedAuthorization = "";
		globalThis.fetch = (async (input, init) => {
			observedUrl = String(input);
			observedAuthorization = String(
				new Headers(init?.headers).get("Authorization"),
			);
			return new Response(
				JSON.stringify({
					section: "memoryFacts",
					rows: [],
					nextAfterId: null,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		try {
			const access = await (
				mockSource("https://example.com/repo.git") as PortableTediSource
			).gitAccess(tediId);
			const source = gatewayPortableTediSource({} as never);
			expect(
				await source.readPage({ access, tediId, section: "memoryFacts" }),
			).toEqual({ text: "", nextAfterId: null, rowCount: 0 });
			expect(observedUrl).toContain(
				`/portable/tedis/${tediId}/snapshot/memoryFacts?limit=500`,
			);
			expect(observedAuthorization).toBe("Bearer test-snapshot-token");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("carries full source history and a verified cognitive snapshot", async () => {
		const base = await mkdtemp(join(tmpdir(), "tedix-portable-test-"));
		try {
			const source = await sourceRepo(base);
			const outputPath = join(base, "tedi.bundle");
			const result = await exportPortableTedi({
				tediId,
				outputPath,
				source: mockSource(source),
			});
			expect(result.snapshotRows).toBe(1);
			expect(result.sourceHead).toBe(git("-C", source, "rev-parse", "HEAD"));
			const restored = join(base, "restored");
			git("clone", outputPath, restored);
			const history = git("-C", restored, "log", "--all", "--format=%s");
			expect(history).toContain("first operating file");
			expect(history).toContain("second operating file");
			expect(history).toContain("Portable tedi snapshot");
			const manifest = JSON.parse(
				await readFile(join(restored, ".tedix-portable/manifest.json"), "utf8"),
			);
			expect(manifest.sourceTediId).toBe(tediId);
			expect(manifest.artifacts.head).toBe(result.sourceHead);
			expect(manifest.files.memoryFacts.count).toBe(1);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("imports verified memory and restores the original Git head into a paused destination", async () => {
		const base = await mkdtemp(join(tmpdir(), "tedix-portable-import-test-"));
		try {
			const source = await sourceRepo(base);
			const outputPath = join(base, "tedi.bundle");
			const exported = await exportPortableTedi({
				tediId,
				outputPath,
				source: mockSource(source),
			});
			const destinationRepo = join(base, "destination.git");
			git("init", "--bare", "-b", "main", destinationRepo);
			const uploaded: Array<{ section: string; rows: unknown[] }> = [];
			const destination: PortableTediDestination = {
				begin: async (manifest) =>
					({
						tediId: "ace596c4-40ef-4b53-9aef-fb1d62f53da4",
						manifestSha256: createHash("sha256")
							.update(JSON.stringify(manifest))
							.digest("hex"),
						snapshot: {
							url: "https://api.tedix.dev/portable/tedis/ace596c4-40ef-4b53-9aef-fb1d62f53da4/import",
							token: "test-ticket",
							expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
						},
						git: {
							remote: destinationRepo,
							token: "test-write-token",
							expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
						},
					}) as never,
				upload: async ({ section, rows }) => {
					uploaded.push({ section, rows });
				},
				verify: async ({ manifest }) => {
					expect(manifest.files.memoryFacts.count).toBe(1);
				},
			};
			const result = await importPortableTedi({
				bundlePath: outputPath,
				destinationSlug: "tedi-restored",
				destination,
			});
			expect(result.status).toBe("paused");
			expect(result.importedRows).toBe(1);
			expect(
				uploaded.find((page) => page.section === "memoryFacts")?.rows,
			).toHaveLength(1);
			expect(
				git("--git-dir", destinationRepo, "rev-parse", "refs/heads/main"),
			).toBe(exported.sourceHead!);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("rejects a credential removed from the current tree but retained in history", async () => {
		const base = await mkdtemp(join(tmpdir(), "tedix-portable-test-"));
		try {
			const source = await sourceRepo(base, true);
			await expect(
				exportPortableTedi({
					tediId,
					outputPath: join(base, "tedi.bundle"),
					source: mockSource(source),
				}),
			).rejects.toThrow(/credential-shaped content/);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("rejects a credential in historical commit metadata", async () => {
		const base = await mkdtemp(join(tmpdir(), "tedix-portable-test-"));
		try {
			const source = await sourceRepo(base);
			git(
				"-C",
				source,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-m",
				`sk_${"b".repeat(32)}`,
			);
			await expect(
				exportPortableTedi({
					tediId,
					outputPath: join(base, "tedi.bundle"),
					source: mockSource(source),
				}),
			).rejects.toThrow(/credential-shaped content in commit/);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("accepts a validated snapshot blob larger than 16 MiB", async () => {
		const base = await mkdtemp(join(tmpdir(), "tedix-portable-test-"));
		try {
			const source = await sourceRepo(base);
			const outputPath = join(base, "large-snapshot.bundle");
			const result = await exportPortableTedi({
				tediId,
				outputPath,
				source: mockSource(source, "A".repeat(17 * 1024 * 1024)),
			});
			expect(result.snapshotRows).toBe(1);
			expect(git("bundle", "verify", outputPath)).toContain("complete history");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("carries a memory row larger than a Code Mode result", async () => {
		const base = await mkdtemp(join(tmpdir(), "tedix-portable-test-"));
		try {
			const source = await sourceRepo(base);
			const content = "Long memory ".repeat(600);
			const outputPath = join(base, "large.bundle");
			await exportPortableTedi({
				tediId,
				outputPath,
				source: mockSource(source, content),
			});
			const restored = join(base, "restored");
			git("clone", outputPath, restored);
			const row = JSON.parse(
				(
					await readFile(
						join(restored, ".tedix-portable/snapshot/memory-facts.ndjson"),
						"utf8",
					)
				).trim(),
			);
			expect(row.content).toBe(content);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
