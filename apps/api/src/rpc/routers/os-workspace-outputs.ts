import { OS_SHEET_MAX_ROWS } from "@tedix/api-contract/utils/os-output-limits";
import {
	applyPresentationPatch,
	projectPresentationDeck,
} from "@tedix/api-contract/utils/presentation-patch";
import { applyDocumentBlockPatch } from "@tedix/api-contract/utils/document-patch";
import {
	blocksFromRichText,
	normalizeDocumentContent,
	normalizeOsOutputInput,
} from "@tedix/api-contract/utils/os-document";
import {
	applyOutputPatch,
	diffOutputContent,
	OutputPatchError,
} from "@tedix/api-contract/utils/output-patch";
import { applySheetRange } from "@tedix/api-contract/utils/sheet-range";
import { mergeOutputContent } from "@tedix/api-contract/utils/output-merge";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import {
	getOrganizationProfile,
	getOrganizationOsTheme,
} from "@tedix/db/queries/organizations";
import type { PresentationAppearance } from "@tedix/api-contract/utils/presentation-style";
import { findKernelRuntimeRunForOutputRevision } from "@tedix/db/queries/kernel-runtime-runs";
import { resolveKernelConversationAccess } from "../../kernel/conversation-access";
import { implement, ORPCError } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsOutput,
	type OsOutputContent,
	type OsOutputExportFormat,
	type OsOutputKind,
	type OsOutputRevision,
	type OsRichTextNode,
	OS_OUTPUT_EXPORT_FORMAT_KINDS,
	OsOutputContentSchema,
	type OsDerivedAccessEnvelope,
	OsDerivedAccessEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsGadgetExecutionByRunId } from "@tedix/db/queries/os-workspaces/executions";
import {
	getOsOutput,
	moveOsOutput,
	listOsOutputRevisions,
	listOsOutputs,
	updateOsOutput,
} from "../../services/workspace-output-storage";
import {
	createOsOutput,
	createOsOutputRevision,
	getOsOutputRevision,
	getOsOutputRevisionByNumber,
} from "../../services/os-workspace-outputs";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/schema/os-workspaces";
import {
	isUsableScreenshot,
	runBrowserQuickAction,
} from "../../integrations/browser-run/client";
import {
	fetchOsExportImage,
	inlineOsExportImages,
	inlineOsOutputAssets,
	type OsExportAssetReader,
} from "../../lib/os-export-images";
import { outputAssetDigest } from "@tedix/api-contract/utils/os-output-assets";
import {
	outputAssetReader,
	readOutputAsset,
	storeOutputAsset,
} from "../../services/os-output-assets";
import {
	OS_EXPORT_RESOURCE_WAIT,
	renderOsOutputHtml,
} from "../../lib/os-output-html";
import {
	buildOsOutputLibrary,
	mapOsOutputRevisionRow,
	mapOsOutputRevisionMetadata,
	mapOsOutputRow,
} from "../../services/os-output-library";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "../../services/os-derived-resource-access";
import { attachOutputEditor } from "../../services/os-output-editor";
import { requireOrgId } from "../org-scope";
import {
	outputMetadataChange,
	publishWorkspaceChangeSafely,
} from "../../services/workspace-feed";
import {
	AUTHZ,
	hasTedisReadAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import { resolveOsWorkspaceViewer } from "../../services/os-workspace-visibility";
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
	revision: Omit<OsOutputRevisionRow, "content">,
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
	revision: Omit<OsOutputRevisionRow, "content">,
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
	let mark = Date.now();
	const lap = (name: string) => {
		const now = Date.now();
		context.serverTiming?.push(`${name};dur=${now - mark}`);
		mark = now;
	};
	if (input.workspaceId) await requireWorkspace(context, input.workspaceId);
	lap("workspace");
	const viewer = await resolveOsWorkspaceViewer(context);
	lap("viewer");
	const rows = await listOsOutputs(
		queryDb(context),
		{ workspaceId: input.workspaceId, organizationId: organizationId },
		viewer,
		{
			kind: input.kind,
			status: input.status,
			limit: input.limit + 1,
		},
	);
	lap("query");
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
			viewer: await resolveOsWorkspaceViewer(context),
			creator: resolveCreator(context),
			workspaceId: input.workspaceId,
			kind: input.kind,
			status: input.status,
			search: input.search,
			limit: input.limit,
			canReadRevision: (revision) => canReadDerivedRevision(context, revision),
		});
	},
);

