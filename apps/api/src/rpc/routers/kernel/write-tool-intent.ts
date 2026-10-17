import type { McpTool } from "./write-tool-policy";

/** In-place edits of an existing Tedix output. */
export const OUTPUT_EDIT_CAPABILITY_RE =
	/^(?:documents\.patch|sheets\.set_range|presentations\.patch)$/;

/** Capabilities a Tedix output (document, sheet or presentation) satisfies. */
const OUTPUT_CREATE_CAPABILITY_RE =
	/^(?:documents?|docs?|sheets?|spreadsheets?|presentations?|slides?|decks?|outputs?)\.create$/;
/** A generic create the router emits for a Tedix artifact ("content.create"). */
const GENERIC_CREATE_CAPABILITY_RE =
	/^(?:content|artifacts?|workspace_artifacts?|workpieces?)\.create$/;
/** The request itself names a document, sheet or presentation. */
const OUTPUT_KIND_RE =
	/\b(?:doc|docs|document|sheet|spreadsheet|deck|slides?|presentation)\b/i;
/** An operator who names an external office suite wants that provider. */
export const EXTERNAL_OFFICE_PROVIDER_RE =
	/\b(?:google|gdrive|notion|excel|microsoft|powerpoint|keynote|office ?365|onedrive|sharepoint|airtable|dropbox|canva|figma)\b/i;

/** Answering a handoff, question or proposal addressed to the operator. */
const WORK_REQUEST_RESPOND_CAPABILITY_RE =
	/^(?:work_)?(?:interactions?|requests?|proposals?|handoffs?)\.(?:respond|accept|decline|answer|reply|resolve)$/;
const WORK_REQUEST_RESPOND_RE =
	/\b(?:accept|decline|answer|respond to|reply to)\b[^\n]*\b(?:proposal|handoff|hand-off|interaction|invitation|work request)\b/i;

/** "Rename this conversation" routes as `conversations.update`. */
const CONVERSATION_RENAME_CAPABILITY_RE =
	/^(?:conversations?|chats?|threads?)\.(?:update|rename)$/;
const RENAME_REQUEST_RE = /\b(?:re-?name|re-?title|call it|title it)\b/i;
/** "Rename this conversation to X" — routed as conversations.update, or (from a
 * workspace) as an output update. The current conversation is the target. */
const RENAME_THIS_CONVERSATION_RE =
	/\b(?:re-?name|re-?title)\s+(?:this|the|current|our)\s+(?:conversation|chat|thread)\s+(?:to|as)\s+([^\n]+)/i;

/**
 * Arguments for renaming the current conversation, read straight from the
 * request. The title is everything after "to", without wrapping quotes or a
 * final period. Null when the request does not have that exact shape.
 */
export function renameThisConversationArgs(
	content: string,
	conversationId: string | undefined,
): { conversationId: string; title: string } | null {
	if (!conversationId) return null;
	// The title ends at the line end: the CLI appends a "Local terminal
	// context:" block after the request.
	const match = RENAME_THIS_CONVERSATION_RE.exec(content.trim());
	const title = match?.[1]
		?.trim()
		.replace(/\.$/, "")
		.replace(/^["“'‘](.*)["”'’]$/, "$1")
		.trim();
	return title && title.length <= 200 ? { conversationId, title } : null;
}

/**
 * The one canonical write primitive for a routed capability, when there is
 * one. A name without a namespace matches any callable ending in `.<name>`.
 */
export const CREATE_OUTPUT_TOOL = "os.create_os_output";

/**
 * Some routed capabilities have one canonical, contract-owned write primitive.
 * Selecting that exact primitive is stronger than asking Jev to re-infer the
 * action from neighboring catalog tools. The batch installer intentionally
 * accepts one or many queries, so it is the single canonical implementation of
 * `catalog.install` regardless of how many product names the operator supplied.
 */
export function canonicalWriteToolName(
	capability: string | null | undefined,
	content = "",
): string | null {
	// "Create a sheet" with no named provider is a Tedix output, not a file in
	// whichever connected drive Jev happens to rank first.
	if (
		capability &&
		(OUTPUT_CREATE_CAPABILITY_RE.test(capability) ||
			(GENERIC_CREATE_CAPABILITY_RE.test(capability) &&
				OUTPUT_KIND_RE.test(content))) &&
		!EXTERNAL_OFFICE_PROVIDER_RE.test(content)
	) {
		return CREATE_OUTPUT_TOOL;
	}
	if (!EXTERNAL_OFFICE_PROVIDER_RE.test(content)) {
		if (capability === "documents.patch") return "os.patch_os_document";
		if (capability === "sheets.set_range") return "os.set_os_sheet_range";
		if (capability === "presentations.patch") return "os.patch_os_slides";
	}
	if (capability === "factories.create") return "projects.create_factory";
	if (capability === "factories.pause") return "projects.pause_factory";
	if (capability === "factories.resume") return "projects.resume_factory";
	if (capability === "factories.archive") return "projects.archive_factory";
	if (capability === "factories.run") return "skills.run_workflow";
	if (capability === "work_items.create") return "work.create_work_items";
	if (
		(capability && WORK_REQUEST_RESPOND_CAPABILITY_RE.test(capability)) ||
		WORK_REQUEST_RESPOND_RE.test(content)
	)
		return "respond_work_interaction";
	if (capability === "catalog.install") return "tenant.install_tenant_mcp_apps";
	if (
		(capability &&
			CONVERSATION_RENAME_CAPABILITY_RE.test(capability) &&
			RENAME_REQUEST_RE.test(content)) ||
		RENAME_THIS_CONVERSATION_RE.test(content.trim())
	) {
		return "rename_conversation";
	}
	return null;
}

export function matchesCanonicalWriteTool(
	toolName: string,
	canonical: string,
): boolean {
	return canonical.includes(".")
		? toolName === canonical
		: toolName.endsWith(`.${canonical}`);
}

export function preferredToolForCapability(
	tools: McpTool[],
	capability: string | null | undefined,
	content = "",
): McpTool | null {
	const canonical = canonicalWriteToolName(capability, content);
	if (!canonical) return null;
	return (
		tools.find((tool) => matchesCanonicalWriteTool(tool.name, canonical)) ??
		null
	);
}
