import type {
	WorkspaceChatAttachment,
	WorkspaceChatFileLocation,
} from "@tedix/api-contract/schemas/workspace-files";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChatImagePreview } from "@/components/chat-image-preview";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	IMAGE_MIME_TYPES,
	WorkspaceFilePreview,
} from "@/components/workspace-file-preview";
import { refreshWorkspaceFileLists } from "@/components/workspace-file-upload";
import { osQuery } from "@/lib/os-query-options";

export function WorkspaceChatMessageFiles({
	workspaceId,
	files,
	chat,
	canSave,
}: {
	workspaceId: string;
	files?: WorkspaceChatAttachment[];
	chat?: WorkspaceChatFileLocation;
	canSave: boolean;
}) {
	if (!files?.length) return null;
	return (
		<ul aria-label="Message files" className="m-0 grid list-none gap-1 p-0">
			{files.map((file) => (
				<li key={file.outputId}>
					{file.chatOnly ? (
						chat ? (
							<ChatUpload
								workspaceId={workspaceId}
								file={file}
								chat={chat}
								canSave={canSave}
							/>
						) : (
							file.title
						)
					) : (
						<>
							<ChatImagePreview
								workspaceId={workspaceId}
								outputId={file.outputId}
								title={file.title}
							/>
							<Link href={`/outputs/${encodeURIComponent(file.outputId)}`}>
								{file.title}
							</Link>{" "}
							<Text as="span" role="caption">
								· Revision {file.revision}
							</Text>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

function ChatUpload({
	workspaceId,
	file,
	chat,
	canSave,
}: {
	workspaceId: string;
	file: WorkspaceChatAttachment;
	chat: WorkspaceChatFileLocation;
	canSave: boolean;
}) {
	const [previewing, setPreviewing] = useState(false);
	const client = useQueryClient();
	const input = { workspaceId, resourceId: file.outputId, chat };
	const metadata = useQuery({
		...osQuery.osWorkspaces.resources.getFile.queryOptions({ input }),
		refetchInterval: 240_000,
		retry: false,
	}).data;
	const saved = useQuery({
		...osQuery.osWorkspaces.resources.get.queryOptions({
			input: { workspaceId, resourceId: file.outputId },
		}),
		enabled: canSave,
		retry: false,
	}).data?.resource;
	const save = useMutation(
		osQuery.osWorkspaces.resources.saveChatFile.mutationOptions({
			onSuccess: () => {
				void refreshWorkspaceFileLists(client, workspaceId).catch(() => {});
			},
		}),
	);
	const savedId =
		save.data?.outputId ?? (saved?.status === "active" ? file.outputId : null);
	return (
		<>
			{metadata && IMAGE_MIME_TYPES.includes(metadata.mimeType) ? (
				<img
					src={metadata.url}
					alt={file.title}
					className="workspace-chat-image-preview"
					data-size="message"
					data-testid="chat-image-preview"
				/>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="ghost" size="sm" onClick={() => setPreviewing(true)}>
					{file.title}
				</Button>
				{savedId ? (
					<Link href={`/outputs/${encodeURIComponent(savedId)}`}>
						Saved to workspace
					</Link>
				) : canSave ? (
					<Button
						variant="outline"
						size="sm"
						disabled={save.isPending}
						onClick={() => save.mutate(input)}
					>
						{save.isPending ? "Saving…" : "Save to workspace"}
					</Button>
				) : null}
			</div>
			{save.isError ? (
				<Text as="p" role="caption" tone="error" aria-live="polite">
					{save.error instanceof Error
						? save.error.message
						: "Could not save the file."}
				</Text>
			) : null}
			{previewing ? (
				<Dialog open onOpenChange={setPreviewing}>
					<DialogContent size="xl">
						<DialogHeader>
							<DialogTitle>{file.title}</DialogTitle>
						</DialogHeader>
						<WorkspaceFilePreview {...input} />
					</DialogContent>
				</Dialog>
			) : null}
		</>
	);
}
