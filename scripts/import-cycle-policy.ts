/** Detect import cycles; every workspace must stay at zero. */

export interface WorkspaceCycles {
	workspace: string;
	cycles: string[][];
}

export function evaluateCycles(measured: WorkspaceCycles[]): {
	ok: boolean;
	failures: string[];
	summary: string;
} {
	const failures: string[] = [];
	let total = 0;
	for (const entry of measured) {
		total += entry.cycles.length;
		if (entry.cycles.length === 0) continue;
		failures.push(
			`${entry.workspace} has ${entry.cycles.length} import cycle(s); every workspace must stay at zero.\n` +
				`${renderCycles(entry.cycles)}\n` +
				"Break the cycle by moving shared symbols into a module both sides import.",
		);
	}
	return {
		ok: failures.length === 0,
		failures,
		summary: `import-cycle check: ${measured.length} workspaces, ${total} cycle(s) total`,
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
