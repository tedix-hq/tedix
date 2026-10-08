import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "./scripts/vite/task-config";

export default defineConfig({
	fmt: {
		ignorePatterns: [
			// Vendored and generated sources retain their owning toolchain's formatting.
			"**/*.astro",
			"docs/DOCS_MAP.md",
			"packages/db/drizzle/**/snapshot.json",
			"**/worker-configuration.d.ts",
			"**/routeTree.gen.ts",
			"apps/cms/src/template-snapshot.ts",
		],
		printWidth: 80,
		semi: true,
		singleQuote: false,
		tabWidth: 2,
		trailingComma: "all",
		useTabs: true,
	},
	test: {
		// Fixture-heavy tests exceed Vitest's 5s default under CPU contention, so
		// the shared timeouts are raised but finite: a real hang still fails.
		//
		// The values live in `scripts/vite/task-config.ts` because a package-local
		// `vite.config.ts` replaces this block for that package rather than merging
		// with it, so every such config has to re-declare them and the two copies
		// must not be able to drift.
		...sharedTestConfig,
	},
	lint: {
		// NO `jsPlugins` HERE, deliberately. Declaring any JS plugin makes
		// `linter.has_external_linter()` true, and oxc then builds a FIXED-SIZE
		// allocator pool whose 4 GiB-aligned chunk glibc serves with a single 6 GiB
		// `mmap` carrying no `MAP_NORESERVE` — the one mapping the kernel's
		// overcommit accounting charges. It is built at startup before any file is
		// read, so a container with less RAM than that cannot run `vp lint` at all,
		// whatever the thread count or file scope. The only plugin this repo ever
		// configured supplied exactly one rule, `prefer-vite-plus-imports`, which
		// now lives in `scripts/lint-vite-plus-imports.ts` and runs inside
		// `lint:repo`. Keep the check; do not bring the allocator back.
		//
		// Keep the default path syntax-only: `lint:type-aware` (run by hand through
		// `bun run lint:deep`, not on push) enforces no-floating-promises across
		// every app/package without measured debt. The
		// excluded workspaces have measured existing findings; the command names the
		// clean project set explicitly so their debt cannot leak into this gate. TSGo `typeCheck`
		// is not a replacement for the repo's project-scoped tsc checks: it currently
		// pulls runner-only files outside validated project boundaries (Bun preload
		// scripts and deliberately partial test doubles). Keep those checks until
		// their diagnostic sets, not merely their exit codes, are equivalent.
		options: { typeAware: false, typeCheck: false },
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "@tedix/db/queries",
							message:
								"Use the owning @tedix/db/queries/* module; the compatibility barrel is not an application boundary.",
						},
					],
				},
			],
		},
		overrides: [
			{
				// New apps/packages are denied DB ownership by default. The excluded
				// paths are the reviewed storage owners from the architecture contract.
				files: ["apps/**", "packages/**", "scripts/**"],
				excludeFiles: [
					"apps/api/**",
					// Builder needs D1 admission beside its live R2/D1 mutation; keep
					// this exception limited to the exact restore-permit owner and tests.
					"apps/cms/src/agent/cms-restore-permit.ts",
					"apps/cms/src/agent/cms-restore-permit.test.ts",
					"apps/cms/src/agent/deploy.test.ts",
					"apps/cms/src/agent/hot-theme.test.ts",
					"apps/cms-runtime/**",
					"apps/docs/**",
					"apps/docs-runtime/**",
					"apps/mcp/**",
					"apps/skill-runtime/**",
					"apps/tedi/**",
					"apps/tedi-runtime/**",
					"packages/db/**",
				],
				rules: {
					"no-restricted-imports": [
						"error",
						{
							paths: [
								{
									name: "@tedix/db/queries",
									message:
										"Use the owning @tedix/db/queries/* module; the compatibility barrel is not an application boundary.",
								},
							],
							patterns: [
								{
									group: ["@tedix/db", "@tedix/db/*"],
									message:
										"This app/package is not a reviewed DB owner. Route platform data access through apps/api or an owning package contract.",
								},
							],
						},
					],
				},
			},
		],
	},
	run: {
		// Tasks cache; package.json scripts do not. Both halves are deliberate.
		//
		// Tasks: a task declares `input`/`output`/`env`, so what invalidates it is
		// stated rather than guessed. Vite+ fingerprints file *contents* and follows
		// the workspace symlinks, so editing a dependency's source misses the
		// dependent's cache too — measured, not assumed.
		//
		// Scripts: caching a command also runs it in Vite+'s clean ~16-variable
		// environment instead of the caller's, and `env`/`untrackedEnv` exist only
		// on tasks. Turning `scripts` on would therefore silently change the
		// environment of every package.json script in the workspace with no way to
		// declare a needed variable back. Measured: with scripts cached, a script
		// saw 16 environment variables and neither `NODE_ENV` nor a caller-exported
		// var; with caching off, 50 and both. Convert a command to a task instead.
		cache: { tasks: true, scripts: false },
	},
});
