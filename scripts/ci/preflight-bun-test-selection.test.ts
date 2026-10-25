import { describe, expect, test } from "bun:test";
import {
	bunfigPreloads,
	importSpecifiers,
	isBunSuiteInfrastructure,
	SELECTION_FILE_LIMIT,
	selectBunTestFiles,
	selectBunTestWorkspaces,
} from "./preflight-bun-test-selection.mjs";

/**
 * A small stand-in repo: one shared package with an `exports` map, and one
 * bun-runner workspace whose tests reach it through different kinds of
 * import. Paths are repo-relative, as the gate sees them.
 */
const FILES: Record<string, string> = {
	"packages/shared/package.json": JSON.stringify({
		name: "@tedix/shared",
		exports: {
			"./util": "./src/util.ts",
			"./schema/*": { import: "./src/schema/*.ts" },
		},
	}),
	"packages/shared/src/util.ts": 'export { deep } from "./deep.js";',
	"packages/shared/src/deep.ts": "export const deep = 1;",
	"packages/shared/src/schema/work.ts": "export const work = 1;",

	"packages/tool/package.json": JSON.stringify({ name: "@tedix/tool" }),
	"packages/tool/bunfig.toml": '[test]\npreload = ["./src/test-env.ts"]\n',
	"packages/tool/src/test-env.ts": "process.env.X = '';",
	"packages/tool/src/a.ts": 'import { deep } from "@tedix/shared/util";',
	"packages/tool/src/a.test.ts": 'import "./a";',
	"packages/tool/src/b.ts":
		'import type { work } from "@tedix/shared/schema/work";',
	"packages/tool/src/b.test.ts": 'import "./b";',
	"packages/tool/src/c.ts": 'export const c = await import("./assets/c.json");',
	"packages/tool/src/assets/c.json": "{}",
	"packages/tool/src/c.test.ts": 'import "./c";',
	"packages/tool/src/d.test.ts": 'import "node:fs"; import "zod";',
	"packages/tool/src/guard.test.ts":
		'import { readFileSync } from "node:fs"; readFileSync(import.meta.dirname + "/a.ts");',
};

const PACKAGE_DIRS: Record<string, string> = {
	"@tedix/shared": "packages/shared",
	"@tedix/tool": "packages/tool",
};

function makeIo(files: Record<string, string> = FILES) {
	return {
		isFile: (file: string) => file in files,
		readSource: (file: string) => files[file] ?? null,
		packageDir: (name: string) => PACKAGE_DIRS[name],
		readManifest: (dir: string) => {
			const raw = files[`${dir}/package.json`];
			return raw ? JSON.parse(raw) : null;
		},
		listTestFiles: (dir: string) =>
			Object.keys(files)
				.filter((f) => f.startsWith(`${dir}/`) && f.endsWith(".test.ts"))
				.sort(),
	};
}

const select = (changedFiles: string[], io = makeIo()) =>
	selectBunTestFiles({ workspaceDir: "packages/tool", changedFiles, io });

describe("selectBunTestWorkspaces", () => {
	const workspaces = ["packages/tool", "apps/runner"];
	test.each(["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"])(
		"root %s selects Bun workspaces without code changes",
		(file) => {
			expect(selectBunTestWorkspaces([file], [], workspaces)).toEqual(
				workspaces,
			);
		},
	);
	test("other changes keep the existing workspace selection", () => {
		for (const files of [
			[],
			["docs/tsconfig.json"],
			["packages/tool/tsconfig.json"],
			["README.md"],
		]) {
			expect(
				selectBunTestWorkspaces(
					files,
					["packages/tool", "apps/vitest"],
					workspaces,
				),
			).toEqual(["packages/tool"]);
		}
	});
});

