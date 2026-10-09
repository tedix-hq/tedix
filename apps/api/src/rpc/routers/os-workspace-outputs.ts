import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { findKernelRuntimeRunForOutputRevision } from "@tedix/db/queries/kernel-runtime-runs";
import { resolveKernelConversationAccess } from "../../kernel/conversation-access";
import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsOutput,
	type OsPresentationCanvasSlide,
	type OsPresentationElement,
	type OsPresentationDeck,
	type OsPresentationSlide,
	type OsOutputContent,
	type OsOutputExportFormat,
	type OsOutputKind,
	type OsOutputRevision,
	OS_OUTPUT_EXPORT_FORMAT_KINDS,
	OsOutputContentSchema,
	type OsDerivedAccessEnvelope,
	OsDerivedAccessEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsGadgetExecutionByRunId } from "@tedix/db/queries/os-workspaces/executions";
import {
	createOsOutput,
	createOsOutputRevision,
	getOsOutput,
	getOsOutputRevision,
	listOsOutputRevisions,
	listOsOutputs,
	updateOsOutput,
} from "@tedix/db/queries/os-workspaces/outputs";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/schema/os-workspaces";
import {
	isUsableScreenshot,
	runBrowserQuickAction,
} from "../../integrations/browser-run/client";
import { renderOsOutputHtml } from "../../lib/os-output-html";
import {
	buildOsOutputLibrary,
	mapOsOutputRevisionRow,
	mapOsOutputRow,
} from "../../services/os-output-library";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "../../services/os-derived-resource-access";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	hasTedisReadAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	queryDb,
	requireOutput,
	requireWorkspace,
	revisionConflict,
	resolveCreator,
	resolveProducer,
} from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);

const EMPTY_ACCESS_ENVELOPE = JSON.stringify({ version: 1, sources: [] });

/**
 * Envelope for a revision authored by a governed run.
 *
 * The run row's `resourceAccessEnvelope` is where the API admits workspace
 * resource grants to a background run ("workflow params cannot establish
 * credential authority"), and every credential or resource release to that
 * run requires the envelope to name the source (`credentials-tedi`,
 * `os-workspace-resource-read-authority`). A run this organization knows
 * whose row carries no envelope, and whose Gadget execution carries none,
 * therefore drew on no workspace resource; its faithful envelope is the same
 * empty one a human author gets. Null stays reserved for an unverifiable
 * producer: a run id this organization and environment do not know, or an
 * envelope that no longer parses.
 */
async function resolveRunAccessEnvelope(
	context: BaseContext,
	input: { organizationId: string; skillRunId: string },
): Promise<string | null> {
	const execution = await getOsGadgetExecutionByRunId(queryDb(context), {
		organizationId: input.organizationId,
		runId: input.skillRunId,
	});
	const run = await getSkillRun(
		context.db,
		input.skillRunId,
		input.organizationId,
		context.env.ENVIRONMENT,
	);
	if (!run && !execution) return null;

	try {
		const rawEnvelope =
			run?.resourceAccessEnvelope ??
			(execution?.resourceAccessEnvelope
				? JSON.parse(execution.resourceAccessEnvelope)
				: null);
		if (!rawEnvelope) return run ? EMPTY_ACCESS_ENVELOPE : null;
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(rawEnvelope);
		return parsed.success ? JSON.stringify(parsed.data) : null;
	} catch {
		return null;
	}
}

async function resolveAccessEnvelope(
	context: BaseContext,
): Promise<string | null> {
	const producer = resolveProducer(context);
	if (!producer.skillRunId) return EMPTY_ACCESS_ENVELOPE;
	return resolveRunAccessEnvelope(context, {
		organizationId: requireOrgId(context),
		skillRunId: producer.skillRunId,
	});
}

/**
 * The viewer requirements a stored revision carries. A revision written
 * before run-authored envelopes defaulted to empty holds null next to its
 * `skillRunId`; it is re-derived from the run exactly as a new write would be,
 * so a legacy row is readable precisely when the run it names admitted no
 * source the viewer must hold.
 */
