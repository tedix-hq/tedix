/**
 * App logo upload via Cloudflare Images Direct Creator Upload: mint a one-time upload URL, POST the file straight to Cloudflare (bypassing
 * Worker body limits), then confirm so the server binds the delivery URL to
 * the app. A successful bind or delete invalidates the apps domain — the
 * app-record reader here is `apps.getByIdWithTools`.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageSquare, Trash, UploadSimple } from "@phosphor-icons/react";
import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/kumo/toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import { Button } from "@/components/kumo/button";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";

const ACCEPTED_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/svg+xml",
	"image/gif",
];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

async function directCreatorUpload(
	appId: string,
	file: File,
): Promise<{ url: string }> {
	const { imageId, uploadURL } = await osApi.images.requestUpload({
		entityType: "app",
		entityId: appId,
	});

	const form = new FormData();
	form.append("file", file);
	const res = await fetch(uploadURL, { method: "POST", body: form });
	if (!res.ok) {
		throw new Error(`Upload failed (${res.status})`);
	}

	return osApi.images.confirmUpload({
		entityType: "app",
		entityId: appId,
		imageId,
	});
}

export function AppImageUpload({
	appId,
	currentImageUrl,
	fallbackText,
	disabled = false,
}: {
	appId: string;
	currentImageUrl?: string | null;
	fallbackText?: string;
	disabled?: boolean;
}) {
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);

	const displayUrl = previewUrl || currentImageUrl;
	const initials = fallbackText
		?.split(" ")
		.map((word) => word[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();

	const invalidateApp = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
	}, [queryClient]);

	const uploadMutation = useMutation({
		mutationFn: (file: File) => directCreatorUpload(appId, file),
		onSuccess: (data) => {
			setPreviewUrl(data.url);
			invalidateApp();
			toast.success("Image uploaded");
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "Upload failed");
		},
	});

	const deleteMutation = useMutation({
		mutationFn: () =>
			osApi.images.delete({ entityType: "app", entityId: appId }),
		onSuccess: () => {
			setPreviewUrl(null);
			invalidateApp();
			toast.success("Image removed");
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "Delete failed");
		},
	});

	const handleFile = useCallback(
		(file: File) => {
			if (!ACCEPTED_TYPES.includes(file.type)) {
				toast.error("Please upload a PNG, JPEG, WebP, SVG, or GIF image");
				return;
			}
			if (file.size > MAX_SIZE) {
				toast.error("Image must be under 5MB");
				return;
			}
			uploadMutation.mutate(file);
		},
		[uploadMutation],
	);

	const isPending = uploadMutation.isPending || deleteMutation.isPending;

	return (
		<div className="flex items-center gap-4">
			<Avatar className={`size-24 ${isPending ? "opacity-60" : ""}`}>
				{displayUrl ? (
					<AvatarImage src={displayUrl} alt={fallbackText || "App logo"} />
				) : null}
				<AvatarFallback className="bg-kumo-fill text-kumo-subtle">
					{isPending ? (
						<Loader aria-label="Uploading" size={22} />
					) : initials ? (
						initials
					) : (
						<ImageSquare size={22} />
					)}
				</AvatarFallback>
			</Avatar>

			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={disabled || isPending}
						onClick={() => fileInputRef.current?.click()}
						icon={
							uploadMutation.isPending ? (
								<Loader aria-label="Uploading" size={14} />
							) : (
								<UploadSimple size={14} />
							)
						}
					>
						Upload
					</Button>
					{displayUrl && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={disabled || isPending}
							onClick={() => deleteMutation.mutate()}
							icon={<Trash size={14} />}
						>
							Remove
						</Button>
					)}
				</div>
				<Text as="p" role="label" tone="secondary" className="m-0">
					PNG, JPEG, WebP, SVG, or GIF. Max 5MB.
				</Text>
			</div>

			<input
				ref={fileInputRef}
				type="file"
				aria-label={`Upload ${fallbackText || "app"} image`}
				accept={ACCEPTED_TYPES.join(",")}
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) handleFile(file);
					// Reset so the same file can be re-selected.
					event.target.value = "";
				}}
			/>
		</div>
	);
}
