import { describe, expect, it } from "vite-plus/test";
import {
	eagerModules,
	eagerImportViolations,
	type InputModule,
} from "./lazy-imports";

const root = "src/worker-app.ts";
const router = "src/rpc/routers/example.ts";
const modules = (kind: string): Record<string, InputModule> => ({
	[root]: {
		imports: [{ path: "src/fixture-handler.ts", kind: "import-statement" }],
	},
	"src/fixture-handler.ts": { imports: [{ path: router, kind }] },
	[router]: { imports: [{ path: root, kind: "import-statement" }] },
});

describe("lazy import boundary", () => {
	it.each(["import-statement", "require-call"])(
		"catches transitive %s router imports, including cycles",
		(kind) => {
			expect(
				eagerImportViolations(eagerModules(modules(kind), root), false),
			).toEqual([router]);
		},
	);
	it("allows deferred implementations and the lazy router index", () => {
		const inputs = modules("dynamic-import");
		inputs[root]!.imports.push({
			path: "src/rpc/routers/index.ts",
			kind: "import-statement",
		});
		inputs["src/rpc/routers/index.ts"] = { imports: [] };
		expect(eagerImportViolations(eagerModules(inputs, root), false)).toEqual(
			[],
		);
	});
	it("keeps the application, workflows, and all routers out of startup", () => {
		expect(
			eagerImportViolations(
				new Set([root, "src/rpc/routers/index.ts", "src/workflows/example.ts"]),
				true,
			),
		).toEqual([root, "src/rpc/routers/index.ts", "src/workflows/example.ts"]);
	});
	it("excludes external imports and fails on incomplete metadata", () => {
		expect(
			eagerModules(
				{
					entry: {
						imports: [
							{
								path: "cloudflare:workers",
								kind: "import-statement",
								external: true,
							},
						],
					},
				},
				"entry",
			),
		).toEqual(new Set(["entry"]));
		expect(() => eagerModules({}, "entry")).toThrow("Missing import metadata");
	});
});
