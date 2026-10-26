import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadSimple } from "@phosphor-icons/react";
import { Button } from "@/components/kumo/button";
import { Alert } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";
import { uploadWorkspaceFile } from "@/lib/workspace-file-upload";
import {
	osQuery,
	canvasOutputsQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

const RECONCILIATION_RETRY_MS = 1_000;

/**
 * `compact` is the chat composer's footer control: one icon button whose label
 * the composer hides at narrow widths. Progress stays on the button and a
 * failure goes to `onError`, so nothing stacks under the one-row footer.
 */
export function WorkspaceFileUpload({
	workspaceId,
	onUploaded,
	compact,
	onError,
}: {
	workspaceId: string;
	onUploaded?: (file: { outputId: string; name: string; url: string }) => void;
	compact?: boolean;
	onError?: (message: string | null) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const busyRef = useRef(false);
	const latest = useRef({ workspaceId, onUploaded, onError });
	latest.current = { workspaceId, onUploaded, onError };
	const [progress, setProgress] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();
	useEffect(() => {
		setProgress(null);
		setError(null);
	}, [workspaceId]);
	async function refresh() {
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
	}
	async function upload(file: File) {
		if (busyRef.current) return;
		busyRef.current = true;
		const current = () => latest.current.workspaceId === workspaceId;
		setProgress(0);
		setError(null);
		latest.current.onError?.(null);
		try {
			const result = await uploadWorkspaceFile(workspaceId, file, (percent) => {
				if (current()) setProgress(percent);
			});
			if (current()) {
				try {
					await refresh();
				} catch {
					setTimeout(() => {
						if (latest.current.workspaceId === workspaceId)
							void refresh().catch(() => {});
					}, RECONCILIATION_RETRY_MS);
				}
				latest.current.onUploaded?.({
					outputId: result.outputId,
					name: result.resource.name,
					url: `/outputs/${result.outputId}`,
				});
			}
		} catch (error) {
			if (current()) {
				const message =
					error instanceof Error ? error.message : "File upload failed.";
				setError(message);
				latest.current.onError?.(message);
			}
		} finally {
			busyRef.current = false;
			setProgress(null);
			if (input.current) input.current.value = "";
		}
	}
	const label = progress === null ? "Upload file" : `Uploading ${progress}%`;
	const picker = (
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
	);
	if (compact)
		return (
			<>
				{picker}
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="chat-composer-upload"
					aria-label={label}
					title={label}
					disabled={progress !== null}
					onClick={() => input.current?.click()}
					icon={<UploadSimple size={14} aria-hidden="true" />}
				>
					<span className="chat-composer-label">{label}</span>
				</Button>
				<span className="sr-only" aria-live="polite">
					{progress === 100 ? "Saving file…" : progress === null ? "" : label}
				</span>
			</>
		);
	return (
		<div className="grid min-w-0 gap-1">
			{picker}
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={progress !== null}
				onClick={() => input.current?.click()}
			>
				{label}
			</Button>
			{progress !== null ? (
				<Text as="p" role="label" aria-live="polite">
					{progress === 100 ? "Saving file…" : `Uploading ${progress}%`}
				</Text>
			) : null}
			{error ? <Alert variant="destructive" description={error} /> : null}
		</div>
	);
}
