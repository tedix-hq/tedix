/** Every excluded local check is retained in the main CI repository or workspace shards. */
export function gateInProfile(name, profile) {
	if (profile === "full") return true;
	if (profile === "ci-policy")
		return !/^tests |^type-check (apps|packages)\//.test(name);
	if (profile !== "local-fast")
		throw new Error(`Unknown gate profile: ${profile}`);
	return /^(node_modules matches|format:check|lint:code|lint:repo|lint:deps|OSS secret|migration order |type-check )/.test(
		name,
	);
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
