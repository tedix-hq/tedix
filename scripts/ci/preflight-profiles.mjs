/** Every excluded local check is retained in the main CI repository or workspace shards. */
export function gateInProfile(name, profile) {
	if (profile === "full") return true;
	if (profile === "ci-policy")
		return !/^tests |^type-check (apps|packages)\//.test(name);
	if (profile !== "local-fast")
		throw new Error(`Unknown gate profile: ${profile}`);
	return /^(node_modules matches|format:check|lint:code|lint:repo|lint:deps|OSS secret|migration order |procedure parity |type-check )/.test(
		name,
	);
}

// These regressions otherwise wait for hourly CI: source-scanning tests are
// invisible to import-based related-test selection, and local-fast skips it.
export function procedureParityGates(files) {
	const when =
		files === null ||
		files.some(
			(file) =>
				file.startsWith("packages/api-contract/src/contracts/") ||
				file.startsWith("apps/api/src/rpc/routers/") ||
				(file.startsWith("apps/os/src/") && /webmcp/i.test(file)) ||
				file.startsWith("apps/os/dev/local-fixtures") ||
				file === "scripts/ci/preflight-gates.mjs" ||
				file.startsWith("scripts/ci/preflight-profiles."),
		);
	return [
		{
			name: "procedure parity MCP scope coverage",
			workspace: "apps/api",
			tests: ["src/services/tool-schema-sync-scope-coverage.test.ts"],
			fix: "map each new endpoint to its reviewed MCP capability scope; never widen the scope or add an unmapped exemption",
		},
		{
			name: "procedure parity local fixtures and WebMCP conventions",
			workspace: "apps/os",
			tests: [
				"dev/local-fixtures-parity.test.ts",
				"src/components/webmcp-tools-conventions.test.ts",
			],
			fix: "add the missing local fixture handler or fix the WebMCP convention reported by the test; retain the assertions",
		},
	].map(({ name, workspace, tests, fix }) => ({
		name,
		when,
		cmd: ["bun", "run", "--cwd", workspace, "test:unit", ...tests],
		fix,
	}));
}

export function migrationOrderGate(files, ranges) {
	return {
		name: "migration order against the push base",
		when:
			files === null ||
			files.some((file) => /^packages\/db\/drizzle\//.test(file)),
		cmd: [
			"node",
			"node_modules/jiti/lib/jiti-cli.mjs",
			"packages/db/scripts/generate-migration.ts",
			"--check-order",
			...ranges.flatMap(({ base, head }) => ["--base", base, "--head", head]),
		],
		fix: "run the migration:restamp command above, then retry bun run push",
	};
}