describe("selectBunTestFiles", () => {
	/*
	 * THE POINT. A change to the shared package used to run the consumer's
	 * whole suite; only the tests whose import graph reaches the change run
	 * now. guard.test.ts reads the checkout as data, so it always runs.
	 */
	test("a changed shared-package file selects the tests that reach it", () => {
		expect(select(["packages/shared/src/deep.ts"])).toEqual({
			mode: "files",
			files: ["src/a.test.ts", "src/guard.test.ts"],
			total: 5,
		});
	});

	test("a dependency manifest change selects its consumers", () => {
		expect(select(["packages/shared/package.json"])).toEqual({
			mode: "files",
			files: ["src/a.test.ts", "src/b.test.ts", "src/guard.test.ts"],
			total: 5,
		});
	});

	test("dependency manifests are followed through transitive workspace imports", () => {
		const io = makeIo({
			...FILES,
			"packages/tool/src/b.ts": 'import "@tedix/tool/src/a";',
			"packages/tool/package.json": JSON.stringify({
				name: "@tedix/tool",
				exports: { "./src/a": "./src/a.ts" },
			}),
		});
		expect(select(["packages/shared/package.json"], io)).toEqual({
			mode: "files",
			files: ["src/a.test.ts", "src/b.test.ts", "src/guard.test.ts"],
			total: 5,
		});
	});

	test("an unrelated dependency manifest does not select consumers", () => {
		expect(select(["packages/unrelated/package.json"])).toEqual({
			mode: "files",
			files: ["src/guard.test.ts"],
			total: 5,
		});
	});

	test.each([
		{ bun: "./src/a.ts" },
		{ bun: "./src/a.ts", import: "./src/other.ts", default: "./src/other.ts" },
		{ bun: { import: "./src/a.ts" } },
		{ import: "./src/a.ts", default: "./src/other.ts" },
		{ default: "./src/a.ts" },
		{ ".": { bun: "./src/a.ts" } },
	])("root conditional exports %j select only the affected test", (exports) => {
		const io = makeIo({
			"packages/shared/package.json": JSON.stringify({ exports }),
			"packages/shared/src/a.ts": "export const a = 1;",
			"packages/shared/src/other.ts": "export const other = 1;",
			"packages/tool/src/a.test.ts": 'import "@tedix/shared";',
			"packages/tool/src/unrelated.test.ts": "export {};",
		});
		for (const changed of ["src/a.ts", "package.json"]) {
			expect(select([`packages/shared/${changed}`], io)).toEqual({
				mode: "files",
				files: ["src/a.test.ts"],
				total: 2,
			});
		}
		expect(select(["packages/shared/src/other.ts"], io)).toEqual({
			mode: "files",
			files: [],
			total: 2,
		});
	});

	test.each([
		null,
		{ bun: ["./src/a.ts"] },
		{ browser: "./src/a.ts" },
		{ types: "./src/a.ts" },
		{ bun: { browser: "./src/a.ts" } },
		{ bun: null, default: "./src/a.ts" },
		{ bun: "./src/missing.ts" },
	])("unsupported root exports %j fail closed", (exports) => {
		const io = makeIo({
			"packages/shared/package.json": JSON.stringify({ exports }),
			"packages/shared/src/a.ts": "export const a = 1;",
			"packages/tool/src/a.test.ts": 'import "@tedix/shared";',
			"packages/tool/src/unrelated.test.ts": "export {};",
		});
		expect(select(["packages/shared/src/a.ts"], io)).toEqual({
			mode: "all",
			reason: expect.stringContaining("import graph incomplete:"),
		});
	});

	test("root conditions do not export package subpaths", () => {
		const io = makeIo({
			...FILES,
			"packages/shared/package.json": JSON.stringify({
				exports: { bun: "./src/util.ts" },
			}),
		});
		expect(select(["packages/shared/src/deep.ts"], io)).toEqual({
			mode: "all",
			reason:
				"import graph incomplete: packages/tool/src/a.ts imports @tedix/shared/util: @tedix/shared does not export ./util",
		});
	});

	test("a wildcard export and a type-only import still form an edge", () => {
		const selection = select(["packages/shared/src/schema/work.ts"]);
		expect(selection.mode).toBe("files");
		if (selection.mode === "files") {
			expect(selection.files).toEqual(["src/b.test.ts", "src/guard.test.ts"]);
		}
	});

	test("a dynamic import of a JSON asset is an edge", () => {
		const selection = select(["packages/tool/src/assets/c.json"]);
		expect(selection.mode).toBe("files");
		if (selection.mode === "files") {
			expect(selection.files).toEqual(["src/c.test.ts", "src/guard.test.ts"]);
		}
	});

	test.each([false, true])(
		"export patterns prefer specificity regardless of insertion order (reversed: %s)",
		(reversed) => {
			for (const narrow of ["./feature/*", "./feature/*.ts"]) {
				const entries = [
					["./*", "./src/*.ts"],
					["./feature/*", "./feature/*.ts"],
					[narrow, "./special/*.ts"],
				];
				const exports = Object.fromEntries(entries);
				const io = makeIo({
					...FILES,
					"packages/shared/package.json": JSON.stringify({
						name: "@tedix/shared",
						exports: reversed
							? Object.fromEntries(Object.entries(exports).reverse())
							: exports,
					}),
					"packages/shared/src/feature/x.ts.ts": "export const x = 1;",
					"packages/shared/feature/x.ts.ts": "export const x = 2;",
					"packages/shared/special/x.ts": "export const x = 3;",
					"packages/shared/special/x.ts.ts": "export const x = 4;",
					"packages/tool/src/a.ts": 'import "@tedix/shared/feature/x.ts";',
					"packages/tool/src/b.ts": "export const b = 1;",
				});
				const target = narrow.endsWith(".ts") ? "x.ts" : "x.ts.ts";
				expect(select([`packages/shared/special/${target}`], io)).toEqual({
					mode: "files",
					files: ["src/a.test.ts", "src/guard.test.ts"],
					total: 5,
				});
				expect(select(["packages/shared/src/feature/x.ts.ts"], io)).toEqual({
					mode: "files",
					files: ["src/guard.test.ts"],
					total: 5,
				});
			}
		},
	);

	test("a changed test file selects itself", () => {
		const selection = select(["packages/tool/src/d.test.ts"]);
		expect(selection.mode).toBe("files");
		if (selection.mode === "files") {
			expect(selection.files).toEqual(["src/d.test.ts", "src/guard.test.ts"]);
		}
	});

	test("a change nothing imports selects only the repo-reading tests", () => {
		expect(select(["apps/os/src/routes/index.tsx"])).toEqual({
			mode: "files",
			files: ["src/guard.test.ts"],
			total: 5,
		});
	});

	test("a changed preload module is an import of every test", () => {
		expect(select(["packages/tool/src/test-env.ts"])).toEqual({
			mode: "all",
			reason: "every test file reaches a changed file",
		});
	});

	test("suite infrastructure resets to the whole suite", () => {
		expect(select(["packages/tool/bunfig.toml"])).toEqual({
			mode: "all",
			reason: "packages/tool/bunfig.toml changed",
		});
		expect(select(["bun.lock"])).toEqual({
			mode: "all",
			reason: "bun.lock changed",
		});
		expect(
			select(["packages/tool/tsconfig.json", "packages/tool/src/b.ts"]),
		).toEqual({ mode: "all", reason: "packages/tool/tsconfig.json changed" });
		expect(select(["packages/tool/scripts/run-tests.ts"])).toEqual({
			mode: "all",
			reason: "packages/tool/scripts/run-tests.ts changed",
		});
	});

	test.each(["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"])(
		"root %s selects the whole suite with an explicit reason",
		(file) => {
			for (const workspaceDir of ["packages/tool", "apps/runner"]) {
				expect(
					selectBunTestFiles({
						workspaceDir,
						changedFiles: [file],
						io: makeIo(),
					}),
				).toEqual({ mode: "all", reason: `${file} changed` });
			}
		},
	);

	test("more than the limit of changed code files runs the whole suite", () => {
		const changed = Array.from(
			{ length: SELECTION_FILE_LIMIT + 1 },
			(_, i) => `apps/os/src/file-${i}.ts`,
		);
		expect(select(changed)).toEqual({
			mode: "all",
			reason: `${SELECTION_FILE_LIMIT + 1} code files changed, above ${SELECTION_FILE_LIMIT}`,
		});
		// Non-code paths do not count towards the limit.
		expect(
			select(changed.slice(1).concat(["docs/a.md", "docs/b.md"])).mode,
		).toBe("files");
	});

	/*
	 * An edge the walker cannot follow would silently drop a test, so an
	 * unresolvable import or an unparseable file is never "no test".
	 */
	test("an unresolvable import falls back to the whole suite, naming it", () => {
		const io = makeIo({
			...FILES,
			"packages/tool/src/a.ts": 'import "@tedix/shared/missing";',
		});
		expect(select(["packages/shared/src/deep.ts"], io)).toEqual({
			mode: "all",
			reason:
				"import graph incomplete: packages/tool/src/a.ts imports @tedix/shared/missing: @tedix/shared does not export ./missing",
		});
		const unknown = makeIo({
			...FILES,
			"packages/tool/src/a.ts": 'import "@tedix/nowhere/x";',
		});
		expect(select(["packages/shared/src/deep.ts"], unknown).mode).toBe("all");
		const relative = makeIo({
			...FILES,
			"packages/tool/src/a.ts": 'import "./gone";',
		});
		expect(select(["packages/shared/src/deep.ts"], relative)).toEqual({
			mode: "all",
			reason:
				"import graph incomplete: packages/tool/src/a.ts imports ./gone: no file resolves it",
		});
	});

	test("an unparseable file falls back to the whole suite", () => {
		const io = makeIo({ ...FILES, "packages/tool/src/a.ts": "import {" });
		expect(select(["packages/shared/src/deep.ts"], io).mode).toBe("all");
	});

	test("a computed require falls back to the whole suite", () => {
		const io = makeIo({
			...FILES,
			"packages/tool/src/a.ts": 'const path = "./changed"; require(path);',
		});
		expect(select(["packages/shared/src/deep.ts"], io)).toEqual({
			mode: "all",
			reason:
				"import graph incomplete: packages/tool/src/a.ts: computed require call",
		});
	});

	test.each(["~/a", "@/a", "#a"])(
		"unconfigured alias %s fails closed",
		(specifier) => {
			const io = makeIo({
				...FILES,
				"packages/tool/src/used.test.ts": `import "${specifier}";`,
			});
			expect(select(["packages/tool/src/a.ts"], io)).toEqual({
				mode: "all",
				reason: `import graph incomplete: packages/tool/src/used.test.ts imports ${specifier}: unresolved local alias requires full suite`,
			});
		},
	);

	test.each(["~/a", "@local/a", "local-a", "@tedix/alias/a"])(
		"configured alias %s triggers a named full-suite fallback",
		(specifier) => {
			const pattern = specifier.includes("/")
				? `${specifier.slice(0, specifier.lastIndexOf("/"))}/*`
				: specifier;
			const io = makeIo({
				...FILES,
				"packages/tool/tsconfig.json": JSON.stringify({
					compilerOptions: { paths: { [pattern]: ["./src/*"] } },
				}),
				"packages/tool/src/used.test.ts": `import "${specifier}";`,
			});
			expect(select(["packages/tool/src/a.ts"], io)).toEqual({
				mode: "all",
				reason: `import graph incomplete: packages/tool/src/used.test.ts imports ${specifier}: local alias ${pattern} in packages/tool/tsconfig.json requires full suite`,
			});
		},
	);

	test.each(["./aliases", "@tedix/shared/aliases.json"])(
		"inherits aliases through %s, including JSONC",
		(parent) => {
			const configFile = parent.startsWith(".")
				? "packages/tool/aliases.json"
				: "packages/shared/aliases.json";
			const io = makeIo({
				...FILES,
				"packages/tool/tsconfig.json": JSON.stringify({ extends: parent }),
				[configFile]:
					'{ // shared aliases\n "compilerOptions": { "paths": { "~/*": ["./src/*"], }, }, }',
				"packages/tool/src/used.test.ts": 'import "~/a";',
			});
			expect(select(["packages/tool/src/a.ts"], io)).toEqual({
				mode: "all",
				reason: `import graph incomplete: packages/tool/src/used.test.ts imports ~/a: local alias ~/* in ${configFile} requires full suite`,
			});
		},
	);

	test("unmatched third-party imports remain supported with configured aliases", () => {
		const io = makeIo({
			...FILES,
			"tsconfig.json": JSON.stringify({
				compilerOptions: { paths: { "~/*": ["./src/*"] } },
			}),
			"packages/tool/src/d.test.ts":
				'import "node:fs"; import "zod"; import "@vendor/pkg";',
		});
		expect(select(["packages/tool/src/b.ts"], io)).toEqual({
			mode: "files",
			files: ["src/b.test.ts", "src/guard.test.ts"],
			total: 5,
		});
	});

	test.each([
		'{"extends":"./missing.json"}',
		'{"extends":"./tsconfig.json"}',
		'{"extends":"unknown/config.json"}',
		'{"compilerOptions":{"baseUrl":"."}}',
		"{ invalid",
	])("uncertain alias configuration fails closed: %s", (config) => {
		const io = makeIo({ ...FILES, "packages/tool/tsconfig.json": config });
		const result = select(["packages/tool/src/b.ts"], io);
		expect(result.mode).toBe("all");
		if (result.mode === "all")
			expect(result.reason).toContain("import graph incomplete:");
	});

	test("a changed inherited config selects its consumers", () => {
		const io = makeIo({
			...FILES,
			"packages/tool/tsconfig.json": '{"extends":"./base.json"}',
			"packages/tool/base.json": "{}",
		});
		expect(select(["packages/tool/base.json"], io)).toEqual({
			mode: "files",
			files: [
				"src/a.test.ts",
				"src/b.test.ts",
				"src/d.test.ts",
				"src/guard.test.ts",
			],
			total: 5,
		});
	});

	test("a dependency outside the repo is not an edge", () => {
		// d.test.ts imports node:fs and zod; neither resolves, neither throws.
		expect(select(["packages/tool/src/b.ts"])).toEqual({
			mode: "files",
			files: ["src/b.test.ts", "src/guard.test.ts"],
			total: 5,
		});
	});
});

