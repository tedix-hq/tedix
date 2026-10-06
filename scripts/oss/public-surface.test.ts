import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	checkPublicSurface,
	discoverWorkspaceCandidates,
	validatePublicSurface,
} from "./public-surface";
import { detachedGitEnv } from "./git-env";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("workspace candidate discovery", () => {
	test("finds every first-party package project and skips vendored packages", () => {
		const manifests = execFileSync(
			"git",
			["ls-tree", "-r", "--name-only", "HEAD"],
			{ cwd: repositoryRoot, encoding: "utf8", env: detachedGitEnv() },
		)
			.split("\n")
			.filter(
				(path) => path !== "package.json" && path.endsWith("/package.json"),
			)
			.sort()
			.map((path) => path.slice(0, -"/package.json".length));
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		expect(candidates.map((candidate) => candidate.path)).toEqual(manifests);
		expect(
			candidates.find(
				(candidate) => candidate.path === "packages/design-tokens",
			)?.declaredLicense,
		).toBe("MIT");
		expect(
			candidates.find((candidate) => candidate.path === "apps/api")
				?.localDependencies.length,
		).toBeGreaterThan(0);
	});

	test("keeps embedded template installs fail-closed", () => {
		const templatePaths = discoverWorkspaceCandidates(repositoryRoot)
			.map((candidate) => candidate.path)
			.filter((path) => path.startsWith("apps/cms/templates/"));
		const names = templatePaths.map((path) => {
			const manifest = JSON.parse(
				readFileSync(resolve(repositoryRoot, path, "package.json"), "utf8"),
			) as { name?: string; private?: boolean };
			expect(manifest.private).toBe(true);
			expect(existsSync(resolve(repositoryRoot, path, "bun.lock"))).toBe(true);
			return manifest.name;
		});
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("positive public workspace surface", () => {
	test("keeps the interim marketing Worker in public product source", () => {
		const result = checkPublicSurface(repositoryRoot);
		expect(result.errors).toEqual([]);
		expect(
			result.resolved.find((entry) => entry.path === "apps/landing"),
		).toMatchObject({
			decision: "public-product",
			licenseClass: "agpl-product",
		});
	});

	test("classifies the exact candidate set and closes local dependency edges", () => {
		const result = checkPublicSurface(repositoryRoot);
		expect(result.errors).toEqual([]);
		expect(result.summary.workspaces).toBeGreaterThan(0);
		expect(
			result.summary.publicProduct +
				result.summary.publicEcosystem +
				result.summary.private,
		).toBe(result.summary.workspaces);
	});

	test("keeps product code AGPL and ecosystem surfaces permissive", () => {
		const result = checkPublicSurface(repositoryRoot);
		expect(
			result.resolved.find((entry) => entry.path === "apps/api")?.licenseClass,
		).toBe("agpl-product");
		expect(
			result.resolved.find((entry) => entry.path === "packages/api-contract")
				?.licenseClass,
		).toBe("apache-ecosystem");
		expect(
			result.resolved.find((entry) => entry.path === "packages/cli")
				?.licenseClass,
		).toBe("agpl-product");
	});

	test("rejects runtime edges from permissive ecosystem packages to AGPL product code", () => {
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		const ecosystem = candidates.find(
			(candidate) => candidate.path === "packages/api-contract",
		)!;
		const result = validatePublicSurface(manifest, [
			...candidates.filter((candidate) => candidate.path !== ecosystem.path),
			{
				...ecosystem,
				localDependencies: [
					...ecosystem.localDependencies,
					{
						group: "dependencies" as const,
						name: "@tedix/auth",
						specifier: "workspace:*",
						targets: ["packages/auth"],
					},
				],
			},
		]);
		expect(
			result.errors.some((error) =>
				error.includes("permissive ecosystem packages must not require AGPL"),
			),
		).toBe(true);
	});

	test("fails closed when a new workspace has no explicit classification", () => {
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		const addedWorkspace = {
			...candidates[0]!,
			manifestPath: "apps/new-workspace/package.json",
			name: "@tedix/new-workspace",
			path: "apps/new-workspace",
		};
		const result = validatePublicSurface(manifest, [
			...candidates,
			addedWorkspace,
		]);
		expect(result.errors).toContain(
			"workspace requires explicit classification: apps/new-workspace",
		);
		expect(
			result.resolved.find((entry) => entry.path === addedWorkspace.path)
				?.decision,
		).toBe("private");
	});

	test("rejects a removed workspace's stale classification", () => {
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		const removed = candidates[0]!;
		const result = validatePublicSurface(
			manifest,
			candidates.filter((candidate) => candidate.path !== removed.path),
		);
		expect(result.errors).toContain(
			`override references unknown workspace: ${removed.path}`,
		);
	});

	test("classifies every candidate workspace explicitly and defaults closed", () => {
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		// The default is what an unreviewed workspace inherits. It must withhold.
		expect(manifest.defaults.decision).toBe("private");
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const classified = new Set(
			manifest.overrides.map((override: { path: string }) => override.path),
		);
		expect(
			candidates
				.map((candidate) => candidate.path)
				.filter((path) => !classified.has(path)),
		).toEqual([]);
	});

	test("withholds a workspace classified private and counts it", () => {
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		const withheld = "packages/context-core";
		const baselinePrivate = validatePublicSurface(manifest, candidates).summary
			.private;
		const result = validatePublicSurface(
			{
				...manifest,
				overrides: manifest.overrides.map(
					(override: { path: string; decision: string }) =>
						override.path === withheld
							? { ...override, decision: "private" }
							: override,
				),
			},
			candidates,
		);
		expect(
			result.resolved.find((entry) => entry.path === withheld)?.decision,
		).toBe("private");
		expect(result.summary.private).toBe(baselinePrivate + 1);
	});

	test("rejects a default that publishes unclassified workspaces", () => {
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		const result = validatePublicSurface(
			{
				...manifest,
				defaults: { decision: "public-product", licenseClass: "agpl-product" },
			},
			candidates,
		);
		expect(
			result.errors.some((error) =>
				error.includes("default decision must be private"),
			),
		).toBe(true);
	});

	test("rejects a published workspace that depends on a withheld one", () => {
		const candidates = discoverWorkspaceCandidates(repositoryRoot);
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		// apps/api depends on packages/db; withholding the target alone would
		// export a lockfile that cannot install.
		const result = validatePublicSurface(
			{
				...manifest,
				overrides: manifest.overrides.map(
					(override: { path: string; decision: string }) =>
						override.path === "packages/db"
							? { ...override, decision: "private" }
							: override,
				),
			},
			candidates,
		);
		expect(
			result.errors.some((error) =>
				error.includes("may not depend on a withheld one"),
			),
		).toBe(true);
	});

	test("encodes public-main authority and bounded security embargoes", () => {
		const manifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "scripts/oss/public-surface.json"),
				"utf8",
			),
		);
		expect(manifest.authority.productSource).toBe("public-main");
		expect(manifest.authority.privateOpsAllowsPersistentProductPatches).toBe(
			false,
		);
		expect(manifest.authority.securityEmbargo.maximumDays).toBeLessThanOrEqual(
			30,
		);
	});
});
