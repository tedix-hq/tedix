import {
	ClockCounterClockwise,
	Detective,
	FileText,
	ListBullets,
	MagnifyingGlass,
	PresentationChart,
	Sparkle,
	Table,
	Users,
} from "@phosphor-icons/react";

import { OS_COPY } from "@/shared/os-copy";

export const CHAT_FORMATS = OS_COPY.chatFormats;

export const CHAT_SLASH_COMMANDS = [
	{
		command: "/summarize",
		icon: ListBullets,
		description: "Recap decisions and next steps.",
		instruction:
			"Summarize the current conversation with decisions, evidence, and next actions.",
	},
	{
		command: "/delegate",
		icon: Users,
		description: "Plan a teammate handoff; approval required.",
		instruction:
			"Prepare a bounded delegation proposal; do not dispatch without the required approval.",
	},
	{
		command: "/investigate",
		icon: Detective,
		description: "Find evidence and explain the findings.",
		instruction:
			"Investigate this request and cite the evidence supporting each conclusion.",
	},
	{
		command: "/read",
		icon: MagnifyingGlass,
		description: "Run one app tool without changing data.",
		instruction:
			'Run one explicit read-only MCP tool: /read app.tool {"argument": "value"}',
	},
] as const;

export const CHAT_CREATE_OPTIONS = {
	Document: {
		icon: FileText,
		description: "Write a document for this request.",
	},
	Spreadsheet: { icon: Table, description: "Organize data in a spreadsheet." },
	Presentation: {
		icon: PresentationChart,
		description: "Turn this request into slides.",
	},
} as const;

const STARTER_ICONS = [FileText, Table, ClockCounterClockwise] as const;

/** Empty-chat starters: an icon, a short title and one line of context. */
export const CHAT_STARTERS = OS_COPY.chatStarterPrompts.map((starter, i) => ({
	...starter,
	icon: STARTER_ICONS[i] ?? Sparkle,
}));

/** A new conversation invites a question or a hand-off; an open thread, a follow-up. */
export function chatComposerPlaceholder(hasMessages: boolean): string {
	return hasMessages
		? OS_COPY.chatComposerPlaceholder.followUp
		: OS_COPY.chatComposerPlaceholder.newConversation;
}
