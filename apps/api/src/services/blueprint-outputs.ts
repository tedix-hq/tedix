import type {
	OsBlueprintDefinition,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { InstantiateOsBlueprintParams } from "@tedix/db/queries/os-workspaces/instantiate";
import { canonicalDigest } from "../lib/blueprint-digest";

/** Stable identities let instance-key apply retries use the same output bindings. */
export async function buildBlueprintOutputRows(
	definition: OsBlueprintDefinition,
	workspace: InstantiateOsBlueprintParams["workspace"],
	gadgets: InstantiateOsBlueprintParams["gadgets"],
) {
	const outputs: NonNullable<InstantiateOsBlueprintParams["outputs"]> = [];
	const outputRevisions: NonNullable<
		InstantiateOsBlueprintParams["outputRevisions"]
	> = [];
	const resources: NonNullable<InstantiateOsBlueprintParams["resources"]> = [];
	const creator = {
		organizationId: workspace.organizationId,
		createdByKind: workspace.createdByKind,
		createdById: workspace.createdById,
		createdAt: workspace.createdAt,
	};
	async function identity(slot: string, kind: string) {
		const digest = await canonicalDigest([
			workspace.organizationId,
			workspace.id,
			"output",
			slot,
			kind,
		]);
		return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
	}
	for (const [index, output] of (
		definition.requirements?.outputs ?? []
	).entries()) {
		const gadget = gadgets.find((app) => app.name === output.gadget);
		if (!gadget) throw new Error(`Unknown producing app: ${output.gadget}`);
		const slot = output.slot ?? `output_${index + 1}`;
		const id = await identity(slot, "output");
		const revisionId = await identity(slot, "revision");
		const content: OsOutputContent =
			output.kind === "document"
				? { kind: "document", blocks: [] }
				: output.kind === "sheet"
					? { kind: "sheet", columns: [], rows: [] }
					: { kind: "presentation", slides: [] };
		outputs.push({
			...creator,
			id,
			workspaceId: workspace.id,
			kind: output.kind,
			title: output.title,
			currentRevisionId: revisionId,
			updatedAt: workspace.updatedAt,
		});
		outputRevisions.push({
			...creator,
			id: revisionId,
			outputId: id,
			revision: 1,
			content: JSON.stringify(content),
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		});
		resources.push({
			...creator,
			id: await identity(slot, "resource"),
			workspaceId: workspace.id,
			slot,
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "output",
			providerResourceId: id,
			name: output.title,
			metadata: JSON.stringify({ gadgetId: gadget.id, kind: output.kind }),
			updatedAt: workspace.updatedAt,
		});
	}
	return { outputs, outputRevisions, resources };
}
