/**
 * The objects the sandbox `env` exposes. Each is a plain object over the
 * data port, then wrapped with `wrapBinding`, so every call is checked,
 * executed and written to the change record exactly as a gateway tool call
 * would be. Nothing here knows about the model or the Durable Object.
 */
import type {
	AccountabilityAdapter,
	Actor,
	ChangeRecord,
	ComplianceAdapter,
	RevisionRef,
	Source,
	UndoPlan,
} from "@tedix/agent-governance/types";
import { wrapBinding } from "@tedix/agent-governance/wrap-binding";
import {
	OsOutputContentSchema,
	type OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { applyDocumentBlockPatch } from "@tedix/api-contract/utils/document-patch";
import type { BindingName } from "./declarations";
import { buildSheetBinding } from "./sheet-binding";
import { buildPresentationBinding } from "./presentation-bindings";
import type {
	CreateWorkInput,
	OutputDetail,
	OutputSummary,
	WorkspaceDataPort,
} from "./data-port";

const OPEN_DISPOSITIONS = new Set([
	"proposed",
	"accepted",
	"in_progress",
	"blocked",
	"review",
]);

export interface BindingDeps {
	data: WorkspaceDataPort;
	compliance: ComplianceAdapter;
	accountability: AccountabilityAdapter;
	actor: Actor;
	source: Source;
	onRecorded?: (record: ChangeRecord) => void;
}

function revisionRef(output: OutputSummary | OutputDetail | null | undefined) {
	return output?.revisionId ? { revisionId: output.revisionId } : undefined;
}

export function buildWorkspaceBindings(
	deps: BindingDeps,
): Record<BindingName, object> {
	const common = {
		compliance: deps.compliance,
		accountability: deps.accountability,
		actor: deps.actor,
		source: deps.source,
		onRecorded: deps.onRecorded,
	};
	const data = deps.data;

	const outputs = {
		list: (options?: {
			kind?: OutputSummary["kind"];
			status?: OutputSummary["status"];
		}) => data.listOutputs(options),
		get: (outputId: string) => data.getOutput(outputId),
		create: (input: { title: string; content: OsOutputContent }) =>
			data.createOutput({ ...input, actorId: deps.actor.id }),
		revise: (input: {
			outputId: string;
			content: OsOutputContent;
			expectedRevision: number;
			note?: string;
		}) => data.reviseOutput({ ...input, actorId: deps.actor.id }),
	};
	const readDocument = async (input: { outputId: string }) => {
		const output = await data.getOutput(input.outputId);
		if (!output || output.content?.kind !== "document")
			throw new Error("Document not found or unavailable");
		return { ...output, content: output.content };
	};
	const documents = {
		read: readDocument,
		replace: async (input: {
			outputId: string;
			expectedRevision: number;
			content: unknown;
		}) => {
			await readDocument(input);
			const content = OsOutputContentSchema.parse(input.content);
			if (content.kind !== "document")
				throw new Error("Expected document content");
			return data.reviseOutput({
				outputId: input.outputId,
				expectedRevision: input.expectedRevision,
				content,
				actorId: deps.actor.id,
			});
		},
		edit: async (input: {
			outputId: string;
			expectedRevision: number;
			ops: unknown;
		}) => {
			const output = await readDocument(input);
			return data.reviseOutput({
				outputId: input.outputId,
				expectedRevision: input.expectedRevision,
				content: applyDocumentBlockPatch(output.content, input.ops),
				actorId: deps.actor.id,
			});
		},
	};
	const documentWrite = {
		riskTier: "bounded_write" as const,
		blastRadius: "single_resource" as const,
		before: async (args: unknown[]) =>
			revisionRef(
				await data.getOutput((args[0] as { outputId: string }).outputId),
			),
		after: async (_args: unknown[], result: unknown) =>
			revisionRef(result as OutputDetail),
		undo: (
			_args: unknown[],
			_result: unknown,
			before?: RevisionRef,
		): UndoPlan | undefined =>
			before ? { kind: "rollback_revision", toRevision: before } : undefined,
	};
	const apps = { list: () => data.listApps() };
	const resources = { list: () => data.listResources() };
	const work = {
		list: (options?: { disposition?: string; limit?: number }) =>
			data.listWork(options),
		listOpen: async () =>
			(await data.listWork({ limit: 500 }))
				.filter((item) => OPEN_DISPOSITIONS.has(item.disposition))
				.map(({ id, title, disposition, workKind, priority }) => ({
					id,
					title,
					disposition,
					workKind,
					priority,
				})),
		create: (input: CreateWorkInput) =>
			data.createWork({ ...input, actorId: deps.actor.id }),
	};

	return {
		sheets: buildSheetBinding(deps),
		presentations: buildPresentationBinding(deps),
		documents: wrapBinding(documents, {
			...common,
			resource: "output",
			methods: {
				read: { riskTier: "read", blastRadius: "none" },
				replace: documentWrite,
				edit: documentWrite,
			},
		}),
		outputs: wrapBinding(outputs, {
			...common,
			resource: "output",
			methods: {
				list: { riskTier: "read", blastRadius: "none" },
				get: { riskTier: "read", blastRadius: "none" },
				create: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					after: async (_args: unknown[], result: unknown) =>
						revisionRef(result as OutputDetail),
				},
				revise: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					before: async (args: unknown[]) => {
						const input = args[0] as { outputId: string };
						return revisionRef(await data.getOutput(input.outputId));
					},
					after: async (_args: unknown[], result: unknown) =>
						revisionRef(result as OutputDetail),
					undo: (
						_args: unknown[],
						_result: unknown,
						before?: RevisionRef,
					): UndoPlan | undefined =>
						before
							? { kind: "rollback_revision", toRevision: before }
							: undefined,
				},
			},
		}),
		apps: wrapBinding(apps, {
			...common,
			resource: "app",
			methods: { list: { riskTier: "read", blastRadius: "none" } },
		}),
		resources: wrapBinding(resources, {
			...common,
			resource: "resource",
			methods: { list: { riskTier: "read", blastRadius: "none" } },
		}),
		work: wrapBinding(work, {
			...common,
			resource: "work",
			methods: {
				list: { riskTier: "read", blastRadius: "none" },
				listOpen: { riskTier: "read", blastRadius: "none" },
				create: { riskTier: "bounded_write", blastRadius: "single_resource" },
			},
		}),
	};
}
