import * as z from "zod";

/** Provider-owned assertion; Tedix binds it but never interprets provider permissions. */
export const HostDelegationSchema = z
	.object({
		token: z
			.string()
			.min(1)
			.max(8192)
			.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
		audience: z.url().refine((value) => {
			const url = new URL(value);
			return url.protocol === "https:" && url.origin === value;
		}, "Delegation audience must be an HTTPS origin"),
		expiresAt: z.number().int().positive(),
	})
	.strict();
export type HostDelegation = z.infer<typeof HostDelegationSchema>;
