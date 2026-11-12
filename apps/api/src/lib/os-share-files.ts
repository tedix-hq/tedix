/**
 * The uploaded file a shared document carries, served through the link and
 * never through the owner's workspace. Every read re-resolves the share
 * session, rechecks the link (revocation, expiry, recipient) and the Output
 * revision the link opens, and streams only the file that revision names.
 * Every refusal is the same 404 as an unknown link.
 */

import type { OsSharedFile } from "@tedix/api-contract/contracts/os-shares";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { base64UrlEncode } from "@tedix/auth/utils";
import {
	getLiveOsShareSession,
	getOsShareLinkById,
	touchOsShareSession,
} from "@tedix/db/queries/os-shares";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsShareLinkRow } from "@tedix/db/schema/os-shares";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import {
	type AuthorizeOsShareRecipient,
	type IdentifyOsShareRecipient,
	hashOsShareToken,
	isActive,
	readOsSharedResource,
	recipientMayOpen,
	shareableOutputRevision,
	TOKEN_SHAPE,
} from "./os-share-redemption";
import {
	readWorkspaceFileManifest,
	streamWorkspaceFile,
	workspaceFileKey,
} from "./workspace-files";

type ShareFileEnv = Pick<
	CloudflareEnv,
	"SKILL_ARTIFACTS" | "SECRETS_MASTER_KEY"
>;

const OUTPUT_ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;
const SESSION_ID_SHAPE = /^[0-9a-f-]{36}$/;

function notFound(): Response {
	return new Response("Share link not found", {
		status: 404,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "private, no-store",
		},
	});
}

type ResolvedShareFile = {
	organizationId: string;
	workspaceId: string;
	resourceId: string;
	filename: string;
	mimeType: string;
	size: number;
};

/**
 * The file `outputId` carries, when this link shows that Output: the linked
 * Output itself (at its pinned or current revision), or a file a living
 * workspace link lists. The file must be an active upload in the Output's
 * own workspace.
 */
async function resolveShareFile(
	env: ShareFileEnv,
	db: DbQueryClient,
	link: OsShareLinkRow,
	outputId: string,
): Promise<ResolvedShareFile | null> {
	let workspaceId: string | null;
	let rawContent: unknown;
	if (link.resourceType === "output") {
		if (link.resourceId !== outputId) return null;
		const resource = await readOsSharedResource(db, link);
		if (resource?.type !== "output" || !("content" in resource.revision))
			return null;
		workspaceId = resource.output.workspaceId;
		rawContent = resource.revision.content;
	} else if (
		link.resourceType === "workspace" &&
		link.revisionMode !== "pinned"
	) {
		const workspace = await getOsWorkspace(db, {
			organizationId: link.organizationId,
			workspaceId: link.resourceId,
		});
		if (!workspace || workspace.status !== "active") return null;
		const shared = await shareableOutputRevision(
			db,
			{ organizationId: link.organizationId, workspaceId: workspace.id },
			outputId,
		);
		if (!shared) return null;
		workspaceId = workspace.id;
		try {
			rawContent = JSON.parse(shared.revision.content);
		} catch {
			return null;
		}
	} else return null;
	const content = OsOutputContentSchema.safeParse(rawContent);
	if (
		!workspaceId ||
		!content.success ||
		content.data.kind !== "document" ||
		!content.data.file ||
		content.data.file.workspaceId !== workspaceId
	)
		return null;
	const { resourceId } = content.data.file;
	const resource = await getOsWorkspaceResource(db, {
		organizationId: link.organizationId,
		workspaceId,
		resourceId,
	});
	if (
		!resource ||
		resource.status !== "active" ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "file"
	)
		return null;
	const manifest = await readWorkspaceFileManifest(
		env,
		link.organizationId,
		workspaceId,
		resourceId,
	);
	if (!manifest) return null;
	return {
		organizationId: link.organizationId,
		workspaceId,
		resourceId,
		filename: manifest.filename,
		mimeType: manifest.mimeValidated
			? manifest.mimeType
			: "application/octet-stream",
		size: manifest.size,
	};
}

/**
 * Binds a media URL to one session, one Output and the exact file it names,
 * so the URL stops working when the session ends or the document's file is
 * replaced. It grants nothing alone: every read rechecks the link.
 */
