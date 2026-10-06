import { getManagementClient } from "@tedix/auth/client";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getPortableTediControlBindings } from "@tedix/db/queries/portable-tedi/snapshot";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { Tedi } from "@tedix/db/schema/tedis";
import { issuePortableSnapshotTicket } from "../../../lib/portable-snapshot-ticket";
import {
	AUTHZ,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	requireOrganizationId,
} from "./helpers";

const READ_TOKEN_TTL_SECONDS = 3_600;

function isMissingArtifactsRepo(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String(error.code).toUpperCase() === "NOT_FOUND";
	}
	return error instanceof Error && /repository not found/i.test(error.message);
}

type ControlBindingRow = Awaited<
	ReturnType<typeof getPortableTediControlBindings>
>["runtimeProfile"];

function portableBinding(
	row: ControlBindingRow,
	id: string | null,
	organizationId: string,
) {
	if (!id) return null;
	if (
		!row ||
		(row.scope === "organization" && row.organizationId !== organizationId) ||
		(row.scope === "system" && row.organizationId !== null)
	) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Tedi control binding is unavailable for export",
		);
	}
	return { scope: row.scope, slug: row.slug, version: row.version };
}

async function assignedAppSlugs(
	context: BaseContext,
	tedi: Tedi,
): Promise<string[]> {
	if (!tedi.descopeUserId) return [];
	const apps = await getAppsByOrganization(context.db, tedi.organizationId);
	if (apps.length === 0) return [];
	const relations = apps.flatMap((app) =>
		(["operator", "observer"] as const).map((relation) => ({
			resource: app.id,
			resourceType: "app",
			relation,
			target: tedi.descopeUserId!,
			targetType: "user",
		})),
	);
	const response = await getManagementClient(context.env).management.fga.check(
		relations,
	);
	if (!response.ok || !response.data) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"App bindings could not be verified for export",
		);
	}
	const allowedIds = new Set(
		response.data
			.filter((item) => item.allowed)
			.map((item) => item.tuple.resource),
	);
	return apps
		.filter((app) => allowedIds.has(app.id))
		.map((app) => app.slug)
		.sort();
}

/** Issue a credential only after the exact owning organization is verified. */
export async function issuePortableGitReadAccess(
	context: BaseContext,
	tediId: string,
): Promise<
	| {
			repoFound: false;
			identity: ReturnType<typeof portableIdentity>;
			bindings: Awaited<ReturnType<typeof portableBindings>>;
			snapshot: { url: string; token: string; expiresAt: string };
	  }
	| {
			repoFound: true;
			identity: ReturnType<typeof portableIdentity>;
			bindings: Awaited<ReturnType<typeof portableBindings>>;
			snapshot: { url: string; token: string; expiresAt: string };
			remote: string;
			token: string;
			expiresAt: string;
	  }
> {
	if (context.authType !== "user") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Portable Git export requires an interactive organization user",
		);
	}
	const organizationId = requireOrganizationId(context);
	const tedi = await getTediByIdForOrganization(
		context.db,
		tediId,
		organizationId,
	);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	const identity = portableIdentity(tedi);
	const bindings = await portableBindings(context, tedi);
	const snapshotTicket = await issuePortableSnapshotTicket({
		secret: context.env.SECRETS_MASTER_KEY,
		organizationId,
		tediId: tedi.id,
		nowMs: Date.now(),
	});
	const snapshot = {
		url: new URL(
			`/portable/tedis/${tedi.id}/snapshot`,
			context.env.API_URL,
		).toString(),
		...snapshotTicket,
	};
	let repo: Awaited<ReturnType<typeof context.env.ARTIFACTS.get>>;
	try {
		repo = await context.env.ARTIFACTS.get(tedi.id);
	} catch (error) {
		if (isMissingArtifactsRepo(error)) {
			return { repoFound: false, identity, bindings, snapshot };
		}
		throw error;
	}
	const { remote } = await repo.info();
	const issued = await repo.createToken("read", READ_TOKEN_TTL_SECONDS);
	const token = issued.plaintext.split("?expires=")[0];
	if (!token) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Empty Artifacts token",
		);
	}
	return {
		repoFound: true,
		identity,
		bindings,
		snapshot,
		remote,
		token,
		expiresAt: new Date(
			Date.now() + READ_TOKEN_TTL_SECONDS * 1_000,
		).toISOString(),
	};
}

function portableIdentity(tedi: Tedi) {
	return {
		name: tedi.name,
		slug: tedi.slug,
		displayName: tedi.displayName,
		personality: tedi.personality,
		avatar: tedi.avatar,
		timezone: tedi.timezone,
		language: tedi.language,
		tags: tedi.tags ?? [],
		installedSkills: tedi.installedSkills ?? [],
		installedPlugins: tedi.installedPlugins ?? [],
	};
}

async function portableBindings(context: BaseContext, tedi: Tedi) {
	const rows = await getPortableTediControlBindings(context.db, tedi);
	return {
		runtimeProfile: portableBinding(
			rows.runtimeProfile,
			tedi.runtimeProfileId,
			tedi.organizationId,
		),
		policyPack: portableBinding(
			rows.policyPack,
			tedi.policyPackId,
			tedi.organizationId,
		),
		workspaceTemplateSet: portableBinding(
			rows.workspaceTemplateSet,
			tedi.workspaceTemplateSetId,
			tedi.organizationId,
		),
		apps: await assignedAppSlugs(context, tedi),
	};
}

export const portableGitReadAccessProcedure =
	authedTedisOs.portableGitReadAccess
		.use(AUTHZ.tedisWrite)
		.handler(({ input, context }) =>
			issuePortableGitReadAccess(context, input.tediId),
		);
