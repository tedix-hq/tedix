/**
 * Views the workspace agent shows in its chat answer. A view is the same
 * MCP Apps result Code Mode's `ui.create_view` returns: data plus a
 * json-render layout, addressed by a generated `ui://widgets/mcp-app/…`
 * resource. The chat renders it in the sandboxed widget frame tedi chat
 * already uses; nothing here runs code or writes workspace data.
 */

/** App whose generic `/r/<layout>` renderer serves generated views. */
import { isRecord } from "@tedix/api-contract/utils/is-record";

export const VIEW_APP_SLUG = "tedix-unified";
export const MAX_VIEWS_PER_TURN = 3;
export const MAX_VIEW_BYTES = 64 * 1024;

export interface ViewInput {
	title: string;
	summary?: string;
	data: Record<string, unknown> | Array<Record<string, unknown>>;
	layoutSpec?: Record<string, unknown>;
}

export interface ShownView {
	viewId: string;
	appSlug: string;
	resourceUri: string;
	title: string;
	/** Structured content handed to the frame; carries `layoutSpec`. */
	toolResult: Record<string, unknown>;
}

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function label(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "view"
	);
}

function columnFormat(key: string, rows: Array<Record<string, unknown>>) {
	const lower = key.toLowerCase();
	if (/(status|state|stage|priority|severity|disposition)/.test(lower))
		return "badge";
	if (/(date|time|created|updated|timestamp)/.test(lower)) return "date";
	if (rows.some((row) => typeof row[key] === "number")) return "number";
	return "text";
}

function firstRecordArray(
	data: Record<string, unknown>,
): { key: string; rows: Array<Record<string, unknown>> } | null {
	for (const [key, value] of Object.entries(data)) {
		if (Array.isArray(value) && value.length > 0 && value.every(isRecord))
			return { key, rows: value };
	}
	return null;
}

function textElement(text: string, variant: "default" | "muted") {
	return { type: "Text", props: { text, variant }, children: [] };
}

/** A table for the first list of records, otherwise a panel of facts. */
export function defaultLayoutSpec(
	title: string,
	summary: string | undefined,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const head = {
		title: textElement(title, "default"),
		...(summary ? { summary: textElement(summary, "muted") } : {}),
	};
	const headIds = Object.keys(head);
	const table = firstRecordArray(data);
	if (table) {
		const keys = [
			...new Set(
				table.rows.flatMap((row) =>
					Object.keys(row).filter((key) => isScalar(row[key])),
				),
			),
		].slice(0, 6);
		return {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: [...headIds, "table"],
				},
				...head,
				table: {
					type: "DataTable",
					props: {
						columns: keys.map((key) => ({
							field: key,
							header: label(key),
							format: columnFormat(key, table.rows),
							sortable: true,
						})),
						data: { $state: `/${table.key}` },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
			},
		};
	}
	const items = Object.entries(data)
		.filter((entry): entry is [string, Scalar] => isScalar(entry[1]))
		.slice(0, 12)
		.map(([key, value]) => ({
			label: label(key),
			value: value === null ? "—" : String(value),
		}));
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children: items.length ? [...headIds, "facts"] : headIds,
			},
			...head,
			...(items.length
				? {
						facts: {
							type: "KeyValuePanel",
							props: {
								items,
								columns: 2,
								density: "compact",
								variant: "plain",
							},
							children: [],
						},
					}
				: {}),
		},
	};
}

function usableLayoutSpec(spec: unknown): Record<string, unknown> | null {
	if (!isRecord(spec) || typeof spec.root !== "string") return null;
	const elements = spec.elements;
	return isRecord(elements) && isRecord(elements[spec.root]) ? spec : null;
}

/** Validate the model's input and shape the result the chat frame renders. */
export function buildView(input: unknown, viewId: string): ShownView {
	if (!isRecord(input)) throw new Error("views.show needs an input object");
	const title =
		typeof input.title === "string" && input.title.trim()
			? input.title.trim().slice(0, 120)
			: null;
	if (!title) throw new Error("views.show needs a title");
	const summary =
		typeof input.summary === "string" && input.summary.trim()
			? input.summary.trim().slice(0, 500)
			: undefined;
	const data = Array.isArray(input.data)
		? input.data.every(isRecord)
			? { rows: input.data }
			: null
		: isRecord(input.data)
			? input.data
			: null;
	if (!data)
		throw new Error(
			"views.show needs data as an object or an array of records",
		);
	if (input.layoutSpec !== undefined && !usableLayoutSpec(input.layoutSpec))
		throw new Error(
			"layoutSpec must be { root, elements } with the root element present; omit it for a default table or facts view",
		);
	const layoutSpec =
		usableLayoutSpec(input.layoutSpec) ??
		defaultLayoutSpec(title, summary, data);
	const toolResult = {
		...data,
		title,
		...(summary ? { summary } : {}),
		layoutSpec,
	};
	const bytes = new TextEncoder().encode(JSON.stringify(toolResult)).length;
	if (bytes > MAX_VIEW_BYTES)
		throw new Error(
			`View data is ${bytes} bytes; keep it under ${MAX_VIEW_BYTES} (show fewer rows or columns)`,
		);
	return {
		viewId,
		appSlug: VIEW_APP_SLUG,
		resourceUri: `ui://widgets/mcp-app/${VIEW_APP_SLUG}/r/${slug(title)}.html`,
		title,
		toolResult,
	};
}
