import * as z from "zod";

const HostSchema = z
	.string()
	.max(253)
	.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const PublicPathSchema = z
	.string()
	.max(2048)
	.regex(/^\/(?!\/)[^?#\\\x00-\x20\x7f]*$/);
const SlugSchema = z
	.string()
	.min(1)
	.max(300)
	.regex(/^[^/?#\\\x00-\x20\x7f]+$/)
	.refine((value) => value !== "." && value !== "..");
const OriginSchema = z.string().refine((value) => {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value;
	} catch {
		return false;
	}
}, "Expected an HTTPS origin");

export const SiteRoutingDefinitionSchema = z
	.object({
		siteRouting: z
			.object({
				version: z.literal(1),
				legacyBlogs: z
					.array(
						z
							.object({
								sourceHost: HostSchema,
								targetOrigin: OriginSchema,
								indexPath: PublicPathSchema,
								feedPath: PublicPathSchema,
								postTargets: z.record(SlugSchema, SlugSchema),
								mediaTargets: z.record(PublicPathSchema, PublicPathSchema),
							})
							.strict(),
					)
					.max(100)
					.refine(
						(rows) =>
							new Set(rows.map((row) => row.sourceHost)).size === rows.length,
						"Duplicate source host",
					),
				retainedMedia: z
					.array(
						z
							.object({
								host: HostSchema,
								path: PublicPathSchema,
								key: z
									.string()
									.max(2048)
									.regex(/^retired-media\/[^\\?#\x00-\x20\x7f]+$/)
									.refine((value) =>
										value
											.split("/")
											.every((segment) => segment !== "." && segment !== ".."),
									),
								sha256: z.string().regex(/^[a-f0-9]{64}$/),
								contentType: z
									.string()
									.max(100)
									.regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
							})
							.strict(),
					)
					.max(1000)
					.refine(
						(rows) =>
							new Set(rows.map((row) => `${row.host}${row.path}`)).size ===
							rows.length,
						"Duplicate retained media path",
					),
			})
			.strict(),
	})
	.strict();

export type SiteRoutingPolicy = z.infer<
	typeof SiteRoutingDefinitionSchema
>["siteRouting"];
