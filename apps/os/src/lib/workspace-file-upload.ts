import { WORKSPACE_FILE_MAX_BYTES } from "@tedix/api-contract/schemas/workspace-files";
import { osApi } from "./api";

export async function uploadWorkspaceFile(
	workspaceId: string,
	file: File,
	onProgress?: (percent: number) => void,
	options?: { document?: boolean },
) {
	if (file.size < 1 || file.size > WORKSPACE_FILE_MAX_BYTES)
		throw new Error("Choose a file between 1 byte and 200 MiB.");
	const mimeType = file.type || "application/octet-stream";
	const upload = await osApi.osWorkspaces.resources.requestFileUpload({
		workspaceId,
		filename: file.name,
		mimeType,
		size: file.size,
	});
	const parts: { partNumber: number; etag: string }[] = [];
	for (const part of upload.parts) {
		const offset = (part.partNumber - 1) * upload.partSize;
		const response = await fetch(part.url, {
			method: "PUT",
			body: file.slice(offset, offset + part.size),
			credentials: "omit",
			headers: { "Content-Type": "application/octet-stream" },
		});
		if (!response.ok)
			throw new Error(
				`Upload failed (${response.status}). Choose the file again to retry.`,
			);
		parts.push((await response.json()) as { partNumber: number; etag: string });
		onProgress?.(Math.round(((offset + part.size) / file.size) * 100));
	}
	const confirm = () =>
		osApi.osWorkspaces.resources.confirmFileUpload({
			workspaceId,
			resourceId: upload.resourceId,
			parts,
			...(options?.document === undefined
				? {}
				: { document: options.document }),
		});
	// Confirming the same upload again returns the file already saved, so a
	// busy server is retried here instead of the person uploading a copy.
	for (const delayMs of [1_000, 3_000]) {
		try {
			return await confirm();
		} catch (error) {
			const failure = error as { status?: unknown; code?: unknown } | null;
			if (failure?.status !== 503 && failure?.code !== "SERVICE_UNAVAILABLE")
				throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return confirm();
}