async function shareFileSignature(
	secret: string,
	sessionId: string,
	outputId: string,
	resourceId: string,
): Promise<string> {
	const key = await deriveHkdfHmacKey(secret, "tedix-os-share-file:v1");
	return base64UrlEncode(
		await hmacSha256(key, JSON.stringify([sessionId, outputId, resourceId])),
	);
}

function sameSignature(given: string, expected: string): boolean {
	if (given.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < given.length; i++)
		diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

async function openLink(
	db: DbQueryClient,
	shareLinkId: string,
	now: string,
	authorizeRecipient?: AuthorizeOsShareRecipient,
	identifyRecipient?: IdentifyOsShareRecipient,
	verifiedEmail?: string | null,
): Promise<OsShareLinkRow | null> {
	const link = await getOsShareLinkById(db, shareLinkId);
	if (!link || !isActive(link, now)) return null;
	return (await recipientMayOpen(
		db,
		link,
		authorizeRecipient,
		identifyRecipient,
		verifiedEmail,
	))
		? link
		: null;
}

/** `POST /os-shared/file`: the file's name, type, size and media URL. */
export async function handleOsShareFile(
	env: ShareFileEnv,
	db: DbQueryClient,
	sessionToken: string,
	outputId: string,
	authorizeRecipient?: AuthorizeOsShareRecipient,
	identifyRecipient?: IdentifyOsShareRecipient,
): Promise<Response> {
	if (!TOKEN_SHAPE.test(sessionToken) || !OUTPUT_ID_SHAPE.test(outputId))
		return notFound();
	const now = new Date().toISOString();
	const session = await touchOsShareSession(
		db,
		await hashOsShareToken(sessionToken),
		now,
	);
	if (!session) return notFound();
	const link = await openLink(
		db,
		session.shareLinkId,
		now,
		authorizeRecipient,
		identifyRecipient,
		session.verifiedEmail,
	);
	if (!link) return notFound();
	const file = await resolveShareFile(env, db, link, outputId);
	if (!file) return notFound();
	const sig = await shareFileSignature(
		env.SECRETS_MASTER_KEY,
		session.id,
		outputId,
		file.resourceId,
	);
	const body: OsSharedFile = {
		filename: file.filename,
		mimeType: file.mimeType,
		size: file.size,
		url: `/api/os-shared/file/${session.id}/${encodeURIComponent(outputId)}?sig=${sig}`,
	};
	return Response.json(body, {
		headers: {
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/** `GET /os-shared/file/:sessionId/:outputId`: the file's bytes, Range-aware. */
export async function serveOsShareFile(
	request: Request,
	env: ShareFileEnv,
	db: DbQueryClient,
	params: { sessionId: string; outputId: string },
	authorizeRecipient?: AuthorizeOsShareRecipient,
	identifyRecipient?: IdentifyOsShareRecipient,
): Promise<Response> {
	const { sessionId, outputId } = params;
	const sig = new URL(request.url).searchParams.get("sig") ?? "";
	if (
		!SESSION_ID_SHAPE.test(sessionId) ||
		!OUTPUT_ID_SHAPE.test(outputId) ||
		!sig
	)
		return notFound();
	const now = new Date().toISOString();
	const session = await getLiveOsShareSession(db, sessionId, now);
	if (!session) return notFound();
	const link = await openLink(
		db,
		session.shareLinkId,
		now,
		authorizeRecipient,
		identifyRecipient,
		session.verifiedEmail,
	);
	if (!link) return notFound();
	const file = await resolveShareFile(env, db, link, outputId);
	if (
		!file ||
		!sameSignature(
			sig,
			await shareFileSignature(
				env.SECRETS_MASTER_KEY,
				session.id,
				outputId,
				file.resourceId,
			),
		)
	)
		return notFound();
	const response = await streamWorkspaceFile(request, env, {
		key: workspaceFileKey(
			file.organizationId,
			file.workspaceId,
			file.resourceId,
		),
		size: file.size,
		mimeType: file.mimeType,
		filename: file.filename,
	});
	response.headers.set("Referrer-Policy", "no-referrer");
	response.headers.set("X-Robots-Tag", "noindex");
	return response;
}
