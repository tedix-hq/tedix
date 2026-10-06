import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	findCatalogEscapes,
	findLockfileDrift,
	formatFailure,
	workspaceDirectories,
} from "./check-deps.mjs";

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"check-deps.mjs",
);

/**
 * The shape the real repo has: a root manifest with a catalog, two members, and
 * a lockfile that agrees with all three. `bun.lock` is written with the trailing
 * commas Bun emits so the fixture exercises the JSONC parse too.
 */
function writeFixture({ osQueryRange, lockOsQueryRange }) {
	const root = mkdtempSync(join(tmpdir(), "lockfile-drift-"));
	mkdirSync(join(root, "apps/os"), { recursive: true });
	mkdirSync(join(root, "packages/ui"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "fixture",
			private: true,
			workspaces: ["packages/*", "apps/*"],
			catalog: { typescript: "^7.0.2" },
		}),
	);
	writeFileSync(
		join(root, "apps/os/package.json"),
		JSON.stringify({
			name: "@fixture/os",
			version: "0.1.0",
			dependencies: {
				"@tanstack/react-query": osQueryRange,
				typescript: "catalog:",
			},
		}),
	);
	writeFileSync(
		join(root, "packages/ui/package.json"),
		JSON.stringify({
			name: "@fixture/ui",
			version: "0.0.1",
			dependencies: { "@tanstack/react-query": "^5.90.0" },
		}),
	);
	writeFileSync(
		join(root, "bun.lock"),
		`{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture", },
    "apps/os": {
      "name": "@fixture/os",
      "version": "0.1.0",
      "dependencies": {
        "@tanstack/react-query": "${lockOsQueryRange}",
        "typescript": "catalog:",
      },
    },
    "packages/ui": {
      "name": "@fixture/ui",
      "version": "0.0.1",
      "dependencies": { "@tanstack/react-query": "^5.90.0", },
    },
  },
  "catalog": { "typescript": "^7.0.2", },
}
`,
	);
	return root;
}

function run(root) {
	return spawnSync("bun", [scriptPath, root], {
		encoding: "utf8",
	});
}

test("a lockfile that satisfies every manifest passes", () => {
	const root = writeFixture({
		osQueryRange: "^5.90.0",
		lockOsQueryRange: "^5.90.0",
	});
	try {
		const result = run(root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/no catalog escapes, and bun\.lock is current for all 3 workspace manifests/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a manifest bumped without regenerating bun.lock fails", () => {
	const root = writeFixture({
		osQueryRange: "^5.99.0",
		lockOsQueryRange: "^5.90.0",
	});
	try {
		const result = run(root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /bun\.lock does not match/);
		assert.match(
			result.stderr,
			/apps\/os · dependencies · @tanstack\/react-query/,
		);
		assert.match(result.stderr, /package\.json: \^5\.99\.0/);
		assert.match(result.stderr, /bun\.lock: +\^5\.90\.0/);
		// The half that costs hours has to be in the message, not just the diff.
		assert.match(result.stderr, /sibling workspace members/);
		assert.match(result.stderr, /bun run lint:deps/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("expands the workspace globs the way Bun keys the lockfile", () => {
	const root = writeFixture({
		osQueryRange: "^5.90.0",
		lockOsQueryRange: "^5.90.0",
	});
	try {
		assert.deepEqual(
			workspaceDirectories({ workspaces: ["packages/*", "apps/*"] }, root),
			["apps/os", "packages/ui"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("catches every drift shape the manifests can carry", () => {
	const findings = findLockfileDrift({
		manifests: new Map([
			[
				"",
				{
					name: "fixture",
					catalog: { typescript: "^7.0.2" },
					overrides: { zod: "4.4.4" },
					trustedDependencies: ["esbuild", "workerd"],
				},
			],
			["apps/os", { name: "@fixture/os", version: "0.2.0" }],
			["apps/new", { name: "@fixture/new" }],
			[
				"packages/mcp",
				{
					name: "@fixture/mcp",
					peerDependencies: { "@cloudflare/codemode": "^0.5.0" },
					peerDependenciesMeta: { "@cloudflare/codemode": { optional: true } },
				},
			],
		]),
		lock: {
			workspaces: {
				"": { name: "fixture" },
				"apps/os": { name: "@fixture/os", version: "0.1.0" },
				"packages/mcp": {
					name: "@fixture/mcp",
					peerDependencies: { "@cloudflare/codemode": "^0.5.0" },
				},
				"packages/deleted": { name: "@fixture/deleted" },
			},
			catalog: { typescript: "^7.0.1" },
			overrides: {},
			trustedDependencies: ["esbuild"],
		},
	});

	assert.deepEqual(
		findings.map((finding) => `${finding.workspace}:${finding.what}`),
		[
			"packages/deleted:workspace member",
			"apps/os:version",
			"apps/new:workspace member",
			"packages/mcp:optional peer · @cloudflare/codemode",
			":overrides · zod",
			":catalog · typescript",
			":trustedDependencies · workerd",
		],
	);
	assert.match(formatFailure(findings), /^ {2}<root> · catalog · typescript$/m);
});

test("a workspace member whose deps are untouched reports nothing", () => {
	assert.deepEqual(
		findLockfileDrift({
			manifests: new Map([
				[
					"apps/os",
					{
						name: "@fixture/os",
						version: "0.1.0",
						dependencies: { react: "catalog:" },
						devDependencies: {},
					},
				],
			]),
			lock: {
				workspaces: {
					"apps/os": {
						name: "@fixture/os",
						version: "0.1.0",
						dependencies: { react: "catalog:" },
						bin: { os: "./cli.ts" },
					},
				},
			},
		}),
		[],
	);
});

test("a workspace hard-coding a catalog-declared version is an escape", () => {
	const manifests = new Map([
		["", { catalog: { typescript: "^7.0.2", zod: "^4.0.0" } }],
		[
			"apps/os",
			{
				dependencies: { zod: "^4.0.0", react: "^19.0.0" },
				devDependencies: { typescript: "catalog:" },
				peerDependencies: { zod: "^4" },
			},
		],
		["packages/ui", { dependencies: { "@fixture/os": "workspace:*" } }],
	]);
	assert.deepEqual(findCatalogEscapes(manifests), [
		{
			workspace: "apps/os",
			section: "dependencies",
			dep: "zod",
			range: "^4.0.0",
			catalog: "^4.0.0",
		},
	]);
});

test("the command fails on a catalog escape even when bun.lock is current", () => {
	const root = writeFixture({
		osQueryRange: "^5.90.0",
		lockOsQueryRange: "^5.90.0",
	});
	try {
		const manifestPath = join(root, "apps/os/package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.devDependencies = { typescript: "^7.0.2" };
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const result = run(root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /hard-coded despite a catalog entry/);
		assert.match(result.stderr, /apps\/os devDependencies: typescript/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