async function resolveRevisionAccessEnvelope(
	context: BaseContext,
	revision: OsOutputRevisionRow,
): Promise<OsDerivedAccessEnvelope | null> {
	const stored = parseDerivedAccessEnvelope(revision.accessEnvelope);
	if (stored || !revision.skillRunId) return stored;
	return parseDerivedAccessEnvelope(
		await resolveRunAccessEnvelope(context, {
			organizationId: revision.organizationId,
			skillRunId: revision.skillRunId,
		}),
	);
}

async function canReadDerivedRevision(
	context: BaseContext,
	revision: OsOutputRevisionRow,
): Promise<boolean> {
	const accessEnvelope = await resolveRevisionAccessEnvelope(context, revision);
	return Boolean(
		accessEnvelope &&
		(await authorizeDerivedOutputSources(context, {
			organizationId: revision.organizationId,
			accessEnvelope,
		})),
	);
}

const outputsList = readOs.outputs.list.handler(async ({ input, context }) => {
	const organizationId = requireOrgId(context);
	const rows = await listOsOutputs(queryDb(context), organizationId, {
		workspaceId: input.workspaceId,
		kind: input.kind,
		status: input.status,
		limit: input.limit + 1,
	});
	return {
		items: rows.slice(0, input.limit).map(mapOsOutputRow),
		truncated: rows.length > input.limit,
	};
});

const outputsLibrary = readOs.outputs.library.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		return buildOsOutputLibrary(queryDb(context), {
			organizationId,
			creator: resolveCreator(context),
			workspaceId: input.workspaceId,
			kind: input.kind,
			status: input.status,
			limit: input.limit,
			canReadRevision: (revision) => canReadDerivedRevision(context, revision),
		});
	},
);

async function requireDerivedRevisionAccess(
	context: BaseContext,
	revision: OsOutputRevisionRow,
): Promise<void> {
	if (!(await canReadDerivedRevision(context, revision))) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Output source access is unavailable",
		);
	}
}

/**
 * The empty body for a kind, used when a caller creates an artifact without
 * one.
 *
 * `content` used to be required, and that made the tool unusable from a chat
 * turn: its schema is a four-way discriminated union of nested block unions,
 * ~10KB projected, and a model asked to create a document would emit the
 * scalars and drop the one field it could not hold. The platform then refused
 * the whole call, so the commonest request a workspace gets -- "make me a
 * doc" -- failed at the first step while the identical call with a hand-built
 * body succeeded.
 *
 * An empty document, sheet, or presentation is a real artifact: it is what the
 * product creates when a person clicks New, and the granular tools
 * (patchDocument, setSheetRange) exist precisely to fill one. A VIDEO has no
 * empty form -- without a renderId it names nothing -- so it keeps its body
 * requirement and says why.
 */
function emptyOutputContent(kind: OsOutputKind): OsOutputContent {
	switch (kind) {
		case "document":
			return { kind: "document", blocks: [] };
		case "sheet":
			return { kind: "sheet", columns: [], rows: [] };
		case "presentation":
			return { kind: "presentation", slides: [] };
		case "video":
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"A video output needs an explicit content body naming its renderId; there is no empty video to create.",
			);
	}
}

