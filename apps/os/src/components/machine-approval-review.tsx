import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const sensitiveKey =
	/(?:password|secret|token|authorization|credential|api[_-]?key|private[_-]?key|cookie)/i;

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
function fileTargets(value: unknown) {
	const args = isRecord(value) ? value : {};
	return [
		"path",
		"filePath",
		"paths",
		"filePaths",
		"sourcePath",
		"destinationPath",
	].flatMap((key) => {
		const value = args[key];
		const entries = Array.isArray(value) ? value : [value];
		return entries.filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
	});
}
export function exactFileQuestion(payload: unknown) {
	const data = machineApprovalData(payload);
	if (!data || !isRecord(data.args)) return null;
	const verbs: Record<string, string> = {
		read_file: "Read",
		read_files: "Read",
		artifact_read_file: "Read",
		delete_file: "Delete",
		delete_files: "Delete",
	};
	const verb = Object.hasOwn(verbs, data.tool) ? verbs[data.tool] : undefined;
	if (!verb) return null;
	const keys = Object.keys(data.args);
	if (
		keys.length !== 1 ||
		!["path", "paths", "filePath", "filePaths"].includes(keys[0]!)
	)
		return null;
	const raw = data.args[keys[0]!];
	const names = Array.isArray(raw) ? raw : [raw];
	if (
		!names.length ||
		!names.every(
			(value) =>
				typeof value === "string" &&
				value.trim() &&
				!value.split(/[\\/]/).some((part) => part === "." || part === "..") &&
				value !== "[redacted]" &&
				!/[?*{}\[\]\x00-\x1f]/.test(value) &&
				!/[\\/]$/.test(value),
		)
	)
		return null;
	return (
		verb +
		(names.length === 1 ? " this file?" : " these " + names.length + " files?")
	);
}
export function ApprovalFileTargets({ args }: { args: unknown }) {
	const paths = fileTargets(redactMachineApproval(args));
	if (!paths.length) return null;
	return (
		<div>
			<strong>Requested files and folders</strong>
			<ul>
				{paths.map((path, index) => (
					<li key={index}>
						<code className="break-all">{path}</code>
					</li>
				))}
			</ul>
		</div>
	);
}
export function MachineApprovalReview({ payload }: { payload: unknown }) {
	const data = machineApprovalData(payload);
	if (!data) return null;
	return (
		<section aria-label="Machine action details">
			<ApprovalFileTargets args={data.args} />
			<details open={!fileTargets(data.args).length}>
				<summary>Action details</summary>
				<p>Machine: {data.principal}</p>
				<p>Tool: {data.tool}</p>
				<p>Operation: {data.operation}</p>
				<p>Rule risk: {data.risk.replaceAll("_", " ")}</p>
				<p>Arguments (secret values are redacted):</p>
				<pre className="whitespace-pre-wrap break-words">
					{JSON.stringify(data.args, null, 2)}
				</pre>
			</details>
			<p>Permission applies once, to this exact action.</p>
		</section>
	);
}
