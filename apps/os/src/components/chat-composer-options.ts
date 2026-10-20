/** Composer format choices and slash-command definitions. */
import { OS_COPY } from "@/shared/os-copy";

export const CHAT_FORMATS = OS_COPY.chatFormats;

export const CHAT_SLASH_COMMANDS = [
	{
		command: "/summarize",
		instruction:
			"Summarize the current conversation with decisions, evidence, and next actions.",
	},
	{
		command: "/delegate",
		instruction:
			"Prepare a bounded delegation proposal; do not dispatch without the required approval.",
	},
	{
		command: "/investigate",
		instruction:
			"Investigate this request and cite the evidence supporting each conclusion.",
	},
	{
		command: "/read",
		instruction:
			'Run one explicit read-only MCP tool: /read app.tool {"argument": "value"}',
	},
] as const;
// ---------------------------------------------------------------------------
// ChatThread
// ---------------------------------------------------------------------------
