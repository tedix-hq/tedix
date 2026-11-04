import * as z from "zod";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { boardErrorFromValue } from "./work-native";

export const RuntimeAppArtifactSchema = z.strictObject({
	workspaceId: z.uuid(),
	gadgetId: z.uuid(),
	revision: z.number().int().positive(),
	revisionId: z.uuid(),
});
export type RuntimeAppArtifact = z.infer<typeof RuntimeAppArtifactSchema>;
export interface RuntimeAppProof extends RuntimeAppArtifact {
	evidenceId: string;
	evidenceUri: string;
}
export class LaneRuntimeAppProofReadError extends Error {}

export function runtimeAppEvidenceUri(app: RuntimeAppArtifact): string {
	return `tedix://workspaces/${app.workspaceId}/gadgets/${app.gadgetId}/revisions/${app.revisionId}`;
}

/** Read only revision metadata into the dispatcher; tenant source stays remote. */
export async function runtimeAppRevisionProof(
	app: RuntimeAppArtifact,
	workItemId: string,
	attemptId: string,
	call: (args: string[]) => Promise<unknown>,
): Promise<RuntimeAppProof | undefined> {
	const read = async (args: string[]) => {
		try {
			const result = await call(args);
			const error = boardErrorFromValue(result);
			if (error) throw new Error(error.message);
			return result;
		} catch (error) {
			throw new LaneRuntimeAppProofReadError(String(error));
		}
	};
	const ledger = await read(["work", "evidence", workItemId, "--limit", "100"]);
	if (!isRecord(ledger) || !Array.isArray(ledger.data))
		throw new LaneRuntimeAppProofReadError(
			"Runtime app evidence ledger is unavailable",
		);
	const uri = runtimeAppEvidenceUri(app);
	const evidence = ledger.data.find(
		(row) =>
			isRecord(row) &&
			z.uuid().safeParse(row.id).success &&
			row.kind === "runtime_app_revision" &&
			row.attemptId === attemptId &&
			row.uri === uri,
	);
	if (!evidence) {
		if (ledger.nextCursor !== null)
			throw new LaneRuntimeAppProofReadError(
				"Complete runtime app evidence ledger is unavailable",
			);
		return undefined;
	}
	const readApp = async (
		tool: string,
		endpoint: string,
		input: unknown,
		projection: string,
	) => {
		const discovery = await read([
			"code",
			`async () => { const r = await discover.search({query:${codeModeLiteral(tool)},limit:3,includeMetadata:true}); return {tools:Array.isArray(r) ? r : r.results}; }`,
		]);
		const descriptor =
			isRecord(discovery) && Array.isArray(discovery.tools)
				? discovery.tools.find(
						(row) =>
							isRecord(row) &&
							row.authorized === true &&
							row.tool === tool &&
							isRecord(row.schemaFreshness) &&
							row.schemaFreshness.sourceRef === endpoint &&
							typeof row.callable === "string" &&
							/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(row.callable),
					)
				: undefined;
		if (!descriptor)
			throw new LaneRuntimeAppProofReadError(
				`Authorized ${endpoint} proof source is unavailable`,
			);
		return read([
			"code",
			`async () => { const r = await ${descriptor.callable}(${codeModeLiteral(input)}); if (r?.ok === false || r?.status >= 400) return r; ${projection} }`,
		]);
	};
	const scope = { workspaceId: app.workspaceId, gadgetId: app.gadgetId };
	const installed = await readApp(
		"get_os_gadget",
		"osWorkspaces/gadgets/get",
		scope,
		"return {gadget:r.gadget,currentRevision:r.currentRevision};",
	);
	if (
		!isRecord(installed) ||
		!isRecord(installed.gadget) ||
		!(installed.currentRevision === null || isRecord(installed.currentRevision))
	)
		throw new LaneRuntimeAppProofReadError(
			"Installed runtime app revision readback is unavailable",
		);
	const { gadget, currentRevision: revision } = installed;
	if (
		!revision ||
		gadget.id !== app.gadgetId ||
		gadget.workspaceId !== app.workspaceId ||
		gadget.status !== "active" ||
		gadget.currentRevisionId !== app.revisionId ||
		revision.id !== app.revisionId ||
		revision.gadgetId !== app.gadgetId ||
		typeof gadget.organizationId !== "string" ||
		revision.organizationId !== gadget.organizationId ||
		revision.revision !== app.revision ||
		!isRecord(revision.manifest) ||
		revision.manifest.entry !== "tedix:runtime/v1"
	)
		return undefined;
	const result = await readApp(
		"gadgets_get_code",
		"osWorkspaces/gadgets/getCode",
		scope,
		'return {code:r.code === null ? null : {revisionId:r.code.revisionId,revision:r.code.revision,codeLength:r.code.codeLength,hasServer:typeof r.code.files?.["server.js"] === "string",hasClient:typeof r.code.files?.["client.js"] === "string"}};',
	);
	if (!isRecord(result) || !(result.code === null || isRecord(result.code)))
		throw new LaneRuntimeAppProofReadError(
			"Runtime app code readback is unavailable",
		);
	if (
		!result.code ||
		result.code.revisionId !== app.revisionId ||
		result.code.revision !== app.revision ||
		!Number.isInteger(result.code.codeLength) ||
		Number(result.code.codeLength) <= 0 ||
		result.code.hasServer !== true ||
		result.code.hasClient !== true
	)
		return undefined;
	return { ...app, evidenceId: evidence.id, evidenceUri: uri };
}
