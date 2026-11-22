import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { WorkspaceScope } from "./env";

export function gadgetExecutionOutputKey(
	scope: WorkspaceScope,
	executionId: string,
	sha256: string,
) {
	return `workspace-gadget-execution-outputs/v1/${encodeURIComponent(scope.organizationId)}/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(executionId)}/${sha256}.json`;
}

export async function readGadgetExecutionBody(
	bucket: R2Bucket,
	scope: WorkspaceScope,
	executionId: string,
	sha256: string,
) {
	if (!/^[a-f0-9]{64}$/.test(sha256))
		throw new Error("Invalid workspace output digest");
	// Keep the original workspace address, even after deletion or recovery.
	const stored = await bucket.get(
		gadgetExecutionOutputKey(scope, executionId, sha256),
	);
	if (!stored) throw new Error("Workspace execution output not found");
	const output = await stored.text();
	if ((await sha256Hex(output)) !== sha256)
		throw new Error("Workspace execution output verification failed");
	return output;
}

export async function copyGadgetExecutionBody(
	bucket: R2Bucket,
	scope: WorkspaceScope,
	executionId: string,
	output: string,
) {
	const body = new TextEncoder().encode(output);
	const sha256 = await sha256Hex(body);
	await bucket.put(gadgetExecutionOutputKey(scope, executionId, sha256), body, {
		onlyIf: { etagDoesNotMatch: "*" },
		sha256,
		httpMetadata: { contentType: "application/json" },
	});
	if (
		(await readGadgetExecutionBody(bucket, scope, executionId, sha256)) !==
		output
	) {
		throw new Error("Workspace execution output verification failed");
	}
	return { sha256, bytes: body.byteLength };
}
