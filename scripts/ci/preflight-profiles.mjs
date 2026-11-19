/** Every excluded local check is retained in the main CI repository or workspace shards. */
export function gateInProfile(name, profile) {
	if (profile === "full") return true;
	if (profile === "ci-policy")
		return !/^tests |^changed script tests$|^type-check (apps|packages)\//.test(
			name,
		);
	if (profile !== "local-fast")
		throw new Error(`Unknown gate profile: ${profile}`);
	// Seconds, not minutes: a push from a laptop shared by many agents must not
	// hold the push queue while broad suites run. Main verify checks types;
	// full suites run on demand.
	return /^(node_modules matches|format:check|lint:code|lint:repo|lint:deps|OSS secret|migration order |procedure parity |type-check scripts\/$)/.test(
		name,
	);
}

export function procedureParityGates(files) {
	const contracts =
		/^packages\/api-contract\/src\/(contracts\/|utils\/contract-routers)/;
	const capabilities =
		/^packages\/api-contract\/src\/schemas\/mcp-capability-scopes/;
	const mcpAuth = /^packages\/mcp\/src\/auth\//;
	const profiles = /^scripts\/ci\/preflight-(?:gates\.mjs$|profiles\.)/;
	const api =
		/^apps\/api\/src\/(rpc\/(?:routers\/|orpc\.|os-audit|fleet-authority-guards)|services\/tool-schema-(?:sync|overrides|projection))/;
	const nativeMcp =
		/^apps\/mcp\/src\/mcp\/(?:home-surface-tools|aggregate-tedis|aggregate-tedi-catalog)/;
	return [
		{
			name: "procedure parity API registries and MCP scope coverage",
			workspace: "apps/api",
			inputs: [api, mcpAuth, capabilities],
			script: "test:unit",
			tests: [
				"src/services/tool-schema-sync-scope-coverage.test.ts",
				"src/rpc/os-audit.coverage.test.ts",
				"src/rpc/routers/contract-parity.test.ts",
			],
			fix: "register the new procedure where the failing test names it (MCP capability scope, OS audit registry, apiContract/ROUTERS, fleet-authority guards); never widen a scope or add an unreviewed exemption",
		},
		{
			name: "procedure parity MCP scope mapping",
			workspace: "packages/mcp",
			inputs: [mcpAuth, capabilities],
			script: "test:run",
			tests: ["src/auth/reviewed-rpc-endpoint-scopes.test.ts"],
			fix: "give the reviewed endpoint a valid scope no looser than its API guard",
		},
		{
			name: "procedure parity MCP capability scopes",
			workspace: "packages/api-contract",
			inputs: [capabilities],
			script: "test:run",
			tests: ["src/schemas/mcp-capability-scopes.test.ts"],
			fix: "map the tool name to its exact capability scope; never widen an existing mapping",
		},
		{
			name: "procedure parity MCP tools resolve to contract procedures",
			workspace: "apps/mcp",
			inputs: [nativeMcp],
			script: "test:run",
			tests: ["src/mcp/aggregate-contract-parity.test.ts"],
			fix: "point the Home or aggregate tool at an existing contract procedure, or add that procedure to the contract",
		},
	].map(({ name, workspace, script, tests, inputs, fix }) => ({
		name,
		when:
			files === null ||
			files.some((file) => {
				if (profiles.test(file)) return true;
				if (tests.some((test) => file === `${workspace}/${test}`)) return true;
				if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file)) return false;
				return contracts.test(file) || inputs.some((input) => input.test(file));
			}),
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
			"bun",
			"packages/db/scripts/generate-migration.ts",
			"--check-order",
			...ranges.flatMap(({ base, head }) => ["--base", base, "--head", head]),
		],
		fix: "run the migration:restamp command above, then retry bun run push",
	};
}
