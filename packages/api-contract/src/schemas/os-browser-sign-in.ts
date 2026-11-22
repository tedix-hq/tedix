import * as z from "zod";

export const BROWSER_SIGN_IN_ENTRY = "tedix:app/browser-sign-in";

/** Each installed copy watches one tedi's browser sign-in. */
export const BrowserSignInConfigSchema = z.strictObject({
	version: z.literal(1),
	tediId: z.uuid(),
});
export type BrowserSignInConfig = z.infer<typeof BrowserSignInConfigSchema>;
