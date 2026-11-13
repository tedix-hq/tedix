/** Local fixture handlers: Gadget and app runtime procedures. */

import {
	mergeAppFiles,
	mergeAppText,
	hasAppConflictMarkers,
} from "@tedix/api-contract/utils/app-draft-merge";
import type { OsAppDraftContent } from "@tedix/api-contract/schemas/os-workspaces";
import type { AppRuntimeFiles } from "@tedix/api-contract/schemas/os-app-runtime";
import type {
	OsCollaborationProposal,
	OsGadget,
	OsGadgetExecution,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	APP_RUNTIME_ENTRY,
	nextId,
	now,
	ORG_ID,
	revisionConflict,
	RpcError,
} from "./core";
import {
	createLocalWorkspace,
	findCollaborationProposal,
	findGadget,
	findOutput,
	findWorkspace,
	installLocalOutputEditor,
	latestRevision,
} from "./lookups";
import { localFilesHash, state } from "./state";

export const gadgetHandlers: Record<string, (input: never) => unknown> = {
	"osWorkspaces/gadgets/installDocument": (input: {
		workspaceId: string;
		outputId: string;
	}) => installLocalOutputEditor({ ...input, kind: "document" }),
	"osWorkspaces/gadgets/installOutputEditor": installLocalOutputEditor,
	"osWorkspaces/gadgets/installWorkDefaults": () => {
		const installed = state.gadgets.flatMap((gadget) => {
			const revision = state.gadgetRevisions.find(
				(row) => row.id === gadget.currentRevisionId,
			);
			const role = revision?.manifest.navigation?.work;
			return gadget.status === "active" && role ? [{ gadget, role }] : [];
		});
		const workspaceId =
			installed[0]?.gadget.workspaceId ??
			createLocalWorkspace({ name: "Work" }).workspace.id;
		for (const role of ["feed", "deck"] as const) {
			if (installed.some((app) => app.role === role)) continue;
			const gadgetId = nextId();
			const revisionId = nextId();
			const createdAt = now();
			state.gadgets.push({
				id: gadgetId,
				organizationId: ORG_ID,
				workspaceId,
				name: role === "feed" ? "Activity" : "Decisions",
				description: null,
				status: "active",
				currentRevisionId: revisionId,
				sourceBlueprintRevisionId: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
				updatedAt: createdAt,
			});
			state.gadgetRevisions.push({
				id: revisionId,
				organizationId: ORG_ID,
				gadgetId,
				revision: 1,
				manifest: {
					entry: `tedix:app/${role === "feed" ? "activity-feed" : "decision-deck"}`,
					capabilities: [],
					navigation: { board: true, work: role, workDefault: role === "deck" },
					config:
						role === "feed"
							? { version: 1, scope: "organization", projects: [] }
							: { version: 1, limit: 50, examples: [] },
				},
				sourceArtifactRef: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
			});
		}
		if (
			!state.gadgets.some((gadget) => {
				const revision = state.gadgetRevisions.find(
					(row) => row.id === gadget.currentRevisionId,
				);
				return (
					gadget.status === "active" &&
					revision?.manifest.entry === "tedix:app/office"
				);
			})
		) {
			const gadgetId = nextId();
			const revisionId = nextId();
			const createdAt = now();
			state.gadgets.push({
				id: gadgetId,
				organizationId: ORG_ID,
				workspaceId,
				name: "Office",
				description: null,
				status: "active",
				currentRevisionId: revisionId,
				sourceBlueprintRevisionId: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
				updatedAt: createdAt,
			});
			state.gadgetRevisions.push({
				id: revisionId,
				organizationId: ORG_ID,
				gadgetId,
				revision: 1,
				manifest: {
					entry: "tedix:app/office",
					capabilities: [],
					navigation: { board: true },
					config: { version: 1 },
				},
				sourceArtifactRef: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
			});
		}
		return { workspaceId };
	},
	"osWorkspaces/gadgets/workApps": (input: { limit: number }) => {
		const items = state.gadgets.flatMap((gadget) => {
			const currentRevision = state.gadgetRevisions.find(
				(row) => row.id === gadget.currentRevisionId,
			);
			return gadget.status === "active" &&
				currentRevision &&
				(currentRevision.manifest.navigation?.work ||
					currentRevision.manifest.navigation?.board)
				? [{ gadget, currentRevision }]
				: [];
		});
		return {
			items: items.slice(0, input.limit),
			truncated: items.length > input.limit,
		};
	},
	"osWorkspaces/gadgets/list": (input: {
		workspaceId: string;
		status?: OsGadget["status"];
	}) => ({
		items: state.gadgets.filter(
			(row) =>
				row.workspaceId === input.workspaceId &&
				(input.status === undefined || row.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/gadgets/create": (input: {
		workspaceId: string;
		name: string;
		description?: string;
	}) => {
		findWorkspace(input.workspaceId);
		const gadget: OsGadget = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			name: input.name,
			description: input.description ?? null,
			status: "active",
			currentRevisionId: null,
			sourceBlueprintRevisionId: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			updatedAt: now(),
		};
		state.gadgets.push(gadget);
		return { gadget };
	},
	"osWorkspaces/gadgets/get": (input: {
		workspaceId: string;
		gadgetId: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const currentRevision = latestRevision(
			state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id),
		);
		return { gadget, currentRevision };
	},
	"osWorkspaces/gadgets/revise": (input: {
		workspaceId: string;
		gadgetId: string;
		manifest: OsGadgetRevision["manifest"];
		files?: AppRuntimeFiles;
		sourceArtifactRef?: string;
		expectedRevision?: number;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const current = latestRevision(
			state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id),
		);
		const currentNumber = current?.revision ?? 0;
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== currentNumber
		) {
			throw revisionConflict(input.expectedRevision, current?.revision ?? null);
		}
		const runtimeApp = input.manifest.entry.trim() === APP_RUNTIME_ENTRY;
		if (runtimeApp && !input.files)
			throw new RpcError(
				"BAD_REQUEST",
				"A runtime app revision needs its files (server.js and client.js)",
			);
		if (!runtimeApp && input.files)
			throw new RpcError(
				"BAD_REQUEST",
				"Only a tedix:runtime/v1 app carries source files",
			);
		const revision: OsGadgetRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			gadgetId: gadget.id,
			revision: currentNumber + 1,
			manifest: {
				...input.manifest,
				capabilities: input.manifest.capabilities ?? [],
			},
			sourceArtifactRef: input.sourceArtifactRef ?? null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
		};
		state.gadgetRevisions.push(revision);
		if (input.files) state.gadgetCode[revision.id] = input.files;
		gadget.currentRevisionId = revision.id;
		gadget.updatedAt = revision.createdAt;
		return { gadget, revision };
	},
	"osAppRuntime/client": (input: { workspaceId: string; gadgetId: string }) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const revision = state.gadgetRevisions.find(
			(row) =>
				row.id === gadget.currentRevisionId && row.gadgetId === gadget.id,
		);
		const files = revision ? state.gadgetCode[revision.id] : undefined;
		if (!revision || !files || revision.manifest.entry !== APP_RUNTIME_ENTRY)
			throw new RpcError("NOT_FOUND", "OS runtime app revision not found");
		return {
			session: `fixture-only:${gadget.id}:${revision.id}`,
			expiresAt: Math.floor(Date.now() / 1000) + 300,
			role: "build",
			revisionId: revision.id,
			client: files["client.js"] ?? "",
			revision: revision.revision,
			settings: revision.manifest.config?.settings ?? {},
			grants: revision.manifest.resourceGrants ?? [],
		};
	},
	"osAppRuntime/readOutput": (input: {
		workspaceId: string;
		gadgetId: string;
		session: string;
		slot: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const revision = state.gadgetRevisions.find(
			(row) =>
				row.id === gadget.currentRevisionId && row.gadgetId === gadget.id,
		);
		if (
			!revision ||
			revision.manifest.entry !== APP_RUNTIME_ENTRY ||
			input.session !== `fixture-only:${gadget.id}:${revision.id}` ||
			!revision.manifest.resourceGrants?.some(
				(grant) =>
					grant.slot === input.slot &&
					grant.operations.includes("outputs.read"),
			)
		)
			throw new RpcError("FORBIDDEN", "App Output slot not granted");
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === gadget.workspaceId &&
				row.slot === input.slot &&
				row.resourceType === "output" &&
				row.status === "active",
		);
		if (!resource) throw new RpcError("NOT_FOUND", "App Output slot not found");
		const output = findOutput(resource.providerResourceId);
		const current = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		if (!current) throw new RpcError("NOT_FOUND", "Output revision not found");
		return current.content;
	},
	"osAppRuntime/saveDraft": (input: {
		workspaceId: string;
		gadgetId: string;
		expectedRevisionId: string;
		content: unknown;
		proposalId?: string;
		expectedSequence?: number;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const current = state.gadgetRevisions.find(
			(row) => row.id === gadget.currentRevisionId,
		)!;
		if (current.id !== input.expectedRevisionId)
			throw new RpcError("CONFLICT", "App revision changed");
		const content = input.content as OsAppDraftContent;
		if (Object.values(content.files).some(hasAppConflictMarkers))
			throw new RpcError("BAD_REQUEST", "Resolve conflict markers");
		if (input.proposalId) {
			const proposal = findCollaborationProposal(input.proposalId);
			if (
				proposal.documentId !== gadget.id ||
				proposal.sequence !== input.expectedSequence ||
				!["open", "accepted"].includes(proposal.status)
			)
				throw new RpcError("CONFLICT", "Draft changed");
			Object.assign(proposal, {
				content,
				baseRevisionId: current.id,
				baseRevision: current.revision,
				status: "open",
				sequence: proposal.sequence + 1,
				decidedAt: null,
				decidedById: null,
				decidedByKind: null,
				decisionRationale: null,
				decisionEvidenceRefs: [],
				updatedAt: now(),
			});
			return { proposal };
		}
		const proposal: OsCollaborationProposal = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			documentType: "gadget",
			documentId: gadget.id,
			baseRevisionId: current.id,
			baseRevision: current.revision,
			status: "open",
			sourceKind: "user",
			sourceId: "local-you",
			content,
			sequence: 0,
			createdByKind: "user",
			createdById: "local-you",
			createdAt: now(),
			updatedAt: now(),
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
	"osAppRuntime/mergeDraft": (input: {
		workspaceId: string;
		gadgetId: string;
		proposalId: string;
		expectedSequence: number;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.documentId !== gadget.id ||
			proposal.sequence !== input.expectedSequence ||
			!["open", "accepted"].includes(proposal.status)
		)
			throw new RpcError("CONFLICT", "Draft changed");
		const base = state.gadgetRevisions.find(
			(row) => row.id === proposal.baseRevisionId,
		)!;
		const main = state.gadgetRevisions.find(
			(row) => row.id === gadget.currentRevisionId,
		)!;
		const draft = proposal.content as OsAppDraftContent;
		const merged = mergeAppFiles(
			state.gadgetCode[base.id]!,
			draft.files,
			state.gadgetCode[main.id]!,
		);
		const manifest = mergeAppText(
			JSON.stringify(base.manifest, null, 2),
			JSON.stringify(draft.manifest, null, 2),
			JSON.stringify(main.manifest, null, 2),
		);
		return {
			...merged,
			manifest: manifest.text!,
			revisionId: main.id,
			conflicts: [
				...merged.conflicts,
				...(manifest.conflict ? ["manifest.json"] : []),
			],
		};
	},
	"osAppRuntime/open": (input: { workspaceId: string; gadgetId: string }) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		if (!gadget.currentRevisionId)
			throw new RpcError("NOT_FOUND", "OS app revision not found");
		// UI-only metadata, never a runtime credential or server execution.
		return {
			session: `fixture-only:${gadget.id}:${gadget.currentRevisionId}`,
			expiresAt: Math.floor(Date.now() / 1000) + 300,
			role: "build",
			revisionId: gadget.currentRevisionId,
		};
	},
	"osAppRuntime/draft": (input: {
		workspaceId: string;
		gadgetId: string;
		proposalId: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.documentType !== "gadget" ||
			proposal.documentId !== gadget.id ||
			proposal.status !== "open"
		)
			throw new RpcError("NOT_FOUND", "OS app draft not found");
		// UI-only metadata, never a runtime credential or server execution.
		return {
			session: `fixture-only:${gadget.id}:${proposal.baseRevisionId}:${proposal.id}`,
			expiresAt: Math.floor(Date.now() / 1000) + 300,
			role: "build",
			revisionId: proposal.baseRevisionId,
		};
	},
	"osAppRuntime/proposeEdit": (input: {
		workspaceId: string;
		gadgetId: string;
		conversationId: string;
		expectedRevisionId: string;
		edits: Array<{ path: string; before: string; after: string }>;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const revision = state.gadgetRevisions.find(
			(row) =>
				row.id === gadget.currentRevisionId && row.gadgetId === gadget.id,
		);
		const current = revision ? state.gadgetCode[revision.id] : undefined;
		if (!revision || !current)
			throw new RpcError("NOT_FOUND", "OS runtime app revision not found");
		if (revision.id !== input.expectedRevisionId)
			throw new RpcError("CONFLICT", "App revision changed");
		const files = { ...current };
		for (const edit of input.edits) {
			const source = files[edit.path];
			if (source === undefined || source.split(edit.before).length !== 2)
				throw new RpcError(
					"CONFLICT",
					"App edit must match exactly once in the current file",
				);
			files[edit.path] = source.replace(edit.before, () => edit.after);
		}
		const createdAt = now();
		const proposal: OsCollaborationProposal = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: gadget.workspaceId,
			documentType: "gadget",
			documentId: gadget.id,
			baseRevisionId: revision.id,
			baseRevision: revision.revision,
			status: "open",
			sourceKind: "chat",
			sourceId: input.conversationId,
			content: { manifest: revision.manifest, files },
			sequence: 0,
			createdByKind: "user",
			createdById: "dev-operator",
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
		return {
			proposal,
			previewUrl: `/workspaces/${gadget.workspaceId}?workpiece=gadget%3A${gadget.id}&view=drafts`,
		};
	},
	"osWorkspaces/gadgets/getCode": (input: {
		workspaceId: string;
		gadgetId: string;
		revisionId?: string;
		knownFilesSha256?: string[];
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const revisionId = input.revisionId ?? gadget.currentRevisionId;
		if (!revisionId) return { code: null };
		const revision = state.gadgetRevisions.find(
			(row) => row.id === revisionId && row.gadgetId === gadget.id,
		);
		if (!revision) throw new RpcError("NOT_FOUND", "OS app revision not found");
		const files = state.gadgetCode[revision.id];
		if (!files) return { code: null };
		const filesSha256 = localFilesHash(files);
		return {
			code: {
				revisionId: revision.id,
				revision: revision.revision,
				filesSha256,
				...(input.knownFilesSha256?.includes(filesSha256) ? {} : { files }),
				codeLength: Object.values(files).reduce(
					(sum, text) => sum + text.length,
					0,
				),
				createdAt: revision.createdAt,
			},
		};
	},
	"osWorkspaces/gadgets/archive": (input: {
		workspaceId: string;
		gadgetId: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		gadget.status = "archived";
		gadget.updatedAt = now();
		return { gadget };
	},
	"osWorkspaces/gadgets/rename": (input: {
		workspaceId: string;
		gadgetId: string;
		name: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		gadget.name = input.name;
		gadget.updatedAt = now();
		return { gadget };
	},
	"osWorkspaces/gadgets/run": (input: {
		workspaceId: string;
		gadgetId: string;
		input?: OsGadgetExecution["input"];
		capabilities?: string[];
		tediId: string;
		approvalMode?: "policy" | "required";
		workItemId?: string;
		idempotencyKey?: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const revision = latestRevision(
			state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id),
		);
		const requested =
			input.capabilities ?? revision?.manifest.capabilities ?? [];
		const undeclared = requested.filter(
			(capability) => !revision?.manifest.capabilities.includes(capability),
		);
		const reasons = [
			...(gadget.status === "archived" ? ["gadget is archived"] : []),
			...(!revision ? ["gadget has no revision to run"] : []),
			...undeclared.map(
				(capability) => `capability is not declared: ${capability}`,
			),
		];
		const admitted = reasons.length === 0;
		const createdAt = now();
		const governed = admitted;
		const execution: OsGadgetExecution = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			gadgetId: gadget.id,
			revisionId: revision?.id ?? null,
			revision: revision?.revision ?? null,
			status: !admitted ? "denied" : governed ? "completed" : "running",
			grantedCapabilities: admitted ? requested : [],
			policyDecision: { allowed: admitted, reasons },
			input: input.input ?? null,
			output: governed
				? {
						ok: true,
						gadgetId: gadget.id,
						revision: revision?.revision ?? null,
					}
				: null,
			error: null,
			costs: governed ? { cpuMs: 32, inferenceMicros: 0 } : null,
			evidenceRefs: governed ? [`local://gadget-runs/${gadget.id}`] : null,
			lineage: {
				runId: governed ? nextId() : null,
				workflowInstanceId: governed ? nextId() : null,
				executionEpoch: 0,
				tediId: input.tediId,
				workItemId: input.workItemId ?? null,
				traceBundleId: governed ? `local-trace:${gadget.id}` : null,
				billingReservationId: governed ? nextId() : null,
				approvalRequestId: null,
				runtimeEnvironment: governed ? "development" : null,
				agentSessionId: null,
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			completedAt: governed ? createdAt : null,
		};
		state.executions.unshift(execution);
		return { execution };
	},
};
