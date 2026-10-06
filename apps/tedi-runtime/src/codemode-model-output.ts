import { projectCodeModeOutputForModel } from "@tedix/tedi-codemode-core/bounded-result";

/** Shared function identity marks the projection in persisted facet descriptors. */
export function codeModeToolModelOutput({ output }: { output: unknown }) {
	return projectCodeModeOutputForModel(output);
}