const outputsCreate = authorOs.outputs.create.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const content = input.content ?? emptyOutputContent(input.kind);
		if (content.kind !== input.kind) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Content body is ${content.kind} but the output is declared ${input.kind}`,
			);
		}
		if (input.workspaceId) {
			await requireWorkspace(context, input.workspaceId);
		}
		const creator = resolveCreator(context);
		const accessEnvelope = await resolveAccessEnvelope(context);
		const now = new Date().toISOString();
		const outputId = crypto.randomUUID();
		const revisionId = crypto.randomUUID();
		const accountability = {
			organizationId,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: now,
		};
		const created = await createOsOutput(
			queryDb(context),
			{
				...accountability,
				id: outputId,
				workspaceId: input.workspaceId ?? null,
				kind: input.kind,
				title: input.title,
				status: "active",
				currentRevisionId: revisionId,
				updatedAt: now,
			},
			{
				...accountability,
				id: revisionId,
				outputId,
				revision: 1,
				content: JSON.stringify(content),
				note: input.note ?? null,
				...resolveProducer(context),
				accessEnvelope,
			},
		);
		return {
			output: mapOsOutputRow(created.output),
			revision: mapOsOutputRevisionRow(created.revision),
		};
	},
);

const outputsGet = readOs.outputs.get.handler(async ({ input, context }) => {
	const output = await requireOutput(context, input.outputId);
	const mapped = mapOsOutputRow(output);
	const currentRevision = await getOsOutputRevision(queryDb(context), {
		organizationId: output.organizationId,
		revisionId: mapped.currentRevisionId,
	});
	if (!currentRevision) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"OS output current revision was not readable",
		);
	}
	await requireDerivedRevisionAccess(context, currentRevision);
	const candidate = hasTedisReadAuthorization(context)
		? await findKernelRuntimeRunForOutputRevision(queryDb(context), {
				organizationId: output.organizationId,
				outputId: output.id,
				revisionId: currentRevision.id,
			})
		: null;
	const access = candidate
		? await resolveKernelConversationAccess(context.db, {
				organizationId: output.organizationId,
				conversationId: candidate.conversationId,
				descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
				required: "read",
			})
		: null;
	return {
		output: mapped,
		currentRevision: mapOsOutputRevisionRow(currentRevision),
		authoringHomeRun:
			candidate && access?.allowed ? { runId: candidate.id } : null,
	};
});

const outputsRename = authorOs.outputs.rename.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		const row = await updateOsOutput(
			queryDb(context),
			{ organizationId: output.organizationId, outputId: output.id },
			{ title: input.title },
		);
		if (!row) throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		return { output: mapOsOutputRow(row) };
	},
);

const outputsRevise = authorOs.outputs.revise.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		await requireCurrentOutputRevision(context, output);
		if (input.content.kind !== output.kind) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Content body is ${input.content.kind} but the output is ${output.kind}`,
			);
		}
		const creator = resolveCreator(context);
		const accessEnvelope = await resolveAccessEnvelope(context);
		const db = queryDb(context);
		const result = await createOsOutputRevision(db, {
			id: crypto.randomUUID(),
			organizationId: output.organizationId,
			outputId: output.id,
			content: JSON.stringify(input.content),
			note: input.note ?? null,
			createdByKind: creator.kind,
			createdById: creator.id,
			...resolveProducer(context),
			accessEnvelope,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) {
			if (result.reason === "output_not_found") {
				throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
			}
			const [latest] = await listOsOutputRevisions(
				db,
				{ organizationId: output.organizationId, outputId: output.id },
				{ limit: 1 },
			);
			throw revisionConflict(
				"Output",
				input.expectedRevision ?? 0,
				latest?.revision ?? null,
			);
		}
		const advanced = await getOsOutput(db, {
			organizationId: output.organizationId,
			outputId: output.id,
		});
		return {
			output: mapOsOutputRow(advanced ?? output),
			revision: mapOsOutputRevisionRow(result.revision),
		};
	},
);

const outputsArchive = authorOs.outputs.archive.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		const row = await updateOsOutput(
			queryDb(context),
			{ organizationId: output.organizationId, outputId: output.id },
			{ status: "archived" },
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		}
		return { output: mapOsOutputRow(row) };
	},
);

/** Load the revision an output's current pointer names, or fail loudly. */
async function requireCurrentOutputRevision(
	context: BaseContext,
	output: OsOutputRow,
): Promise<OsOutputRevisionRow> {
	const revision = output.currentRevisionId
		? await getOsOutputRevision(queryDb(context), {
				organizationId: output.organizationId,
				revisionId: output.currentRevisionId,
			})
		: undefined;
	if (!revision) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"OS output current revision was not readable",
		);
	}
	await requireDerivedRevisionAccess(context, revision);
	return revision;
}

