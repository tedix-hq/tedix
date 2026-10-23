// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import viteConfig from "../vite.config";

const sandboxes: string[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

describe("tsconfig pin", () => {
	test("the app config pins its own tsconfig.json", async () => {
		const config = await viteConfig({
			command: "serve",
			mode: "development",
			isPreview: false,
		});
		expect(config.tsconfig).toBe("./tsconfig.json");
	});

	// vitejs/vite#23672: a file the nearest `include` doesn't own (here
	// `unowned.ts`; in the wild `index.html` and its html-proxy modules) sends
	// tsconfig auto-discovery walking ancestor directories; an ancestor
	// tsconfig whose `extends` cannot resolve aborts the transform with
	// TSCONFIG_ERROR. A worktree under another checkout inherits the parent's
	// install state this way.
	test("an ancestor's unresolvable tsconfig breaks transforms unless tsconfig is pinned", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "os-tsconfig-"));
		sandboxes.push(sandbox);
		const parent = join(sandbox, "checkout");
		const app = join(parent, "app");
		mkdirSync(join(app, "src"), { recursive: true });
		writeFileSync(
			join(parent, "tsconfig.json"),
			'{ "extends": "@missing/tsconfig/base.json" }',
		);
		writeFileSync(join(app, "tsconfig.json"), '{ "include": ["src"] }');
		writeFileSync(join(app, "src", "main.ts"), "export {};\n");
		writeFileSync(join(app, "unowned.ts"), "export {};\n");

		const discover = await createServer({
			configFile: false,
			root: app,
			logLevel: "silent",
			server: { hmr: false },
		});
		try {
			await expect(discover.transformRequest("/unowned.ts")).rejects.toThrow(
				/Tsconfig not found/,
			);
		} finally {
			await discover.close();
		}

		const pinned = await createServer({
			configFile: false,
			root: app,
			tsconfig: "./tsconfig.json",
			logLevel: "silent",
			server: { hmr: false },
		});
		try {
			await expect(
				pinned.transformRequest("/unowned.ts"),
			).resolves.toMatchObject({ code: expect.any(String) });
		} finally {
			await pinned.close();
		}
	});
});
