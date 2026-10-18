import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";

export const TODAY_COLUMNS = [
	"Project",
	"Goal",
	"Progress",
	"Running",
	"Needs you",
	"Project link",
	"Receipts link",
	"Deck link",
];

export function readToday(content: OsOutputContent) {
	if (content.kind !== "document") return null;
	const table = content.blocks.find((b) => b.type === "table");
	const paragraphs = content.blocks.filter((b) => b.type === "paragraph");
	if (
		!table ||
		table.type !== "table" ||
		table.headers.join("|") !== TODAY_COLUMNS.join("|") ||
		paragraphs.length < 3
	)
		return null;
	const rows = table.rows.filter(
		(r) =>
			r.length === TODAY_COLUMNS.length &&
			r
				.slice(5)
				.every(
					(link) =>
						/^\/work(?:\/projects\/|[?#]|$)/.test(link) &&
						!/[\\\u0000-\u0020]/.test(link),
				),
	);
	const receiptsTable = content.blocks.find(
		(b) =>
			b.type === "table" &&
			b.headers.join("|") === "Project|Receipt|Summary|Source|Time",
	);
	const receipts: ActivityFeedItem[] =
		receiptsTable?.type === "table"
			? receiptsTable.rows.flatMap(([projectId, id, sentence, source, at]) => {
					if (
						!projectId ||
						!id ||
						!sentence ||
						!source?.startsWith("/outputs/") ||
						!at ||
						!Number.isFinite(Date.parse(at))
					)
						return [];
					return [
						{
							id: `today-document:${id}`,
							projectId,
							sentence,
							source,
							at,
							actor: "Tedix",
							workItemId: null,
							tediId: null,
							kind: "result",
							classId: "document_updated",
							importance: "normal",
							dueAt: null,
							needsAction: false,
							stalled: false,
							done: true,
							explanation: "A saved document was updated today.",
							reactions: [],
						},
					];
				})
			: [];
	return {
		receipts,
		purpose: paragraphs[0]!.text,
		updated: paragraphs[1]!.text,
		quiet: paragraphs[2]!.text,
		rows,
	};
}

export function todayShortcut(event: KeyboardEvent) {
	const target = event.target;
	return (
		event.key === "t" &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.shiftKey &&
		!(
			target instanceof HTMLElement &&
			(target.isContentEditable ||
				target.closest(
					"input, textarea, select, [role=textbox], [role=combobox]",
				))
		)
	);
}
