import {
	type ClipboardEvent,
	type ComponentProps,
	createContext,
	type DragEvent,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, X } from "@phosphor-icons/react";
import { officeFileFormat } from "@tedix/api-contract/utils/office-file-read";
import { ChatImagePreview } from "@/components/chat-image-preview";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import {
	IMAGE_MIME_TYPES,
	WorkspaceFilePreview,
} from "@/components/workspace-file-preview";
import { refreshWorkspaceFileLists } from "@/components/workspace-file-upload";
import { osQuery } from "@/lib/os-query-options";
import { cn } from "@/lib/utils";
import { uploadWorkspaceFile } from "@/lib/workspace-file-upload";

/** A message carries at most this many files. */
export const CHAT_FILE_LIMIT = 5;

type DropTarget = {
	onFiles: (files: File[]) => void;
	/** The message already has all the files it can carry. */
	full: () => boolean;
};

const DropContext = createContext<((target: DropTarget) => () => void) | null>(
	null,
);

function carriesFiles(event: DragEvent) {
	return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * The workspace chat panel as a place to drop files. The composer inside it
 * says what to do with them through `useWorkspaceChatFileDrop`; while no
 * composer accepts files, a drag is left alone.
 */
export function WorkspaceChatDropZone({
	children,
	className,
	...props
}: ComponentProps<"div">) {
	const target = useRef<DropTarget | null>(null);
	const depth = useRef(0);
	const [active, setActive] = useState(false);
	const register = useCallback((next: DropTarget) => {
		target.current = next;
		return () => {
			if (target.current === next) target.current = null;
		};
	}, []);
	const reset = () => {
		depth.current = 0;
		setActive(false);
	};
	const accepts = (event: DragEvent) =>
		target.current !== null && carriesFiles(event);
	return (
		<DropContext.Provider value={register}>
			<div
				{...props}
				className={cn("relative", className)}
				onDragEnter={(event) => {
					if (!accepts(event)) return;
					event.preventDefault();
					depth.current += 1;
					setActive(true);
				}}
				onDragOver={(event) => {
					if (!accepts(event)) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = target.current?.full()
						? "none"
						: "copy";
					setActive(true);
				}}
				onDragLeave={() => {
					depth.current = Math.max(0, depth.current - 1);
					if (depth.current === 0) setActive(false);
				}}
				onDragEnd={reset}
				onDrop={(event) => {
					if (!accepts(event)) return;
					event.preventDefault();
					event.stopPropagation();
					reset();
					target.current?.onFiles(Array.from(event.dataTransfer.files));
				}}
			>
				{children}
				{active ? (
					<Surface
						data-slot="attachment-dropzone"
						role="status"
						className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-kumo-brand p-4"
					>
						<Text role="body" className="m-0 flex items-center gap-2">
							<Paperclip size={20} aria-hidden="true" />
							{target.current?.full()
								? "Messages are limited to 5 attachments"
								: "Drop files to attach"}
						</Text>
					</Surface>
				) : null}
			</div>
		</DropContext.Provider>
	);
}

/** Sends files dropped on the chat panel to this composer; `null` declines them. */
export function useWorkspaceChatFileDrop(target: DropTarget | null) {
	const register = useContext(DropContext);
	const latest = useRef(target);
	latest.current = target;
	const accepting = target !== null;
	useEffect(() => {
		if (!register || !accepting) return;
		return register({
			onFiles: (files) => latest.current?.onFiles(files),
			full: () => latest.current?.full() ?? true,
		});
	}, [register, accepting]);
}

/**
 * The files a paste should attach. A clipboard that also holds plain text is
 * a text paste (a copied table cell carries a picture of itself too).
 */
export function pastedFiles(event: ClipboardEvent): File[] {
	const files = Array.from(event.clipboardData.files);
	if (files.length === 0 || event.clipboardData.getData("text/plain"))
		return [];
	return files;
}

export type WorkspaceChatUpload = {
	id: number;
	name: string;
	progress: number;
	error: string | null;
};

/**
 * Uploads dropped or pasted files to the workspace and hands each saved file
 * to `onAttached`. One file failing leaves the others alone.
 */
export function useWorkspaceChatUploads({
	workspaceId,
	attachedCount,
	onAttached,
}: {
	workspaceId: string;
	/** Files already on the message. */
	attachedCount: number;
	onAttached: (file: { outputId: string; title: string }) => void;
}) {
	const queryClient = useQueryClient();
	const [uploads, setUploads] = useState<WorkspaceChatUpload[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const latest = useRef({ attachedCount, onAttached });
	latest.current = { attachedCount, onAttached };
	const nextId = useRef(0);
	const generation = useRef(0);
	const inFlight = useRef(0);
	const removed = useRef(new Set<number>());
	const full = () =>
		latest.current.attachedCount + inFlight.current >= CHAT_FILE_LIMIT;
	const addFiles = (files: File[]) => {
		if (files.length === 0) return;
		const capacity = Math.max(
			0,
			CHAT_FILE_LIMIT - latest.current.attachedCount - inFlight.current,
		);
		if (capacity === 0) {
			setNotice("Messages are limited to 5 attachments.");
			return;
		}
		setNotice(
			files.length > capacity
				? "Messages are limited to 5 attachments; extra files were not added."
				: null,
		);
		const run = generation.current;
		for (const file of files.slice(0, capacity)) {
			const id = ++nextId.current;
			inFlight.current += 1;
			setUploads((items) => [
				...items,
				{ id, name: file.name, progress: 0, error: null },
			]);
			const patch = (change: Partial<WorkspaceChatUpload>) => {
				if (generation.current !== run) return;
				setUploads((items) =>
					items.map((item) => (item.id === id ? { ...item, ...change } : item)),
				);
			};
			void uploadWorkspaceFile(
				workspaceId,
				file,
				(progress) => patch({ progress }),
				{ document: true },
			)
				.then((result) => {
					if (generation.current !== run || removed.current.has(id)) return;
					if (!result.outputId) throw new Error("File upload failed.");
					void refreshWorkspaceFileLists(queryClient, workspaceId).catch(
						() => {},
					);
					setUploads((items) => items.filter((item) => item.id !== id));
					latest.current.onAttached({
						outputId: result.outputId,
						title: result.resource.name,
					});
				})
				.catch((error: unknown) =>
					patch({
						error:
							error instanceof Error ? error.message : "File upload failed.",
					}),
				)
				.finally(() => {
					if (generation.current === run) inFlight.current -= 1;
				});
		}
	};
	return {
		uploads,
		notice,
		/** A file is still on its way; sending now would leave it behind. */
		busy: uploads.some((item) => item.error === null),
		full,
		addFiles,
		/** Takes a file off the message; one still uploading is not attached when it lands. */
		remove: (id: number) => {
			removed.current.add(id);
			setUploads((items) => items.filter((item) => item.id !== id));
		},
		/** Forgets every upload, for a switch to another conversation. */
		clear: () => {
			generation.current += 1;
			inFlight.current = 0;
			setUploads([]);
			setNotice(null);
		},
	};
}

/** The files on the message being written, and the ones still uploading. */
export function WorkspaceChatComposerFiles({
	workspaceId,
	files,
	uploads,
	notice,
	onRemove,
	onRemoveUpload,
}: {
	workspaceId: string;
	files: Array<{ outputId: string; title: string }>;
	uploads: WorkspaceChatUpload[];
	notice: string | null;
	onRemove: (outputId: string) => void;
	onRemoveUpload: (id: number) => void;
}) {
	const [previewing, setPreviewing] = useState<{
		outputId: string;
		title: string;
	} | null>(null);
	return (
		<>
			{notice ? (
				<Text
					as="p"
					role="caption"
					tone="error"
					className="m-0 px-1"
					data-slot="attachment-error"
					aria-live="assertive"
				>
					{notice}
				</Text>
			) : null}
			{files.length + uploads.length > 0 ? (
				<ul
					aria-label="Files added to this message"
					className="workspace-chat-composer-files"
				>
					{files.map((file) => (
						<AttachedFile
							key={file.outputId}
							workspaceId={workspaceId}
							file={file}
							onOpen={() => setPreviewing(file)}
							onRemove={() => onRemove(file.outputId)}
						/>
					))}
					{uploads.map((upload) => (
						<li
							key={`upload-${upload.id}`}
							data-state={upload.error ? "failed" : "uploading"}
						>
							<FileText aria-hidden size={14} />
							<span className="truncate">{upload.name}</span>
							{upload.error ? (
								<Text as="span" role="caption" tone="error" aria-live="polite">
									{upload.error}
								</Text>
							) : (
								<Text as="span" role="caption" aria-live="polite">
									{upload.progress >= 100
										? "Saving file…"
										: `Uploading ${upload.progress}%`}
								</Text>
							)}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={`Remove ${upload.name}`}
								title="Remove"
								onClick={() => onRemoveUpload(upload.id)}
							>
								<X aria-hidden size={12} />
							</Button>
						</li>
					))}
				</ul>
			) : null}
			{previewing ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setPreviewing(null);
					}}
				>
					<DialogContent size="xl">
						<DialogHeader>
							<DialogTitle>{previewing.title}</DialogTitle>
						</DialogHeader>
						<WorkspaceFilePreview
							workspaceId={workspaceId}
							resourceId={previewing.outputId}
						/>
					</DialogContent>
				</Dialog>
			) : null}
		</>
	);
}