/**
 * Persist a server-side-edited body as the next revision. The edit was applied
 * against `baseRevision`'s content, so the write is always CAS-fenced on it —
 * even when the caller sent no expectedRevision, a concurrent revision write
 * loses the swap instead of silently dropping that write's content.
 */
async function persistEditedOutputRevision(
	context: BaseContext,
	output: OsOutputRow,
	baseRevision: number,
	content: OsOutputContent,
	note: string | undefined,
): Promise<{ output: OsOutput; revision: OsOutputRevision }> {
	const creator = resolveCreator(context);
	const accessEnvelope = await resolveAccessEnvelope(context);
	const db = queryDb(context);
	const result = await createOsOutputRevision(db, {
		id: crypto.randomUUID(),
		organizationId: output.organizationId,
		outputId: output.id,
		content: JSON.stringify(content),
		note: note ?? null,
		createdByKind: creator.kind,
		createdById: creator.id,
		...resolveProducer(context),
		accessEnvelope,
		expectedRevision: baseRevision,
	});
	if (!result.ok) {
		if (result.reason === "output_not_found") {
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		}
		const [latest] = await listOsOutputRevisions(
			db,
			{ organizationId: output.organizationId, outputId: output.id },
			{ limit: 1 },
		);
		throw revisionConflict("Output", baseRevision, latest?.revision ?? null);
	}
	const advanced = await getOsOutput(db, {
		organizationId: output.organizationId,
		outputId: output.id,
	});
	return {
		output: mapOsOutputRow(advanced ?? output),
		revision: mapOsOutputRevisionRow(result.revision),
	};
}

/**
 * Slide patching keeps the visual deck and its semantic projection consistent.
 *
 * A presentation body carries `slides` (the headless outline) and an optional
 * `deck` (the 1200x675 canvas that is actually rendered). The schema is explicit
 * that the deck is primary and `slides` is "its semantic/headless projection",
 * so patching the projection and dropping the deck would delete every author's
 * layout. These helpers instead patch the deck and re-derive the projection, so
 * a patch is never destructive and a deckless presentation gains one.
 */
const SLIDE_TITLE_ID = () => `title-${crypto.randomUUID()}`;
const SLIDE_BULLET_ID = () => `bullet-${crypto.randomUUID()}`;

type SlideOutline = { title: string; bullets: string[]; notes?: string };

/** Lay out one canvas slide from an outline, in the deck's own coordinates. */
function canvasSlideFromOutline(
	outline: SlideOutline,
): OsPresentationCanvasSlide {
	const elements: OsPresentationElement[] = [
		{
			id: SLIDE_TITLE_ID(),
			type: "title",
			x: 72,
			y: 72,
			width: 1_056,
			height: 96,
			text: outline.title,
			style: { fontSize: 44, fontWeight: "semibold" },
		},
	];
	if (outline.bullets.length > 0) {
		elements.push({
			id: SLIDE_BULLET_ID(),
			type: "bullet",
			x: 72,
			y: 200,
			width: 1_056,
			height: 380,
			text: outline.bullets.join("\n"),
			style: { fontSize: 24 },
		});
	}
	return {
		id: `slide-${crypto.randomUUID()}`,
		name: outline.title.slice(0, 200),
		layout: outline.bullets.length > 0 ? "title-content" : "title",
		background: "#ffffff",
		elements,
		...(outline.notes ? { notes: outline.notes } : {}),
	};
}

/**
 * Rewrite an existing canvas slide from an outline, preserving its identity,
 * background and layout so a replace does not reset the author's styling.
 */
function applyOutlineToCanvasSlide(
	slide: OsPresentationCanvasSlide,
	outline: SlideOutline,
): OsPresentationCanvasSlide {
	const rebuilt = canvasSlideFromOutline(outline);
	return {
		...slide,
		name: outline.title.slice(0, 200),
		elements: rebuilt.elements,
		...(outline.notes ? { notes: outline.notes } : { notes: undefined }),
	};
}

