/** Every excluded local check is retained in the main CI repository or workspace shards. */
export function gateInProfile(name, profile) {
	if (profile === "full") return true;
	if (profile === "ci-policy")
		return !/^tests |^type-check (apps|packages)\//.test(name);
	if (profile !== "local-fast")
		throw new Error(`Unknown gate profile: ${profile}`);
	return /^(node_modules matches|format:check|lint:code|lint:repo|lint:deps|OSS secret|type-check )/.test(
		name,
	);
}