function AttachedFile({
	workspaceId,
	file,
	onOpen,
	onRemove,
}: {
	workspaceId: string;
	file: { outputId: string; title: string };
	onOpen: () => void;
	onRemove: () => void;
}) {
	// An uploaded file's document shares its resource's id; a document, sheet
	// or deck made in the workspace has no such resource and stays a label.
	const resource = useQuery({
		...osQuery.osWorkspaces.resources.get.queryOptions({
			input: { workspaceId, resourceId: file.outputId },
		}),
		retry: false,
		staleTime: Infinity,
	}).data?.resource;
	const mimeType =
		resource?.resourceType === "file" &&
		typeof resource.metadata.mimeType === "string"
			? resource.metadata.mimeType
			: undefined;
	const canPreview =
		resource?.resourceType === "file" &&
		(mimeType === "application/pdf" ||
			(mimeType !== undefined && IMAGE_MIME_TYPES.includes(mimeType)) ||
			officeFileFormat(resource.name, mimeType) !== null);
	return (
		<li>
			<ChatImagePreview
				workspaceId={workspaceId}
				outputId={file.outputId}
				title={file.title}
				size="chip"
			/>
			<FileText aria-hidden size={14} />
			{canPreview ? (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="min-w-0 px-1"
					aria-label={`Preview ${file.title}`}
					title="Preview"
					onClick={onOpen}
				>
					<span className="truncate">{file.title}</span>
				</Button>
			) : (
				<span className="truncate">{file.title}</span>
			)}
			<Button
				type="button"
				size="icon-sm"
				variant="ghost"
				aria-label={`Remove ${file.title}`}
				title="Remove"
				onClick={onRemove}
			>
				<X aria-hidden size={12} />
			</Button>
		</li>
	);
}
