/**
 * Missing instruction files are provisioned from the tedi's generated defaults
 * and used in the same turn; unreadable repos and failures provision nothing.
 * Run: `bun run src/identity-provisioning.test.ts`.
 */
import assert from "node:assert/strict";
import {
	type IdentityProvisioningDeps,
	provisionMissingIdentityFiles,
} from "./identity-provisioning";
import type { IdentityReadDiagnostics } from "./workspace";

const env = {
	API_SERVICE: {} as Fetcher,
	ARTIFACTS: {} as Artifacts,
	CF_ACCOUNT_ID: "account",
};
function diagnostics(
	missing: string[],
	artifacts: Partial<IdentityReadDiagnostics["artifacts"]> = {},
): IdentityReadDiagnostics {
	return {
		checkedAt: "2026-11-18T00:00:00Z",
		tediId: "tedi-1",
		artifacts: {
			bound: true,
			configured: true,
			repoName: "tedi-1",
			repoFound: true,
			cloneOk: true,
			...artifacts,
		},
		files: [],
		provisionedFiles: [],
		missingFiles: missing,
	};
}
function deps(overrides: Partial<IdentityProvisioningDeps> = {}) {
	const commits: { path: string; content: string }[][] = [];
	const value: IdentityProvisioningDeps = {
		fetchWorkspaceFiles: async () => ({
			"SOUL.md": "soul",
			"IDENTITY.md": "identity",
			"MEMORY.md": "memory",
			"TOOLS.md": "",
		}),
		commit: async (_artifacts, options) => {
			commits.push(options.files);
			return null;
		},
		...overrides,
	};
	return { value, commits };
}
const input = (d: IdentityReadDiagnostics) => ({
	tediId: "tedi-1",
	organizationId: "org-1",
	slug: "cto",
	diagnostics: d,
});

{
	const { value, commits } = deps();
	const files = await provisionMissingIdentityFiles(
		env,
		input(diagnostics(["SOUL.md", "memory/MEMORY.md", "TOOLS.md"])),
		value,
	);
	assert.deepEqual(
		files,
		[
			{ key: "SOUL.md", text: "soul" },
			{ key: "memory/MEMORY.md", text: "memory" },
		],
		"missing files are committed and returned; empty defaults are skipped",
	);
	assert.deepEqual(commits, [
		[
			{ path: "SOUL.md", content: "soul" },
			{ path: "memory/MEMORY.md", content: "memory" },
		],
	]);
}

for (const d of [
	diagnostics([]),
	diagnostics(["SOUL.md"], { error: "clone failed" }),
	diagnostics(["SOUL.md"], { cloneOk: false }),
]) {
	const { value, commits } = deps();
	assert.deepEqual(
		await provisionMissingIdentityFiles(env, input(d), value),
		[],
	);
	assert.deepEqual(
		commits,
		[],
		"nothing missing, or an unreadable repo, provisions nothing",
	);
}

{
	const { value, commits } = deps();
	const files = await provisionMissingIdentityFiles(
		env,
		input(diagnostics(["SOUL.md"], { repoFound: false, cloneOk: false })),
		value,
	);
	assert.deepEqual(files, [{ key: "SOUL.md", text: "soul" }]);
	assert.equal(commits.length, 1, "a tedi without a repo gets one created");
}

{
	const { value, commits } = deps();
	assert.deepEqual(
		await provisionMissingIdentityFiles(
			{ ...env, API_SERVICE: undefined },
			input(diagnostics(["SOUL.md"])),
			value,
		),
		[],
	);
	assert.deepEqual(commits, [], "no API binding provisions nothing");
}

{
	const { value } = deps({
		commit: async () => {
			throw new Error("push rejected");
		},
	});
	assert.deepEqual(
		await provisionMissingIdentityFiles(
			env,
			input(diagnostics(["SOUL.md"])),
			value,
		),
		[],
		"a failed commit leaves the files missing for this turn",
	);
}
