import * as z from "zod";
import { validateUrl } from "@tedix/ssrf-guard";
import { buildQueryString } from "./utils/query-params";

const PlainFetchConfigSchema = z
	.object({
		transport: z.literal("external"),
		method: z.literal("GET"),
		baseUrl: z.string(),
		endpoint: z.string(),
		queryArrayFormats: z
			.record(z.string(), z.enum(["comma", "space", "pipe"]))
			.optional(),
	})
	.passthrough();

/** Only a plain, credential-free GET has one destination we can show in full. */
export function exactEgressFetchUrl(
	rawConfig: unknown,
	args: Record<string, unknown>,
): string | null {
	const parsedConfig = PlainFetchConfigSchema.safeParse(rawConfig);
	if (!parsedConfig.success) return null;
	const config = parsedConfig.data;
	if (
		!config.baseUrl ||
		config.auth ||
		config.staticHeaders ||
		config.paramMap ||
		config.staticParams ||
		config.bodyEncoding ||
		["runtimeOnlyParams", "headerParams", "queryParams", "x-mcp-header"].some(
			(key) => Object.hasOwn(config, key),
		)
	)
		return null;
	const endpoint = config.endpoint;
	if (!/^[a-zA-Z0-9_\-/.]*$/.test(endpoint)) return null;
	const query = buildQueryString(args, config.queryArrayFormats);
	const url = `${config.baseUrl}/${endpoint}${query ? `?${query}` : ""}`;
	try {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.hash ||
			new URL(config.baseUrl).search ||
			validateUrl(url)
		)
			return null;
		return url;
	} catch {
		return null;
	}
}
