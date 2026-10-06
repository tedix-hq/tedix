import { autoFixSpec, isNonEmptySpec, validateSpec } from "@json-render/core";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export const MAX_WIDGET_SPEC_PAYLOAD_BYTES = 100_000;

export interface WidgetSpecIssue {
	level: "error" | "warning";
	source: string;
	message: string;
}

export interface WidgetSpecResult {
	spec: Record<string, unknown> | null;
	issues: WidgetSpecIssue[];
}

export interface WidgetDataResult {
	data: Record<string, unknown> | null;
	issues: WidgetSpecIssue[];
}

function issue(
	level: WidgetSpecIssue["level"],
	source: string,
	message: string,
): WidgetSpecIssue {
	return { level, source, message };
}

function safeDecodeBase64(value: string): string {
	const decoded = value.includes("%") ? decodeURIComponent(value) : value;
	const normalized = decoded.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized.padEnd(
		normalized.length + ((4 - (normalized.length % 4)) % 4),
		"=",
	);
	const binary = atob(padded);
	return new TextDecoder("utf-8", { fatal: true }).decode(
		Uint8Array.from(binary, (character) => character.charCodeAt(0)),
	);
}

function parseRecordJson(
	source: string,
	value: string,
): {
	value: Record<string, unknown> | null;
	issues: WidgetSpecIssue[];
} {
	try {
		const parsed = JSON.parse(value);
		if (!isRecord(parsed)) {
			return {
				value: null,
				issues: [issue("error", source, "Payload must be a JSON object.")],
			};
		}
		return { value: parsed, issues: [] };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown parse error";
		return {
			value: null,
			issues: [issue("error", source, `Invalid JSON: ${message}`)],
		};
	}
}

function parseEncodedRecord(
	source: string,
	value: string | null,
): {
	value: Record<string, unknown> | null;
	issues: WidgetSpecIssue[];
} {
	if (!value) return { value: null, issues: [] };
	if (value.length > MAX_WIDGET_SPEC_PAYLOAD_BYTES) {
		return {
			value: null,
			issues: [
				issue(
					"error",
					source,
					`Encoded payload exceeds ${MAX_WIDGET_SPEC_PAYLOAD_BYTES} bytes.`,
				),
			],
		};
	}
	try {
		return parseRecordJson(source, safeDecodeBase64(value));
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown base64 decode error";
		return {
			value: null,
			issues: [issue("error", source, `Invalid base64 payload: ${message}`)],
		};
	}
}

export function normalizeWidgetSpec(
	rawSpec: Record<string, unknown> | null,
	source: string,
): WidgetSpecResult {
	if (!rawSpec) return { spec: null, issues: [] };
	if (!isNonEmptySpec(rawSpec)) {
		return {
			spec: null,
			issues: [
				issue("error", source, "Spec is empty or missing json-render root."),
			],
		};
	}

	const firstPass = validateSpec(rawSpec as never);
	if (firstPass.valid) {
		return { spec: rawSpec, issues: [] };
	}

	const validationMessages =
		firstPass.issues?.map((item) => item.message).filter(Boolean) ?? [];

	// Prefer a lossless repair. Rendering is the last stop, so a lossy fix —
	// which prunes content rather than relocating it — is still better than a
	// blank widget; but it must never pass silently, so we take it only after
	// the lossless pass fails and we say exactly what it dropped.
	const lossless = autoFixSpec(rawSpec as never, { lossy: false });
	if (validateSpec(lossless.spec).valid) {
		return {
			spec: lossless.spec as unknown as Record<string, unknown>,
			issues: [
				issue(
					"warning",
					source,
					`Autofixed spec validation issue(s): ${validationMessages.join("; ")}`,
				),
			],
		};
	}

	const autofix = autoFixSpec(rawSpec as never);
	const secondPass = validateSpec(autofix.spec);
	if (secondPass.valid) {
		const discarded = autofix.fixDetails
			.filter((fix) => fix.lossy)
			.map((fix) => fix.message);
		return {
			spec: autofix.spec as unknown as Record<string, unknown>,
			issues: [
				issue(
					"warning",
					source,
					`Autofixed spec validation issue(s): ${validationMessages.join("; ")}`,
				),
				...(discarded.length > 0
					? [
							issue(
								"error",
								source,
								`Autofix DISCARDED content to make the spec render: ${discarded.join("; ")}`,
							),
						]
					: []),
			],
		};
	}

	return {
		spec: rawSpec,
		issues: [
			issue(
				"warning",
				source,
				`Spec validation issue(s): ${validationMessages.join("; ")}`,
			),
		],
	};
}

