import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Case = [changed: string[], scope: string[], covered: boolean];

function scopeCovers(cases: Case[]): boolean[] {
	const result = spawnSync(
		"python3",
		[
			"-B",
			"-c",
			"import json, sys; from lane_file_scope import scope_covers; print(json.dumps([scope_covers(c, s) for c, s in json.load(sys.stdin)]))",
		],
		{
			cwd: fileURLToPath(new URL(".", import.meta.url)),
			input: JSON.stringify(cases.map(([changed, scope]) => [changed, scope])),
			encoding: "utf8",
		},
	);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout) as boolean[];
}

test("the push broker accepts committed files inside a directory File scope", () => {
	// The scope and paths of real refused pushes (Work 59529f14, 410cff42, 3db32925).
	const briefScope = ["apps/", "packages/", "scripts/"];
	const cases: Case[] = [
		[
			[
				"packages/api-contract/src/utils/skill-schedule.test.ts",
				"packages/api-contract/src/utils/skill-schedule.ts",
			],
			briefScope,
			true,
		],
		[
			[
				"apps/tedi-runtime/src/workflow-image-handoff.test.ts",
				"apps/tedi-runtime/src/workflow-image-handoff.ts",
			],
			briefScope,
			true,
		],
		[
			[
				"apps/os/src/routes/settings/-settings-nav.tsx",
				"apps/os/e2e/settings-nav-phone.spec.ts",
				"scripts/ci/affected-suite.ts",
			],
			briefScope,
			true,
		],
		// Directory forms: no trailing slash, a glob suffix, a leading ./
		[["apps/os/src/a.ts"], ["apps/os"], true],
		[["apps/os/src/a.ts"], ["apps/**"], true],
		[["apps/os/src/a.ts"], ["./apps/os/src/"], true],
		// Exact file entries still work.
		[["apps/os/src/a.ts"], ["apps/os/src/a.ts"], true],
		[
			["apps/os/src/a.ts", "apps/os/src/a.test.ts"],
			["apps/os/src/a.ts", "apps/os/src/a.test.ts"],
			true,
		],
	];
	expect(scopeCovers(cases)).toEqual(cases.map(([, , covered]) => covered));
});

test("the push broker still refuses changes outside the File scope", () => {
	const cases: Case[] = [
		// One path outside the scope refuses the whole push.
		[
			["apps/os/src/a.ts", ".github/workflows/ci.yml"],
			["apps/", "packages/"],
			false,
		],
		[["package.json"], ["apps/", "packages/", "scripts/"], false],
		// A shared name prefix is not containment.
		[["apps-legacy/a.ts"], ["apps"], false],
		[["apps/os/src/ab.ts"], ["apps/os/src/a"], false],
		// An exact file entry does not cover its siblings.
		[["apps/os/src/b.ts"], ["apps/os/src/a.ts"], false],
		// Nothing changed, or no usable scope.
		[[], ["apps/"], false],
		[["apps/os/src/a.ts"], [], false],
		// Whole-repository and escaping entries cover nothing.
		[["apps/os/src/a.ts"], ["."], false],
		[["apps/os/src/a.ts"], ["/"], false],
		[["apps/os/src/a.ts"], ["**"], false],
		[["apps/os/src/a.ts"], ["apps/../apps"], false],
		[["../outside/apps/a.ts"], ["apps/"], false],
		[["apps/../package.json"], ["apps/"], false],
		[["/etc/hosts"], ["apps/"], false],
		// Quoted, unusual Git paths fail closed instead of matching by accident.
		[['"apps/caf\\303\\251.ts"'], ["apps/"], false],
	];
	expect(scopeCovers(cases)).toEqual(cases.map(([, , covered]) => covered));
});
