/**
 * Pure decision layer for the import-cycle gate.
 *
 * Split from `lint-import-cycles.ts` so the POLICY is testable without walking
 * the filesystem or parsing TypeScript.
 *
 * WHY A SHRINK-ONLY BASELINE RATHER THAN A HARD ZERO.
 *
 * A circular import is a real hazard: module A's top-level code can run before
 * B has finished initializing, so the graph cannot be reasoned about one file
 * at a time. That matters more here than in a human-written repo, because
 * agents navigate by reading a file in isolation and assuming its imports are
 * already resolved.
 *
 * But most of this repo is already clean and one app is not, so a hard zero
 * would either fail the build today or have to be introduced with an
 * exemption list nobody prunes. A per-workspace baseline pins each workspace
 * where it actually is: the clean ones are pinned at 0 and can never regress,
 * and the one with existing cycles can only ratchet down. That is the same
 * gate shape the bundle guard and the authz coverage lint already use — the
 * judgement lives in the DIRECTION, not in a number someone has to bump.
 *
 * A shrink is never a failure. It just means the baseline is pessimistic,
 * which costs nothing until refreshed with `--update-baseline`.
 */

export interface WorkspaceCycles {
	/** Repo-relative workspace root, e.g. `apps/api/src`. */
	workspace: string;
	/** Each cycle rendered as its member files, in traversal order. */
	cycles: string[][];
}

export interface CycleBaseline {
	$comment?: string;
	/** workspace root -> allowed cycle count. */
	workspaces: Record<string, number>;
}

export interface CycleVerdict {
	ok: boolean;
	/** Empty when ok. Each entry is a complete, actionable operator message. */
	failures: string[];
	/** Workspaces whose count dropped below baseline — good news, never fatal. */
	improvements: string[];
	summary: string;
}

export function evaluateCycles(input: {
	measured: WorkspaceCycles[];
	baseline: CycleBaseline;
}): CycleVerdict {
	const failures: string[] = [];
	const improvements: string[] = [];
	let total = 0;

	for (const entry of input.measured) {
		const count = entry.cycles.length;
		total += count;
		const allowed = input.baseline.workspaces[entry.workspace];

		if (allowed === undefined) {
			// A new workspace defaults to zero-tolerance. Anything else would let
			// a package be added WITH cycles and never be noticed.
			if (count > 0) {
				failures.push(
					`${entry.workspace} is not in the baseline and has ${count} import cycle(s).\n` +
						`${renderCycles(entry.cycles)}\n` +
						"New workspaces start at zero. Break the cycle, or record the debt deliberately:\n" +
						"  bun scripts/lint-import-cycles.ts --update-baseline",
				);
			}
			continue;
		}

		if (count > allowed) {
			failures.push(
				`${entry.workspace} has ${count} import cycle(s), over its baseline of ${allowed}.\n` +
					`${renderCycles(entry.cycles)}\n` +
					"A cycle means these modules cannot be initialized — or read — independently.\n" +
					"Break it by moving the shared symbol DOWN into a module both sides import,\n" +
					"rather than having the lower module reach back up.\n" +
					"If the cycle is genuinely intended, refresh the baseline and say why in the commit:\n" +
					"  bun scripts/lint-import-cycles.ts --update-baseline",
			);
			continue;
		}

		if (count < allowed) {
			improvements.push(
				`${entry.workspace}: ${allowed} -> ${count} cycle(s) — consider --update-baseline`,
			);
		}
	}

	return {
		ok: failures.length === 0,
		failures,
		improvements,
		summary:
			`import-cycle check passed (${input.measured.length} workspaces, ${total} cycle(s) total` +
			`${improvements.length > 0 ? `; ${improvements.length} workspace(s) improved` : ""})`,
	};
}

/** Render cycles as `a.ts -> b.ts -> a.ts`, capped so a bad run stays readable. */
export function renderCycles(cycles: string[][], limit = 10): string {
	const shown = cycles.slice(0, limit);
	const lines = shown.map(
		(cycle) => `  ${[...cycle, cycle[0]].filter(Boolean).join(" -> ")}`,
	);
	if (cycles.length > shown.length) {
		lines.push(`  ... and ${cycles.length - shown.length} more`);
	}
	return lines.join("\n");
}

/**
 * Tarjan strongly-connected components.
 *
 * Every SCC with more than one member is a cycle, plus any single node that
 * imports itself. Returns members in deterministic order so the baseline and
 * the failure output are stable across runs.
 */
export function findCycles(graph: Map<string, string[]>): string[][] {
	let index = 0;
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const cycles: string[][] = [];

	// Iterative, not recursive: this graph is thousands of modules deep in the
	// worst case and a recursive Tarjan blows the stack on a real monorepo.
	for (const root of [...graph.keys()].sort()) {
		if (indices.has(root)) continue;
		const work: Array<{ node: string; edge: number }> = [
			{ node: root, edge: 0 },
		];

		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const { node } = frame;

			if (frame.edge === 0) {
				indices.set(node, index);
				low.set(node, index);
				index += 1;
				stack.push(node);
				onStack.add(node);
			}

			const edges = graph.get(node) ?? [];
			if (frame.edge < edges.length) {
				const next = edges[frame.edge]!;
				frame.edge += 1;
				if (!indices.has(next)) {
					work.push({ node: next, edge: 0 });
				} else if (onStack.has(next)) {
					low.set(node, Math.min(low.get(node)!, indices.get(next)!));
				}
				continue;
			}

			if (low.get(node) === indices.get(node)) {
				const component: string[] = [];
				let member: string | undefined;
				do {
					member = stack.pop();
					if (member === undefined) break;
					onStack.delete(member);
					component.push(member);
				} while (member !== node);

				const selfEdge = (graph.get(node) ?? []).includes(node);
				if (component.length > 1 || selfEdge) {
					cycles.push(component.reverse());
				}
			}

			work.pop();
			const parent = work[work.length - 1];
			if (parent) {
				low.set(parent.node, Math.min(low.get(parent.node)!, low.get(node)!));
			}
		}
	}

	return cycles.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}
