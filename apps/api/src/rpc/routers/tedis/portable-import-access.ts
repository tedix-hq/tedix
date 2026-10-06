import { CreateTediInputSchema } from "@tedix/api-contract/schemas/tedi";
import type { PortableTediImportBeginInputSchema } from "@tedix/api-contract/schemas/portable-tedi";
import { verifyPortableTediManifest } from "@tedix/api-contract/utils/portable-tedi";
import { updateTedi } from "@tedix/db/queries/tedis";
import type * as z from "zod";
import { issuePortableImportTicket } from "../../../lib/portable-import-ticket";
import { createTediForPortableImport } from "./crud";
import {
	AUTHZ,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	requireOrganizationId,
} from "./helpers";

const WRITE_TOKEN_TTL_SECONDS = 3_600;

/** Only an interactive org user can start a fresh, paused import. */
export async function beginPortableTediImport(
	context: BaseContext,
	input: z.infer<typeof PortableTediImportBeginInputSchema>,
) {
	if (context.authType !== "user") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Portable import requires an interactive organization user",
		);
	}
	const organizationId = requireOrganizationId(context);
	const manifest = verifyPortableTediManifest(input.manifest);
	const identity = manifest.identity;
	const destination = await createTediForPortableImport(
		context,
		CreateTediInputSchema.parse({
			name: identity.name,
			slug: input.destinationSlug,
			displayName: identity.displayName ?? undefined,
			personality: identity.personality ?? undefined,
			timezone: identity.timezone ?? undefined,
			language: identity.language ?? undefined,
			tags: identity.tags,
			registerDescopeAih: false,
		}),
	);
	const tediId = destination.id;
	// Local presentation and installed skill names are portable metadata. App,
	// plugin and control bindings require destination-owned authorization.
	await updateTedi(context.db, tediId, {
		avatar: identity.avatar,
		installedSkills: identity.installedSkills,
	});
	let gitToken: string;
	let remote: string;
	try {
		const repo = await context.env.ARTIFACTS.create(tediId, {
			description: `Portable import for ${input.destinationSlug}`,
			readOnly: false,
			setDefaultBranch: "main",
		});
		remote = repo.remote;
		gitToken = repo.token.split("?expires=")[0] ?? "";
		if (!gitToken) throw new Error("Empty Artifacts write token");
	} catch (error) {
		console.error("Portable import Artifacts repo creation failed", {
			tediId,
			error: error instanceof Error ? error.message : String(error),
		});
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			`Portable import target ${tediId} remains paused; its Artifacts repo could not be created`,
		);
	}
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(manifest)),
		),
	);
	const manifestSha256 = Array.from(digest, (part) =>
		part.toString(16).padStart(2, "0"),
	).join("");
	const ticket = await issuePortableImportTicket({
		secret: context.env.SECRETS_MASTER_KEY,
		organizationId,
		tediId,
		sourceTediId: manifest.sourceTediId,
		manifestSha256,
		nowMs: Date.now(),
	});
	return {
		tediId,
		manifestSha256,
		snapshot: {
			url: new URL(
				`/portable/tedis/${tediId}/import`,
				context.env.API_URL,
			).toString(),
			...ticket,
		},
		git: {
			remote,
			token: gitToken,
			expiresAt: new Date(
				Date.now() + WRITE_TOKEN_TTL_SECONDS * 1_000,
			).toISOString(),
		},
	};
}

export const portableImportBeginProcedure = authedTedisOs.portableImportBegin
	.use(AUTHZ.tedisWrite)
	.handler(({ input, context }) => beginPortableTediImport(context, input));
