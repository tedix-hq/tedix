/**
 * Every folder the organization's skills already use, parents included, in
 * the order the Skills page shows them. "reddit/reports" also offers "reddit".
 */
export function skillFolderPaths(
	entries: readonly { folderPath?: string | null }[],
): string[] {
	const paths = new Set<string>();
	for (const { folderPath } of entries) {
		if (!folderPath) continue;
		const segments = folderPath.split("/");
		for (let index = 1; index <= segments.length; index += 1)
			paths.add(segments.slice(0, index).join("/"));
	}
	return [...paths].sort((left, right) => left.localeCompare(right));
}