/** The semantic projection of a deck, mirroring the client's `projectDeck`. */
function projectDeckToSlides(deck: OsPresentationDeck): OsPresentationSlide[] {
	return deck.slides.map((slide) => {
		const ordered = [...slide.elements].sort((a, b) => a.y - b.y || a.x - b.x);
		const title =
			ordered.find((element) => element.type === "title")?.text ?? slide.name;
		const bullets = ordered
			.filter((element) => element.type === "bullet")
			.flatMap((element) => (element.text ?? "").split("\n"))
			.map((item) => item.trim())
			.filter(Boolean)
			.slice(0, 30);
		return {
			title: title.slice(0, 300),
			bullets,
			...(slide.notes ? { notes: slide.notes } : {}),
		};
	});
}

/** Build a deck from a body that only ever had the outline. */
function deckFromSlides(slides: OsPresentationSlide[]): OsPresentationDeck {
	const canvas = slides.map((slide) =>
		canvasSlideFromOutline({
			title: slide.title,
			bullets: slide.bullets,
			...(slide.notes ? { notes: slide.notes } : {}),
		}),
	);
	return {
		width: 1_200,
		height: 675,
		activeSlideId: canvas[0]?.id ?? `slide-${crypto.randomUUID()}`,
		slides: canvas,
	};
}

const outputsPatchSlides = authorOs.outputs.patchSlides.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		if (output.kind !== "presentation") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`outputs.patchSlides edits presentations; this output is a ${output.kind}`,
			);
		}
		const base = await requireCurrentOutputRevision(context, output);
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== base.revision
		) {
			throw revisionConflict("Output", input.expectedRevision, base.revision);
		}
		const content = OsOutputContentSchema.parse(JSON.parse(base.content));
		if (content.kind !== "presentation") {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Presentation output carries a non-presentation current revision body",
			);
		}
		const deck = content.deck ?? deckFromSlides(content.slides);
		const slides = [...deck.slides];
		for (const [position, op] of input.ops.entries()) {
			const limit = op.op === "insert" ? slides.length : slides.length - 1;
			const index = op.op === "move" ? op.from : op.index;
			if (index > limit || (op.op === "move" && op.to > slides.length - 1)) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`ops[${position}]: ${op.op} index ${index} is out of range (the deck holds ${slides.length} slides at that step)`,
				);
			}
			if (op.op === "insert") {
				slides.splice(op.index, 0, canvasSlideFromOutline(op.slide));
			} else if (op.op === "replace") {
				const existing = slides[op.index];
				if (existing) {
					slides[op.index] = applyOutlineToCanvasSlide(existing, op.slide);
				}
			} else if (op.op === "delete") {
				slides.splice(op.index, 1);
			} else {
				const [moved] = slides.splice(op.from, 1);
				if (moved) slides.splice(op.to, 0, moved);
			}
		}
		const activeSlideId = slides.some(
			(slide) => slide.id === deck.activeSlideId,
		)
			? deck.activeSlideId
			: (slides[0]?.id ?? deck.activeSlideId);
		const nextDeck: OsPresentationDeck = { ...deck, slides, activeSlideId };
		const next = OsOutputContentSchema.safeParse({
			kind: "presentation",
			slides: projectDeckToSlides(nextDeck),
			deck: nextDeck,
		});
		if (!next.success) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Patched presentation violates the content schema: ${next.error.issues[0]?.message ?? "invalid"}`,
			);
		}
		return persistEditedOutputRevision(
			context,
			output,
			base.revision,
			next.data,
			input.note,
		);
	},
);

const outputsPatchDocument = authorOs.outputs.patchDocument.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		if (output.kind !== "document") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`outputs.patchDocument edits documents; this output is a ${output.kind}`,
			);
		}
		const base = await requireCurrentOutputRevision(context, output);
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== base.revision
		) {
			throw revisionConflict("Output", input.expectedRevision, base.revision);
		}
		const content = OsOutputContentSchema.parse(JSON.parse(base.content));
		if (content.kind !== "document") {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Document output carries a non-document current revision body",
			);
		}
		const blocks = [...content.blocks];
		for (const [position, op] of input.ops.entries()) {
			const limit = op.op === "insert" ? blocks.length : blocks.length - 1;
			if (op.index > limit) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`ops[${position}]: ${op.op} index ${op.index} is out of range (the list holds ${blocks.length} blocks at that step)`,
				);
			}
			if (op.op === "insert") {
				blocks.splice(op.index, 0, op.block);
			} else if (op.op === "replace") {
				blocks[op.index] = op.block;
			} else {
				blocks.splice(op.index, 1);
			}
		}
		const next = OsOutputContentSchema.safeParse({
			kind: "document",
			blocks,
		});
		if (!next.success) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Patched document violates the content schema: ${next.error.issues[0]?.message ?? "invalid"}`,
			);
		}
		return persistEditedOutputRevision(
			context,
			output,
			base.revision,
			next.data,
			input.note,
		);
	},
);

