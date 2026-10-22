import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function read(path: string): string {
	return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function job(workflow: string, name: string): string {
	const start = workflow.indexOf(`\n  ${name}:\n`);
	expect(start).toBeGreaterThan(-1);
	const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/);
	return next === -1
		? workflow.slice(start)
		: workflow.slice(start, start + 1 + next);
}

describe("public CI policy", () => {
	test("verifies and builds the tagged CLI without managed publication credentials", () => {
		const workflow = read(".github/workflows/oss-cli-release.yml");
		expect(workflow).toContain('      - "cli-v*"');
		expect(workflow).toContain(
			"github.repository == 'tedix-hq/tedix' && github.event.repository.private == false",
		);
		expect(workflow).toContain('test "${GITHUB_REF_NAME}" = "cli-v${VERSION}"');
		expect(workflow).toContain("build:standalone ${{ matrix.target }}");
		expect(workflow).toContain("actions/upload-artifact@");
		expect(workflow).toContain("sha256sum tedix-* > SHA256SUMS");
		expect(workflow).toContain("actions/attest-build-provenance@");
		expect(workflow).toContain("permissions:\n  contents: read\n");
		expect(workflow).not.toContain("${{ secrets.");
		expect(workflow).not.toContain("CLOUDFLARE_ACCOUNT_ID");
		expect(workflow).not.toContain("wrangler r2");
		expect(workflow).not.toContain("gh release");
	});

	test("uses only immutable remote actions and read-only repository access", () => {
		const workflow = read(".github/workflows/oss-public-ci.yml");
		expect(workflow).toContain("  push:\n    branches: [main]\n");
		expect(workflow).not.toMatch(/^\s+schedule:/m);
		expect(workflow).toContain("permissions:\n  contents: read\n");
		expect(job(workflow, "verify")).toContain("cancel-in-progress: true");
		expect(workflow.slice(0, workflow.indexOf("\njobs:"))).toContain(
			"cancel-in-progress: false",
		);
		expect(workflow).not.toContain("${{ secrets.");
		expect(workflow).not.toMatch(/^[ \t]+permissions:/m);

		for (const match of workflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)) {
			const action = match[1] ?? "";
			if (action.startsWith("./")) continue;
			expect(action).toMatch(/@[0-9a-f]{40}$/);
		}
	});

	test("installs the OS browser before either lane can run its tests", () => {
		const workflow = read(".github/workflows/oss-public-ci.yml");
		for (const [name, command] of [
			["verify", "run: bun run verify"],
			["tests", "run: bun run test:ci"],
		] as const) {
			const lane = job(workflow, name);
			const resolve = lane.indexOf(
				"run: node scripts/ci/full-suite-hourly.mjs browsers apps/os test:ci",
			);
			const install = lane.indexOf(
				"uses: ./.github/actions/playwright-browsers",
			);
			expect(resolve).toBeGreaterThan(-1);
			expect(resolve).toBeLessThan(install);
			expect(lane).toContain(
				"browsers: ${{ steps.os-browsers.outputs.browsers }}",
			);
			expect(install).toBeLessThan(lane.indexOf(command));
		}
	});

	test("skips automatic runs in a private repository", () => {
		const workflow = read(".github/workflows/oss-public-ci.yml");
		expect(job(workflow, "verify")).toContain(
			"github.event.repository.private == false &&",
		);
		for (const name of ["policy", "types", "tests", "build"]) {
			const heavy = job(workflow, name);
			expect(heavy).toContain(
				"(inputs.force_full == true || github.event_name != 'push') &&",
			);
			expect(heavy).toContain("github.event.repository.private == false");
		}
	});
});
