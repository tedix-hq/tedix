import { useQuery } from "@tanstack/react-query";
import {
	osQuery,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import { IMAGE_MIME_TYPES } from "@/components/workspace-file-preview";

/**
 * A small preview of an uploaded picture attached to a chat message. An
 * uploaded file's document shares its resource's id, so the workspace's
 * file list says whether the attachment is a picture; anything else shows
 * nothing and the caller keeps its plain link.
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
	const resources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const resource = resources.data?.items.find(
		(item) => item.id === outputId && item.resourceType === "file",
	);
	const mimeType = resource?.metadata.mimeType;
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
