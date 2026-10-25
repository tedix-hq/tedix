/**
 * A synthetic GitHub tree shaped like the Tedix monorepo on 25 Oct 2026
 * (9,485 entries; tip blobs ≈ 515 MB, of which `apps` ≈ 94 MB in 5,423 files
 * and `packages` ≈ 417 MB in 2,813 files). The CTO tedi's broad
 * `clone_repo` selection of these prefixes reset its Durable Object isolate.
 *
 * Shared by the plain-bun repo tests and the workerd budget test, so both
 * exercise the production selection over the same shape without any network.
 */

export interface FixtureTreeEntry {
	path: string;
	type: "blob" | "tree";
	sha: string;
	size?: number;
}

const SHAPE: Array<{ prefix: string; files: number; bytes: number }> = [
	{ prefix: "apps", files: 5_423, bytes: 93_802_847 },
	{ prefix: "packages", files: 2_813, bytes: 417_222_186 },
	{ prefix: "docs", files: 57, bytes: 990_613 },
	{ prefix: "scripts", files: 190, bytes: 1_644_781 },
	// Shares a leading string with `apps`; a selector must not reach it.
	{ prefix: "apps-archive", files: 3, bytes: 3_000 },
];

/** The broad selection the CTO tedi requested. */
export const BROAD_MONOREPO_PATHS = [
	"apps",
	"packages",
	"docs",
	"scripts",
	"memory",
];

export function monorepoTree(): FixtureTreeEntry[] {
	const tree: FixtureTreeEntry[] = [
		{ path: "README.md", type: "blob", sha: "sha-readme", size: 4_096 },
	];
	for (const { prefix, files, bytes } of SHAPE) {
		tree.push({ path: prefix, type: "tree", sha: `sha-${prefix}` });
		const size = Math.floor(bytes / files);
		for (let i = 0; i < files; i++) {
			tree.push({
				path: `${prefix}/m${i % 40}/src/file${i}.ts`,
				type: "blob",
				sha: `sha-${prefix}-${i}`,
				size,
			});
		}
	}
	return tree;
}

/** Tip-tree blob bytes, as the checkout-size probe sums them. */
export function monorepoTreeBytes(tree: FixtureTreeEntry[]): number {
	return tree.reduce(
		(sum, entry) => sum + (entry.type === "blob" ? (entry.size ?? 0) : 0),
		0,
	);
}
