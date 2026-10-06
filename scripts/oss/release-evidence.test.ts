import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { detachedGitEnv } from "./git-env";
import { checkPublicSurface } from "./public-surface";
import { generateReleaseEvidence, readCommitBlobs } from "./release-evidence";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const tempRoot = tmpdir();
const outputRoots: string[] = [];
let firstOutput: string;
let secondOutput: string;

function git(args: string[]): Buffer {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		env: detachedGitEnv(),
		maxBuffer: 128 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
	return result.stdout;
}

function json(name: string): any {
	return JSON.parse(readFileSync(resolve(firstOutput, name), "utf8"));
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function property(component: any, name: string): string | undefined {
	return component.properties?.find((entry: any) => entry.name === name)?.value;
}

beforeAll(() => {
	firstOutput = mkdtempSync(resolve(tempRoot, "tedix-oss-evidence-a-"));
	secondOutput = mkdtempSync(resolve(tempRoot, "tedix-oss-evidence-b-"));
	outputRoots.push(firstOutput, secondOutput);
	// License resolution has its own test; an empty registry keeps this one offline.
	const dependencyLicenses = {
		schemaVersion: 1 as const,
		lockfiles: [],
		entries: [],
		summary: { packages: 0, unresolved: 0 },
	};
	generateReleaseEvidence(repositoryRoot, {
		dependencyLicenses,
		out: firstOutput,
	});
	generateReleaseEvidence(repositoryRoot, {
		dependencyLicenses,
		out: secondOutput,
	});
}, 30_000);

afterAll(() => {
	for (const path of outputRoots)
		rmSync(path, { force: true, recursive: true });
});

describe("OSS release evidence", () => {
	test("is byte-for-byte deterministic across output directories", () => {
		const firstNames = readdirSync(firstOutput).sort();
		const secondNames = readdirSync(secondOutput).sort();
		expect(firstNames).toEqual([
			"checksums.txt",
			"license-inventory.json",
			"migration-metadata.json",
			"provenance.json",
			"source.cdx.json",
		]);
		expect(secondNames).toEqual(firstNames);
		for (const name of firstNames) {
			expect(readFileSync(resolve(firstOutput, name))).toEqual(
				readFileSync(resolve(secondOutput, name)),
			);
		}
	});

	test("records the exact selected commit and public workspace coverage", () => {
		const commit = git(["rev-parse", "HEAD^{commit}"]).toString("utf8").trim();
		const provenance = json("provenance.json");
		const inventory = json("license-inventory.json");
		const sourceBom = json("source.cdx.json");
		const surface = checkPublicSurface(repositoryRoot, commit, false);
		expect(sourceBom.bomFormat).toBe("CycloneDX");
		expect(sourceBom.specVersion).toBe("1.6");
		expect(provenance.publicCommit).toBe(commit);
		expect(provenance.requestedRef).toBe("HEAD");
		expect(inventory.publicCommit).toBe(commit);
		expect(inventory.workspaces.map((entry: any) => entry.path)).toEqual(
			surface.resolved.map((entry) => entry.path),
		);
		expect(provenance.artifactScope.publicWorkspaces).toEqual(
			surface.resolved.map((entry) => entry.path),
		);
		expect(
			sourceBom.components
				.filter(
					(component: any) =>
						property(component, "tedix:component-kind") === "workspace",
				)
				.map((component: any) => property(component, "tedix:workspace-path")),
		).toEqual(surface.resolved.map((entry) => entry.path));
	});

	/**
	 * A plain registry dependency must carry
	 * the lockfile integrity and must NOT claim a local-archive hash. That
	 * still exercises the locked-npm SBOM path and additionally fails if a
	 * stale vendored entry is ever reintroduced without its archive.
	 */
	test("tracks a registry dependency by lockfile integrity alone", () => {
		const sourceBom = json("source.cdx.json");
		const computer = sourceBom.components.find(
			(component: any) =>
				component.name === "@cloudflare/computer" &&
				property(component, "tedix:component-kind") === "locked-npm",
		);
		const lock = parse(git(["show", "HEAD:bun.lock"]).toString("utf8"), [], {
			allowTrailingComma: true,
		});
		const locked = lock.packages["@cloudflare/computer"];
		const integrity = locked.find(
			(value: unknown) =>
				typeof value === "string" && value.startsWith("sha512-"),
		);
		expect(property(computer, "tedix:bun-locator")).toBe(locked[0]);
		expect(property(computer, "tedix:bun-integrity")).toBe(integrity);
		expect(computer.hashes).toContainEqual({
			alg: "SHA-512",
			content: Buffer.from(
				integrity.slice("sha512-".length),
				"base64",
			).toString("hex"),
		});
		expect(computer.hashes.some((hash: any) => hash.alg === "SHA-256")).toBe(
			false,
		);
	});

	test("includes tracked Python requirements and container base images", () => {
		const sourceBom = json("source.cdx.json");
		const commit = sourceBom.metadata.component.version;
		const trackedPaths = git(["ls-tree", "-r", "--name-only", commit])
			.toString("utf8")
			.split("\n")
			.filter(Boolean);
		const pythonPaths = new Set(
			sourceBom.components
				.filter(
					(component: any) =>
						property(component, "tedix:component-kind") ===
						"python-requirement",
				)
				.map((component: any) => property(component, "tedix:source-path")),
		);
		const containerPaths = new Set(
			sourceBom.components
				.filter(
					(component: any) =>
						property(component, "tedix:component-kind") ===
						"container-base-image",
				)
				.map((component: any) => property(component, "tedix:source-path")),
		);
		expect(pythonPaths).toEqual(
			new Set(
				trackedPaths.filter((path) => path.endsWith("/requirements.txt")),
			),
		);
		expect(containerPaths).toEqual(
			new Set(
				trackedPaths.filter((path) =>
					/(?:^|\/)Dockerfile(?:\..+)?$/.test(path),
				),
			),
		);
		const nonNpmComponents = sourceBom.components.filter((component: any) =>
			["python-requirement", "container-base-image"].includes(
				property(component, "tedix:component-kind"),
			),
		);
		expect(nonNpmComponents).not.toHaveLength(0);
		for (const component of nonNpmComponents) {
			expect(component.licenses).not.toContainEqual({
				license: { name: "NOASSERTION" },
			});
			expect(component.hashes).toEqual([
				{ alg: "SHA-256", content: expect.stringMatching(/^[a-f0-9]{64}$/) },
			]);
			expect(property(component, "tedix:license-evidence")).toMatch(
				/^https:\/\//,
			);
		}
		for (const component of nonNpmComponents.filter(
			(component: any) =>
				property(component, "tedix:component-kind") === "container-base-image",
		)) {
			expect(property(component, "tedix:container-locator")).toContain(
				"@sha256:",
			);
			expect(property(component, "tedix:container-locator")).not.toContain(
				"${",
			);
		}
	});

	test("hashes every tracked database migration from the selected commit", () => {
		const metadata = json("migration-metadata.json");
		const commit = metadata.publicCommit;
		const expectedPaths = git(["ls-tree", "-r", "--name-only", commit])
			.toString("utf8")
			.split("\n")
			.filter(
				(path) => path.startsWith("packages/db/") && path.endsWith(".sql"),
			)
			.sort();
		expect(metadata.migrations.map((entry: any) => entry.path)).toEqual(
			expectedPaths,
		);
		for (const migration of metadata.migrations) {
			expect(migration.sha256).toBe(
				sha256(git(["show", `${commit}:${migration.path}`])),
			);
		}
	});

	test("checksums every other emitted artifact", () => {
		const lines = readFileSync(resolve(firstOutput, "checksums.txt"), "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(4);
		const checkedNames: string[] = [];
		for (const line of lines) {
			const match = line.match(/^([a-f0-9]{64})  (.+)$/);
			expect(match).not.toBeNull();
			const [, expected, name] = match!;
			checkedNames.push(name!);
			expect(expected).toBe(sha256(readFileSync(resolve(firstOutput, name!))));
		}
		expect(checkedNames.sort()).toEqual(
			readdirSync(firstOutput)
				.filter((name) => name !== "checksums.txt")
				.sort(),
		);
	});
});

describe("readCommitBlobs", () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-commit-blobs-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			env: detachedGitEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		})
			.toString()
			.trim();
	git("init");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	const binary = Buffer.from([0, 10, 255, 13, 65]);
	const paths = Array.from({ length: 101 }, (_, index) => `file ${index}`);
	for (const path of paths) writeFileSync(join(root, path), binary);
	git("add", ".");
	git("commit", "-m", "fixture");
	const commit = git("rev-parse", "HEAD");
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test("batches exact-commit binary bytes across chunk boundaries, ignoring dirty files", () => {
		writeFileSync(join(root, paths[0]!), "changed");
		const blobs = readCommitBlobs(root, commit, paths, new Set(paths));
		expect(blobs.size).toBe(101);
		for (const path of paths) expect(blobs.get(path)).toEqual(binary);
	});

	test("rejects unselected paths, injected records, missing objects and mutable refs", () => {
		expect(() => readCommitBlobs(root, commit, [paths[0]!], new Set())).toThrow(
			"not selected",
		);
		expect(() =>
			readCommitBlobs(root, commit, ["bad\npath"], new Set(["bad\npath"])),
		).toThrow("not selected");
		expect(() =>
			readCommitBlobs(root, commit, ["absent"], new Set(["absent"])),
		).toThrow("Missing");
		expect(() => readCommitBlobs(root, "HEAD", paths, new Set(paths))).toThrow(
			"exact commit",
		);
		expect(readCommitBlobs(root, commit, [], new Set()).size).toBe(0);
	});
});
