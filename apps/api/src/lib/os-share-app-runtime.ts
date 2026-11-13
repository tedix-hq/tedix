/**
 * A share-link guest using a runtime app without a Tedix account. The guest
 * holds only the share session token minted by `/os-shared/redeem`; every
 * call here resolves that token again, so revocation, expiry and policy
 * narrowing apply at once. The guest's app session is signed like a member's
 * but carries the `share_session` principal, the `use` role and the link id,
 * which the app host checks and cuts on revoke. Every refusal is the same
 * plain 404 as an unknown link: a guest learns nothing about what exists.
 *
 * A link with the `edit` role lets a visitor whose email the link names save
 * changes to the app's files. The app's own server code still runs as `use`;
 * a save goes through `handleGuestAppSave`, which checks the link, the
 * visitor's verified email and the file on every call.
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
import {
	parseOutputContentWithImages,
	readOutputAsset,
} from "../services/os-output-assets";
import {
	EMPTY_OUTPUT_ACCESS_ENVELOPE,
	osOutputChangesSince,
	saveOsOutputPatch,
} from "../services/os-output-patch";
import { getOsOutputRevisionByNumber } from "../services/os-workspace-outputs";
import type { OsOutputRevisionRow } from "@tedix/db/schema/os-workspaces";
import type {
	OsShareLinkRow,
	OsShareSessionRow,
} from "@tedix/db/schema/os-shares";
import type { OsShareGuestRefusal } from "@tedix/api-contract/contracts/os-shares";
import { OsOutputContentPatchSchema } from "@tedix/api-contract/schemas/os-output-patch";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { OS_OUTPUT_CONTENT_MAX_BYTES } from "@tedix/api-contract/utils/os-output-limits";
import { outputAssetDigest } from "@tedix/api-contract/utils/os-output-assets";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { loadAppRuntimeRevision } from "../services/os-app-runtime-code";
import { runInteractiveAppCall } from "../services/os-app-triggers";
import {
	effectiveRole,
	guestAppRefusal,
	guestAppRevisionId,
	hashOsShareToken,
	isActive,
	linkAdmitsGuest,
	recipientMayOpen,
	shareableOutputRevision,
	stoppedByPrivateWorkspace,
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
	workspaceName: string;
	verifiedEmail?: string | null;
	/**
	 * True when this visitor may save changes to the app's files: the link
	 * carries the `edit` role, admits only invited people, and this session
	 * proved one of their emails.
	 */
	canEdit: boolean;
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
	if (
		!link ||
		!isActive(link, now) ||
		!(await recipientMayOpen(
			db,
			link,
			undefined,
			undefined,
			session.verifiedEmail,
		))
	)
		return null;
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
		stoppedByPrivateWorkspace(link, workspace)
	)
		return null;
	return {
		organizationId: link.organizationId,
		workspaceId: workspace.id,
		// A file-only visitor never learns what a private workspace is called.
		workspaceName: workspace.visibility === "private" ? "" : workspace.name,
		gadgetId: gadget.id,
		revisionId,
		shareLinkId: link.id,
		shareSessionId: session.id,
		verifiedEmail: session.verifiedEmail,
		// The link's own role must say edit: a build link that policy limited
		// down keeps asking for a signed-in member and never lets a visitor save.
		canEdit:
			link.resourceType === "gadget" &&
			link.role === "edit" &&
			effectiveRole(link) === "edit" &&
			link.access === "invited" &&
			Boolean(session.verifiedEmail),
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
	if (field(body, "guestName") !== undefined && !guestName.success)
		return notFound();
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
		guestName:
			scope.verifiedEmail ?? (guestName.success ? guestName.data : "Guest"),
	});
	return noStoreJson({
		session: session.token,
		verifiedEmail: scope.verifiedEmail,
		expiresAt: session.expiresAt,
		// What the page may offer. The signed session above stays `use`: the
		// app's server code never runs with more, and a save is checked again.
		role: scope.canEdit ? ("edit" as const) : GUEST_ROLE,
		revisionId: scope.revisionId,
		app: {
			...scope.app,
			workspaceId: scope.workspaceId,
			...(scope.workspaceName ? { workspaceName: scope.workspaceName } : {}),
			revision: code.revision,
			client: code.files["client.js"] ?? "",
			settings: code.config.settings ?? {},
			recordsGuestInput: code.config.recordsGuestInput ?? false,
			grants: code.grants,
		},
	});
}