async function requireDerivedRevisionAccess(
	context: BaseContext,
	revision: Omit<OsOutputRevisionRow, "content">,
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

function normalizeOutputBody(input: OsOutputContent | string): OsOutputContent {
	const parsed = OsOutputContentSchema.safeParse(normalizeOsOutputInput(input));
	if (!parsed.success)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Document content exceeds the output schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
		);
	return parsed.data;
}

const outputsCreate = authorOs.outputs.create.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const content = normalizeOutputBody(
			input.content ?? emptyOutputContent(input.kind),
		);
		if (content.kind !== input.kind) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Content body is ${content.kind} but the output is declared ${input.kind}`,
			);
		}
		if (input.workspaceId) {
			await requireWorkspace(context, input.workspaceId);
		} else if (context.externalAgentPrincipalId) {
			// Coding agents left Outputs in no workspace and had to recreate them
			// to regroup; they must say where an Output belongs.
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"workspaceId is required when an agent creates an output",
			);
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
		// Every creator (people, agents, tedis, skills) lands here; the output
		// opens in its reusable editor gadget from the first read.
		await attachOutputEditor(context, created.output);
		return {
			output: mapOsOutputRow(created.output),
			revision: mapOsOutputRevisionRow(created.revision),
		};
	},
);

const outputsHistory = readOs.outputs.history.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		const scope = {
			organizationId: output.organizationId,
			outputId: output.id,
		};
		const exact = input.revision
			? await getOsOutputRevisionByNumber(queryDb(context), {
					...scope,
					revision: input.revision,
				})
			: null;
		const rows = input.revision
			? exact
				? [exact]
				: []
			: await listOsOutputRevisions(queryDb(context), scope, {
					limit: 50,
					beforeRevision: input.beforeRevision,
				});
		for (const revision of rows)
			await requireDerivedRevisionAccess(context, revision);
		const { factoryCardRevisionRequests } =
			await import("../../services/factory-card-revisions");
		const newest =
			output.kind === "sheet" &&
			!input.revision &&
			!input.beforeRevision &&
			rows[0]
				? await getOsOutputRevision(queryDb(context), {
						organizationId: output.organizationId,
						revisionId: rows[0].id,
					})
				: null;
		const pending = newest
			? await factoryCardRevisionRequests(
					context,
					mapOsOutputRevisionRow(newest),
				)
			: [];
		return {
			revisions: exact
				? [mapOsOutputRevisionRow(exact)]
				: rows.map(mapOsOutputRevisionMetadata),
			nextBeforeRevision:
				!input.revision && rows.length === 50 ? rows.at(-1)!.revision : null,
			pending,
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

/** Publish a metadata-only change (rename, move, archive, restore) for the current revision. */
async function publishOutputMetadataChange(
	context: BaseContext,
	row: OsOutputRow,
): Promise<void> {
	const db = queryDb(context);
	const [current] = await listOsOutputRevisions(
		db,
		{ organizationId: row.organizationId, outputId: row.id },
		{ limit: 1 },
	);
	if (!current) return;
	await publishWorkspaceChangeSafely(
		{ db, queue: context.env.AUTOMATION_EVENTS },
		outputMetadataChange(row, current, resolveCreator(context)),
	);
}

const outputsRename = authorOs.outputs.rename.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		const row = await updateOsOutput(
			queryDb(context),
			{ organizationId: output.organizationId, outputId: output.id },
			{ title: input.title },
		);
		if (!row) throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		await publishOutputMetadataChange(context, row);
		return { output: mapOsOutputRow(row) };
	},
);

const outputsMove = authorOs.outputs.move.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		const target = await requireWorkspace(context, input.workspaceId);
		if (output.workspaceId === target.id)
			return { output: mapOsOutputRow(output), previousWorkspaceId: target.id };
		let moved;
		try {
			moved = await moveOsOutput(queryDb(context), output, target.id);
		} catch (error) {
			console.error("OS output transfer pending", error);
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Output transfer could not finish. Read the output again before retrying.",
			);
		}
		if (!moved.ok && moved.reason === "not_found")
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		if (!moved.ok)
			throw createError(
				ErrorCodes.CONFLICT,
				"Output transfer already in progress",
			);
		const row = moved.output;
		await publishOutputMetadataChange(context, row);
		// Editor bindings are per workspace; the target needs its own.
		await attachOutputEditor(context, row);
		return {
			output: mapOsOutputRow(row),
			previousWorkspaceId: output.workspaceId,
		};
	},
);

const outputsRevise = authorOs.outputs.revise.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		if (
			input.expectedWorkspaceId !== undefined &&
			input.expectedWorkspaceId !== output.workspaceId
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"This file moved to another workspace. Reopen it before saving.",
			);
		const base = await requireCurrentOutputRevision(context, output);
		if (input.expectedRevisionId && input.expectedRevisionId !== base.id)
			throw revisionConflict(
				"Output",
				input.expectedRevision ?? 0,
				base.revision,
			);
		let content = normalizeOutputBody(input.content);
		if (content.kind !== output.kind) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Content body is ${content.kind} but the output is ${output.kind}`,
			);
		}
		const creator = resolveCreator(context);
		const accessEnvelope = await resolveAccessEnvelope(context);
		const db = queryDb(context);
		let expectedRevision =
			input.expectedRevision ??
			(input.expectedRevisionId ? base.revision : undefined);
		let note = input.note ?? null;
		if (
			expectedRevision !== undefined &&
			expectedRevision < base.revision &&
			!input.expectedRevisionId
		) {
			const merged = await mergeStaleSave(
				context,
				output,
				base,
				expectedRevision,
				content,
				accessEnvelope,
			);
			if (merged) {
				content = merged;
				note = `${note ?? "Saved"} · merged with revision ${base.revision}`;
				expectedRevision = base.revision;
			}
		}
		const result = await createOsOutputRevision(db, {
			id: crypto.randomUUID(),
			organizationId: output.organizationId,
			outputId: output.id,
			expectedWorkspaceId: input.expectedWorkspaceId,
			content: JSON.stringify(content),
			note,
			createdByKind: creator.kind,
			createdById: creator.id,
			...resolveProducer(context),
			accessEnvelope,
			expectedRevision,
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
		await publishOutputMetadataChange(context, row);
		return { output: mapOsOutputRow(row) };
	},
);

