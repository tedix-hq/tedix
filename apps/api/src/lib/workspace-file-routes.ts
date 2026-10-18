import { createRouterClient, ORPCError } from "@orpc/server";
import { createContext } from "../rpc/orpc";
import { getFile } from "../rpc/routers/os-workspace-files";
import {
	readWorkspaceFileManifest,
	verifyWorkspaceFileSignature,
	workspaceFileKey,
	workspaceFilePartSize,
	workspaceFileInlineMime,
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
		return new Response("Invalid or expired upload URL", { status: 403 });
	const manifest = await readWorkspaceFileManifest(
		env,
		org,
		workspaceId,
		resourceId,
	);
	if (!manifest || Date.parse(manifest.expiresAt) <= Date.now())
		return new Response("Upload expired", { status: 410 });
	const workspace = await getOsWorkspace(createDbQueryClient(env.DB), {
		organizationId: org,
		workspaceId,
	});
	if (!workspace || workspace.status !== "active")
		return new Response("Not found", { status: 404 });
	const size = workspaceFilePartSize(manifest.size, part);
	if (size === null || !request.body)
		return new Response("Invalid part", { status: 400 });
	const declared = request.headers.get("Content-Length");
	if (declared !== null && Number(declared) !== size)
		return new Response("Wrong part size", { status: 400 });
	const reader = request.body.getReader();
	const bytes = new Uint8Array(size);
	let offset = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (offset + value.length > size) {
			await reader.cancel();
			return new Response("Part too large", { status: 413 });
		}
		bytes.set(value, offset);
		offset += value.length;
	}
	if (offset !== size) return new Response("Incomplete part", { status: 400 });
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
		const key = workspaceFileKey(org, workspaceId, resourceId);
		let range: { offset: number; length: number } | undefined;
		const rawRange = request.headers.get("Range");
		if (rawRange) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
			if (!match || (!match[1] && !match[2])) return rangeError(file.size);
			const start = match[1]
				? Number(match[1])
				: Math.max(0, file.size - Number(match[2]));
			const end = match[1]
				? match[2]
					? Math.min(Number(match[2]), file.size - 1)
					: file.size - 1
				: file.size - 1;
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end < start ||
				start >= file.size
			)
				return rangeError(file.size);
			range = { offset: start, length: end - start + 1 };
		}
		const object =
			request.method === "HEAD"
				? await env.SKILL_ARTIFACTS.head(key)
				: await env.SKILL_ARTIFACTS.get(key, range ? { range } : undefined);
		if (!object || object.size !== file.size)
			return new Response("Not found", { status: 404 });
		const inline = workspaceFileInlineMime(file.mimeType);
		const headers = new Headers({
			"Content-Type": inline ?? "application/octet-stream",
			"Content-Length": String(range?.length ?? file.size),
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox; default-src 'none'",
		});
		if (range)
			headers.set(
				"Content-Range",
				`bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`,
			);
		return new Response(
			"body" in object ? (object as R2ObjectBody).body : null,
			{ status: range ? 206 : 200, headers },
		);
	} catch (error) {
		if (error instanceof ORPCError)
			return new Response("File unavailable", {
				status: error.code === "UNAUTHORIZED" ? 401 : 404,
			});
		throw error;
	}
}
function rangeError(size: number) {
	return new Response(null, {
		status: 416,
		headers: {
			"Content-Range": `bytes */${size}`,
			"Cache-Control": "private, no-store",
		},
	});
}