/** Call a server method as the guest; the receipt names the share session. */
export async function handleGuestAppCall(
	env: GuestEnv,
	db: DbQueryClient,
	body: unknown,
	waitUntil?: (work: Promise<unknown>) => void,
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
		session.actorUserId !== undefined
	)
		return notFound();
	try {
		const code = await loadAppRuntimeRevision(db, scope, scope.revisionId);
		if (
			code.digest !== session.codeDigest ||
			(await guestAppRefusal(db, scope, code.grants))
		)
			return notFound();
		const result = await runInteractiveAppCall(
			env,
			db,
			{
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
					guestName: session.guestName ?? "Guest",
					guestIdentity: "self_reported",
				},
			},
			waitUntil,
		);
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
	shareLinkIds: readonly string[] = [],
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
	for (const shareLinkId of shareLinkIds) {
		if (
			!(await guestAppRefusal(
				db,
				{ ...app, gadgetId: app.id, revisionId: revision.id, shareLinkId },
				manifest.resourceGrants ?? [],
			))
		)
			return null;
	}
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
	const shared = await guestSlotFile(db, scope, slot);
	if (!shared) return null;
	return guestFileRead(scope, shared.output, shared.revision);
}

/**
 * The file a slot is bound to in the visitor's workspace with its current
 * revision, or null: only a Tedix file whose current revision carries no
 * data from connected accounts.
 */
async function guestSlotFile(
	db: DbQueryClient,
	scope: Pick<GuestAppScope, "organizationId" | "workspaceId">,
	slot: string,
) {
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
	return shareableOutputRevision(db, scope, resource.providerResourceId);
}

/** A revision a visitor may read: one that names no connected-account source. */
function sourceless(revision: Pick<OsOutputRevisionRow, "accessEnvelope">) {
	if (!revision.accessEnvelope) return false;
	try {
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(
			JSON.parse(revision.accessEnvelope),
		);
		return parsed.success && parsed.data.sources.length === 0;
	} catch {
		return false;
	}
}

