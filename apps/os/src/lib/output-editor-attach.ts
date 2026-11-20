import type { QueryClient } from "@tanstack/react-query";
import type {
	OsOutput,
	OsOutputRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	appRuntimeCodeQueryOptions,
	canvasGadgetDetailQueryOptions,
	osQuery,
	osQueryKeys,
	workspaceOpenQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

type EditorKind = Exclude<OsOutput["kind"], "video">;

/** The editor kind of a file that can be edited, or null when it is read-only. */
export function outputEditorKind(detail: {
	output: Pick<OsOutput, "kind" | "status">;
	currentRevision: Pick<OsOutputRevision, "content">;
}): EditorKind | null {
	const { output, currentRevision } = detail;
	if (output.status !== "active" || output.kind === "video") return null;
	if (
		currentRevision.content.kind === "document" &&
		currentRevision.content.file
	)
		return null;
	return output.kind;
}

/**
 * Attach the editor app of a workspace file and return the app's id.
 * Attaching is idempotent: a file that already has an editor returns that
 * same app. The app's data starts loading before the lists are refreshed.
 */
export async function attachOutputEditor(
	queryClient: QueryClient,
	workspaceId: string,
	outputId: string,
	kind: EditorKind,
): Promise<string> {
	const { gadget } =
		await osQuery.osWorkspaces.gadgets.installOutputEditor.call({
			workspaceId,
			outputId,
			kind,
		});
	void queryClient.prefetchQuery(
		canvasGadgetDetailQueryOptions(workspaceId, gadget.id),
	);
	void queryClient.prefetchQuery(
		workspaceOpenQueryOptions(workspaceId, gadget.id),
	);
	if (gadget.currentRevisionId)
		void queryClient.prefetchQuery(
			appRuntimeCodeQueryOptions(
				workspaceId,
				gadget.id,
				gadget.currentRevisionId,
			),
		);
	await Promise.all([
		queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
		queryClient.invalidateQueries({
			queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
		}),
	]);
	return gadget.id;
}
