import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OsAppDraftContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type { OsAppDraftContent } from "@tedix/api-contract/schemas/os-workspaces";
import { hasAppConflictMarkers } from "@tedix/api-contract/utils/app-draft-merge";
import { Button } from "@/components/kumo/button";
import { Textarea } from "@/components/kumo/textarea";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys, workspaceOpenQueryOptions } from "@/lib/os-query-options";

export function AppDraftEditor({
	manifest,
	files,
	selectedFile,
	onSave,
}: {
	manifest: string;
	files: Record<string, string>;
	selectedFile?: string;
	onSave: (content: OsAppDraftContent) => Promise<unknown>;
}) {
	const [texts, setTexts] = useState<Record<string, string>>({
		...files,
		"manifest.json": manifest,
	});
	const [selection, setSelection] = useState("manifest.json");
	const path = selectedFile ?? selection;
	const save = useMutation({
		mutationFn: async () => {
			if (Object.values(texts).some(hasAppConflictMarkers))
				throw new Error("Resolve all conflict markers before saving.");
			const { "manifest.json": manifestText, ...draftFiles } = texts;
			const content = OsAppDraftContentSchema.parse({
				manifest: JSON.parse(manifestText ?? ""),
				files: draftFiles,
			});
			await onSave(content);
		},
	});
	return (
		<div className="grid min-w-0 gap-2 p-3" data-app-draft-editor>
			{!selectedFile && (
				<div className="flex flex-wrap gap-1">
					{Object.keys(texts).map((file) => (
						<Button
							key={file}
							size="sm"
							variant={file === path ? "secondary" : "ghost"}
							onClick={() => setSelection(file)}
						>
							{file}
						</Button>
					))}
				</div>
			)}
			<Textarea
				aria-label={`Edit ${path}`}
				className="font-mono"
				rows={16}
				value={texts[path] ?? ""}
				onChange={(event) => setTexts({ ...texts, [path]: event.target.value })}
				disabled={save.isPending}
			/>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					disabled={save.isPending}
					onClick={() => save.mutate()}
				>
					{save.isPending ? "Saving…" : "Save as draft"}
				</Button>
				{!selectedFile && path !== "manifest.json" && (
					<Button
						size="sm"
						variant="ghost"
						disabled={save.isPending}
						onClick={() => {
							const next = { ...texts };
							delete next[path];
							setTexts(next);
							setSelection("manifest.json");
						}}
					>
						Delete file
					</Button>
				)}
			</div>
			{save.error && (
				<Text as="p" tone="error" role="label">
					{save.error.message}
				</Text>
			)}
		</div>
	);
}

export function AppCodeDraftEditor({
	workspaceId,
	gadgetId,
	revisionId,
	content,
	selectedFile,
	onSaved,
}: {
	workspaceId: string;
	gadgetId: string;
	revisionId: string;
	content: OsAppDraftContent;
	selectedFile: string;
	onSaved: () => void;
}) {
	const queryClient = useQueryClient();
	const access = useQuery(workspaceOpenQueryOptions(workspaceId, gadgetId));
	const [base] = useState({ revisionId, content });
	if (access.data?.capability.role !== "build")
		return (
			<pre className="m-0 overflow-auto px-4 py-3 text-xs">
				{selectedFile === "manifest.json"
					? JSON.stringify(content.manifest, null, 2)
					: content.files[selectedFile]}
			</pre>
		);
	return (
		<AppDraftEditor
			manifest={JSON.stringify(base.content.manifest, null, 2)}
			files={base.content.files}
			selectedFile={selectedFile}
			onSave={async (draft) => {
				await osApi.osAppRuntime.saveDraft({
					workspaceId,
					gadgetId,
					expectedRevisionId: base.revisionId,
					content: draft,
				});
				await queryClient.invalidateQueries({
					queryKey: osQueryKeys.collaborationProposals(),
				});
				onSaved();
			}}
		/>
	);
}
