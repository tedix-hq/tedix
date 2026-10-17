import { z } from "zod";

/** Installation-owned public-client configuration; credentials never live here. */
export const OidcIdentityConfigSchema = z
	.object({
		kind: z.literal("oidc"),
		issuer: z.url(),
		clientId: z.string().min(1).max(200),
		redirectUri: z.url(),
		scopes: z
			.array(z.string().regex(/^[\w:.-]+$/))
			.min(1)
			.max(50),
		scopeMapping: z.record(
			z.string(),
			z.array(z.string().regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/)),
		),
		sessionSeconds: z.number().int().min(60).max(3600).default(900),
	})
	.strict();
export type OidcIdentityConfig = z.infer<typeof OidcIdentityConfigSchema>;
