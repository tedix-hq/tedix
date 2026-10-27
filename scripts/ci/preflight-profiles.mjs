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
// Each is a fast "every X is registered" invariant across routers, contracts,
// OS audit and MCP scope mapping (27 Oct: c96abdd53 red-mained os-audit
// coverage, which no pre-push gate ran).
export function procedureParityGates(files) {
	const when =
		files === null ||
		files.some(
			(file) =>
				file.startsWith("packages/api-contract/src/contracts/") ||
				file.startsWith("packages/api-contract/src/contract-versions") ||
				file.startsWith("packages/api-contract/src/utils/contract-routers") ||
				file.startsWith(
					"packages/api-contract/src/schemas/mcp-capability-scopes",
				) ||
				file.startsWith("packages/mcp/src/auth/") ||
				file.startsWith("apps/api/src/rpc/routers/") ||
				file.startsWith("apps/api/src/rpc/os-audit") ||
				file.startsWith("apps/api/src/rpc/fleet-authority-guards") ||
				file.startsWith("apps/mcp/src/mcp/home-surface-tools") ||
				file.startsWith("apps/mcp/src/mcp/aggregate-tedis") ||
				(file.startsWith("apps/os/src/") && /webmcp/i.test(file)) ||
				file.startsWith("apps/os/dev/local-fixtures") ||
				file === "scripts/ci/preflight-gates.mjs" ||
				file.startsWith("scripts/ci/preflight-profiles."),
		);
	return [
		{
			name: "procedure parity API registries and MCP scope coverage",
			workspace: "apps/api",
			script: "test:unit",
			tests: [
				"src/services/tool-schema-sync-scope-coverage.test.ts",
				"src/rpc/os-audit.coverage.test.ts",
				"src/rpc/routers/contract-parity.test.ts",
				"src/rpc/fleet-authority-coverage.test.ts",
				"src/rpc/contract-surface-versions.test.ts",
			],
			fix: "register the new procedure where the failing test names it (MCP capability scope, OS audit registry, apiContract/ROUTERS, fleet-authority guards, surface version); never widen a scope or add an unreviewed exemption",
		},
		{
			name: "procedure parity MCP scope mapping",
			workspace: "packages/mcp",
			script: "test:run",
			tests: ["src/auth/reviewed-rpc-endpoint-scopes.test.ts"],
			fix: "give the reviewed endpoint a valid scope no looser than its API guard",
		},
		{
			name: "procedure parity MCP capability scopes",
			workspace: "packages/api-contract",
			script: "test:run",
			tests: ["src/schemas/mcp-capability-scopes.test.ts"],
			fix: "map the tool name to its exact capability scope; never widen an existing mapping",
		},
		{
			name: "procedure parity MCP tools resolve to contract procedures",
			workspace: "apps/mcp",
			script: "test:run",
			tests: ["src/mcp/aggregate-contract-parity.test.ts"],
			fix: "point the Home or aggregate tool at an existing contract procedure, or add that procedure to the contract",
		},
		{
			name: "procedure parity local fixtures and WebMCP conventions",
			workspace: "apps/os",
			script: "test:unit",
			tests: [
				"dev/local-fixtures-parity.test.ts",
				"dev/local-fixtures.test.ts",
				"src/components/webmcp-tools-conventions.test.ts",
			],
			fix: "add the missing local fixture handler, make its output parse against the contract, or fix the WebMCP convention reported by the test; retain the assertions",
		},
	].map(({ name, workspace, script, tests, fix }) => ({
		name,
		when,
		cmd: ["bun", "run", "--cwd", workspace, script, ...tests],
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
