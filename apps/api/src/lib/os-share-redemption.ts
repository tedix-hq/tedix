/** Public redemption and session reads for governed Tedix OS share links. */

import type { OsShareRole } from "@tedix/api-contract/contracts/os-shares";
import {
	type OsDerivedAccessEnvelope,
	OsDerivedAccessEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	createOsShareSession,
	getOsShareLinkById,
	getOsShareLinkByTokenHash,
	touchOsShareSession,
} from "@tedix/db/queries/os-shares";
import {
	getOsGadget,
	getOsGadgetRevision,
	listOsGadgets,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsOutput,
	getOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsShareLinkRow } from "@tedix/db/schema/os-shares";

/** Mint a 256-bit base64url secret. The plaintext is never persisted. */
export function generateOsShareToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** sha-256 hex of a plaintext link or session secret. */
export async function hashOsShareToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ROLE_RANK: Record<OsShareRole, number> = { viewer: 0, use: 1, build: 2 };

function notFound(): Response {
	return new Response("Share link not found", {
		status: 404,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

function noStoreJson(body: unknown): Response {
	return Response.json(body, {
		headers: {
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function isActive(link: OsShareLinkRow, now: string): boolean {
	return (
		link.revokedAt === null && (link.expiresAt === null || link.expiresAt > now)
	);
}

function effectiveRole(link: OsShareLinkRow): OsShareRole {
	if (!link.policyMaxRole) return link.role;
	return ROLE_RANK[link.policyMaxRole] < ROLE_RANK[link.role]
		? link.policyMaxRole
		: link.role;
}

export type AuthorizeOsShareRecipient = (
	link: OsShareLinkRow,
	effectiveRole: OsShareRole,
	accessEnvelope?: OsDerivedAccessEnvelope,
) => Promise<boolean>;

async function recipientMayOpen(
	db: DbQueryClient,
	link: OsShareLinkRow,
	authorizeRecipient?: AuthorizeOsShareRecipient,
): Promise<boolean> {
	if (link.resourceType === "output") {
		const output = await getOsOutput(db, {
			organizationId: link.organizationId,
			outputId: link.resourceId,
		});
		const revisionId =
			link.revisionMode === "pinned"
				? link.pinnedRevisionId
				: output?.currentRevisionId;
		const revision = revisionId
			? await getOsOutputRevision(db, {
					organizationId: link.organizationId,
					revisionId,
				})
			: null;
		if (!revision?.accessEnvelope) return false;
		let rawEnvelope: unknown;
		try {
			rawEnvelope = JSON.parse(revision.accessEnvelope);
		} catch {
			return false;
		}
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(rawEnvelope);
		if (!parsed.success) return false;
		if (parsed.data.sources.length === 0) return true;
		return Boolean(
			authorizeRecipient &&
			(await authorizeRecipient(link, effectiveRole(link), parsed.data)),
		);
	}
	return Boolean(
		authorizeRecipient && (await authorizeRecipient(link, effectiveRole(link))),
	);
}

function shareEnvelope(link: OsShareLinkRow) {
	return {
		id: link.id,
		resourceType: link.resourceType,
		role: link.role,
		effectiveRole: effectiveRole(link),
		revisionMode: link.revisionMode,
		note: link.note,
		expiresAt: link.expiresAt,
		createdAt: link.createdAt,
		createdByKind: link.createdByKind,
		policyReason: link.policyReason,
		policyRestrictedAt: link.policyRestrictedAt,
	};
}

function exposedManifest(manifest: string, role: OsShareRole) {
	const parsed = JSON.parse(manifest) as {
		entry?: unknown;
		capabilities?: unknown;
		skillSlug?: unknown;
		notes?: unknown;
	};
	if (role === "build") return parsed;
	return { entry: typeof parsed.entry === "string" ? parsed.entry : "" };
}

async function readGadget(
	db: DbQueryClient,
	link: OsShareLinkRow,
	role: OsShareRole,
) {
	const gadget = await getOsGadget(db, {
		organizationId: link.organizationId,
		gadgetId: link.resourceId,
	});
	if (!gadget || gadget.status !== "active") return null;
	const revisionId =
		link.revisionMode === "pinned"
			? link.pinnedRevisionId
			: gadget.currentRevisionId;
	const revision = revisionId
		? await getOsGadgetRevision(db, {
				organizationId: link.organizationId,
				revisionId,
			})
		: null;
	if (!revision || revision.gadgetId !== gadget.id) return null;
	return {
		type: "gadget" as const,
		gadget: {
			id: gadget.id,
			workspaceId: gadget.workspaceId,
			name: gadget.name,
			description: gadget.description,
			createdByKind: gadget.createdByKind,
		},
		revision: {
			id: revision.id,
			revision: revision.revision,
			manifest: exposedManifest(revision.manifest, role),
			createdAt: revision.createdAt,
		},
		openPath:
			role === "build"
				? `/canvas?workspace=${encodeURIComponent(gadget.workspaceId)}`
				: null,
	};
}

function projectWorkspaceSnapshot(snapshot: string, role: OsShareRole) {
	const parsed = JSON.parse(snapshot) as {
		workspace: unknown;
		gadgets: Array<{
			id: string;
			name: string;
			description: string | null;
			revision: null | {
				id: string;
				revision: number;
				manifest: Record<string, unknown>;
			};
		}>;
	};
	return {
		workspace: parsed.workspace,
		gadgets: parsed.gadgets.map((gadget) => ({
			...gadget,
			revision: gadget.revision
				? {
						...gadget.revision,
						manifest:
							role === "build"
								? gadget.revision.manifest
								: { entry: gadget.revision.manifest.entry ?? "" },
					}
				: null,
		})),
	};
}

async function readWorkspace(
	db: DbQueryClient,
	link: OsShareLinkRow,
	role: OsShareRole,
) {
	const workspace = await getOsWorkspace(db, {
		organizationId: link.organizationId,
		workspaceId: link.resourceId,
	});
	if (!workspace || workspace.status !== "active") return null;
	if (link.revisionMode === "pinned") {
		if (!link.pinnedSnapshot) return null;
		return {
			type: "workspace" as const,
			...projectWorkspaceSnapshot(link.pinnedSnapshot, role),
			openPath:
				role === "build"
					? `/canvas?workspace=${encodeURIComponent(link.resourceId)}`
					: null,
		};
	}
	const gadgets = await listOsGadgets(db, link.organizationId, {
		workspaceId: workspace.id,
		status: "active",
		limit: 200,
	});
	const projected = await Promise.all(
		gadgets.map(async (gadget) => {
			const revision = gadget.currentRevisionId
				? await getOsGadgetRevision(db, {
						organizationId: link.organizationId,
						revisionId: gadget.currentRevisionId,
					})
				: null;
			return {
				id: gadget.id,
				name: gadget.name,
				description: gadget.description,
				revision: revision
					? {
							id: revision.id,
							revision: revision.revision,
							manifest: exposedManifest(revision.manifest, role),
						}
					: null,
			};
		}),
	);
	return {
		type: "workspace" as const,
		workspace: {
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
			sourceBlueprintId: workspace.sourceBlueprintId,
			sourceBlueprintRevisionNumber: workspace.sourceBlueprintRevisionNumber,
			createdByKind: workspace.createdByKind,
		},
		gadgets: projected,
		openPath:
			role === "build"
				? `/canvas?workspace=${encodeURIComponent(workspace.id)}`
				: null,
	};
}

async function readOutput(db: DbQueryClient, link: OsShareLinkRow) {
	const output = await getOsOutput(db, {
		organizationId: link.organizationId,
		outputId: link.resourceId,
	});
	if (!output || output.status !== "active") return null;
	const revisionId =
		link.revisionMode === "pinned"
			? link.pinnedRevisionId
			: output.currentRevisionId;
	const revision = revisionId
		? await getOsOutputRevision(db, {
				organizationId: link.organizationId,
				revisionId,
			})
		: null;
	if (!revision || revision.outputId !== output.id) return null;
	return {
		type: "output" as const,
		output: {
			id: output.id,
			workspaceId: output.workspaceId,
			title: output.title,
			kind: output.kind,
			createdByKind: output.createdByKind,
		},
		revision: {
			id: revision.id,
			revision: revision.revision,
			content: JSON.parse(revision.content),
			createdAt: revision.createdAt,
		},
		openPath: null,
	};
}

export async function readOsSharedResource(
	db: DbQueryClient,
	link: OsShareLinkRow,
) {
	const role = effectiveRole(link);
	if (link.resourceType === "output") return readOutput(db, link);
	if (link.resourceType === "gadget") return readGadget(db, link, role);
	return readWorkspace(db, link, role);
}

async function sessionResponse(
	db: DbQueryClient,
	link: OsShareLinkRow,
	sessionToken?: string,
): Promise<Response> {
	const resource = await readOsSharedResource(db, link);
	if (!resource) return notFound();
	return noStoreJson({
		share: shareEnvelope(link),
		resource,
		...(sessionToken ? { sessionToken } : {}),
	});
}

/** Exchange a reusable link secret for a short-lived, independently revocable session. */
export async function handleOsShareRedemption(
	db: DbQueryClient,
	token: string,
	authorizeRecipient?: AuthorizeOsShareRecipient,
): Promise<Response> {
	if (!TOKEN_SHAPE.test(token)) return notFound();
	const now = new Date().toISOString();
	const linkTokenHash = await hashOsShareToken(token);
	const link = await getOsShareLinkByTokenHash(db, linkTokenHash);
	if (!link || !isActive(link, now)) return notFound();
	if (!(await recipientMayOpen(db, link, authorizeRecipient)))
		return notFound();
	const sessionToken = generateOsShareToken();
	const linkExpiry = link.expiresAt
		? Date.parse(link.expiresAt)
		: Number.POSITIVE_INFINITY;
	const expiresAt = new Date(
		Math.min(Date.now() + SESSION_TTL_MS, linkExpiry),
	).toISOString();
	const session = await createOsShareSession(db, {
		id: crypto.randomUUID(),
		sessionTokenHash: await hashOsShareToken(sessionToken),
		createdAt: now,
		lastSeenAt: now,
		expiresAt,
		linkTokenHash,
		expectedEffectiveRole: effectiveRole(link),
		now,
	});
	if (!session) return notFound();
	const currentLink = await getOsShareLinkById(db, session.shareLinkId);
	if (!currentLink || !isActive(currentLink, now)) return notFound();
	if (!(await recipientMayOpen(db, currentLink, authorizeRecipient)))
		return notFound();
	return sessionResponse(db, currentLink, sessionToken);
}

/** Read a redeemed session; revocation and policy narrowing apply immediately. */
export async function handleOsShareSessionRead(
	db: DbQueryClient,
	sessionToken: string,
	authorizeRecipient?: AuthorizeOsShareRecipient,
): Promise<Response> {
	if (!TOKEN_SHAPE.test(sessionToken)) return notFound();
	const now = new Date().toISOString();
	const session = await touchOsShareSession(
		db,
		await hashOsShareToken(sessionToken),
		now,
	);
	if (!session) return notFound();
	const link = await getOsShareLinkById(db, session.shareLinkId);
	if (!link || !isActive(link, now)) return notFound();
	if (!(await recipientMayOpen(db, link, authorizeRecipient)))
		return notFound();
	return sessionResponse(db, link);
}