export function parseWidgetSpecHeader(
	headerValue: string | null,
): WidgetSpecResult {
	if (!headerValue) return { spec: null, issues: [] };
	if (headerValue.length > MAX_WIDGET_SPEC_PAYLOAD_BYTES) {
		return {
			spec: null,
			issues: [
				issue(
					"error",
					"X-Tedix-Layout-Spec",
					`Header exceeds ${MAX_WIDGET_SPEC_PAYLOAD_BYTES} bytes.`,
				),
			],
		};
	}
	const parsed = parseRecordJson("X-Tedix-Layout-Spec", headerValue);
	const normalized = normalizeWidgetSpec(parsed.value, "X-Tedix-Layout-Spec");
	return {
		spec: normalized.spec,
		issues: [...parsed.issues, ...normalized.issues],
	};
}

export function parseWidgetSpecParam(value: string | null): WidgetSpecResult {
	const parsed = parseEncodedRecord("spec", value);
	const normalized = normalizeWidgetSpec(parsed.value, "spec");
	return {
		spec: normalized.spec,
		issues: [...parsed.issues, ...normalized.issues],
	};
}

export function parseWidgetDataParam(value: string | null): WidgetDataResult {
	const parsed = parseEncodedRecord("data", value);
	return { data: parsed.value, issues: parsed.issues };
}

export async function parseWidgetPreviewBody(
	request: Request,
): Promise<WidgetSpecResult & WidgetDataResult> {
	if (request.method !== "POST") {
		return { spec: null, data: null, issues: [] };
	}

	try {
		const text = await request.text();
		if (text.length > MAX_WIDGET_SPEC_PAYLOAD_BYTES) {
			return {
				spec: null,
				data: null,
				issues: [
					issue(
						"error",
						"body",
						`Request body exceeds ${MAX_WIDGET_SPEC_PAYLOAD_BYTES} bytes.`,
					),
				],
			};
		}

		const parsed = JSON.parse(text);
		if (!isRecord(parsed)) {
			return {
				spec: null,
				data: null,
				issues: [issue("error", "body", "Request body must be a JSON object.")],
			};
		}

		const rawSpec = isRecord(parsed.spec) ? parsed.spec : null;
		const rawData = isRecord(parsed.data) ? parsed.data : null;
		const normalized = normalizeWidgetSpec(rawSpec, "body.spec");
		return {
			spec: normalized.spec,
			data: rawData,
			issues: normalized.issues,
		};
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown parse error";
		return {
			spec: null,
			data: null,
			issues: [issue("error", "body", `Invalid JSON body: ${message}`)],
		};
	}
}

export function mergeWidgetDataIntoSpec(
	spec: Record<string, unknown> | null,
	data: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!spec || !data) return spec;
	const existingState = isRecord(spec.state) ? spec.state : {};
	return {
		...spec,
		state: { ...existingState, ...data },
	};
}

export function escapeJsonForHtml(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function logWidgetSpecIssues(prefix: string, issues: WidgetSpecIssue[]) {
	for (const item of issues) {
		const logger = item.level === "error" ? console.error : console.warn;
		logger(`[${prefix}] ${item.source}: ${item.message}`);
	}
}
