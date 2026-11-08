import { wrapBinding } from "@tedix/agent-governance/wrap-binding";
import type { RevisionRef, UndoPlan } from "@tedix/agent-governance/types";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { applyPresentationPatch } from "@tedix/api-contract/utils/presentation-patch";
import type { BindingDeps } from "./bindings";
import type { OutputDetail } from "./data-port";

export function buildPresentationBinding(deps: BindingDeps) {
	const read = async (input: { outputId: string }) => {
		const output = await deps.data.getOutput(input.outputId);
		if (!output || output.content?.kind !== "presentation")
			throw new Error("Presentation not found or unavailable");
		return { ...output, content: output.content };
	};
	const methods = {
		read,
		replace: async (input: {
			outputId: string;
			expectedRevision: number;
			content: unknown;
		}) => {
			await read(input);
			const content = OsOutputContentSchema.parse(input.content);
			if (content.kind !== "presentation")
				throw new Error("Expected presentation content");
			return deps.data.reviseOutput({
				...input,
				content,
				actorId: deps.actor.id,
			});
		},
		edit: async (input: {
			outputId: string;
			expectedRevision: number;
			ops: unknown;
		}) => {
			const current = await read(input);
			return deps.data.reviseOutput({
				outputId: input.outputId,
				expectedRevision: input.expectedRevision,
				content: applyPresentationPatch(current.content, input.ops),
				actorId: deps.actor.id,
			});
		},
	};
	const write = {
		riskTier: "bounded_write" as const,
		blastRadius: "single_resource" as const,
		before: async (args: unknown[]) => {
			const current = await deps.data.getOutput(
				(args[0] as { outputId: string }).outputId,
			);
			return current?.revisionId
				? { revisionId: current.revisionId }
				: undefined;
		},
		after: async (_args: unknown[], result: unknown) => {
			const output = result as OutputDetail;
			return output.revisionId ? { revisionId: output.revisionId } : undefined;
		},
		undo: (
			_args: unknown[],
			_result: unknown,
			before?: RevisionRef,
		): UndoPlan | undefined =>
			before ? { kind: "rollback_revision", toRevision: before } : undefined,
	};
	return wrapBinding(methods, {
		compliance: deps.compliance,
		accountability: deps.accountability,
		actor: deps.actor,
		source: deps.source,
		onRecorded: deps.onRecorded,
		resource: "output",
		methods: {
			read: { riskTier: "read", blastRadius: "none" },
			replace: write,
			edit: write,
		},
	});
}

export const PRESENTATION_BINDING_DECLARATION = `
/** Canonical presentations shared by Slides apps and the native editor. */
interface PresentationContent {kind:"presentation";slides:Array<{title:string;bullets:string[];notes?:string}>;deck?:unknown}
interface PresentationDetail extends OutputSummary {content:PresentationContent}
interface Presentations {
  read(input:{outputId:string}):Promise<PresentationDetail>;
  /** Preserve deck when replacing content; recorded and may require approval. */
  replace(input:{outputId:string;expectedRevision:number;content:PresentationContent}):Promise<PresentationDetail>;
  /** Ordered slide edits preserve canvas layout and revision history. */
  edit(input:{outputId:string;expectedRevision:number;ops:Array<{op:"insert"|"replace";index:number;slide:{title:string;bullets?:string[];notes?:string;canvas?:unknown}}|{op:"delete";index:number}|{op:"move";from:number;to:number}>}):Promise<PresentationDetail>;
}`.trim();