const outputsRestore = authorOs.outputs.restore.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		if (output.status === "active") return { output: mapOsOutputRow(output) };
		const row = await updateOsOutput(
			queryDb(context),
			{ organizationId: output.organizationId, outputId: output.id },
			{ status: "active" },
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		}
		await publishOutputMetadataChange(context, row);
		return { output: mapOsOutputRow(row) };
	},
);

/**
 * A save made from an older revision: merge it with what was saved since,
 * when both edited different parts. Returns null when the edits overlap or the
 * merge cannot be proven safe, and the caller answers with the usual conflict.
 * The current revision must carry the same source requirements as this write,
 * so a merge never moves content out from behind a stricter access check.
 */
async function mergeStaleSave(
	context: BaseContext,
	output: OsOutputRow,
	current: OsOutputRevisionRow,
	startedFrom: number,
	mine: OsOutputContent,
	accessEnvelope: string | null,
): Promise<OsOutputContent | null> {
	if (current.accessEnvelope !== accessEnvelope) return null;
	const started = await getOsOutputRevisionByNumber(queryDb(context), {
		organizationId: output.organizationId,
		outputId: output.id,
		revision: startedFrom,
	});
	if (!started || !(await canReadDerivedRevision(context, started)))
		return null;
	const base = OsOutputContentSchema.safeParse(JSON.parse(started.content));
	const theirs = OsOutputContentSchema.safeParse(JSON.parse(current.content));
	if (!base.success || !theirs.success) return null;
	const merged = mergeOutputContent(base.data, mine, theirs.data, {
		documentBlocks: blocksFromRichText,
		presentationSlides: projectPresentationDeck,
	});
	if (!merged.ok) return null;
	const checked = OsOutputContentSchema.safeParse(merged.content);
	return checked.success ? checked.data : null;
}

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

