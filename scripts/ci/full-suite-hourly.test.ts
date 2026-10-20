import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	workspaceMatrix,
	alreadyPassed,
	ciObservation,
} from "./full-suite-hourly.mjs";

describe("hourly full suite", () => {
	test("discovers every workspace with tests or types, including new and type-only packages", () => {
		const root = mkdtempSync(join(tmpdir(), "hourly-suite-"));
		try {
			for (const [workspace, scripts] of [
				["apps/new-app", { "test:run": "run-tests", "type-check": "tsc" }],
				["packages/types-only", { "type-check": "tsc" }],
				["packages/tests-only", { "test:run": "run-tests" }],
				["packages/config", {}],
			] as const) {
				mkdirSync(join(root, workspace), { recursive: true });
				writeFileSync(
					join(root, workspace, "package.json"),
					JSON.stringify({ scripts }),
				);
			}
			mkdirSync(join(root, "apps/no-manifest"));
			expect(workspaceMatrix(root).include).toEqual([
				{ workspace: "apps/new-app", test: true, types: true },
				{ workspace: "packages/tests-only", test: true, types: false },
				{ workspace: "packages/types-only", test: false, types: true },
			]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("skips only a successful run of this exact SHA and paginates history", async () => {
		const sha = "a".repeat(40);
		const requests: string[] = [];
		const request = async (path: string) => {
			requests.push(path);
			return {
				workflow_runs:
					requests.length === 1
						? Array.from({ length: 100 }, () => ({
								id: 1,
								head_sha: "b".repeat(40),
								conclusion: "success",
							}))
						: [{ id: 2, head_sha: sha, conclusion: "success" }],
			};
		};
		expect(
			await alreadyPassed({
				repository: "example/product",
				sha,
				runId: 3,
				request,
			}),
		).toBe(true);
		expect(requests[1]).toContain("page=2");
		for (const run of [
			{ id: 3, head_sha: sha, conclusion: "success" },
			{ id: 2, head_sha: sha, conclusion: "failure" },
			{ id: 2, head_sha: sha, conclusion: "cancelled" },
		])
			expect(
				await alreadyPassed({
					repository: "example/product",
					sha,
					runId: 3,
					request: async () => ({ workflow_runs: [run] }),
				}),
			).toBe(false);
		await expect(
			alreadyPassed({
				repository: "example/product",
				sha,
				runId: 3,
				request: async () => {
					throw new Error("API unavailable");
				},
			}),
		).rejects.toThrow("API unavailable");
	});
	test("aggregates all failing workspaces into one incident for the tested SHA", () => {
		const run = {
			path: ".github/workflows/full-suite-hourly.yml",
			head_branch: "main",
			head_repository: { full_name: "example/product" },
			conclusion: "failure",
			head_sha: "a".repeat(40),
			html_url: "https://github.com/example/product/actions/runs/1",
		};
		const report = (changed = {}) =>
			ciObservation({
				projectId: "project",
				repository: "example/product",
				run: { ...run, ...changed },
				jobs: [
					{
						name: "Workspace apps/api",
						conclusion: "failure",
						html_url: "https://example.test/job/1",
					},
					{
						name: "Workspace packages/db",
						conclusion: "timed_out",
						html_url: "https://example.test/job/2",
					},
					{ name: "Workspace apps/os", conclusion: "success" },
				],
			});
		expect(report()).toMatchObject({
			kind: "ci_red",
			surface: "full-suite-hourly",
			sha: run.head_sha,
		});
		expect(report().summary).toContain("Workspace apps/api");
		expect(report().summary).toContain("Workspace packages/db");
		expect(report().summary).not.toContain("Workspace apps/os");
		for (const changed of [
			{ head_branch: "topic" },
			{ path: "untrusted.yml" },
			{ head_repository: { full_name: "attacker/fork" } },
			{ conclusion: "cancelled" },
		])
			expect(() => report(changed)).toThrow();
	});
});
