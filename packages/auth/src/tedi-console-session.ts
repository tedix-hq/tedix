import { SignJWT, jwtVerify } from "jose";
export const TEDI_CONSOLE_SESSION_PREFIX = "tcs_";
export const TEDI_CONSOLE_SESSION_TTL_SECONDS = 300;
const issuer = "tedix:session-broker:tedi-console";
const audience = "tedix:tedi-console:read";
async function signingKey(masterKey: string) {
	if (!masterKey) throw new Error("Console session signing unavailable");
	const source = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(masterKey),
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
export interface TediConsoleSession {
	tediId: string;
	organizationId: string;
	grantRevision: string;
}
export async function mintTediConsoleSession(
	masterKey: string,
	session: TediConsoleSession,
	expiresAt: number,
) {
	const now = Math.floor(Date.now() / 1000);
	if (expiresAt <= now || expiresAt > now + TEDI_CONSOLE_SESSION_TTL_SECONDS)
		throw new Error("Invalid console session expiry");
	return (
		TEDI_CONSOLE_SESSION_PREFIX +
		(await new SignJWT({
			organizationId: session.organizationId,
			grantRevision: session.grantRevision,
		})
			.setProtectedHeader({ alg: "HS256", typ: "tedix.tedi-console" })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject(session.tediId)
			.setIssuedAt(now)
			.setExpirationTime(expiresAt)
			.setJti(crypto.randomUUID())
			.sign(await signingKey(masterKey)))
	);
}
export async function verifyTediConsoleSession(
	masterKey: string,
	token: string,
): Promise<TediConsoleSession> {
	if (!token.startsWith(TEDI_CONSOLE_SESSION_PREFIX))
		throw new Error("Not a console session");
	const { payload, protectedHeader } = await jwtVerify(
		token.slice(TEDI_CONSOLE_SESSION_PREFIX.length),
		await signingKey(masterKey),
		{
			issuer,
			audience,
			algorithms: ["HS256"],
			maxTokenAge: TEDI_CONSOLE_SESSION_TTL_SECONDS,
		},
	);
	if (
		protectedHeader.typ !== "tedix.tedi-console" ||
		!payload.sub ||
		typeof payload.organizationId !== "string" ||
		typeof payload.grantRevision !== "string" ||
		typeof payload.iat !== "number" ||
		typeof payload.exp !== "number" ||
		payload.exp - payload.iat > TEDI_CONSOLE_SESSION_TTL_SECONDS
	)
		throw new Error("Invalid console session");
	return {
		tediId: payload.sub,
		organizationId: payload.organizationId,
		grantRevision: payload.grantRevision,
	};
}
