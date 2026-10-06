export const WORKSTATION_EGRESS_GUARD_VERSION = "2026-06-28-v2-run-context";
const WORKSTATION_SANDBOX_ID_SUFFIX = "we2";
const MAX_WORKSTATION_SANDBOX_ID_LENGTH = 63;

function shortHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function workstationSandboxId(tediId: string): string {
	const safeBase =
		tediId
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "tedi";
	const suffix = `-${WORKSTATION_SANDBOX_ID_SUFFIX}`;
	if (safeBase.length <= MAX_WORKSTATION_SANDBOX_ID_LENGTH - suffix.length) {
		return `${safeBase}${suffix}`;
	}
	const hash = shortHash(safeBase);
	const prefixLength =
		MAX_WORKSTATION_SANDBOX_ID_LENGTH - suffix.length - hash.length - 1;
	return `${safeBase.slice(0, prefixLength)}-${hash}${suffix}`;
}
