import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { outputImageQueryOptions } from "./os-query-options";
import {
	outputAssetReferences,
	withEmbeddedOutputAssets,
} from "./output-assets";

/**
 * A file's content for a read view: stored images are read once each and
 * drawn from embedded copies. An image still loading, or one that cannot be
 * read, draws nothing.
 */
export function useOutputContentWithImages<T extends OsOutputContent>(
	outputId: string,
	content: T,
): T {
	const references = useMemo(() => outputAssetReferences(content), [content]);
	const embedded = useQueries({
		queries: references.map((url) =>
			outputImageQueryOptions({ outputId, url }),
		),
		combine: (results) =>
			results.map((result) => result.data?.dataUrl ?? "").join("\n"),
	});
	return useMemo(() => {
		const sources = embedded.split("\n");
		return withEmbeddedOutputAssets(
			content,
			new Map(
				references.flatMap((reference, index) =>
					sources[index] ? [[reference, sources[index]] as const] : [],
				),
			),
		);
	}, [content, references, embedded]);
}
