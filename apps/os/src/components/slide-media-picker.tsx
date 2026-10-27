import { ImageSquare } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { SlideImageUploadButton } from "@/components/slide-insert-library";
import { osQuery } from "@/lib/os-query-options";
import { safeImageSource } from "@/lib/output-models";
import { SLIDE_IMAGE_TYPES } from "@/lib/slide-image-upload";

const WORKSPACE_IMAGES_LIMIT = 100;

/** True when a workspace file resource reports a slide-embeddable image type. */
export function isSlideImageResource(
	resource: Pick<OsWorkspaceResource, "providerId" | "resourceType"> & {
		metadata?: Record<string, unknown>;
	},
): boolean {
	if (resource.providerId !== "tedix" || resource.resourceType !== "file")
		return false;
	const mimeType = resource.metadata?.mimeType;
	return (
		typeof mimeType === "string" &&
		(SLIDE_IMAGE_TYPES as readonly string[]).includes(mimeType)
	);
}

/**
 * Download one workspace file through its signed preview URL and hand it
 * back as a File, so the ordinary slide-image pipeline sizes and embeds it.
 */
async function workspaceImageFile(
	workspaceId: string,
	resource: OsWorkspaceResource,
): Promise<File> {
	const file = await (
		await import("@/lib/api")
	).osApi.osWorkspaces.resources.getFile({
		workspaceId,
		resourceId: resource.id,
	});
	const response = await fetch(file.url);
	if (!response.ok) throw new Error("The workspace file could not be read.");
	const blob = await response.blob();
	return new File([blob], file.filename, { type: blob.type || file.mimeType });
}

function WorkspaceImageRow({
	workspaceId,
	resource,
	disabled,
	onPick,
}: {
	workspaceId: string;
	resource: OsWorkspaceResource;
	disabled?: boolean;
	onPick: (file: File) => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const preview = useQuery({
		...osQuery.osWorkspaces.resources.getFile.queryOptions({
			input: { workspaceId, resourceId: resource.id },
		}),
		staleTime: 240_000,
	});
	const pick = async () => {
		setError(null);
		try {
			onPick(await workspaceImageFile(workspaceId, resource));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The file could not be used.",
			);
		}
	};
	return (
		<li className="grid gap-1">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				multiline
				disabled={disabled}
				className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
				aria-label={`Use workspace image ${resource.name}`}
				onClick={() => void pick()}
			>
				<span
					className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-sm bg-kumo-fill"
					aria-hidden
				>
					{preview.data?.url ? (
						<img
							src={preview.data.url}
							alt=""
							className="size-full object-cover"
						/>
					) : (
						<ImageSquare size={16} />
					)}
				</span>
				<span className="grid min-w-0">
					<Text as="span" role="label" weight="medium" truncate>
						{resource.name}
					</Text>
					<Text as="span" role="caption" tone="secondary" truncate>
						Workspace file
					</Text>
				</span>
			</Button>
			{error ? (
				<Text as="span" role="caption" className="text-kumo-danger px-2">
					{error}
				</Text>
			) : null}
		</li>
	);
}

function WorkspaceImageList({
	workspaceId,
	disabled,
	onPick,
}: {
	workspaceId: string;
	disabled?: boolean;
	onPick: (file: File) => void;
}) {
	const resources = useQuery(
		osQuery.osWorkspaces.resources.list.queryOptions({
			input: {
				workspaceId,
				status: "active",
				limit: WORKSPACE_IMAGES_LIMIT,
			},
		}),
	);
	const images = (resources.data?.items ?? []).filter(isSlideImageResource);
	if (resources.isPending)
		return (
			<Text role="caption" tone="secondary" className="m-0 px-2">
				Loading workspace images…
			</Text>
		);
	if (resources.isError)
		return (
			<Text role="caption" tone="secondary" className="m-0 px-2">
				Workspace images are unavailable right now.
			</Text>
		);
	if (!images.length)
		return (
			<Text role="caption" tone="secondary" className="m-0 px-2">
				No images in this workspace yet. Upload one below and it is added to
				the workspace files.
			</Text>
		);
	return (
		<ul className="m-0 grid max-h-60 list-none gap-0.5 overflow-y-auto p-0">
			{images.map((resource) => (
				<WorkspaceImageRow
					key={resource.id}
					workspaceId={workspaceId}
					resource={resource}
					disabled={disabled}
					onPick={onPick}
				/>
			))}
		</ul>
	);
}

/**
 * The slide image picker: choose an image already in the workspace, upload a
 * new one, or keep a linked URL. Choosing always yields a File (or a URL when
 * `onPickUrl` is set), so callers share the same embed path as uploads.
 */
export function SlideMediaPicker({
	workspaceId,
	open,
	onOpenChange,
	onPickFile,
	onPickUrl,
}: {
	/** Workspace to list files from; omitted hides the workspace section. */
	workspaceId?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPickFile: (file: File) => void;
	/** Linked-image path; the URL row is hidden unless provided. */
	onPickUrl?: (src: string) => void;
}) {
	const [url, setUrl] = useState("");
	const pickFile = (file: File) => {
		onOpenChange(false);
		onPickFile(file);
	};
	const pickUrl = () => {
		const src = safeImageSource(url.trim());
		if (!src) return;
		onOpenChange(false);
		setUrl("");
		onPickUrl?.(src);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" aria-label="Choose slide image">
				<DialogHeader>
					<DialogTitle>Choose an image</DialogTitle>
					<DialogDescription>
						Pick an image from this workspace, upload one from your device, or
						link one by URL.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					{workspaceId ? (
						<section aria-label="Workspace images" className="grid gap-1">
							<Text
								as="h3"
								role="caption"
								tone="secondary"
								weight="semibold"
								className="m-0 px-2"
							>
								Workspace files
							</Text>
							<WorkspaceImageList
								workspaceId={workspaceId}
								onPick={pickFile}
							/>
						</section>
					) : null}
					<SlideImageUploadButton
						label="Upload from device"
						onFile={pickFile}
					/>
					{onPickUrl ? (
						<div className="flex items-end gap-2">
							<Input
								type="url"
								aria-label="Slide image URL"
								placeholder="https://"
								maxLength={2_048}
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										pickUrl();
									}
								}}
							/>
							<Button
								type="button"
								size="sm"
								variant="secondary"
								disabled={!safeImageSource(url.trim())}
								onClick={pickUrl}
							>
								Use link
							</Button>
						</div>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
