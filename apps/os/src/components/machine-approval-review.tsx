import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";

const sensitiveKey =
	/(?:password|secret|token|authorization|credential|api[_-]?key|private[_-]?key|cookie)/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Preserve useful arguments while never rendering values in credential fields. */
export function redactMachineApproval(
	value: unknown,
	key = "",
	depth = 0,
): unknown {
	if (sensitiveKey.test(key)) return "[redacted]";
	if (depth > 12) return "[too deeply nested to display]";
	if (typeof value === "string")
		return containsCardSecret(value) ? "[redacted]" : value;
	if (Array.isArray(value))
		return value.map((item) => redactMachineApproval(item, "", depth + 1));
	if (isRecord(value))
		return Object.fromEntries(
			Object.entries(value).map(([name, child]) => [
				name,
				redactMachineApproval(child, name, depth + 1),
			]),
		);
	return value;
}
export function machineApprovalData(payload: unknown) {
	if (!isRecord(payload) || payload.kind !== "mcp_machine_tool_call")
		return null;
	const descriptor = isRecord(payload.descriptor) ? payload.descriptor : {};
	const mount = isRecord(descriptor.mount) ? descriptor.mount : {};
	return {
		principal:
			typeof payload.principalId === "string" ? payload.principalId : "Unknown",
		tool:
			typeof mount.sourceToolId === "string" ? mount.sourceToolId : "Unknown",
		operation:
			typeof mount.endpoint === "string"
				? mount.endpoint
				: typeof mount.upstreamOperation === "string"
					? mount.upstreamOperation
					: "Unknown",
		risk: typeof payload.riskTier === "string" ? payload.riskTier : "Unknown",
		args: redactMachineApproval(payload.args ?? {}),
	};
}
export function MachineApprovalReview({ payload }: { payload: unknown }) {
	const data = machineApprovalData(payload);
	if (!data) return null;
	return (
		<section aria-label="Machine action details">
			<p>Machine: {data.principal}</p>
			<p>Tool: {data.tool}</p>
			<p>Operation: {data.operation}</p>
			<p>Rule risk: {data.risk.replaceAll("_", " ")}</p>
			<p>Arguments (secret values are redacted):</p>
			<pre className="whitespace-pre-wrap break-words">
				{JSON.stringify(data.args, null, 2)}
			</pre>
			<p>
				After approval, the same machine session must retry this exact call.
			</p>
		</section>
	);
}
