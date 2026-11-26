import * as z from "zod";

/**
 * Poppy personal-agent identity hosted by Tedix.
 *
 * One identity per tedi: Tedix serves the tedi's Poppy client metadata
 * document and `jwks_uri` at a stable HTTPS URL on the API host, keeps the
 * ES256 signing key encrypted in the tedi's secrets, and the tedi runtime
 * signs `Poppy-Session` JWTs for company endpoints with it. The key material
 * never appears in any schema here — views expose URLs and the public kid only.
 */

/** `tedi_secrets.name` holding the encrypted ES256 private JWK. */
export const POPPY_AGENT_SIGNING_KEY_SECRET = "POPPY_AGENT_SIGNING_KEY";

/** Public path (on the API origin) of a tedi's client metadata document. */
export function poppyAgentClientMetadataPath(slug: string): string {
	return `/poppy-agent/${encodeURIComponent(slug)}/client.json`;
}

/** Public path (on the API origin) of a tedi's JWKS document. */
export function poppyAgentJwksPath(slug: string): string {
	return `/poppy-agent/${encodeURIComponent(slug)}/jwks.json`;
}

/** The `client_id` URL a tedi's signed sessions carry as `iss`. */
export function poppyAgentClientId(apiOrigin: string, slug: string): string {
	return `${apiOrigin}${poppyAgentClientMetadataPath(slug)}`;
}

export const PoppyAgentTediIdSchema = z.string().min(1).max(128);

export const PoppyAgentGetInputSchema = z.object({
	tediId: PoppyAgentTediIdSchema,
});

export const PoppyAgentSetEnabledInputSchema = z.object({
	tediId: PoppyAgentTediIdSchema,
	enabled: z.boolean(),
});

/**
 * Admin-facing view of one tedi's Poppy identity. Never carries key material.
 */
export const PoppyAgentIdentityViewSchema = z.object({
	enabled: z.boolean(),
	/** Public HTTPS URL of the client metadata document (`iss` of sessions). */
	clientId: z.string().nullable(),
	jwksUri: z.string().nullable(),
	/** Public `kid` of the signing key, when the identity is enabled. */
	keyId: z.string().nullable(),
	clientName: z.string().nullable(),
});

export type PoppyAgentIdentityView = z.infer<
	typeof PoppyAgentIdentityViewSchema
>;
