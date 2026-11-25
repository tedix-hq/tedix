import * as z from "zod";

export const effortSchema = z.enum([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"model-default",
]);
export const permissionSchema = z.strictObject({
	sandbox: z
		.enum(["read-only", "workspace-write", "danger-full-access"])
		.optional(),
	approval: z
		.enum(["untrusted", "on-failure", "on-request", "never"])
		.optional(),
	mode: z.string().min(1).optional(),
});
export interface LaneExecutionSettings {
	effort?: z.infer<typeof effortSchema>;
	permission?: z.infer<typeof permissionSchema>;
}

/** Resolve once from the route, never from the owner's harness settings. */
export function executionSettings(
	executor: string,
	settings: LaneExecutionSettings = {},
): LaneExecutionSettings {
	const effort =
		settings.effort ?? (executor === "devin" ? "model-default" : "medium");
	const permission = settings.permission ?? {};
	const invalid = (message: string): never => {
		throw new Error(`${executor}: ${message}`);
	};
	if (executor === "codex") {
		if (["max", "model-default"].includes(effort) || permission.mode)
			invalid(
				"unsupported effort or permission mode; use sandbox and approval",
			);
		return {
			effort,
			permission: {
				sandbox: permission.sandbox ?? "workspace-write",
				approval: permission.approval ?? "never",
			},
		};
	}
	if (permission.sandbox || permission.approval)
		invalid("sandbox and approval fields are only supported by Codex");
	if (executor === "claude-code") {
		if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
			invalid("unsupported effort");
		const mode = permission.mode ?? "auto";
		if (
			![
				"default",
				"acceptEdits",
				"plan",
				"auto",
				"dontAsk",
				"bypassPermissions",
			].includes(mode)
		)
			invalid("unsupported permission mode");
		return { effort, permission: { mode } };
	}
	if (executor === "opencode") {
		const mode = permission.mode ?? "auto";
		if (!["auto", "reject"].includes(mode))
			invalid("permission mode must be auto or reject");
		if (effort === "model-default")
			invalid("choose an explicit model variant as effort");
		return { effort, permission: { mode } };
	}
	if (executor === "devin") {
		// Devin exposes thinking levels interactively, but no documented launch override.
		if (effort !== "model-default")
			invalid("Devin has no supported effort launch flag; use model-default");
		const mode = permission.mode ?? "normal";
		if (
			!["normal", "accept-edits", "smart", "dangerous", "autonomous"].includes(
				mode,
			)
		)
			invalid("unsupported permission mode");
		return { effort, permission: { mode } };
	}
	if (settings.effort || settings.permission)
		invalid("execution settings are not supported");
	return {};
}

export function executionFlags(
	executor: string,
	settings: LaneExecutionSettings = {},
) {
	const resolved = executionSettings(executor, settings);
	if (executor === "codex")
		return [
			"-c",
			`model_reasoning_effort=${JSON.stringify(resolved.effort)}`,
			"-c",
			`sandbox_mode=${JSON.stringify(resolved.permission!.sandbox)}`,
			"-c",
			`approval_policy=${JSON.stringify(resolved.permission!.approval)}`,
		];
	if (executor === "claude-code")
		return [
			"--effort",
			resolved.effort!,
			"--permission-mode",
			resolved.permission!.mode!,
		];
	if (executor === "devin")
		return ["--permission-mode", resolved.permission!.mode!];
	if (executor === "opencode")
		return resolved.permission!.mode === "auto" ? ["--auto"] : [];
	return [];
}