/** How the plain copies next to a rich body are rebuilt after a patch or merge. */
const OUTPUT_PROJECTIONS = {
	documentBlocks: blocksFromRichText,
	presentationSlides: projectPresentationDeck,
};

/**
 * Stored content as the editors hold it. A document written before the rich
 * editor carries only blocks; its rich body is derived here exactly as the
 * editor's host derives it, so a patch made in the editor fits.
 */
function editableStoredContent(row: OsOutputRevisionRow): OsOutputContent {
	const content = OsOutputContentSchema.parse(JSON.parse(row.content));
	return content.kind === "document" && !content.file && content.blocks.length
		? normalizeDocumentContent(content)
		: content;
}

/** Saves that lost the write to a concurrent save are applied again this often. */
const PATCH_WRITE_ATTEMPTS = 3;

const outputsPatch = authorOs.outputs.patch.handler(
	async ({ input, context }) => {
		let output = await requireOutput(context, input.outputId);
		if (
			input.expectedWorkspaceId !== undefined &&
			input.expectedWorkspaceId !== output.workspaceId
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"This file moved to another workspace. Reopen it before saving.",
			);
		if (input.patch.kind !== output.kind)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`The patch is for a ${input.patch.kind} but the output is a ${output.kind}`,
			);
		const creator = resolveCreator(context);
		const accessEnvelope = await resolveAccessEnvelope(context);
		const db = queryDb(context);
		const conflict = (currentRevision: number | null, parts?: string[]) =>
			new ORPCError("CONFLICT", {
				message: parts?.length
					? "Someone else changed the same part of this file"
					: "Output revision compare-and-swap lost against a concurrent revision write",
				data: {
					expectedRevision: input.baseRevision,
					currentRevision,
					...(parts?.length ? { parts } : {}),
				},
			});
		let latest: number | null = null;
		for (let attempt = 0; attempt < PATCH_WRITE_ATTEMPTS; attempt++) {
			const current = await requireCurrentOutputRevision(context, output);
			latest = current.revision;
			if (input.baseRevision > current.revision)
				throw conflict(current.revision);
			const theirs = editableStoredContent(current);
			let base = theirs;
			if (input.baseRevision < current.revision) {
				// A merge never moves content out from behind a stricter access
				// check, and never builds on a revision this caller cannot read.
				if (current.accessEnvelope !== accessEnvelope)
					throw conflict(current.revision);
				const started = await getOsOutputRevisionByNumber(db, {
					organizationId: output.organizationId,
					outputId: output.id,
					revision: input.baseRevision,
				});
				if (!started || !(await canReadDerivedRevision(context, started)))
					throw conflict(current.revision);
				base = editableStoredContent(started);
			}
			let mine: OsOutputContent;
			try {
				mine = applyOutputPatch(base, input.patch, OUTPUT_PROJECTIONS);
			} catch (error) {
				if (!(error instanceof OutputPatchError)) throw error;
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			}
			let next = mine;
			if (base !== theirs) {
				const merged = mergeOutputContent(
					base,
					mine,
					theirs,
					OUTPUT_PROJECTIONS,
				);
				if (!merged.ok) throw conflict(current.revision, merged.conflicts);
				next = merged.content;
			}
			const checked = OsOutputContentSchema.safeParse(next);
			if (!checked.success) {
				const issue = checked.error.issues[0];
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`The change does not fit this file: ${issue?.path.join("/") ?? ""} ${issue?.message ?? "invalid"}`.trim(),
				);
			}
			const result = await createOsOutputRevision(db, {
				id: crypto.randomUUID(),
				organizationId: output.organizationId,
				outputId: output.id,
				expectedWorkspaceId: input.expectedWorkspaceId,
				content: JSON.stringify(checked.data),
				note:
					base === theirs
						? (input.note ?? null)
						: `${input.note ?? "Saved"} · merged with revision ${current.revision}`,
				createdByKind: creator.kind,
				createdById: creator.id,
				...resolveProducer(context),
				accessEnvelope,
				expectedRevision: current.revision,
			});
			if (result.ok) {
				const advanced = await getOsOutput(db, {
					organizationId: output.organizationId,
					outputId: output.id,
				});
				// What is stored beyond what the caller sent: someone else's merged
				// changes, schema defaults, images moved out of the content.
				const stored = OsOutputContentSchema.parse(
					JSON.parse(result.revision.content),
				);
				return {
					output: mapOsOutputRow(advanced ?? output),
					revision: {
						id: result.revision.id,
						revision: result.revision.revision,
						createdAt: result.revision.createdAt,
					},
					mergedWith: base === theirs ? null : current.revision,
					catchUp: diffOutputContent(mine, stored),
				};
			}
			if (result.reason === "output_not_found")
				throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
			// Someone saved between the read and the write: apply the patch again
			// on top of their revision.
			output = await requireOutput(context, input.outputId);
		}
		throw conflict(latest);
	},
);

