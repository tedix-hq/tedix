export interface InputModule {
	imports: Array<{ path: string; kind: string; external?: boolean }>;
}

/** Follow runtime imports only; deferred modules cannot make a root eager. */
export function eagerModules(
	inputs: Record<string, InputModule>,
	entry: string,
): Set<string> {
	const visited = new Set<string>();
	const visit = (path: string): void => {
		if (visited.has(path)) return;
		const input = inputs[path];
		if (!input) throw new Error(`Missing import metadata for ${path}`);
		visited.add(path);
		for (const imported of input.imports) {
			if (!imported.external && imported.kind !== "dynamic-import") {
				visit(imported.path);
			}
		}
	};
	visit(entry);
	return visited;
}

export function eagerImportViolations(
	modules: Set<string>,
	startup: boolean,
): string[] {
	return [...modules].filter(
		(path) =>
			(path.startsWith("src/rpc/routers/") &&
				(startup || path !== "src/rpc/routers/index.ts")) ||
			(startup &&
				(path === "src/worker-app.ts" || path.startsWith("src/workflows/"))),
	);
}
