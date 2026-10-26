import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { AppRuntimeRoleSchema } from "@tedix/api-contract/schemas/os-app-runtime";

export const APP_SESSION_TTL_SECONDS = 300;
const issuer = "tedix:workspace-app";
const audience = "tedix:workspace-app-host";

export const WorkspaceAppSessionSchema = z
	.object({
		organizationId: z.string().min(1),
		workspaceId: z.uuid(),
		gadgetId: z.uuid(),
		revisionId: z.uuid(),
		revision: z.number().int().positive(),
		actorUserId: z.string().optional(),
		actorPermissions: z.array(z.string()).optional(),
		config: z.record(z.string(), z.json()).optional(),
		compatibilityDate: z.string().optional(),
		principal: z
			.object({ kind: z.string().min(1), id: z.string().min(1) })
			.strict(),
		role: AppRuntimeRoleSchema,
		grants: z.array(
			z
				.object({ slot: z.string().min(1), operations: z.array(z.string()) })
				.strict(),
		),
		previewId: z.uuid().optional(),
		proposalId: z.uuid().optional(),
		proposalSequence: z.number().int().nonnegative().optional(),
		codeDigest: z.string().optional(),
		/** Set for a guest who opened the app through a share link; revoking the link cuts the session. */
		shareLinkId: z.uuid().optional(),
	})
	.strict();
export type WorkspaceAppSession = z.infer<typeof WorkspaceAppSessionSchema>;

async function signingKey(secret: string) {
	if (!secret) throw new Error("App session signing unavailable");
	const source = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: new TextEncoder().encode(issuer),
				info: new TextEncoder().encode(audience),
			},
			source,
			256,
		),
	);
}

export async function mintWorkspaceAppSession(
	secret: string,
	session: WorkspaceAppSession,
) {
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = now + APP_SESSION_TTL_SECONDS;
	const token = await new SignJWT({
		app: WorkspaceAppSessionSchema.parse(session),
	})
		.setProtectedHeader({ alg: "HS256", typ: "tedix.workspace-app" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(expiresAt)
		.setJti(crypto.randomUUID())
		.sign(await signingKey(secret));
	return { token, expiresAt };
}

export async function verifyWorkspaceAppSession(secret: string, token: string) {
	const { payload, protectedHeader } = await jwtVerify(
		token,
		await signingKey(secret),
		{
			issuer,
			audience,
			algorithms: ["HS256"],
			maxTokenAge: APP_SESSION_TTL_SECONDS,
		},
	);
	if (
		protectedHeader.typ !== "tedix.workspace-app" ||
		!payload.jti ||
		typeof payload.iat !== "number" ||
		typeof payload.exp !== "number" ||
		payload.exp - payload.iat > APP_SESSION_TTL_SECONDS ||
		payload.iat > Math.floor(Date.now() / 1000)
	)
		throw new Error("Invalid app session");
	return {
		...WorkspaceAppSessionSchema.parse(payload.app),
		expiresAt: payload.exp,
		sessionId: payload.jti,
	};
}
