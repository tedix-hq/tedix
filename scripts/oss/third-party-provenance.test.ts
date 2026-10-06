import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	renderThirdPartyNotices,
	checkRepositoryProvenance,
	validateProvenance,
	type ProvenanceRegistry,
} from "./third-party-provenance";
import { detachedGitEnv } from "./git-env";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const registry = JSON.parse(
	readFileSync(
		resolve(repositoryRoot, "scripts/oss/third-party-sources.json"),
		"utf8",
	),
) as ProvenanceRegistry;

describe("third-party provenance", () => {
	test("hashes symlinks consistently in a checkout and committed tree", () => {
		const root = mkdtempSync(resolve(tmpdir(), "provenance-symlink-"));
		try {
			mkdirSync(resolve(root, "scripts/oss"), { recursive: true });
			mkdirSync(resolve(root, "patches"));
			const target = "example.patch";
			writeFileSync(resolve(root, "patches", target), "example patch\n");
			symlinkSync(target, resolve(root, "patches/link.patch"));
			writeFileSync(resolve(root, "LICENSE"), "Example license\n");
			const hash = (text: string) =>
				createHash("sha256").update(text).digest("hex");
			const source: ProvenanceRegistry = {
				schemaVersion: 1,
				entries: [
					{
						id: "example",
						sourceKind: "dependency-patch",
						reviewStatus: "verified",
						coverage: {
							exactPaths: ["patches/example.patch", "patches/link.patch"],
						},
						upstream: {
							repository: "https://example.test/source",
							revision: "example",
						},
						license: { spdx: "MIT", textPath: "LICENSE" },
						notice: "Example fixture.",
						artifacts: [
							{
								path: "patches/example.patch",
								sha256: hash("example patch\n"),
							},
							{ path: "patches/link.patch", sha256: hash(target) },
						],
					},
				],
			};
			writeFileSync(
				resolve(root, "scripts/oss/third-party-sources.json"),
				JSON.stringify(source),
			);
			writeFileSync(
				resolve(root, "THIRD_PARTY_NOTICES.md"),
				renderThirdPartyNotices(source),
			);
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: root,
					env: detachedGitEnv(),
					stdio: "pipe",
				});
			git("init", "--quiet");
			git("add", ".");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.test",
				"commit",
				"--quiet",
				"-m",
				"Fixture",
			);
			expect(checkRepositoryProvenance(root, { strict: true }).errors).toEqual(
				[],
			);
			expect(
				checkRepositoryProvenance(root, { strict: true, ref: "HEAD" }).errors,
			).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("rejects unregistered nested patches even under a registered source prefix", () => {
		const path =
			"apps/cms/templates/example/patches/@example/plugin@1.0.0.patch";
		const source: ProvenanceRegistry = {
			schemaVersion: 1,
			entries: [
				{
					id: "example-scaffold",
					sourceKind: "copied-and-modified-source",
					reviewStatus: "needs-review",
					coverage: { prefixes: ["apps/cms/templates/example"] },
					upstream: { repository: null, revision: null },
					license: null,
					notice: null,
				},
			],
		};
		const tree = {
			files: [path],
			readBuffer: () => Buffer.from("patch"),
			readText: () => "patch",
		};
		expect(validateProvenance(source, tree).errors).toEqual([
			`unregistered third-party source: ${path}`,
		]);
		source.entries.push({
			...source.entries[0]!,
			id: "example-plugin-patch",
			sourceKind: "dependency-patch",
			coverage: { exactPaths: [path] },
		});
		expect(validateProvenance(source, tree).errors).toEqual([]);
	});

	test("renders stable notices from the registry", () => {
		const first = renderThirdPartyNotices(registry);
		const second = renderThirdPartyNotices(registry);
		expect(first).toBe(second);
		for (const entry of registry.entries) {
			expect(first).toContain(`## ${entry.id}\n`);
		}
		expect(first).not.toContain("## Pending review");
	});
});
