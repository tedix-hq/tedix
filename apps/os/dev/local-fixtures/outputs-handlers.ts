/** Local fixture handlers: Output and collaboration-proposal procedures. */

import { mergeOutputContent } from "@tedix/api-contract/utils/output-merge";
import {
	applyOutputPatch,
	diffOutputContent,
	type OutputPatch,
} from "@tedix/api-contract/utils/output-patch";
import type { AppRuntimeFiles } from "@tedix/api-contract/schemas/os-app-runtime";
import type {
	OsCollaborationProposal,
	OsGadgetRevision,
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	editableLocalContent,
	LOCAL_OUTPUT_PROJECTIONS,
	nextId,
	now,
	ORG_ID,
	revisionConflict,
	RpcError,
} from "./core";
import {
	findCollaborationProposal,
	findGadget,
	findOutput,
	findWorkspace,
	latestRevision,
	localOutputLibraryItem,
} from "./lookups";
import { localOutputAssets, state } from "./state";

export const outputHandlers: Record<string, (input: never) => unknown> = {
	"osWorkspaces/outputs/list": (
		input:
			| {
					workspaceId?: string;
					kind?: OsOutput["kind"];
					status?: OsOutput["status"];
			  }
			| undefined,
	) => ({
		items: state.outputs.filter(
			(row) =>
				(input?.workspaceId === undefined ||
					row.workspaceId === input.workspaceId) &&
				(input?.kind === undefined || row.kind === input.kind) &&
				(input?.status === undefined || row.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/outputs/library": (
		input:
			| {
					kind?: OsOutput["kind"];
					status?: OsOutput["status"];
					limit?: number;
			  }
			| undefined,
	) => {
		const limit = input?.limit ?? 50;
		const rows = state.outputs
			.filter(
				(output) =>
					(input?.kind === undefined || output.kind === input.kind) &&
					(input?.status === undefined || output.status === input.status),
			)
			.map((output) => {
				const revision = latestRevision(
					state.outputRevisions.filter((row) => row.outputId === output.id),
				);
				if (!revision)
					throw new RpcError("NOT_FOUND", "Output revision not found");
				return localOutputLibraryItem(output, revision);
			});
		return { items: rows.slice(0, limit), truncated: rows.length > limit };
	},
	"osWorkspaces/outputs/create": (input: {
		kind: OsOutput["kind"];
		title: string;
		workspaceId?: string;
		content: OsOutputContent;
		note?: string;
	}) => {
		if (input.content.kind !== input.kind) {
			throw new RpcError(
				"BAD_REQUEST",
				"Content kind must match the output kind",
			);
		}
		const createdAt = now();
		const revision: OsOutputRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			outputId: nextId(),
			revision: 1,
			content: input.content,
			note: input.note ?? null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
		};
		const output: OsOutput = {
			id: revision.outputId,
			organizationId: ORG_ID,
			workspaceId: input.workspaceId ?? null,
			kind: input.kind,
			title: input.title,
			status: "active",
			currentRevisionId: revision.id,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
		};
		state.outputs.push(output);
		state.outputRevisions.push(revision);
		return { output, revision };
	},
	"osWorkspaces/outputs/get": (input: { outputId: string }) => {
		const output = findOutput(input.outputId);
		const currentRevision = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		if (!currentRevision)
			throw new RpcError("NOT_FOUND", "Output revision not found");
		return { output, currentRevision, authoringHomeRun: null };
	},
	// The sample data makes no network requests: every linked image is one grey
	// stand-in. An image stored with a file is kept in memory and read back.
	"osWorkspaces/outputs/image": (input: { outputId: string; url: string }) => {
		findOutput(input.outputId);
		const stored = localOutputAssets.get(`${input.outputId}:${input.url}`);
		if (!stored && input.url.startsWith("tedix-asset:"))
			throw new RpcError("NOT_FOUND", "This file holds no such image");
		return {
			dataUrl:
				stored ??
				`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#d4d4d4"/></svg>')}`,
		};
	},
	"osWorkspaces/outputs/uploadImage": (input: {
		outputId: string;
		dataUrl: string;
	}) => {
		findOutput(input.outputId);
		// Sample handlers answer at once, so this is a plain 256-bit mix of the
		// text and not the SHA-256 the server names an image by.
		let name = "";
		for (let seed = 0; seed < 8; seed++) {
			let hash = 0x811c9dc5 ^ seed;
			for (let index = 0; index < input.dataUrl.length; index++)
				hash = Math.imul(hash ^ input.dataUrl.charCodeAt(index), 0x01000193);
			name += (hash >>> 0).toString(16).padStart(8, "0");
		}
		const reference = `tedix-asset:${name}`;
		localOutputAssets.set(`${input.outputId}:${reference}`, input.dataUrl);
		return { reference };
	},
	"osWorkspaces/outputs/rename": (input: {
		outputId: string;
		title: string;
	}) => {
		const output = findOutput(input.outputId);
		output.title = input.title;
		output.updatedAt = now();
		return { output };
	},
	"osWorkspaces/outputs/move": (input: {
		outputId: string;
		workspaceId: string;
	}) => {
		const output = findOutput(input.outputId);
		findWorkspace(input.workspaceId);
		const previousWorkspaceId = output.workspaceId;
		if (previousWorkspaceId !== input.workspaceId) {
			output.workspaceId = input.workspaceId;
			output.updatedAt = now();
		}
		return { output, previousWorkspaceId };
	},
	"osWorkspaces/outputs/revise": (input: {
		outputId: string;
		content: OsOutputContent;
		note?: string;
		expectedRevision?: number;
	}) => {
		const output = findOutput(input.outputId);
		if (input.content.kind !== output.kind) {
			throw new RpcError(
				"BAD_REQUEST",
				"Content kind must match the output kind",
			);
		}
		const current = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		const currentNumber = current?.revision ?? 0;
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== currentNumber
		) {
			throw revisionConflict(input.expectedRevision, current?.revision ?? null);
		}
		const revision: OsOutputRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			outputId: output.id,
			revision: currentNumber + 1,
			content: input.content,
			note: input.note ?? null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
		};
		state.outputRevisions.push(revision);
		output.currentRevisionId = revision.id;
		output.updatedAt = revision.createdAt;
		return { output, revision };
	},
	"osWorkspaces/outputs/patch": (input: {
		outputId: string;
		baseRevision: number;
		patch: OutputPatch;
		note?: string;
	}) => {
		const output = findOutput(input.outputId);
		const revisions = state.outputRevisions.filter(
			(row) => row.outputId === output.id,
		);
		const current = latestRevision(revisions);
		const started = revisions.find(
			(row) => row.revision === input.baseRevision,
		);
		if (!current || !started)
			throw revisionConflict(input.baseRevision, current?.revision ?? null);
		if (input.patch.kind !== output.kind)
			throw new RpcError(
				"BAD_REQUEST",
				"The patch kind must match the output kind",
			);
		const base = editableLocalContent(started.content);
		const theirs = editableLocalContent(current.content);
		let mine: OsOutputContent;
		try {
			mine = applyOutputPatch(base, input.patch, LOCAL_OUTPUT_PROJECTIONS);
		} catch (error) {
			throw new RpcError(
				"BAD_REQUEST",
				error instanceof Error ? error.message : "The patch does not fit",
			);
		}
		let next = mine;
		if (started !== current) {
			// Someone saved since: changes to different parts both land.
			const merged = mergeOutputContent(
				base,
				mine,
				theirs,
				LOCAL_OUTPUT_PROJECTIONS,
			);
			if (!merged.ok)
				throw new RpcError("CONFLICT", "Revision conflict", {
					expectedRevision: input.baseRevision,
					currentRevision: current.revision,
					parts: merged.conflicts,
				});
			next = merged.content;
		}
		const revision: OsOutputRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			outputId: output.id,
			revision: current.revision + 1,
			content: next,
			note: input.note ?? null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
		};
		state.outputRevisions.push(revision);
		output.currentRevisionId = revision.id;
		output.updatedAt = revision.createdAt;
		return {
			output,
			revision: {
				id: revision.id,
				revision: revision.revision,
				createdAt: revision.createdAt,
			},
			mergedWith: started === current ? null : current.revision,
			continuesBurst: false,
			catchUp: diffOutputContent(mine, next),
		};
	},
	"osWorkspaces/outputs/changes": (input: {
		outputId: string;
		sinceRevision: number;
	}) => {
		const output = findOutput(input.outputId);
		const revisions = state.outputRevisions.filter(
			(row) => row.outputId === output.id,
		);
		const current = latestRevision(revisions);
		if (!current) throw new RpcError("NOT_FOUND", "OS output not found");
		const answer = {
			output,
			revision: {
				id: current.id,
				revision: current.revision,
				createdAt: current.createdAt,
				createdByKind: current.createdByKind,
			},
		};
		if (input.sinceRevision >= current.revision)
			return { ...answer, patch: null };
		const since = revisions.find((row) => row.revision === input.sinceRevision);
		const content = editableLocalContent(current.content);
		if (!since || since.content.kind !== content.kind)
			return { ...answer, patch: null, content };
		return {
			...answer,
			patch: diffOutputContent(editableLocalContent(since.content), content),
		};
	},
	"osWorkspaces/outputs/setSheetRange": (input: {
		outputId: string;
		startRow: number;
		startColumn: number;
		cells: (string | number | boolean | null)[][];
		note?: string;
		expectedRevision?: number;
	}) => {
		const output = findOutput(input.outputId);
		const current = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		if (!current || current.content.kind !== "sheet")
			throw new RpcError("BAD_REQUEST", "Range writes need a sheet output");
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== current.revision
		)
			throw revisionConflict(input.expectedRevision, current.revision);
		const { columns } = current.content;
		const rows = current.content.rows.map((row) => [...row]);
		input.cells.forEach((cells, offset) => {
			const rowIndex = input.startRow + offset;
			while (rows.length <= rowIndex) rows.push(columns.map(() => null));
			cells.forEach((cell, column) => {
				if (input.startColumn + column >= columns.length)
					throw new RpcError("BAD_REQUEST", "The range exceeds the columns");
				rows[rowIndex]![input.startColumn + column] = cell;
			});
		});
		const revision: OsOutputRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			outputId: output.id,
			revision: current.revision + 1,
			content: { kind: "sheet", columns, rows },
			note: input.note ?? null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
		};
		state.outputRevisions.push(revision);
		output.currentRevisionId = revision.id;
		output.updatedAt = revision.createdAt;
		return { output, revision };
	},
	"osWorkspaces/outputs/export": (input: {
		outputId: string;
		format: "pdf" | "png";
	}) => {
		const output = findOutput(input.outputId);
		const current = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		return {
			key: `exports/${output.id}/rev-${current?.revision ?? 1}.${input.format}`,
			format: input.format,
			revision: current?.revision ?? 1,
			sizeBytes: 128_000,
			url: `https://local.invalid/exports/${output.id}.${input.format}`,
		};
	},
	"osWorkspaces/outputs/archive": (input: { outputId: string }) => {
		const output = findOutput(input.outputId);
		output.status = "archived";
		output.updatedAt = now();
		return { output };
	},
	"osWorkspaces/outputs/restore": (input: { outputId: string }) => {
		const output = findOutput(input.outputId);
		if (output.status === "active") return { output };
		output.status = "active";
		output.updatedAt = now();
		return { output };
	},
	"osWorkspaces/collaboration/list": (input: {
		workspaceId: string;
		documentType?: OsCollaborationProposal["documentType"];
		documentId?: string;
		statuses?: OsCollaborationProposal["status"][];
		limit?: number;
	}) => {
		const items = state.collaborationProposals
			.filter(
				(row) =>
					row.workspaceId === input.workspaceId &&
					(input.documentType === undefined ||
						row.documentType === input.documentType) &&
					(input.documentId === undefined ||
						row.documentId === input.documentId) &&
					(input.statuses === undefined || input.statuses.includes(row.status)),
			)
			.slice(0, input.limit ?? 50);
		return { items, truncated: false };
	},
	"osWorkspaces/collaboration/get": (input: { proposalId: string }) => ({
		proposal: findCollaborationProposal(input.proposalId),
	}),
	"osWorkspaces/collaboration/create": (input: {
		workspaceId: string;
		documentType: OsCollaborationProposal["documentType"];
		documentId: string;
		sourceKind: OsCollaborationProposal["sourceKind"];
		sourceId: string;
		content: OsCollaborationProposal["content"];
	}) => {
		findWorkspace(input.workspaceId);
		const currentRevision =
			input.documentType === "gadget"
				? latestRevision(
						state.gadgetRevisions.filter(
							(row) =>
								row.gadgetId ===
								findGadget(input.workspaceId, input.documentId).id,
						),
					)
				: latestRevision(
						state.outputRevisions.filter(
							(row) => row.outputId === findOutput(input.documentId).id,
						),
					);
		if (!currentRevision) {
			throw new RpcError("CONFLICT", "Document has no immutable base revision");
		}
		const createdAt = now();
		const proposal: OsCollaborationProposal = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			documentType: input.documentType,
			documentId: input.documentId,
			baseRevisionId: currentRevision.id,
			baseRevision: currentRevision.revision,
			status: "open",
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			content: input.content,
			sequence: 0,
			createdByKind: "external_agent",
			createdById: "local-agent",
			createdAt,
			updatedAt: createdAt,
			decisionRationale: null,
			decisionEvidenceRefs: [],
			decidedByKind: null,
			decidedById: null,
			decidedAt: null,
			mergeRationale: null,
			mergeEvidenceRefs: [],
			mergedByKind: null,
			mergedById: null,
			mergedAt: null,
			resultRevisionId: null,
			resultRevision: null,
		};
		state.collaborationProposals.push(proposal);
		return { proposal };
	},
	"osWorkspaces/collaboration/updatePreview": (input: {
		proposalId: string;
		expectedSequence: number;
		content: OsCollaborationProposal["content"];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.status !== "open" ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal preview changed");
		}
		proposal.content = input.content;
		proposal.sequence += 1;
		proposal.updatedAt = now();
		return { proposal };
	},
	"osWorkspaces/collaboration/accept": (input: {
		proposalId: string;
		expectedSequence: number;
		rationale: string;
		evidenceRefs?: string[];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.status !== "open" ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal preview changed");
		}
		proposal.status = "accepted";
		proposal.decisionRationale = input.rationale;
		proposal.decisionEvidenceRefs = input.evidenceRefs ?? [];
		proposal.decidedByKind = "user";
		proposal.decidedById = "dev-operator";
		proposal.decidedAt = now();
		proposal.updatedAt = proposal.decidedAt;
		return { proposal };
	},
	"osWorkspaces/collaboration/reject": (input: {
		proposalId: string;
		expectedSequence: number;
		rationale: string;
		evidenceRefs?: string[];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			(proposal.status !== "open" && proposal.status !== "accepted") ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal preview changed");
		}
		proposal.status = "rejected";
		proposal.decisionRationale = input.rationale;
		proposal.decisionEvidenceRefs = input.evidenceRefs ?? [];
		proposal.decidedByKind = "user";
		proposal.decidedById = "dev-operator";
		proposal.decidedAt = now();
		proposal.updatedAt = proposal.decidedAt;
		return { proposal };
	},
	"osWorkspaces/collaboration/merge": (input: {
		proposalId: string;
		expectedSequence: number;
		rationale: string;
		evidenceRefs?: string[];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.status !== "accepted" ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal is not accepted");
		}
		const createdAt = now();
		const revisionId = nextId();
		const revisionNumber = proposal.baseRevision + 1;
		const revision =
			proposal.documentType === "gadget"
				? (() => {
						const gadget = findGadget(
							proposal.workspaceId,
							proposal.documentId,
						);
						if (gadget.currentRevisionId !== proposal.baseRevisionId) {
							throw revisionConflict(proposal.baseRevision, revisionNumber);
						}
						// A runtime app draft carries its manifest and files together.
						const draft = proposal.content as {
							manifest?: OsGadgetRevision["manifest"];
							files?: AppRuntimeFiles;
						};
						const isAppDraft =
							typeof draft.manifest === "object" &&
							typeof draft.files === "object";
						if (isAppDraft) state.gadgetCode[revisionId] = draft.files!;
						const next: OsGadgetRevision = {
							id: revisionId,
							organizationId: ORG_ID,
							gadgetId: gadget.id,
							revision: revisionNumber,
							manifest: isAppDraft
								? draft.manifest!
								: (proposal.content as OsGadgetRevision["manifest"]),
							sourceArtifactRef: null,
							createdByKind: "user",
							createdById: "dev-operator",
							createdAt,
						};
						state.gadgetRevisions.push(next);
						gadget.currentRevisionId = revisionId;
						gadget.updatedAt = createdAt;
						return next;
					})()
				: (() => {
						const output = findOutput(proposal.documentId);
						if (output.currentRevisionId !== proposal.baseRevisionId) {
							throw revisionConflict(proposal.baseRevision, revisionNumber);
						}
						const next: OsOutputRevision = {
							id: revisionId,
							organizationId: ORG_ID,
							outputId: output.id,
							revision: revisionNumber,
							content: proposal.content as OsOutputContent,
							note: input.rationale,
							producedBy: null,
							accessEnvelope: null,
							createdByKind: "user",
							createdById: "dev-operator",
							createdAt,
						};
						state.outputRevisions.push(next);
						output.currentRevisionId = revisionId;
						output.updatedAt = createdAt;
						return next;
					})();
		proposal.status = "merged";
		proposal.mergeRationale = input.rationale;
		proposal.mergeEvidenceRefs = input.evidenceRefs ?? [];
		proposal.mergedByKind = "user";
		proposal.mergedById = "dev-operator";
		proposal.mergedAt = createdAt;
		proposal.resultRevisionId = revisionId;
		proposal.resultRevision = revisionNumber;
		proposal.updatedAt = createdAt;
		return { proposal, revision };
	},
};
