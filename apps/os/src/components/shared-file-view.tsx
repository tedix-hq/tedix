import type { OsSharedFile } from "@tedix/api-contract/contracts/os-shares";
import { useEffect, useState } from "react";
import { LoadError } from "@/components/kumo/alert";
import { buttonVariants } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";

const IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
];
const VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A shared file by type: a player, an image, a PDF viewer, or a download. */
export function SharedFileBody({ file }: { file: OsSharedFile }) {
	const download = (
		<Link
			variant="plain"
			className={buttonVariants({ size: "sm", variant: "outline" })}
			href={file.url}
			download={file.filename}
			data-shared-file-download
		>
			Download file
		</Link>
	);
	const caption = (
		<Text
			as="span"
			role="label"
			tone="secondary"
			className="min-w-0 wrap-anywhere"
		>
			{file.filename} · {fileSize(file.size)}
		</Text>
	);
	let body = null;
	if (VIDEO_MIME_TYPES.includes(file.mimeType))
		body = (
			<video
				src={file.url}
				controls
				playsInline
				preload="metadata"
				className="max-h-[75vh] w-full rounded-lg bg-black"
				aria-label={file.filename}
			>
				<track kind="captions" />
			</video>
		);
	else if (IMAGE_MIME_TYPES.includes(file.mimeType))
		body = (
			<img
				src={file.url}
				alt={file.filename}
				className="max-h-[75vh] w-full object-contain"
			/>
		);
	else if (file.mimeType === "application/pdf")
		body = (
			<iframe
				title={file.filename}
				src={file.url}
				className="h-[75vh] w-full rounded-lg border border-kumo-line"
			/>
		);
	return (
		<figure
			className="m-0 mx-auto grid w-full max-w-5xl min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
			data-shared-file={file.mimeType}
		>
			{body}
			<figcaption className="flex flex-wrap items-center justify-between gap-2">
				{caption}
				{download}
			</figcaption>
		</figure>
	);
}

type Loaded =
	| { status: "loading" }
	| { status: "ready"; file: OsSharedFile }
	| { status: "unavailable" };

/**
 * The uploaded file of a shared document, read through the link's own
 * session. The media URL stays the same for the whole session, so the share
 * page's background rechecks never restart a playing video.
 */
export function SharedFileView({
	sessionToken,
	outputId,
}: {
	sessionToken: string;
	outputId: string;
}) {
	const [state, setState] = useState<Loaded>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let alive = true;
		setState({ status: "loading" });
		fetch("/api/os-shared/file", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionToken, outputId }),
		})
			.then((response) =>
				response.ok
					? (response.json() as Promise<OsSharedFile>)
					: Promise.reject(new Error("This file is unavailable")),
			)
			.then(
				(file) => {
					if (alive) setState({ status: "ready", file });
				},
				() => {
					if (alive) setState({ status: "unavailable" });
				},
			);
		return () => {
			alive = false;
		};
	}, [sessionToken, outputId, attempt]);
	if (state.status === "loading")
		return (
			<Text as="p" role="body">
				Loading file…
			</Text>
		);
	if (state.status === "unavailable")
		return (
			<LoadError
				title="This file could not be loaded"
				help="The link may have expired or been revoked."
				onRetry={() => setAttempt((value) => value + 1)}
			/>
		);
	return <SharedFileBody file={state.file} />;
}
