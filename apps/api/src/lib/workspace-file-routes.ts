import { createRouterClient, ORPCError } from "@orpc/server";
import { createContext } from "../rpc/orpc";
import { getFile } from "../rpc/routers/os-workspace-files";
import {
	readWorkspaceFileManifest,
	verifyWorkspaceFileSignature,
	workspaceFileKey,
	workspaceFilePartSize,
	streamWorkspaceFile,
} from "./workspace-files";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { createDbQueryClient } from "@tedix/db/query-client";

/** Binary upload is bounded per part and never enters the RPC/base64 path. */
export async function uploadWorkspaceFilePart(
	request: Request,
	env: CloudflareEnv,
	params: {
		organizationId: string;
		workspaceId: string;
		resourceId: string;
		partNumber: string;
	},
) {
	const { organizationId: org, workspaceId, resourceId } = params;
	const part = Number(params.partNumber);
	if (
		!(await verifyWorkspaceFileSignature(
			env.SECRETS_MASTER_KEY,
			`upload:${part}`,
			org,
			workspaceId,
			resourceId,
			new URL(request.url),
		))
	)
		return new Response(
			"This upload URL is invalid or has expired. Request a new upload URL.",
			{ status: 403 },
		);
	const manifest = await readWorkspaceFileManifest(
		env,
		org,
		workspaceId,
		resourceId,
	);
	if (!manifest || Date.parse(manifest.expiresAt) <= Date.now())
		return new Response(
			"This upload has expired or is no longer available. Request a new upload URL.",
			{ status: 410 },
		);
	const workspace = await getOsWorkspace(createDbQueryClient(env.DB), {
		organizationId: org,
		workspaceId,
	});
	if (!workspace || workspace.status !== "active")
		return new Response(
			"The workspace for this upload is unavailable. Check workspace access and request a new upload URL.",
			{ status: 404 },
		);
	const size = workspaceFilePartSize(manifest.size, part);
	if (size === null || !request.body)
		return new Response(
			size === null
				? "This file part is invalid. Retry the correct part from the upload instructions."
				: `This file part has no data. Retry this part with exactly ${size} bytes.`,
			{ status: 400 },
		);
	const declared = request.headers.get("Content-Length");
	if (declared !== null && Number(declared) !== size)
		return new Response(
			`This file part must contain exactly ${size} bytes. Retry this part with the correct data.`,
			{ status: 400 },
		);
	const reader = request.body.getReader();
	const bytes = new Uint8Array(size);
	let offset = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (offset + value.length > size) {
			await reader.cancel();
			return new Response(
				`This file part exceeds the expected ${size} bytes. Retry this part with the correct data.`,
				{ status: 413 },
			);
		}
		bytes.set(value, offset);
		offset += value.length;
	}
	if (offset !== size)
		return new Response(
			`This file part is incomplete; expected ${size} bytes. Retry this part with all its data.`,
			{ status: 400 },
		);
	const upload = env.SKILL_ARTIFACTS.resumeMultipartUpload(
		workspaceFileKey(org, workspaceId, resourceId),
		manifest.uploadId,
	);
	const receipt = await upload.uploadPart(part, bytes);
	return Response.json(receipt, {
		headers: { "Cache-Control": "private, no-store" },
	});
}

export async function serveWorkspaceFile(
	request: Request,
	env: CloudflareEnv,
	params: { organizationId: string; workspaceId: string; resourceId: string },
) {
	try {
		const { organizationId: org, workspaceId, resourceId } = params;
		const url = new URL(request.url);
		if (
			!(await verifyWorkspaceFileSignature(
				env.SECRETS_MASTER_KEY,
				"read",
				org,
				workspaceId,
				resourceId,
				url,
			))
		)
			return new Response("Invalid or expired file URL", { status: 403 });
		// The ordinary API auth middleware rechecks membership, tenant host and private-workspace visibility on EVERY range/read.
		const file = await createRouterClient(getFile, {
			context: createContext(request, env),
		})({ workspaceId, resourceId });
		if (new URL(file.url, request.url).pathname !== `/api${url.pathname}`)
			return new Response("Not found", { status: 404 });
		return streamWorkspaceFile(request, env, {
			key: workspaceFileKey(org, workspaceId, resourceId),
			...file,
		});
	} catch (error) {
		if (error instanceof ORPCError)
			return new Response("File unavailable", {
				status: error.code === "UNAUTHORIZED" ? 401 : 404,
			});
		throw error;
	}
}