const outputsChanges = readOs.outputs.changes.handler(
	async ({ input, context }) => {
		const output = await requireOutput(context, input.outputId);
		const current = await requireCurrentOutputRevision(context, output);
		const answer = {
			output: mapOsOutputRow(output),
			revision: {
				id: current.id,
				revision: current.revision,
				createdAt: current.createdAt,
			},
		};
		if (input.sinceRevision >= current.revision)
			return { ...answer, patch: null };
		const content = editableStoredContent(current);
		const started = await getOsOutputRevisionByNumber(queryDb(context), {
			organizationId: output.organizationId,
			outputId: output.id,
			revision: input.sinceRevision,
		});
		if (!started || !(await canReadDerivedRevision(context, started)))
			return { ...answer, patch: null, content };
		const since = editableStoredContent(started);
		if (since.kind !== content.kind || content.kind === "video")
			return { ...answer, patch: null, content };
		return { ...answer, patch: diffOutputContent(since, content) };
	},
);

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
		let next: Extract<OsOutputContent, { kind: "presentation" }>;
		try {
			next = applyPresentationPatch(content, input.ops);
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				error instanceof Error ? error.message : "Invalid slide edits",
			);
		}
		return persistEditedOutputRevision(
			context,
			output,
			base.revision,
			next,
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
		let next: Extract<OsOutputContent, { kind: "document" }>;
		try {
			next = applyDocumentBlockPatch(content, input.ops);
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				error instanceof Error ? error.message : "Invalid document patch",
			);
		}
		return persistEditedOutputRevision(
			context,
			output,
			base.revision,
			next,
			input.note,
		);
	},
);

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
				`The rectangle spans columns ${input.startColumn}..${input.startColumn + width - 1} but the sheet has ${columnCount} columns; columns are added by editors, not by range writes. Declare the column headers first with revise_os_output (content.columns), then write the cells`,
			);
		}
		const endRow = input.startRow + input.cells.length;
		if (endRow > OS_SHEET_MAX_ROWS) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`The rectangle ends at row ${endRow}, beyond the ${OS_SHEET_MAX_ROWS}-row sheet cap`,
			);
		}
		const next = OsOutputContentSchema.safeParse(
			applySheetRange(content, input.startRow, input.startColumn, input.cells),
		);
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
	markdown: "text/markdown; charset=utf-8",
	html: "text/html; charset=utf-8",
	csv: "text/csv; charset=utf-8",
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
	organization: PresentationAppearance,
	readAsset: OsExportAssetReader,
): Promise<Uint8Array> {
	if (!context.env.BROWSER) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Output export requires Browser Rendering; the BROWSER binding is not configured",
		);
	}
	const content = await inlineOsExportImages(revision.content, readAsset);
	const html = renderOsOutputHtml(
		mapOsOutputRow(output),
		{
			...revision,
			content,
		},
		organization,
	);
	const response = await runBrowserQuickAction(
		context.env.BROWSER,
		format === "pdf" ? "pdf" : "screenshot",
		{
			html,
			...OS_EXPORT_RESOURCE_WAIT,
			...(format === "png" && content.kind === "presentation"
				? {
						viewport: { width: 1200, height: 675 },
						screenshotOptions: { fullPage: true },
					}
				: {}),
			...(format === "pdf"
				? { pdfOptions: { preferCSSPageSize: true, printBackground: true } }
				: {}),
		},
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
		if (
			input.expectedWorkspaceId !== undefined &&
			input.expectedWorkspaceId !== output.workspaceId
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"This file moved to another workspace. Reopen it before exporting.",
			);
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
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== revision.revision
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"The saved revision changed. Reload before exporting.",
			);
		let selectedSheetIndex: number | undefined;
		if (input.sheetId) {
			if (input.format !== "csv") {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"sheetId is valid only for CSV exports",
				);
			}
			selectedSheetIndex =
				revision.content.kind === "sheet"
					? revision.content.workbook?.sheets.findIndex(
							(sheet) => sheet.id === input.sheetId,
						)
					: undefined;
			if (selectedSheetIndex === undefined || selectedSheetIndex < 0) {
				throw createError(ErrorCodes.BAD_REQUEST, "Sheet not found");
			}
		}
		let organization: PresentationAppearance = {};
		if (output.kind === "presentation") {
			const [profile, appearance] = await Promise.all([
				getOrganizationProfile(context.db, output.organizationId),
				getOrganizationOsTheme(context.db, output.organizationId),
			]);
			organization = {
				name: profile?.name,
				logoUrl: profile?.logoUrl,
				appearance,
			};
			if (revision.content.kind === "presentation") {
				for (const slide of revision.content.deck?.slides ?? []) {
					for (const element of slide.elements) {
						if (element.type === "logo") {
							element.type = organization.logoUrl ? "image" : "text";
							element.src = organization.logoUrl ?? undefined;
							element.text = organization.name ?? "";
						}
					}
				}
			}
		}
		const readAsset = outputAssetReader({
			organizationId: output.organizationId,
			outputId: output.id,
		});
		let bytes: Uint8Array;
		let extension: string = input.format === "markdown" ? "md" : input.format;
		let contentType: string = EXPORT_CONTENT_TYPES[input.format];
		if (input.format === "pdf" || input.format === "png") {
			bytes = await renderExportBytes(
				context,
				output,
				revision,
				input.format,
				organization,
				readAsset,
			);
		} else if (input.format === "csv" && revision.content.kind === "sheet") {
			const { buildOsSheetCsv } = await import("../../lib/os-output-csv");
			({ bytes, extension, contentType } = await buildOsSheetCsv(
				revision.content,
				input.sheetId,
			));
		} else if (
			(input.format === "markdown" || input.format === "html") &&
			revision.content.kind === "document"
		) {
			const content = await inlineOsExportImages(revision.content, readAsset);
			const { renderOsDocumentMarkdown } =
				await import("../../lib/os-output-markdown");
			bytes = new TextEncoder().encode(
				input.format === "markdown"
					? renderOsDocumentMarkdown(content)
					: renderOsOutputHtml(mapOsOutputRow(output), {
							...revision,
							content,
						}),
			);
		} else if (
			input.format === "xlsx" ||
			input.format === "docx" ||
			input.format === "pptx"
		) {
			// Deferred so the OOXML writers stay off the router's import graph
			// until an Office export is actually asked for.
			const { buildOsOutputOfficeExport } =
				await import("../../lib/os-output-office");
			const { prepareOsPptxImages } = await import("../../lib/os-pptx-images");
			bytes = await buildOsOutputOfficeExport(
				input.format,
				input.format === "pptx"
					? await prepareOsPptxImages(
							revision.content,
							context.env.BROWSER,
							readAsset,
						)
					: await inlineOsOutputAssets(revision.content, readAsset),
				output.title,
				organization,
			);
		} else {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Export format does not match stored content",
			);
		}
		const tabSuffix =
			selectedSheetIndex !== undefined ? `-tab-${selectedSheetIndex + 1}` : "";
		const file = `rev-${revision.revision}${tabSuffix}.${extension}`;
		const key = `os-exports/${output.organizationId}/${output.id}/${file}`;
		await context.env.R2_BUCKET.put(key, bytes, {
			httpMetadata: { contentType },
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
				`/os-exports/${output.id}/${file}`,
				context.env.API_URL,
			).toString(),
		};
	},
);

