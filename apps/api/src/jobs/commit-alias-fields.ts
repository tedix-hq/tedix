import type { CommitAliasCountCursor } from "@tedix/api-contract/schemas/commit-alias-counts";

type Location = CommitAliasCountCursor["location"];
type Slot = {
	parent: Record<string, unknown> | unknown[];
	key: string | number;
	value: unknown;
};

/** The mutable projection fields counted by the inventory, never arbitrary JSON leaves. */
export function mutableCommitFields(
	location: Location,
	value: unknown,
): Slot[] {
	const slots: Slot[] = [];
	const visit = (node: unknown, path: string[]) => {
		if (!node || typeof node !== "object") return;
		const [key, ...rest] = path;
		if (key === "*") {
			if (Array.isArray(node))
				node.forEach((item, index) => {
					if (rest.length) visit(item, rest);
					else slots.push({ parent: node, key: index, value: item });
				});
		} else if (key && !Array.isArray(node)) {
			const parent = node as Record<string, unknown>;
			if (rest.length) visit(parent[key], rest);
			else if (Object.hasOwn(parent, key))
				slots.push({ parent, key, value: parent[key] });
		}
	};
	const paths: string[] =
		location === "work_attempts.metadata"
			? [
					"settlement.commitSha",
					"settlement.runCommitSha",
					"settlement.baseCommit",
					"settlement.commitShas.*",
					"commitShas.*",
					"commits.*.sha",
					"commitSha",
					"sourceCommit",
					"repositoryLifecycle.merge.commitSha",
					"cliRelease.commitSha",
					"laneResult.commitSha",
					"recoveredCommits.*.commitSha",
				]
			: location === "work_items.metadata"
				? ["event.sha", "event.beforeSha", "event.commitShas.*"]
				: location === "kernel_requests.snapshot"
					? [
							"checks.*.commitSha",
							"checks.*.baseSha",
							"observations.*.observedVersion",
						]
					: [];
	for (const path of paths) visit(value, path.split("."));
	return slots;
}

export function isCommitAliasUnlocked(
	location: Location,
	store: string,
	state: string | null,
) {
	return (
		store === "main" &&
		(location === "work_items.metadata" ||
			location === "kernel_requests.snapshot" ||
			(location === "work_attempts.metadata" &&
				["queued", "running", "waiting", "retrying"].includes(state ?? "")))
	);
}