/** Wire-schema sheet bound the range write must respect when extending rows. */
const SHEET_ROW_CAP = 1_000;

const outputsSetSheetRange = authorOs.outputs.setSheetRange.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		if (output.kind !== "sheet") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`outputs.setSheetRange edits sheets; this output is a ${output.kind}`,
			);
		}
		const base = await requireCurrentOutputRevision(context, output);
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== base.revision
		) {
			throw revisionConflict("Output", input.expectedRevision, base.revision);
		}
		const content = OsOutputContentSchema.parse(JSON.parse(base.content));
		if (content.kind !== "sheet") {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Sheet output carries a non-sheet current revision body",
			);
		}
		const columnCount = content.columns.length;
		const width = Math.max(...input.cells.map((row) => row.length));
		if (input.startColumn + width > columnCount) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`The rectangle spans columns ${input.startColumn}..${input.startColumn + width - 1} but the sheet has ${columnCount} columns; columns are added by editors, not by range writes`,
			);
		}
		const endRow = input.startRow + input.cells.length;
		if (endRow > SHEET_ROW_CAP) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`The rectangle ends at row ${endRow}, beyond the ${SHEET_ROW_CAP}-row sheet cap`,
			);
		}
		const rows = content.rows.map((row) => [...row]);
		while (rows.length < endRow) {
			rows.push(Array.from({ length: columnCount }, () => null));
		}
		for (const [rowOffset, sourceRow] of input.cells.entries()) {
			const target = rows[input.startRow + rowOffset]!;
			while (target.length < input.startColumn) target.push(null);
			for (const [columnOffset, cell] of sourceRow.entries()) {
				target[input.startColumn + columnOffset] = cell;
			}
		}
		const workbook = content.workbook
			? {
					...content.workbook,
					sheets: content.workbook.sheets.map((sheet) => {
						if (sheet.id !== content.workbook?.activeSheetId) return sheet;
						const richRows = sheet.rows.map((row) => [...row]);
						while (richRows.length < endRow) {
							richRows.push(
								Array.from({ length: sheet.columns.length }, () => ({
									input: "",
									value: null,
								})),
							);
						}
						for (const [rowOffset, sourceRow] of input.cells.entries()) {
							const target = richRows[input.startRow + rowOffset]!;
							while (target.length < input.startColumn) {
								target.push({ input: "", value: null });
							}
							for (const [columnOffset, cell] of sourceRow.entries()) {
								const index = input.startColumn + columnOffset;
								const previous = target[index];
								target[index] = {
									input: cell === null ? "" : String(cell),
									value: cell,
									...(previous?.format ? { format: previous.format } : {}),
								};
							}
						}
						return { ...sheet, rows: richRows };
					}),
				}
			: undefined;
		const next = OsOutputContentSchema.safeParse({
			kind: "sheet",
			columns: content.columns,
			rows,
			...(workbook ? { workbook } : {}),
		});
		if (!next.success) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`The written sheet violates the content schema: ${next.error.issues[0]?.message ?? "invalid"}`,
			);
		}
		return persistEditedOutputRevision(
			context,
			output,
			base.revision,
			next.data,
			input.note,
		);
	},
);