const DISPLAY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Whether the content itself links to this image. A deck's logo element is checked separately. */
function contentLinksImage(content: OsOutputContent, url: string): boolean {
	if (content.kind === "presentation")
		return (content.deck?.slides ?? []).some(
			(slide) =>
				slide.backgroundImage === url ||
				slide.elements.some(
					(element) =>
						(element.type === "image" || element.type === "svg") &&
						element.src === url,
				),
		);
	if (content.kind !== "document") return false;
	const linked = (node: OsRichTextNode): boolean =>
		(node.type === "image" && node.attrs?.src === url) ||
		(node.content ?? []).some(linked);
	return (content.richText?.content ?? []).some(linked);
}

/** The output an image call names, once the caller may read its current revision. */
async function requireImageOutput(
	context: BaseContext,
	input: { outputId: string; workspaceId?: string },
): Promise<OsOutputRow> {
	const output = await requireOutput(context, input.outputId);
	if (
		input.workspaceId !== undefined &&
		output.workspaceId !== input.workspaceId
	)
		throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
	const [current] = await listOsOutputRevisions(
		queryDb(context),
		{ organizationId: output.organizationId, outputId: output.id },
		{ limit: 1 },
	);
	if (!current)
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"OS output current revision was not readable",
		);
	await requireDerivedRevisionAccess(context, current);
	return output;
}