async function guestFileRead(
	scope: Pick<GuestAppScope, "workspaceId">,
	output: { id: string; title: string; kind: string },
	revision: OsOutputRevisionRow,
) {
	return {
		// The Doc, Sheet and Slides editors refuse a file that does not name
		// the workspace they were opened in, so the read says where it lives.
		output: {
			id: output.id,
			workspaceId: scope.workspaceId,
			title: output.title,
			kind: output.kind,
		},
		revision: {
			id: revision.id,
			revision: revision.revision,
			content: await parseOutputContentWithImages(revision),
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

function refusal(status: number, body: Record<string, unknown>): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/** The slot a visitor's call names, with the app's grants, or null. */
async function guestSlotCall(db: DbQueryClient, body: unknown) {
	const scope = await resolveGuestAppScope(
		db,
		field(body, "sessionToken"),
		field(body, "appId"),
	);
	if (!scope) return null;
	const slot = field(body, "slot");
	if (typeof slot !== "string" || slot.length === 0 || slot.length > 160)
		return null;
	let code;
	try {
		code = await loadAppRuntimeRevision(db, scope, scope.revisionId);
	} catch {
		return null;
	}
	if (await guestAppRefusal(db, scope, code.grants)) return null;
	return { scope, slot, grants: code.grants };
}

/**
 * Save a visitor's change to one of the app's files. Allowed only when the
 * link lets its invited people edit and this session proved an invited
 * email; the app must grant writing on the slot, and the file must carry no
 * data from connected accounts. The save is recorded under the share
 * session, which holds the visitor's verified email.
 */
export async function handleGuestAppSave(
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const call = await guestSlotCall(db, body);
	if (!call || !call.scope.canEdit) return notFound();
	const { scope, slot, grants } = call;
	const mayWrite = (["outputs.patch", "outputs.write"] as const).some(
		(operation) =>
			appRuntimePermission({ role: "edit", grants, operation, slot }).allowed,
	);
	if (!mayWrite) return notFound();
	const baseRevision = field(body, "baseRevision");
	if (!Number.isInteger(baseRevision) || Number(baseRevision) < 1)
		return notFound();
	const rawPatch = field(body, "patch");
	if (
		new TextEncoder().encode(JSON.stringify(rawPatch) ?? "").length >
		OS_OUTPUT_CONTENT_MAX_BYTES
	)
		return refusal(400, {
			code: "BAD_REQUEST",
			message: "This change is too large to save",
		});
	const patch = OsOutputContentPatchSchema.safeParse(rawPatch);
	if (!patch.success) return notFound();
	const file = await guestSlotFile(db, scope, slot);
	if (!file) return notFound();
	if (patch.data.kind !== file.output.kind)
		return refusal(400, {
			code: "BAD_REQUEST",
			message: "This change does not fit this file",
		});
	const current = async () => {
		const shared = await guestSlotFile(db, scope, slot);
		if (!shared || shared.output.id !== file.output.id)
			throw new ORPCError("NOT_FOUND", { message: "Share link not found" });
		return shared;
	};
	try {
		return noStoreJson(
			await saveOsOutputPatch(db, {
				output: file.output,
				reloadOutput: async () => (await current()).output,
				currentRevision: async () => (await current()).revision,
				canReadRevision: async (revision) => sourceless(revision),
				baseRevision: Number(baseRevision),
				patch: patch.data,
				...(field(body, "explicit") === true
					? { note: "Saved through a share link" }
					: { autosave: true }),
				expectedWorkspaceId: scope.workspaceId,
				creator: {
					kind: "service",
					id: `${SHARE_SESSION_PRINCIPAL_KIND}:${scope.shareSessionId}`,
				},
				producer: { skillRunId: null, skillId: null },
				accessEnvelope: EMPTY_OUTPUT_ACCESS_ENVELOPE,
			}),
		);
	} catch (error) {
		if (error instanceof ORPCError && error.code === "CONFLICT")
			return refusal(409, {
				code: "CONFLICT",
				message: error.message,
				data: error.data,
			});
		if (error instanceof ORPCError && error.code === "BAD_REQUEST")
			return refusal(400, { code: "BAD_REQUEST", message: error.message });
		return notFound();
	}
}

/** What changed in a granted file since a revision the visitor holds. */
export async function handleGuestAppChanges(
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const call = await guestSlotCall(db, body);
	const sinceRevision = field(body, "sinceRevision");
	if (
		!call ||
		!Number.isInteger(sinceRevision) ||
		Number(sinceRevision) < 1 ||
		!appRuntimePermission({
			role: GUEST_ROLE,
			grants: call.grants,
			operation: "outputs.read",
			slot: call.slot,
		}).allowed
	)
		return notFound();
	const file = await guestSlotFile(db, call.scope, call.slot);
	if (!file) return notFound();
	return noStoreJson(
		await osOutputChangesSince(db, {
			output: file.output,
			current: file.revision,
			sinceRevision: Number(sinceRevision),
			canReadRevision: async (revision) => sourceless(revision),
		}),
	);
}

/**
 * A granted file at its current revision, or at a numbered one the visitor's
 * unsaved changes were made against.
 */
export async function handleGuestAppRevision(
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const call = await guestSlotCall(db, body);
	const number = field(body, "revision");
	if (
		!call ||
		(number !== undefined &&
			(!Number.isInteger(number) || Number(number) < 1)) ||
		!appRuntimePermission({
			role: GUEST_ROLE,
			grants: call.grants,
			operation: "outputs.read",
			slot: call.slot,
		}).allowed
	)
		return notFound();
	const file = await guestSlotFile(db, call.scope, call.slot);
	if (!file) return notFound();
	let revision: OsOutputRevisionRow | undefined = file.revision;
	if (number !== undefined && Number(number) !== file.revision.revision) {
		revision = await getOsOutputRevisionByNumber(db, {
			organizationId: call.scope.organizationId,
			outputId: file.output.id,
			revision: Number(number),
		});
		if (!revision || !sourceless(revision)) return notFound();
	}
	return noStoreJson(await guestFileRead(call.scope, file.output, revision));
}

/** One image stored with a granted file, as a data URL. */
export async function handleGuestAppImage(
	db: DbQueryClient,
	body: unknown,
): Promise<Response> {
	const call = await guestSlotCall(db, body);
	const url = field(body, "url");
	if (
		!call ||
		typeof url !== "string" ||
		!outputAssetDigest(url) ||
		!appRuntimePermission({
			role: GUEST_ROLE,
			grants: call.grants,
			operation: "outputs.read",
			slot: call.slot,
		}).allowed
	)
		return notFound();
	const file = await guestSlotFile(db, call.scope, call.slot);
	if (!file) return notFound();
	const dataUrl = await readOutputAsset(
		{ organizationId: call.scope.organizationId, outputId: file.output.id },
		url,
	);
	return dataUrl ? noStoreJson({ dataUrl }) : notFound();
}
