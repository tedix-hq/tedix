/**
 * A share-link guest using a runtime app without a Tedix account. The guest
 * holds only the share session token minted by `/os-shared/redeem`; every
 * call here resolves that token again, so revocation, expiry and policy
 * narrowing apply at once. The guest's app session is signed like a member's
 * but carries the `share_session` principal, the `use` role and the link id,
 * which the app host checks and cuts on revoke. Every refusal is the same
 * plain 404 as an unknown link: a guest learns nothing about what exists.
 */
import {
	AppRuntimeArgumentsSchema,
	AppRuntimeGuestNameSchema,
	AppRuntimeMethodSchema,
} from "@tedix/api-contract/schemas/os-app-runtime";
import { OsGadgetManifestSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	appRuntimePermission,
	isAppRuntimeManifest,
} from "@tedix/api-contract/utils/app-runtime";
import {
	mintWorkspaceAppSession,
	verifyWorkspaceAppSession,
	type WorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import {
	getLiveOsShareSession,
	getOsShareLinkById,
	touchOsShareSession,
} from "@tedix/db/queries/os-shares";
import {
	getOsGadget,
	getOsGadgetRevision,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import type {
	OsShareLinkRow,
	OsShareSessionRow,
} from "@tedix/db/schema/os-shares";
import type { OsShareGuestRefusal } from "@tedix/api-contract/contracts/os-shares";
import { z } from "zod";
import {
	loadAppRuntimeRevision,
	runAppRuntimeCall,
} from "../services/os-app-runtime-code";
import {
	effectiveRole,
	guestAppRefusal,
	guestAppRevisionId,
	hashOsShareToken,
	isActive,
	linkAdmitsGuest,
	shareableOutputRevision,
	TOKEN_SHAPE,
	workspaceLinkAdmitsGuest,
	workspaceLinkAppRevisionId,
} from "./os-share-redemption";

export const SHARE_SESSION_PRINCIPAL_KIND = "share_session";
const GUEST_ROLE = "use" as const;

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

export interface GuestAppScope {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	revisionId: string;
	shareLinkId: string;
	shareSessionId: string;
	app: { id: string; name: string; description: string | null };
}

/**
 * Resolve a guest's share session to the app it may use, or null. The link
 * must still be live and admit guests, the workspace must not have turned
 * private since the link was minted, and the app must still run its own code.
 * An app link names its app; a workspace link opens the app `appId` names,
 * which must be one of the workspace's own.
 */
export async function resolveGuestAppScope(
	db: DbQueryClient,
	sessionToken: unknown,
	appId?: unknown,
	now = new Date().toISOString(),
): Promise<GuestAppScope | null> {
	if (typeof sessionToken !== "string" || !TOKEN_SHAPE.test(sessionToken))
		return null;
	if (appId !== undefined && (typeof appId !== "string" || appId.length > 100))
		return null;
	const session = await touchOsShareSession(
		db,
		await hashOsShareToken(sessionToken),
		now,
	);
	return session ? resolveGuestAppLinkScope(db, session, now, appId) : null;
}

/** Reauthorize a verified app session at the server's resource callback. */
export async function resolveGuestAppCapabilityScope(
	db: DbQueryClient,
	appSession: WorkspaceAppSession,
	now = new Date().toISOString(),
): Promise<GuestAppScope | null> {
	if (
		appSession.principal.kind !== SHARE_SESSION_PRINCIPAL_KIND ||
		appSession.role !== GUEST_ROLE ||
		!appSession.shareLinkId ||
		appSession.actorUserId !== undefined ||
		appSession.previewId !== undefined
	)
		return null;
	const session = await getLiveOsShareSession(db, appSession.principal.id, now);
	if (!session) return null;
	const scope = await resolveGuestAppLinkScope(
		db,
		session,
		now,
		appSession.gadgetId,
	);
	if (
		!scope ||
		scope.shareLinkId !== appSession.shareLinkId ||
		scope.organizationId !== appSession.organizationId ||
		scope.workspaceId !== appSession.workspaceId ||
		scope.gadgetId !== appSession.gadgetId ||
		scope.revisionId !== appSession.revisionId
	)
		return null;
	return scope;
}

/**
 * The app and revision a guest link opens: the link's own app, or for a
 * workspace link one of the workspace's active apps that runs its own code.
 */
async function guestLinkApp(
	db: DbQueryClient,
	link: OsShareLinkRow,
	appId: string | undefined,
) {
	if (link.resourceType === "gadget") {
		if (appId !== undefined && appId !== link.resourceId) return null;
		if (!(await linkAdmitsGuest(db, link))) return null;
		const gadget = await getOsGadget(db, {
			organizationId: link.organizationId,
			gadgetId: link.resourceId,
		});
		const revisionId = gadget ? guestAppRevisionId(link, gadget) : null;
		return gadget && revisionId ? { gadget, revisionId } : null;
	}
	if (
		!appId ||
		!workspaceLinkAdmitsGuest(link) ||
		effectiveRole(link) !== GUEST_ROLE
	)
		return null;
	const gadget = await getOsGadget(db, {
		organizationId: link.organizationId,
		gadgetId: appId,
	});
	if (
		!gadget ||
		gadget.status !== "active" ||
		gadget.workspaceId !== link.resourceId
	)
		return null;
	const revisionId = workspaceLinkAppRevisionId(link, gadget);
	const revision = revisionId
		? await getOsGadgetRevision(db, {
				organizationId: link.organizationId,
				revisionId,
			})
		: null;
	if (!revision || revision.gadgetId !== gadget.id) return null;
	try {
		if (
			!isAppRuntimeManifest(
				OsGadgetManifestSchema.parse(JSON.parse(revision.manifest)),
			)
		)
			return null;
	} catch {
		return null;
	}
	return { gadget, revisionId: revision.id };
}

async function resolveGuestAppLinkScope(
	db: DbQueryClient,
	session: OsShareSessionRow,
	now: string,
	appId?: string,
): Promise<GuestAppScope | null> {
	const link = await getOsShareLinkById(db, session.shareLinkId);
	if (!link || !isActive(link, now)) return null;
	const opened = await guestLinkApp(db, link, appId);
	if (!opened) return null;
	const { gadget, revisionId } = opened;
	const workspace = await getOsWorkspace(db, {
		organizationId: link.organizationId,
		workspaceId: gadget.workspaceId,
	});
	if (
		!workspace ||
		workspace.status !== "active" ||
		workspace.visibility === "private"
	)
		return null;
	return {
		organizationId: link.organizationId,
		workspaceId: workspace.id,
		gadgetId: gadget.id,
		revisionId,
		shareLinkId: link.id,
		shareSessionId: session.id,
		app: { id: gadget.id, name: gadget.name, description: gadget.description },
	};
}

type GuestEnv = Pick<
	CloudflareEnv,
	"TEDI_SERVICE" | "ENVIRONMENT" | "SECRETS_MASTER_KEY"
>;

function field(body: unknown, name: string): unknown {
	return typeof body === "object" && body !== null && name in body
		? (body as Record<string, unknown>)[name]
		: undefined;
}

/**
 * Open the app for a guest: the client document's source, the settings and
 * grants the client reads from `context`, and a signed app session for
 * server calls. The server module never leaves the API.
 */
export async function handleGuestAppOpen(
	env: GuestEnv,
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const scope = await resolveGuestAppScope(
		db,
		field(body, "sessionToken"),
		field(body, "appId"),
	);
	if (!scope) return notFound();
	const guestName = AppRuntimeGuestNameSchema.safeParse(
		field(body, "guestName"),
	);
	if (!guestName.success) return notFound();
	let code;
	try {
		code = await loadAppRuntimeRevision(db, scope, scope.revisionId);
	} catch {
		return notFound();
	}
	if (await guestAppRefusal(db, scope, code.grants)) return notFound();
	const session = await mintWorkspaceAppSession(env.SECRETS_MASTER_KEY, {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		gadgetId: scope.gadgetId,
		revisionId: scope.revisionId,
		revision: code.revision,
		principal: { kind: SHARE_SESSION_PRINCIPAL_KIND, id: scope.shareSessionId },
		role: GUEST_ROLE,
		grants: code.grants,
		codeDigest: code.digest,
		config: code.config,
		compatibilityDate: code.compatibilityDate,
		shareLinkId: scope.shareLinkId,
		guestName: guestName.data,
	});
	return noStoreJson({
		session: session.token,
		expiresAt: session.expiresAt,
		role: GUEST_ROLE,
		revisionId: scope.revisionId,
		app: {
			...scope.app,
			workspaceId: scope.workspaceId,
			revision: code.revision,
			client: code.files["client.js"] ?? "",
			settings: code.config.settings ?? {},
			grants: code.grants,
		},
	});
}

/** Call a server method as the guest; the receipt names the share session. */
export async function handleGuestAppCall(
	env: GuestEnv,
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const scope = await resolveGuestAppScope(
		db,
		field(body, "sessionToken"),
		field(body, "appId"),
	);
	if (!scope) return notFound();
	const input = z
		.object({
			session: z.string().min(1).max(16000),
			method: AppRuntimeMethodSchema,
			args: AppRuntimeArgumentsSchema.default([]),
		})
		.safeParse({
			session: field(body, "session"),
			method: field(body, "method"),
			args: field(body, "args") ?? [],
		});
	if (!input.success) return notFound();
	let session;
	try {
		session = await verifyWorkspaceAppSession(
			env.SECRETS_MASTER_KEY,
			input.data.session,
		);
	} catch {
		return notFound();
	}
	if (
		session.organizationId !== scope.organizationId ||
		session.workspaceId !== scope.workspaceId ||
		session.gadgetId !== scope.gadgetId ||
		session.revisionId !== scope.revisionId ||
		session.principal.kind !== SHARE_SESSION_PRINCIPAL_KIND ||
		session.principal.id !== scope.shareSessionId ||
		session.shareLinkId !== scope.shareLinkId ||
		session.role !== GUEST_ROLE ||
		session.previewId !== undefined ||
		session.actorUserId !== undefined ||
		!session.guestName
	)
		return notFound();
	try {
		const code = await loadAppRuntimeRevision(db, scope, scope.revisionId);
		if (
			code.digest !== session.codeDigest ||
			(await guestAppRefusal(db, scope, code.grants))
		)
			return notFound();
		const result = await runAppRuntimeCall(env, db, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			gadgetId: scope.gadgetId,
			revisionId: scope.revisionId,
			code,
			role: GUEST_ROLE,
			session: input.data.session,
			method: input.data.method,
			args: input.data.args,
			createdBy: {
				kind: "service",
				id: `${SHARE_SESSION_PRINCIPAL_KIND}:${scope.shareSessionId}`,
			},
			policy: {
				shareLinkId: scope.shareLinkId,
				shareSessionId: scope.shareSessionId,
				guestName: session.guestName,
				guestIdentity: "self_reported",
			},
		});
		return noStoreJson({ result });
	} catch {
		return notFound();
	}
}

/**
 * For the share dialog: why people without an account cannot open this app's
 * current revision through a link, null when they can, undefined when it has
 * no revision. An app that does not run its own code renders through Tedix
 * skills and the builder's connected accounts, so it always needs sign-in.
 */
export async function guestAppRefusalForApp(
	db: DbQueryClient,
	app: {
		id: string;
		organizationId: string;
		workspaceId: string;
		currentRevisionId: string | null;
	},
): Promise<OsShareGuestRefusal | null | undefined> {
	if (!app.currentRevisionId) return undefined;
	const revision = await getOsGadgetRevision(db, {
		organizationId: app.organizationId,
		revisionId: app.currentRevisionId,
	});
	if (!revision || revision.gadgetId !== app.id) return undefined;
	let manifest;
	try {
		manifest = OsGadgetManifestSchema.parse(JSON.parse(revision.manifest));
	} catch {
		return { reason: "not_runtime_app" };
	}
	if (!isAppRuntimeManifest(manifest)) return { reason: "not_runtime_app" };
	return guestAppRefusal(db, app, manifest.resourceGrants ?? []);
}

/**
 * Read a granted Output for the guest's client. Only slots the manifest
 * grants `outputs.read` on, and only Outputs whose access envelope names no
 * sources: a guest has no connected accounts to re-check source access with.
 */
export async function readGuestAppSlot(
	db: DbQueryClient,
	scope: Pick<GuestAppScope, "organizationId" | "workspaceId">,
	grants: ReadonlyArray<{ slot: string; operations: readonly string[] }>,
	slot: string,
) {
	if (
		!appRuntimePermission({
			role: GUEST_ROLE,
			grants,
			operation: "outputs.read",
			slot,
		}).allowed
	)
		return null;
	const resources = await listOsWorkspaceResources(db, {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		status: "active",
		limit: 200,
	});
	const resource = resources.find((row) => row.slot === slot);
	if (
		!resource ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "output"
	)
		return null;
	const shared = await shareableOutputRevision(
		db,
		scope,
		resource.providerResourceId,
	);
	if (!shared) return null;
	const { output, revision } = shared;
	return {
		output: { id: output.id, title: output.title, kind: output.kind },
		revision: {
			id: revision.id,
			revision: revision.revision,
			content: JSON.parse(revision.content) as unknown,
		},
	};
}

export async function handleGuestAppRead(
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const scope = await resolveGuestAppScope(
		db,
		field(body, "sessionToken"),
		field(body, "appId"),
	);
	if (!scope) return notFound();
	const slot = field(body, "slot");
	if (typeof slot !== "string" || slot.length === 0 || slot.length > 160)
		return notFound();
	let code;
	try {
		code = await loadAppRuntimeRevision(db, scope, scope.revisionId);
	} catch {
		return notFound();
	}
	const read = await readGuestAppSlot(db, scope, code.grants, slot);
	return read ? noStoreJson(read) : notFound();
}