/**
 * One image of an output, embedded for an editor that has no network or an
 * agent that wants to see it. A stored image is served when the caller may
 * read the output and the output holds it. A linked image is fetched only
 * when the saved file uses the link, so this reaches nothing an export of
 * the same file does not.
 */
const outputsImage = readOs.outputs.image.handler(
	async ({ input, context }) => {
		if (outputAssetDigest(input.url)) {
			const output = await requireImageOutput(context, input);
			const dataUrl = await readOutputAsset(
				{ organizationId: output.organizationId, outputId: output.id },
				input.url,
			);
			if (!dataUrl)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"This file holds no such image",
				);
			return { dataUrl };
		}
		const output = await requireOutput(context, input.outputId);
		if (
			input.workspaceId !== undefined &&
			output.workspaceId !== input.workspaceId
		)
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		const { content } = mapOsOutputRevisionRow(
			await requireCurrentOutputRevision(context, output),
		);
		let linked = contentLinksImage(content, input.url);
		if (
			!linked &&
			content.kind === "presentation" &&
			content.deck?.slides.some((slide) =>
				slide.elements.some((element) => element.type === "logo"),
			)
		) {
			const profile = await getOrganizationProfile(
				context.db,
				output.organizationId,
			);
			linked = profile?.logoUrl === input.url;
		}
		if (!linked)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This link is not an image of the saved file",
			);
		try {
			return {
				dataUrl: await fetchOsExportImage(input.url, DISPLAY_IMAGE_MAX_BYTES),
			};
		} catch {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The image could not be loaded. It must be a public HTTPS image of at most 5 MB.",
			);
		}
	},
);

/** Store one image with a file so its content can name it by reference. */
const outputsUploadImage = authorOs.outputs.uploadImage.handler(
	async ({ input, context }) => {
		const output = await requireImageOutput(context, input);
		if (output.kind !== "presentation" && output.kind !== "document")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Images are stored with presentations and documents; this output is a ${output.kind}`,
			);
		return {
			reference: await storeOutputAsset(
				{ organizationId: output.organizationId, outputId: output.id },
				input.dataUrl,
			),
		};
	},
);

export const osOutputProcedures = {
	history: outputsHistory,
	list: outputsList,
	library: outputsLibrary,
	create: outputsCreate,
	get: outputsGet,
	image: outputsImage,
	uploadImage: outputsUploadImage,
	rename: outputsRename,
	move: outputsMove,
	revise: outputsRevise,
	patch: outputsPatch,
	changes: outputsChanges,
	patchDocument: outputsPatchDocument,
	patchSlides: outputsPatchSlides,
	setSheetRange: outputsSetSheetRange,
	export: outputsExport,
	archive: outputsArchive,
	restore: outputsRestore,
};