describe("importSpecifiers", () => {
	test("reads static, re-exported, dynamic and required modules", () => {
		const source = [
			'import a from "./a";',
			'import type { T } from "@tedix/db/client";',
			'export * from "./b.js";',
			'export { x } from "../c";',
			'const d = await import("./d.json");',
			"const e = await import(`./${name}`);",
			'const f = require("./f");',
			'import "./side";',
		].join("\n");
		expect(importSpecifiers("x.ts", source)).toEqual([
			"./a",
			"@tedix/db/client",
			"./side",
			"./b.js",
			"../c",
			"./d.json",
			"./f",
		]);
	});

	test("throws on malformed source", () => {
		expect(() => importSpecifiers("x.ts", "import {")).toThrow(/x\.ts/);
	});
});

describe("isBunSuiteInfrastructure", () => {
	test("names the runner's configuration and the dependency set", () => {
		const ws = "packages/cli";
		for (const file of [
			"bun.lock",
			"package.json",
			"tsconfig.json",
			"tsconfig.base.json",
			"packages/cli/package.json",
			"packages/cli/bunfig.toml",
			"packages/cli/scripts/run-tests.ts",
			"packages/cli/tsconfig.json",
			"packages/cli/tsconfig.build.json",
			"packages/cli/vitest.config.ts",
			"packages/cli/vitest.workers.config.ts",
			"packages/cli/vite.config.ts",
		]) {
			expect(isBunSuiteInfrastructure(file, ws)).toBe(true);
		}
		for (const file of [
			"packages/cli/src/index.ts",
			"packages/cli/src/package.json",
			"packages/cli/src/tsconfig.json",
			"packages/db/tsconfig.json",
			"docs/tsconfig.json",
			"packages/db/package.json",
			"apps/os/vitest.config.ts",
		]) {
			expect(isBunSuiteInfrastructure(file, ws)).toBe(false);
		}
	});
});

describe("bunfigPreloads", () => {
	test("reads the preload list, with or without a [test] table", () => {
		expect(bunfigPreloads('[test]\npreload = ["./src/test-env.ts"]\n')).toEqual(
			["./src/test-env.ts"],
		);
		expect(
			bunfigPreloads("# comment\npreload = [\"./a.ts\", './b.ts']\n"),
		).toEqual(["./a.ts", "./b.ts"]);
		expect(bunfigPreloads(null)).toEqual([]);
		expect(bunfigPreloads("[install]\nexact = true\n")).toEqual([]);
	});
});
