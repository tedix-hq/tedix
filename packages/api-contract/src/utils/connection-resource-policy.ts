import * as z from "zod";
import { ConnectionAllowedResourcesSchema } from "../schemas/connections";

const pageRead = z
	.object({
		page_id: z.string(),
		filter_properties: z.array(z.string()).optional(),
	})
	.strict();
const pageFetch = z.object({ url: z.string() }).strict();
const resourceTool = z.object({
	transport: z.literal("mcp"),
	mcpToolName: z.string(),
	auth: z.object({ type: z.literal("connection"), connectionId: z.string() }),
});
const pageId = (value: string) => {
	if (
		!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
			value,
		)
	)
		return null;
	return value.replaceAll("-", "").toLowerCase();
};

const repositoryPart = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+$/)
	.refine((value) => value !== "." && value !== "..");
const repository = { owner: repositoryPart, repo: repositoryPart };
const githubArguments = {
	issue_write: z
		.object({
			...repository,
			method: z.literal("update"),
			issue_number: z.number().int().positive(),
			title: z.string().optional(),
			body: z.string().optional(),
			state: z.enum(["open", "closed"]).optional(),
			state_reason: z.enum(["completed", "not_planned", "reopened"]).optional(),
			labels: z.array(z.string()).optional(),
			assignees: z.array(z.string()).optional(),
			milestone: z.number().int().positive().optional(),
			type: z.string().nullable().optional(),
		})
		.strict(),
	create_or_update_file: z
		.object({
			...repository,
			branch: z.string().min(1),
			content: z.string(),
			message: z.string(),
			path: z.string().min(1),
			sha: z.string().optional(),
			allow_symlink_write: z.boolean().optional(),
		})
		.strict(),
	get_file_contents: z
		.object({
			...repository,
			path: z.string().optional(),
			ref: z.string().optional(),
			sha: z.string().optional(),
		})
		.strict(),
};

/** The same decision for discovery/binding (no arguments) and execution/replay. */
export function resolveConnectionResourceAccess(input: {
	allowedResources: unknown;
	additionalLimits?: unknown[];
	providerId: string;
	config: unknown;
	arguments?: unknown;
}): { allowed: boolean; resourceId?: string } {
	const limits = [
		input.allowedResources,
		...(input.additionalLimits ?? []),
	].filter((limit) => limit !== null);
	if (!limits.length) return { allowed: true };
	const policy = ConnectionAllowedResourcesSchema.safeParse(limits[0]);
	if (!policy.success) return { allowed: false };
	const key = (resource: (typeof policy.data)[number]) =>
		`${resource.resourceType}:${resource.resourceType === "notion_page" ? resource.resourceId.replaceAll("-", "").toLowerCase() : resource.resourceId.toLowerCase()}`;
	for (const limit of limits.slice(1)) {
		const next = ConnectionAllowedResourcesSchema.safeParse(limit);
		if (!next.success) return { allowed: false };
		const allowed = new Set(next.data.map(key));
		policy.data = policy.data.filter((resource) => allowed.has(key(resource)));
	}
	const config = resourceTool.safeParse(input.config);
	if (
		!policy.data.length ||
		!config.success ||
		config.data.auth.connectionId !== input.providerId
	)
		return { allowed: false };
	const githubSchema = Object.hasOwn(githubArguments, config.data.mcpToolName)
		? githubArguments[config.data.mcpToolName as keyof typeof githubArguments]
		: undefined;
	if (githubSchema) {
		if (!policy.data.every((r) => r.resourceType === "github_repository"))
			return { allowed: false };
		const endpoint = z
			.object({ mcpServerUrl: z.string() })
			.safeParse(input.config);
		try {
			const url = new URL(endpoint.success ? endpoint.data.mcpServerUrl : "");
			if (
				url.origin !== "https://api.githubcopilot.com" ||
				!/^\/mcp(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(url.pathname) ||
				url.search ||
				url.hash ||
				url.username ||
				url.password
			)
				return { allowed: false };
		} catch {
			return { allowed: false };
		}
		if (input.arguments === undefined)
			return {
				allowed: policy.data.some(
					(r) => r.resourceType === "github_repository",
				),
			};
		const args = githubSchema.safeParse(input.arguments);
		if (!args.success) return { allowed: false };
		const resourceId = `${args.data.owner}/${args.data.repo}`.toLowerCase();
		return {
			allowed: policy.data.some(
				(r) =>
					r.resourceType === "github_repository" &&
					r.resourceId.toLowerCase() === resourceId,
			),
			resourceId,
		};
	}
	if (
		!["notion-fetch", "API-retrieve-a-page"].includes(config.data.mcpToolName)
	)
		return { allowed: false };
	if (!policy.data.every((r) => r.resourceType === "notion_page"))
		return { allowed: false };
	if (input.arguments === undefined)
		return {
			allowed: true,
		};
	let target: string | null = null;
	if (config.data.mcpToolName === "API-retrieve-a-page") {
		const args = pageRead.safeParse(input.arguments);
		if (args.success) target = pageId(args.data.page_id);
	} else if (config.data.mcpToolName === "notion-fetch") {
		const args = pageFetch.safeParse(input.arguments);
		if (args.success) {
			target = pageId(args.data.url);
			try {
				const url = new URL(args.data.url);
				if (
					url.protocol === "https:" &&
					!url.username &&
					!url.password &&
					!url.port &&
					(url.hostname === "notion.com" ||
						url.hostname.endsWith(".notion.com") ||
						url.hostname === "notion.so" ||
						url.hostname.endsWith(".notion.so") ||
						url.hostname.endsWith(".notion.site"))
				) {
					// A view/block fragment must never turn into authority for a different resource.
					if (!url.hash && !url.search) {
						target = pageId(url.pathname.slice(1).replace(/\/$/, ""));
					}
				}
			} catch {
				/* Invalid URLs have no verifiable target. */
			}
		}
	}
	return {
		allowed: Boolean(
			target &&
			policy.data.some(
				(resource) =>
					resource.resourceType === "notion_page" &&
					pageId(resource.resourceId) === target,
			),
		),
		...(target ? { resourceId: target } : {}),
	};
}