const EXPORT_CONTENT_TYPES = {
	pdf: "application/pdf",
	png: "image/png",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const satisfies Record<OsOutputExportFormat, string>;

/**
 * Print or photograph the output through Browser Rendering. Only `pdf` and
 * `png` come through here: they are renderings of a laid-out page, and that
 * layout is exactly what an Office file must not be made of.
 */
async function renderExportBytes(
	context: BaseContext,
	output: OsOutputRow,
	revision: OsOutputRevision,
	format: "pdf" | "png",
): Promise<Uint8Array> {
	if (!context.env.BROWSER) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Output export requires Browser Rendering; the BROWSER binding is not configured",
		);
	}
	const html = renderOsOutputHtml(mapOsOutputRow(output), revision);
	const response = await runBrowserQuickAction(
		context.env.BROWSER,
		format === "pdf" ? "pdf" : "screenshot",
		{ html },
	);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (format === "png") {
		const responseType =
			response.headers.get("content-type") ?? EXPORT_CONTENT_TYPES.png;
		if (!isUsableScreenshot(bytes, responseType)) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				`Browser Rendering returned an unusable image (${responseType}, ${bytes.byteLength} bytes)`,
			);
		}
	} else if (bytes.byteLength === 0) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Browser Rendering returned an empty PDF",
		);
	}
	return bytes;
}

const outputsExport = authorOs.outputs.export.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		// The kind gate runs before anything else is loaded or rendered: a
		// `.pptx` of a spreadsheet is not a degraded export, it is a category
		// error, and hiding the button in one client is not a refusal.
		const applicableKinds: readonly OsOutputKind[] =
			OS_OUTPUT_EXPORT_FORMAT_KINDS[input.format];
		if (!applicableKinds.includes(output.kind)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`${input.format} export applies to ${applicableKinds.join(", ")} outputs; this output is a ${output.kind}`,
			);
		}
		const revisionRow = await requireCurrentOutputRevision(context, output);
		const revision = mapOsOutputRevisionRow(revisionRow);
		let bytes: Uint8Array;
		if (input.format === "pdf" || input.format === "png") {
			bytes = await renderExportBytes(context, output, revision, input.format);
		} else {
			// Deferred so the OOXML writers stay off the router's import graph
			// until an Office export is actually asked for.
			const { buildOsOutputOfficeExport } =
				await import("../../lib/os-output-office");
			bytes = await buildOsOutputOfficeExport(
				input.format,
				revision.content,
				output.title,
			);
		}
		const key = `os-exports/${output.organizationId}/${output.id}/rev-${revision.revision}.${input.format}`;
		await context.env.R2_BUCKET.put(key, bytes, {
			httpMetadata: { contentType: EXPORT_CONTENT_TYPES[input.format] },
			customMetadata: {
				organizationId: output.organizationId,
				outputId: output.id,
				revision: String(revision.revision),
				exportedAt: new Date().toISOString(),
			},
		});
		return {
			key,
			format: input.format,
			revision: revision.revision,
			sizeBytes: bytes.byteLength,
			// Built on the configured public origin, never the request URL: a
			// service-binding or OS-proxy call arrives as `https://api/...`,
			// which no browser can open.
			url: new URL(
				`/os-exports/${output.id}/rev-${revision.revision}.${input.format}`,
				context.env.API_URL,
			).toString(),
		};
	},
);

export const osOutputProcedures = {
	list: outputsList,
	library: outputsLibrary,
	create: outputsCreate,
	get: outputsGet,
	rename: outputsRename,
	revise: outputsRevise,
	patchDocument: outputsPatchDocument,
	patchSlides: outputsPatchSlides,
	setSheetRange: outputsSetSheetRange,
	export: outputsExport,
	archive: outputsArchive,
};
