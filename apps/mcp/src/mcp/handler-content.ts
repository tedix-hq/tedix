import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { contentFreeMcpException, createMcpLogger } from "../log";
import type { RpcToolResult, ToolExecutionContext } from "./handler";
import {
	applyStripField,
	applyToNestedArrays,
	getByPath,
	setByPath,
} from "./handlers/path-utils";

const log = createMcpLogger("mcp.tool_handler");

/** Max text content length before truncation */
const MAX_TEXT_LENGTH = 4000;

const CHAR_COUNT_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Head-truncate model-visible text at MAX_TEXT_LENGTH with a machine-actionable
 * hint that teaches the caller how to get a smaller result on the next call.
 * Display text only — structuredContent is never truncated here.
 */
function truncateTextContent(text: string): string {
	if (text.length <= MAX_TEXT_LENGTH) return text;
	return `${text.slice(0, MAX_TEXT_LENGTH)}\n[Truncated: showing first ${CHAR_COUNT_FORMAT.format(MAX_TEXT_LENGTH)} of ${CHAR_COUNT_FORMAT.format(text.length)} chars. Narrow the query with this tool's pagination/filter parameters, or call it via Code Mode and select only the fields you need.]`;
}

/**
 * Render a `modelSummaryTemplate` against the shaped structured payload.
 * Same `{field.path}` placeholder syntax as responseTransforms, plus a
 * `{count:field.path}` helper that renders the length of the array at that
 * path (`0` when the path is missing or not an array).
 */
function renderModelSummaryTemplate(
	template: string,
	payload: Record<string, unknown>,
): string {
	return template.replace(/\{([^{}]+)\}/g, (_match, expr: string) => {
		if (expr.startsWith("count:")) {
			const value = getByPath(payload, expr.slice("count:".length));
			return Array.isArray(value) ? String(value.length) : "0";
		}
		const value = getByPath(payload, expr);
		if (value == null) return "";
		return typeof value === "object" ? JSON.stringify(value) : String(value);
	});
}

export function buildStructuredContent(
	result: RpcToolResult,
	ctx: ToolExecutionContext<ToolConfig>,
): Record<string, unknown> {
	// Shaping mutates nested arrays and objects; each projection owns its copy.
	const data = structuredClone(result.data);
	let output: Record<string, unknown>;
	if (data != null && typeof data === "object" && !Array.isArray(data)) {
		output = data as Record<string, unknown>;
	} else {
		output = { data };
	}

	// Apply responseMap: rename/extract fields for widget consumption
	// Supports "[]" suffix for array-wrapping: { "source[]": "sources" }
	// wraps a scalar value in an array for the target field
	const responseMap = ctx.config.responseMap;
	if (responseMap) {
		for (const [sourceExpr, targetKey] of Object.entries(responseMap)) {
			const wrapArray = sourceExpr.endsWith("[]");
			const sourcePath = wrapArray ? sourceExpr.slice(0, -2) : sourceExpr;
			let value = getByPath(output, sourcePath);
			if (value !== undefined) {
				if (wrapArray && !Array.isArray(value)) {
					value = [value];
				}
				output[targetKey] = value;
				// Remove original key if it differs and is a top-level key
				if (
					!sourcePath.includes(".") &&
					sourcePath !== targetKey &&
					sourcePath in output
				) {
					delete output[sourcePath];
				}
			}
		}
	}

	// Apply responseTransforms: compute derived fields on array items
	const transforms = ctx.config.responseTransforms;
	if (transforms) {
		for (const rule of transforms) {
			const arr = getByPath(output, rule.arrayPath);
			if (!Array.isArray(arr)) continue;
			for (const item of arr) {
				if (item == null || typeof item !== "object") continue;
				const value = rule.template.replace(
					/\{([^{}]+)\}/g,
					(_m, path: string) => {
						const v = getByPath(item, path);
						return v != null ? String(v) : "";
					},
				);
				setByPath(item as Record<string, unknown>, rule.set, value);
			}
		}
	}

	// Apply arrayLimits: truncate nested arrays to max length
	const arrayLimits = ctx.config.arrayLimits;
	if (arrayLimits) {
		for (const [pathExpr, maxLen] of Object.entries(arrayLimits)) {
			applyToNestedArrays(output, pathExpr, (arr) => {
				arr.length = Math.min(arr.length, maxLen);
			});
		}
	}

	// Apply stripFields: remove unwanted fields from output
	const stripFields = ctx.config.stripFields;
	if (stripFields) {
		for (const pathExpr of stripFields) {
			applyStripField(output, pathExpr);
		}
	}

	// Apply staticOutput: constant fields for widget context (doesn't overwrite API data)
	const staticOutput = ctx.config.staticOutput;
	if (staticOutput) {
		for (const [key, value] of Object.entries(staticOutput)) {
			if (!(key in output)) {
				output[key] = value;
			}
		}
	}

	return output;
}

export function buildTextContent(
	result: RpcToolResult,
	ctx: ToolExecutionContext<ToolConfig>,
	shapeContent = buildStructuredContent,
): string {
	if (result.status >= 400) {
		const errorData = result.data as Record<string, unknown> | undefined;
		if (errorData && typeof errorData === "object") {
			// REST-style: { error: "..." } — Google-style APIs nest an object
			// ({ code, message, status }) here; String() renders that as the
			// useless "Error: [object Object]", so stringify objects instead.
			if ("error" in errorData) {
				const inner = errorData.error;
				const detail =
					inner && typeof inner === "object"
						? JSON.stringify(inner).slice(0, 500)
						: String(inner);
				return `Error: ${detail}`;
			}
			// oRPC-style: { code: "BAD_REQUEST", message: "...", data?: {...} }
			if ("code" in errorData && "message" in errorData) {
				// Validation errors carry their issues in the message and an
				// empty `data: {}`; appending that renders a meaningless " — {}".
				const detail =
					errorData.data &&
					typeof errorData.data === "object" &&
					Object.keys(errorData.data).length > 0
						? ` — ${JSON.stringify(errorData.data).slice(0, 300)}`
						: "";
				return `${errorData.code}: ${errorData.message}${detail}`;
			}
		}
		return `Request failed with status ${result.status}`;
	}
	// Dual-audience projection: when the tool config carries a
	// modelSummaryTemplate, the model-visible text becomes the rendered
	// template while structuredContent keeps the full shaped payload for
	// widgets/hosts. Paths resolve against the shaped structured output so
	// the projection and structuredContent always describe the same data.
	// Fail-soft: a malformed template row must never turn a successful
	// result into an error — fall back to the default JSON text instead.
	const modelSummaryTemplate = ctx.config.modelSummaryTemplate;
	if (modelSummaryTemplate) {
		if (typeof modelSummaryTemplate === "string") {
			try {
				// Keep custom shaping callbacks isolated from the upstream payload.
				const shaped = shapeContent(
					{ ...result, data: structuredClone(result.data) },
					ctx,
				);
				return truncateTextContent(
					renderModelSummaryTemplate(modelSummaryTemplate, shaped),
				);
			} catch (error) {
				log.error("Model summary rendering failed; using JSON text", {
					event: "handler.model_summary_render_failed",
					appId: ctx.appId,
					toolName: ctx.toolId,
					outcome: "invalid",
					error: contentFreeMcpException(error),
				});
			}
		} else {
			log.error("Model summary template is not a string", {
				event: "handler.model_summary_template_invalid",
				appId: ctx.appId,
				toolName: ctx.toolId,
				outcome: "invalid",
			});
		}
	}
	return truncateTextContent(JSON.stringify(result.data, null, 2));
}
