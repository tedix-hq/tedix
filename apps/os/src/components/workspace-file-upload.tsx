import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { uploadWorkspaceFile } from "@/lib/workspace-file-upload";
import {
	osQuery,
	canvasOutputsQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

export function WorkspaceFileUpload({
	workspaceId,
	onUploaded,
}: {
	workspaceId: string;
	onUploaded?: (file: { outputId: string; name: string; url: string }) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const busyRef = useRef(false);
	const latest = useRef({ workspaceId, onUploaded });
	latest.current = { workspaceId, onUploaded };
	const [progress, setProgress] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();
	async function upload(file: File) {
		if (busyRef.current) return;
		busyRef.current = true;
		setProgress(0);
		setError(null);
		try {
			const result = await uploadWorkspaceFile(workspaceId, file, setProgress);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
				}),
				queryClient.invalidateQueries({
					queryKey: canvasOutputsQueryOptions(workspaceId).queryKey,
				}),
				queryClient.invalidateQueries({
					queryKey: osQuery.osWorkspaces.outputs.library.key(),
				}),
			]);
			if (latest.current.workspaceId === workspaceId)
				latest.current.onUploaded?.({
					outputId: result.outputId,
					name: result.resource.name,
					url: `/outputs/${result.outputId}`,
				});
		} catch (error) {
			setError(error instanceof Error ? error.message : "File upload failed.");
		} finally {
			busyRef.current = false;
			setProgress(null);
			if (input.current) input.current.value = "";
		}
	}
	return (
		<div className="grid min-w-0 gap-1">
			<input
				ref={input}
				type="file"
				className="hidden"
				aria-label="Upload workspace file"
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					if (file) void upload(file);
				}}
			/>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={progress !== null}
				onClick={() => input.current?.click()}
			>
				{progress === null ? "Upload file" : `Uploading ${progress}%`}
			</Button>
			{progress !== null ? (
				<Text as="p" role="label" aria-live="polite">
					{progress === 100 ? "Saving file…" : `Uploading ${progress}%`}
				</Text>
			) : null}
			{error ? (
				<Text as="p" role="label" tone="error" aria-live="polite">
					{error}
				</Text>
			) : null}
		</div>
	);
}
