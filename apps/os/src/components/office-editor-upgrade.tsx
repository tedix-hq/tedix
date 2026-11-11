import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import {
	useAppRuntimeDrafts,
	useDocWritingDrafts,
} from "@/components/doc-writing-drafts";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { OFFICE_EDITOR_VERSIONS } from "@tedix/api-contract/assets/office-editor-versions";

type EditorKind = keyof typeof OFFICE_EDITOR_VERSIONS;

export function officeEditorUpgrade(manifest: OsGadgetManifest) {
	const operations = new Set(
		manifest.operations?.map((operation) => operation.name),
	);
	const kind: EditorKind | undefined =
		operations.has("readDocument") && operations.has("replaceDocument")
			? "document"
			: operations.has("readSheet") && operations.has("replaceSheet")
				? "sheet"
				: operations.has("readPresentation") &&
					  operations.has("replacePresentation")
					? "presentation"
					: undefined;
	if (!kind) return null;
	const config = manifest.config?.settings;
	const settings =
		config && typeof config === "object" && !Array.isArray(config)
			? config
			: {};
	const version =
		typeof settings?.blueprintVersion === "number"
			? settings.blueprintVersion
			: 1;
	return version < OFFICE_EDITOR_VERSIONS[kind]
		? { kind, version, currentVersion: OFFICE_EDITOR_VERSIONS[kind] }
		: null;
}

/**
 * Brings an open Doc, Sheet or Slides editor up to the newest one. It runs by
 * itself and shows nothing: the file and its history stay as they are. It
 * waits while the old editor still holds unsaved changes.
 */
export function OfficeEditorUpgrade({
	workspaceId,
	outputId,
	gadgetId,
	revisionId,
	kind,
}: {
	workspaceId: string;
	outputId: string;
	gadgetId: string;
	revisionId: string;
	kind: EditorKind;
}) {
	const appDrafts = useAppRuntimeDrafts();
	const documentDrafts = useDocWritingDrafts();
	const client = useQueryClient();
	const { mutate } = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.gadgets.installOutputEditor({
				workspaceId,
				outputId,
				kind,
				upgradeFromRevisionId: revisionId,
			}),
		onSuccess: () =>
			Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
				client.invalidateQueries({ queryKey: osQueryKeys.blueprints() }),
			]),
	});
	const tried = useRef<string | null>(null);
	useEffect(() => {
		if (tried.current === revisionId) return;
		if (
			appDrafts?.has(`${workspaceId}:${gadgetId}:${revisionId}:${outputId}`) ||
			[...(documentDrafts?.keys() ?? [])].some((key) =>
				key.startsWith(`${gadgetId}:${revisionId}:`),
			)
		)
			return;
		tried.current = revisionId;
		mutate();
	});
	return null;
}
