import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { Text } from "@/components/kumo/text";

export function WorkspaceFilePreview({
	workspaceId,
	resourceId,
}: {
	workspaceId: string;
	resourceId: string;
}) {
	const playback = useRef({ time: 0, playing: false });
	const query = useQuery({
		...osQuery.osWorkspaces.resources.getFile.queryOptions({
			input: { workspaceId, resourceId },
		}),
		staleTime: 0,
		refetchInterval: 240_000,
	});
	if (query.isPending)
		return (
			<Text as="p" role="body">
				Loading file…
			</Text>
		);
	if (query.isError)
		return (
			<Text as="p" role="body" tone="error">
				This file is unavailable or you no longer have access.
			</Text>
		);
	const file = query.data;
	const src = file.url;
	return (
		<figure className="m-0 grid w-full min-w-0 gap-3">
			{["video/mp4", "video/webm"].includes(file.mimeType) ? (
				<video
					src={src}
					controls
					preload="metadata"
					className="w-full rounded-lg bg-black"
					aria-label={file.filename}
					onTimeUpdate={(event) => {
						if (event.currentTarget.readyState > 0)
							playback.current.time = event.currentTarget.currentTime;
					}}
					onPlay={() => {
						playback.current.playing = true;
					}}
					onPause={(event) => {
						if (event.currentTarget.readyState > 0)
							playback.current.playing = false;
					}}
					onLoadedMetadata={(event) => {
						const video = event.currentTarget;
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
			) : [
					"image/png",
					"image/jpeg",
					"image/webp",
					"image/gif",
					"image/avif",
			  ].includes(file.mimeType) ? (
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
			<figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm">
				<span>
					{file.filename} · {(file.size / 1024 / 1024).toFixed(1)} MiB
				</span>
				<a href={src} download={file.filename}>
					Download file
				</a>
			</figcaption>
		</figure>
	);
}
