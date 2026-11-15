import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { IMAGE_MIME_TYPES } from "@/components/workspace-file-preview";

/**
 * A small preview of an uploaded picture attached to a chat message. An
 * uploaded file's document shares its resource's id, so that resource says
 * whether the attachment is a picture. Any other attachment has no such
 * resource and shows nothing; the caller keeps its plain link.
 */
export function ChatImagePreview({
	workspaceId,
	outputId,
	title,
	size = "message",
}: {
	workspaceId: string;
	outputId: string;
	title: string;
	/** A chip in the composer shows a thumbnail; a sent message shows more. */
	size?: "chip" | "message";
}) {
	// Read the one resource: a workspace's file list is capped, so a new
	// upload in a busy workspace may not be on it.
	const resource = useQuery({
		...osQuery.osWorkspaces.resources.get.queryOptions({
			input: { workspaceId, resourceId: outputId },
		}),
		retry: false,
		staleTime: Infinity,
	}).data?.resource;
	const mimeType =
		resource?.resourceType === "file" ? resource.metadata.mimeType : undefined;
	const isImage =
		typeof mimeType === "string" && IMAGE_MIME_TYPES.includes(mimeType);
	const file = useQuery({
		...osQuery.osWorkspaces.resources.getFile.queryOptions({
			input: { workspaceId, resourceId: outputId },
		}),
		enabled: isImage,
		// The signed link lasts five minutes; renew it before it lapses.
		refetchInterval: 240_000,
	});
	if (!isImage || !file.data) return null;
	return (
		<img
			alt={title}
			className="workspace-chat-image-preview"
			data-size={size}
			data-testid="chat-image-preview"
			src={file.data.url}
		/>
	);
}
