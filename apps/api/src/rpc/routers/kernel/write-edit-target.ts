import type { DbClient } from "@tedix/db/client";
import {
	getOsOutput,
	getOsOutputRevision,
	listOsOutputs,
} from "@tedix/db/queries/os-workspaces/outputs";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
	type OsWorkspaceViewer,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { parseDerivedAccessEnvelope } from "../../../services/os-derived-resource-access";

export type WriteWorkspaceContext = {
	workspaceId: string;
	workspaceName: string;
};

const UUID_RE =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const MAX_EDIT_TARGET_CHARS = 12_000;

/** The output kind (document, sheet, presentation) of a read edit target. */
export function editTargetKind(editTarget: string | null): string | null {
	if (!editTarget) return null;
	try {
		const kind = (JSON.parse(editTarget) as { kind?: unknown }).kind;
		return typeof kind === "string" && /^[a-z]+$/.test(kind) ? kind : null;
	} catch {
		return null;
	}
}

/**
 * The output an edit refers to: the selected workpiece, else the first id named
 * in the request or the route's rationale. Without its current body the planner
 * cannot address existing blocks, rows or slides ("add a totals row", "make
 * slide 2 two columns") and either declines or rewrites the whole output.
 * Protected revisions (derived from access-checked sources) are never read here.
 */
export async function readEditTargetOutput(input: {
	db: DbClient;
	organizationId: string;
	/** The member the turn acts for; outputs in others' private workspaces are skipped. */
	viewer: OsWorkspaceViewer;
	workspaceContext?: WriteWorkspaceContext;
	texts: Array<string | null | undefined>;
}): Promise<string | null> {
	const workpiece = (
		input.workspaceContext as
			| { workpiece?: { kind?: unknown; id?: unknown } }
			| undefined
	)?.workpiece;
	const ids = [
		...(workpiece?.kind === "output" && typeof workpiece.id === "string"
			? [workpiece.id]
			: []),
		...input.texts.flatMap((text) => text?.match(UUID_RE) ?? []),
	]
		.map((id) => id.toLowerCase())
		.filter(
			(id, index, all) =>
				all.indexOf(id) === index &&
				id !== input.workspaceContext?.workspaceId?.toLowerCase(),
		)
		.slice(0, 3);
	// A follow-up can name its sheet only by title ("titled "Social cards …"");
	// resolve that against active sheets the member can see, workspace first.
	if (ids.length === 0) {
		const title = input.texts
			.map((text) => text?.match(/\btitled "([^"\n]{1,200})"/)?.[1])
			.find(Boolean);
		if (title) {
			const sheets = await listOsOutputs(
				input.db,
				input.organizationId,
				input.viewer,
				{ kind: "sheet", status: "active", limit: 200 },
			).catch(() => []);
			const named = sheets.filter((row) => row.title.trim() === title.trim());
			const match =
				named.find(
					(row) => row.workspaceId === input.workspaceContext?.workspaceId,
				) ?? (named.length === 1 ? named[0] : undefined);
			if (match) ids.push(match.id);
		}
	}
	for (const outputId of ids) {
		const output = await getOsOutput(input.db, {
			organizationId: input.organizationId,
			outputId,
		}).catch(() => undefined);
		if (!output || output.status !== "active" || !output.currentRevisionId)
			continue;
		if (output.workspaceId) {
			const workspace = await getOsWorkspace(input.db, {
				organizationId: input.organizationId,
				workspaceId: output.workspaceId,
			}).catch(() => undefined);
			if (workspace && !isOsWorkspaceVisibleTo(workspace, input.viewer))
				continue;
		}
		const revision = await getOsOutputRevision(input.db, {
			organizationId: input.organizationId,
			revisionId: output.currentRevisionId,
		}).catch(() => undefined);
		if (!revision || revision.outputId !== output.id) continue;
		const envelope = parseDerivedAccessEnvelope(revision.accessEnvelope);
		if (!envelope || envelope.sources.length > 0) return null;
		return JSON.stringify({
			outputId: output.id,
			kind: output.kind,
			title: output.title,
			revision: revision.revision,
			truncated: revision.content.length > MAX_EDIT_TARGET_CHARS,
			content: revision.content.slice(0, MAX_EDIT_TARGET_CHARS),
		});
	}
	return null;
}

/** A1 notation is one-based; Tedix sheet range arguments index data from zero. */
export function normalizeOsSheetCellAddress(
	content: string,
	toolName: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (
		toolName !== "os.set_os_sheet_range" ||
		!Array.isArray(args.cells) ||
		args.cells.length !== 1 ||
		!Array.isArray(args.cells[0]) ||
		args.cells[0].length !== 1
	)
		return args;
	const match =
		/^(?:please\s+)?(?:update|set|change)\s+(?:the\s+)?cell\s+([a-z]{1,3})([1-9]\d*)\s+(?:to\b|=)/i.exec(
			content.trim(),
		);
	if (!match?.[1] || !match[2]) return args;
	const references = content
		.replace(UUID_RE, "")
		.replace(/"[^"]*"|“[^”]*”/g, "")
		.match(/\b[a-z]{1,3}[1-9]\d*\b/gi);
	if (references?.length !== 1) return args;
	let column = 0;
	for (const letter of match[1].toUpperCase())
		column = column * 26 + letter.charCodeAt(0) - 64;
	return { ...args, startRow: Number(match[2]) - 1, startColumn: column - 1 };
}
