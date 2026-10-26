import * as z from "zod";

/** The one internal audience the pilot issues for. */
export const TOKEN_EXCHANGE_API_AUDIENCE = "tedix:api";
/** Header the MCP edge forwards the exchanged token in, service binding only. */
export const EXCHANGED_TOKEN_HEADER = "X-Tedix-Exchanged-Token";

export const ExchangeInternalTokenInputSchema = z.strictObject({
	/** The API procedure the token is for, e.g. `tedis/get`. */
	endpoint: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[A-Za-z0-9]+(?:\/[A-Za-z0-9]+)+$/),
	/** What the calling tool requires; the broker only ever narrows to these. */
	scopes: z
		.array(
			z
				.string()
				.min(1)
				.max(128)
				.regex(/^[A-Za-z0-9._:-]+$/),
		)
		.min(1)
		.max(8),
});

export const ExchangeInternalTokenOutputSchema = z.strictObject({
	accessToken: z.string(),
	issuedTokenType: z.literal("urn:ietf:params:oauth:token-type:access_token"),
	tokenType: z.literal("Bearer"),
	expiresIn: z.number().int().positive(),
	scope: z.string(),
	jti: z.string(),
});

export const RevokeExchangedTokenInputSchema = z.strictObject({
	jti: z.uuid(),
});

export const RevokeExchangedTokenOutputSchema = z.strictObject({
	revoked: z.array(z.string()),
});
