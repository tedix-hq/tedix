import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { Button } from "@/components/kumo/button";
import { ArrowCircleUp } from "@phosphor-icons/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	useAppRuntimeDrafts,
	useDocWritingDrafts,
} from "@/components/doc-writing-drafts";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { OFFICE_EDITOR_VERSIONS } from "@tedix/api-contract/assets/office-editor-versions";

type EditorKind = keyof typeof OFFICE_EDITOR_VERSIONS;
const labels = { document: "Doc", sheet: "Sheet", presentation: "Slides" };

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
	const flaggedVersion =
		kind === "document" && typeof settings?.editor === "string"
			? Number(/^document-v(\d+)$/.exec(settings.editor)?.[1] ?? 1)
			: 1;
	const version =
		typeof settings?.blueprintVersion === "number"
			? settings.blueprintVersion
			: flaggedVersion;
	return version < OFFICE_EDITOR_VERSIONS[kind]
		? { kind, version, currentVersion: OFFICE_EDITOR_VERSIONS[kind] }
		: null;
}

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
	const label = labels[kind];
	const [open, setOpen] = useState(false);
	const appDrafts = useAppRuntimeDrafts();
	const documentDrafts = useDocWritingDrafts();
	const client = useQueryClient();
	const upgrade = useMutation({
		mutationFn: async () => {
			if (
				appDrafts?.has(
					`${workspaceId}:${gadgetId}:${revisionId}:${outputId}`,
				) ||
				[...(documentDrafts?.keys() ?? [])].some((key) =>
					key.startsWith(`${gadgetId}:${revisionId}:`),
				)
			)
				throw new Error(
					"Save or explicitly discard your current draft before upgrading. Your editor and draft have not changed.",
				);
			const result = await osApi.osWorkspaces.gadgets.installOutputEditor({
				workspaceId,
				outputId,
				kind,
				upgradeFromRevisionId: revisionId,
			});
			if (result.gadget.id !== gadgetId)
				throw new Error(
					"The editor identity changed. Reopen the workspace to review it.",
				);
			return result;
		},
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
				client.invalidateQueries({ queryKey: osQueryKeys.blueprints() }),
			]);
			setOpen(false);
		},
	});
	return (
		<>
			{/* One quiet line above the app, not a block that pushes it down. */}
			<div
				className="flex items-center gap-2 border-b border-kumo-hairline px-3 py-1 text-kumo-subtle type-tedix-label"
				role="status"
			>
				<ArrowCircleUp aria-hidden size={14} />
				<span className="min-w-0 flex-1 truncate">
					A newer {label} editor is available. Your file and its history stay as
					they are.
				</span>
				<Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
					Upgrade
				</Button>
			</div>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title={`Upgrade this ${label} editor?`}
				description="Save any edits first. This replaces the app's client and server code, including custom code changes, while keeping the same file, app and revision history. Unsaved drafts stay attached to the old app version and do not move to the new editor."
				confirmLabel="Upgrade editor"
				pendingLabel="Upgrading…"
				isPending={upgrade.isPending}
				error={upgrade.error}
				onConfirm={() => upgrade.mutate()}
			/>
		</>
	);
}
