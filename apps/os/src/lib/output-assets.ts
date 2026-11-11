import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	listOutputImageSources,
	outputAssetDigest,
	visitOutputImageSources,
} from "@tedix/api-contract/utils/os-output-assets";

/** The stored images a file's content names, each once. */
export function outputAssetReferences(content: OsOutputContent): string[] {
	return listOutputImageSources(
		content,
		(source) => outputAssetDigest(source) !== null,
	);
}

/**
 * A copy of the content for display, with each stored image the map knows
 * drawn from its embedded copy. The content itself keeps its references.
 */
export function withEmbeddedOutputAssets<T extends OsOutputContent>(
	content: T,
	embedded: ReadonlyMap<string, string>,
): T {
	if (embedded.size === 0) return content;
	const copy = structuredClone(content);
	visitOutputImageSources(copy, (source) => embedded.get(source));
	return copy;
}
