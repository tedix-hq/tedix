import { Trash, UploadSimple } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	OS_WORKSPACE_ICON_CONTENT_TYPES,
	OS_WORKSPACE_ICON_MAX_BYTES,
	type OsWorkspace,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useRef, useState } from "react";
import { EntityAvatar } from "@/components/entity-avatar";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";

type IconContentType = (typeof OS_WORKSPACE_ICON_CONTENT_TYPES)[number];

function isIconType(type: string): type is IconContentType {
	return (OS_WORKSPACE_ICON_CONTENT_TYPES as readonly string[]).includes(type);
}

async function toBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function failureText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The workspace's icon in the Edit workspace dialog. Upload and Remove save
 * straight away, like an organization logo, so they never wait on the form.
 */
export function WorkspaceIconField({ workspace }: { workspace: OsWorkspace }) {
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [failure, setFailure] = useState<string | null>(null);

	// Every list and switcher reads the workspace from these queries, so the
	// dialog and every icon refresh together.
	const saved = async () => {
		setFailure(null);
		await queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() });
	};
	const upload = useMutation({
		mutationFn: async (file: File & { type: IconContentType }) =>
			osApi.osWorkspaces.workspaces.setIcon({
				workspaceId: workspace.id,
				contentType: file.type,
				fileData: await toBase64(file),
			}),
		onSuccess: saved,
		onError: (error) =>
			setFailure(failureText(error, "The icon could not be uploaded.")),
	});
	const remove = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.workspaces.removeIcon({ workspaceId: workspace.id }),
		onSuccess: saved,
		onError: (error) =>
			setFailure(failureText(error, "The icon could not be removed.")),
	});
	const pending = upload.isPending || remove.isPending;

	const choose = (file: File) => {
		if (!isIconType(file.type)) {
			setFailure("Choose a PNG, JPEG, WebP or SVG image.");
			return;
		}
		if (file.size > OS_WORKSPACE_ICON_MAX_BYTES) {
			setFailure("The image must be 1 MB or smaller.");
			return;
		}
		upload.mutate(file as File & { type: IconContentType });
	};

	return (
		<div className="grid gap-2" data-testid="workspace-icon-field">
			<Text as="span" role="label" weight="medium">
				Workspace icon
			</Text>
			<div className="flex flex-wrap items-center gap-3">
				<EntityAvatar
					id={workspace.id}
					name={workspace.name}
					kind="workspace"
					image={workspace.iconUrl}
					imageFit="contain"
					alt={workspace.iconUrl ? `${workspace.name} icon` : undefined}
					className={pending ? "size-12 opacity-60" : "size-12"}
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					loading={upload.isPending}
					disabled={pending}
					onClick={() => fileInputRef.current?.click()}
				>
					<UploadSimple size={14} /> Upload
				</Button>
				{workspace.iconUrl ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						loading={remove.isPending}
						disabled={pending}
						onClick={() => remove.mutate()}
					>
						<Trash size={14} /> Remove
					</Button>
				) : null}
				<input
					ref={fileInputRef}
					type="file"
					aria-label="Upload workspace icon"
					accept={OS_WORKSPACE_ICON_CONTENT_TYPES.join(",")}
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) choose(file);
						event.target.value = "";
					}}
				/>
			</div>
			<Text role="caption" tone="secondary">
				Shown instead of the initials. PNG, JPEG, WebP or SVG, up to 1 MB.
			</Text>
			{failure ? (
				<Text aria-atomic="true" aria-live="assertive" tone="error">
					{failure}
				</Text>
			) : null}
		</div>
	);
}
