import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	OsAppDraftContentSchema,
	type OsAppDraftContent,
	type OsCollaborationProposal,
} from "@tedix/api-contract/schemas/os-workspaces";
import { hasAppConflictMarkers } from "@tedix/api-contract/utils/app-draft-merge";
import { CanvasCodeEditor } from "@/components/canvas-editor";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { useCollabDoc } from "@/lib/use-collab-doc";

/** Code stays in the proposal until the existing review flow explicitly accepts it. */
export function AppSharedDraftEditor({
	workspaceId,
	gadgetId,
	proposal,
	content,
	onClose,
}: {
	workspaceId: string;
	gadgetId: string;
	proposal: OsCollaborationProposal;
	content: OsAppDraftContent;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [path, setPath] = useState("manifest.json");
	const [initial] = useState({
		baseRevisionId: proposal.baseRevisionId,
		sequence: proposal.sequence,
		content,
	});
	const baseChanged = proposal.baseRevisionId !== initial.baseRevisionId;
	const closed = proposal.status !== "open";
	const reservedSource = "manifest.json" in content.files;
	const loaded = baseChanged || reservedSource ? initial.content : content;
	const texts = {
		...loaded.files,
		"manifest.json": JSON.stringify(loaded.manifest, null, 2),
	};
	const room = useCollabDoc({
		workspaceId,
		docKey: `app-draft:${gadgetId}:${proposal.id}:${initial.baseRevisionId}`,
		enabled: !("manifest.json" in initial.content.files),
		canonical: {
			text: "",
			files: texts,
			revision:
				baseChanged || reservedSource ? initial.sequence : proposal.sequence,
			revisionId: initial.baseRevisionId,
		},
	});
	const save = useMutation({
		mutationFn: async () => {
			if (baseChanged || closed || reservedSource)
				throw new Error(
					"This draft changed or closed. Copy your code before reopening it.",
				);
			const basis = room.commitBasis();
			const stamp = room.canonical;
			if (!basis?.files || !stamp?.revisionId || room.recoveryRequired)
				throw new Error("Wait for shared changes to sync before saving.");
			const { "manifest.json": manifest, ...files } = Object.fromEntries(
				basis.files,
			);
			if (
				Object.values(files).some(hasAppConflictMarkers) ||
				hasAppConflictMarkers(manifest ?? "")
			)
				throw new Error("Resolve all conflict markers before saving.");
			const draft = OsAppDraftContentSchema.parse({
				manifest: JSON.parse(manifest ?? ""),
				files,
			});
			const saved = await osApi.osAppRuntime.saveDraft({
				workspaceId,
				gadgetId,
				proposalId: proposal.id,
				expectedRevisionId: stamp.revisionId,
				expectedSequence: stamp.revision,
				content: draft,
			});
			room.groundCommit(
				basis,
				saved.proposal.sequence,
				saved.proposal.baseRevisionId,
			);
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.collaborationProposals(),
			});
		},
	});
	return (
		<section className="grid min-w-0 gap-2" aria-label="Shared draft code">
			<Text as="p" role="label" tone="secondary" className="m-0">
				{reservedSource
					? "Shared editing unavailable"
					: room.status === "connected"
						? `${room.peers} connected`
						: "Connecting shared editor…"}
				{" · Save shared changes before previewing or accepting this draft."}
			</Text>
			{reservedSource && (
				<Text as="p" role="label" tone="warning">
					This app contains a source file named manifest.json. Shared editing is
					unavailable so that file stays intact. Ask an agent to edit this draft
					while preserving that file.
				</Text>
			)}
			<div className="flex flex-wrap gap-1">
				{Object.keys(texts).map((file) => (
					<Button
						key={file}
						size="sm"
						variant={file === path ? "secondary" : "ghost"}
						onClick={() => setPath(file)}
					>
						{file}
					</Button>
				))}
			</div>
			{room.session && (
				<CanvasCodeEditor
					session={room.session}
					path={path}
					readOnly={
						reservedSource ||
						baseChanged ||
						closed ||
						room.status !== "connected" ||
						save.isPending ||
						room.recoveryRequired ||
						room.recoverableFiles !== null
					}
				/>
			)}
			{(baseChanged || closed) && (
				<Text as="p" role="label" tone="warning">
					This draft changed base or closed. Your editor stays open so you can
					copy and compare the code before reopening the draft.
				</Text>
			)}
			{room.recoverableFiles && (
				<div className="grid gap-2">
					<Text as="p" role="label" tone="warning">
						The connection interrupted unsynced edits. Copy this retained code
						and compare it with the shared files before continuing.
					</Text>
					<Textarea
						aria-label="Retained unsynced code"
						readOnly
						rows={8}
						value={JSON.stringify(room.recoverableFiles, null, 2)}
					/>
					<Button
						size="sm"
						variant="secondary"
						onClick={room.clearRecoverableFiles}
					>
						I have reviewed my copy; use shared code
					</Button>
				</div>
			)}
			{room.recoveryRequired && (
				<Text as="p" role="label" tone="warning">
					This draft changed outside the editor. Keep a copy of your edits, then
					reload and compare before saving.
				</Text>
			)}
			{room.tooLarge && (
				<Text as="p" role="label" tone="warning">
					This draft is too large for shared editing.
				</Text>
			)}
			{save.error && (
				<Text as="p" role="label" tone="error">
					{save.error.message}
				</Text>
			)}
			<Button
				size="sm"
				disabled={
					reservedSource ||
					baseChanged ||
					closed ||
					save.isPending ||
					room.status !== "connected" ||
					room.unacknowledged ||
					room.recoveryRequired ||
					room.recoverableFiles !== null ||
					room.blocked !== null
				}
				onClick={() => save.mutate()}
			>
				{save.isPending ? "Saving…" : "Save shared draft"}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={
					save.isPending ||
					room.unacknowledged ||
					room.recoverableFiles !== null
				}
				onClick={onClose}
			>
				Close editor
			</Button>
		</section>
	);
}
