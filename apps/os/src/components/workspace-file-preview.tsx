import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { Button, buttonVariants } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";

const VIDEO_MIME_TYPES = ["video/mp4", "video/webm"];
const IMAGE_MIME_TYPES = [
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
		return (
			<Text as="p" role="body">
				Loading file…
			</Text>
		);
	}
	if (query.isError) {
		playback.current = { fileKey, time: 0, playing: false };
		return (
			<Alert variant="destructive">
				<AlertDescription>
					<span>This file is unavailable or you no longer have access.</span>
					<Button
						variant="outline"
						size="sm"
						className="mt-2 w-fit"
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
					>
						{query.isFetching ? "Trying again…" : "Try again"}
					</Button>
				</AlertDescription>
			</Alert>
		);
	}
	const file = query.data;
	const isVideo = VIDEO_MIME_TYPES.includes(file.mimeType);
	// Playback survives a same-file URL rotation only: a different file or a
	// non-video render starts fresh.
	if (playback.current.fileKey !== fileKey || !isVideo)
		playback.current = { fileKey, time: 0, playing: false };
	const src = file.url;
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
					{file.filename} · {(file.size / 1024 / 1024).toFixed(1)} MiB
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
