import { collectMcpHeaderBindings } from "@tedix/mcp-shared/mcp-param-headers";
import type {
	McpIconInfo,
	McpPromptInfo,
	McpResourceInfo,
	McpResourceTemplateInfo,
	McpToolAnnotations,
	McpToolInfo,
} from "./types";
import { isRecord } from "@tedix/api-contract/utils/is-record";

function mapMcpIcons(value: unknown): McpIconInfo[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const icons: McpIconInfo[] = value.filter(isRecord).map((icon) => {
		const mapped: McpIconInfo = { src: String(icon.src ?? "") };
		if (typeof icon.mimeType === "string") mapped.mimeType = icon.mimeType;
		if (Array.isArray(icon.sizes)) mapped.sizes = icon.sizes.map(String);
		else if (typeof icon.sizes === "string") mapped.sizes = [icon.sizes];
		if (icon.theme === "light" || icon.theme === "dark") {
			mapped.theme = icon.theme;
		}
		return mapped;
	});
	const valid = icons.filter((icon) => icon.src);
	return valid.length > 0 ? valid : undefined;
}

export function mapToolsListResult(
	serverId: string,
	result: unknown,
): McpToolInfo[] {
	const payload = result as { tools?: Array<Record<string, unknown>> };
	return (payload.tools ?? [])
		.filter((tool) => typeof tool.name === "string")
		.flatMap((tool) => {
			const ann = tool.annotations as McpToolAnnotations | undefined;
			const meta = tool._meta as Record<string, unknown> | undefined;
			const hasWidget = Boolean(
				meta?.["openai/outputTemplate"] || meta?.["com.tedix/hasWidget"],
			);
			const widgetDescription = (meta?.["openai/widgetDescription"] ??
				meta?.["com.tedix/widgetDescription"]) as string | undefined;
			const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
			const headerBindings = collectMcpHeaderBindings(inputSchema);
			if (!headerBindings.ok) {
				console.warn(
					`[mcp-client-core] skipping tool "${String(tool.name)}" with invalid x-mcp-header annotation: ${headerBindings.reason}`,
				);
				return [];
			}
			return [
				{
					serverId,
					name: tool.name as string,
					title: typeof tool.title === "string" ? tool.title : undefined,
					description:
						typeof tool.description === "string" ? tool.description : undefined,
					inputSchema,
					outputSchema: isRecord(tool.outputSchema)
						? tool.outputSchema
						: undefined,
					icons: mapMcpIcons(tool.icons),
					annotations: ann,
					meta,
					hasWidget,
					widgetDescription,
				},
			];
		});
}

export function mapResourcesListResult(
	serverId: string,
	result: unknown,
): McpResourceInfo[] {
	const payload = result as { resources?: Array<Record<string, unknown>> };
	return (payload.resources ?? [])
		.filter((resource) => typeof resource.uri === "string")
		.map((resource) => ({
			serverId,
			uri: resource.uri as string,
			name: typeof resource.name === "string" ? resource.name : undefined,
			description:
				typeof resource.description === "string"
					? resource.description
					: undefined,
			mimeType:
				typeof resource.mimeType === "string" ? resource.mimeType : undefined,
			icons: mapMcpIcons(resource.icons),
			annotations: isRecord(resource.annotations)
				? resource.annotations
				: undefined,
			_meta: isRecord(resource._meta) ? resource._meta : undefined,
		}));
}

export function mapResourceTemplatesListResult(
	serverId: string,
	result: unknown,
): McpResourceTemplateInfo[] {
	const payload = result as {
		resourceTemplates?: Array<Record<string, unknown>>;
	};
	return (payload.resourceTemplates ?? [])
		.filter((template) => typeof template.uriTemplate === "string")
		.map((template) => ({
			serverId,
			uriTemplate: template.uriTemplate as string,
			name: typeof template.name === "string" ? template.name : undefined,
			title: typeof template.title === "string" ? template.title : undefined,
			description:
				typeof template.description === "string"
					? template.description
					: undefined,
			mimeType:
				typeof template.mimeType === "string" ? template.mimeType : undefined,
			icons: mapMcpIcons(template.icons),
			annotations: isRecord(template.annotations)
				? template.annotations
				: undefined,
			_meta: isRecord(template._meta) ? template._meta : undefined,
		}));
}

export function mapPromptsListResult(
	serverId: string,
	result: unknown,
): McpPromptInfo[] {
	const payload = result as { prompts?: Array<Record<string, unknown>> };
	return (payload.prompts ?? [])
		.filter((prompt) => typeof prompt.name === "string")
		.map((prompt) => ({
			serverId,
			name: prompt.name as string,
			title: typeof prompt.title === "string" ? prompt.title : undefined,
			description:
				typeof prompt.description === "string" ? prompt.description : undefined,
			icons: mapMcpIcons(prompt.icons),
			_meta: isRecord(prompt._meta) ? prompt._meta : undefined,
			arguments: Array.isArray(prompt.arguments)
				? prompt.arguments
						.filter((arg): arg is Record<string, unknown> => isRecord(arg))
						.map((arg) => ({
							name: String(arg.name ?? ""),
							description:
								typeof arg.description === "string"
									? arg.description
									: undefined,
							required:
								typeof arg.required === "boolean" ? arg.required : undefined,
						}))
						.filter((arg) => arg.name)
				: undefined,
		}));
}
