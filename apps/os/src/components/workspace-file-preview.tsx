import { useRef } from "react";
import { LoadingArea } from "@/components/loading-area";
import { formatBytes } from "@/components/run-detail-sections";
import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { buttonVariants } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { LoadError } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";
import { officeFileFormat } from "@tedix/api-contract/utils/office-file-read";
import { isTextFile } from "@tedix/api-contract/utils/workspace-file-text";
import {
	OFFICE_PREVIEW_MAX_BYTES,
	OfficeFilePreview,
} from "@/components/office-file-preview";
import {
	TEXT_PREVIEW_MAX_BYTES,
	TextFilePreview,
} from "@/components/text-file-preview";

const VIDEO_MIME_TYPES = ["video/mp4", "video/webm"];
export const IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
];

/**
 * A media event is obsolete when the element still plays a resource other than
 * the one the current `src` attribute selected — for example events queued
 * before a file change or before a signed-URL rotation finished loading.
 */
function currentSourceLoaded(video: HTMLVideoElement) {
	return video.currentSrc !== "" && video.currentSrc === video.src;
}

export function WorkspaceFilePreview({
	workspaceId,
	resourceId,
}: {
	workspaceId: string;
	resourceId: string;
}) {
	const fileKey = `${workspaceId}/${resourceId}`;
	const playback = useRef({ fileKey, time: 0, playing: false });
	const query = useQuery({
		...osQuery.osWorkspaces.resources.getFile.queryOptions({
			input: { workspaceId, resourceId },
		}),
		staleTime: 0,
		refetchInterval: 240_000,
	});
	if (query.isPending) {
		playback.current = { fileKey, time: 0, playing: false };
		return <LoadingArea className="h-60" label="Loading file" />;
	}
	if (query.isError) {
		playback.current = { fileKey, time: 0, playing: false };
		return (
			<LoadError
				title="This file could not be loaded"
				help="It may be unavailable or you may no longer have access."
				error={query.error}
				onRetry={() => void query.refetch()}
				retrying={query.isFetching}
			/>
		);
	}
	const file = query.data;
	const isVideo = VIDEO_MIME_TYPES.includes(file.mimeType);
	// Playback survives a same-file URL rotation only: a different file or a
	// non-video render starts fresh.
	if (playback.current.fileKey !== fileKey || !isVideo)
		playback.current = { fileKey, time: 0, playing: false };
	const src = file.url;
	const officeFormat =
		file.size <= OFFICE_PREVIEW_MAX_BYTES
			? officeFileFormat(file.filename, file.mimeType)
			: null;
	return (
		<figure className="m-0 grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
			{isVideo ? (
				<video
					key={src}
					src={src}
					controls
					preload="metadata"
					className="w-full rounded-lg bg-black"
					aria-label={file.filename}
					onTimeUpdate={(event) => {
						const video = event.currentTarget;
						if (currentSourceLoaded(video) && video.readyState > 0)
							playback.current.time = video.currentTime;
					}}
					onPlay={(event) => {
						if (currentSourceLoaded(event.currentTarget))
							playback.current.playing = true;
					}}
					onPause={(event) => {
						const video = event.currentTarget;
						if (currentSourceLoaded(video) && video.readyState > 0)
							playback.current.playing = false;
					}}
					onLoadedMetadata={(event) => {
						const video = event.currentTarget;
						if (!currentSourceLoaded(video)) return;
						video.currentTime = playback.current.time;
						if (playback.current.playing)
							void video.play().catch(() => {
								playback.current.playing = false;
							});
					}}
				>
					<track kind="captions" />
				</video>
			) : file.mimeType === "application/pdf" ? (
				<iframe
					title={file.filename}
					src={src}
					className="h-[70vh] w-full rounded-lg border border-kumo-line"
				/>
			) : IMAGE_MIME_TYPES.includes(file.mimeType) ? (
				<img
					src={src}
					alt={file.filename}
					className="max-h-[70vh] w-full object-contain"
				/>
			) : officeFormat ? (
				<OfficeFilePreview
					workspaceId={workspaceId}
					resourceId={resourceId}
					url={src}
					filename={file.filename}
					format={officeFormat}
				/>
			) : file.size <= TEXT_PREVIEW_MAX_BYTES &&
			  !officeFileFormat(file.filename, file.mimeType) &&
			  isTextFile(file.filename, file.mimeType) ? (
				<TextFilePreview
					workspaceId={workspaceId}
					resourceId={resourceId}
					url={src}
				/>
			) : (
				<Text as="p" role="body">
					Download this file to open it.
				</Text>
			)}
			<figcaption className="flex flex-wrap items-center justify-between gap-2">
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="min-w-0 wrap-anywhere"
				>
					{file.filename} · {formatBytes(file.size)}
				</Text>
				<Link
					variant="plain"
					className={buttonVariants({ size: "sm", variant: "outline" })}
					href={src}
					download={file.filename}
				>
					Download file
				</Link>
			</figcaption>
		</figure>
	);
}
