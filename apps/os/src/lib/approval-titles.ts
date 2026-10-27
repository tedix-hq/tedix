/**
 * Plain-language titles for approval requests and tool calls.
 *
 * Older approval rows (and some current ones) carry a raw tool slug as their
 * title: `example-unified:tedi_146194__run_skill_workflow`, `Run
 * work.create_work_items`, `Approve Kernel write: gmail.create_draft on
 * gmail-tedix`. People should read what the action does, not its wire name,
 * so the OS formats those here. A title that already reads as a sentence is
 * returned unchanged.
 */

import { stripRetryNote } from "@tedix/api-contract/utils/approval-decision";

const APP_SUFFIXES = /[-_](?:tedix|unified|mcp|app)$/i;

/** `google-gmail-tedix` → `Google Gmail`; `example-unified` → `Example`. */
export function appLabel(slug: string | null | undefined): string | null {
	const base = slug?.trim().replace(APP_SUFFIXES, "").replace(APP_SUFFIXES, "");
	if (!base) return null;
	if (/^tedix$/i.test(base)) return "Tedix";
	return base
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function words(identifier: string): string {
	return identifier
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-.]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function sentence(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function stringArg(
	args: Record<string, unknown> | null | undefined,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

/**
 * The verb phrase for one tool: `work.create_work_items` → `Create work
 * items`; `tedi_146194__run_skill_workflow` → `Run skill`. The namespace
 * before the last dot and a per-tedi `tedi_<n>__` prefix are routing detail.
 */
export function plainToolTitle(
	toolName: string,
	args?: Record<string, unknown> | null,
): string {
	const bare = toolName
		.trim()
		.replace(/^.*[.:]/, "")
		.replace(/^tedi_[0-9a-z]+__/i, "");
	if (/^run_skill(?:_workflow)?$|^start_skill(?:_run)?$/i.test(bare)) {
		const skill = stringArg(args, [
			"skillName",
			"skillTitle",
			"skillSlug",
			"slug",
			"skill",
		]);
		return skill ? `Run skill: ${sentence(words(skill))}` : "Run a skill";
	}
	return sentence(words(bare)) || toolName;
}

const SLUG_TOKEN = /^[\w-]+(?:[.:][\w-]+)+$|^[a-z0-9]+(?:_[a-z0-9]+)+$/i;
const KERNEL_WRITE = /^approve kernel write:\s*(\S+)\s+on\s+(\S+)\s*$/i;
const VERB_SLUG = /^(?:run|approve|call|use)\s+(\S+?)…?$/i;

/** `app:tool` or `tool` from one slug-shaped token. */
function splitSlug(token: string): { app: string | null; tool: string } {
	const colon = token.indexOf(":");
	return colon > 0
		? { app: token.slice(0, colon), tool: token.slice(colon + 1) }
		: { app: null, tool: token };
}

/**
 * The title a person reads for one approval. `title` is the backend title;
 * `payload` supplies the exact tool and app when the request carries them.
 */
export function plainApprovalTitle(
	title: string,
	payload?: {
		toolName?: unknown;
		appSlug?: unknown;
		args?: unknown;
	} | null,
): string {
	// The gateway's retry note ("Nothing has run yet; …", "After deciding in
	// Tedix OS, retry …") is a consequence, not part of the action's name.
	const raw = stripRetryNote(title).trim();
	const args =
		payload?.args && typeof payload.args === "object"
			? (payload.args as Record<string, unknown>)
			: null;
	const withApp = (tool: string, app: string | null) => {
		const action = plainToolTitle(tool, args);
		const label = appLabel(app);
		return label &&
			label !== "Tedix" &&
			!action.toLowerCase().startsWith(label.toLowerCase())
			? `${action} in ${label}`
			: action;
	};
	const kernel = raw.match(KERNEL_WRITE);
	if (kernel?.[1]) return withApp(kernel[1], kernel[2] ?? null);
	const verb = raw.match(VERB_SLUG);
	if (verb?.[1] && SLUG_TOKEN.test(verb[1])) {
		const { app, tool } = splitSlug(verb[1]);
		return withApp(
			tool,
			app ?? (typeof payload?.appSlug === "string" ? payload.appSlug : null),
		);
	}
	if (!raw || SLUG_TOKEN.test(raw)) {
		const { app, tool } = splitSlug(
			raw || (typeof payload?.toolName === "string" ? payload.toolName : ""),
		);
		if (!tool) return title;
		return withApp(
			tool,
			app ?? (typeof payload?.appSlug === "string" ? payload.appSlug : null),
		);
	}
	return raw;
}
