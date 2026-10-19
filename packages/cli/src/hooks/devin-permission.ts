import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { devinPermissionProfile } from "../devin-config";
import { devinSecretPaths } from "../devin-lane-security";
import { isObject } from "./hook-io";

function canonical(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	if (parent === path) return path;
	return resolve(canonical(parent), relative(parent, path));
}

/** Deterministic tool fence; the mandatory OS sandbox also covers indirect runtime reads. */
export function devinPermissionBlock(
	raw: string,
	root: string,
): string | undefined {
	const event = JSON.parse(raw);
	if (!isObject(event) || !isObject(event.tool_input))
		return "Malformed Devin tool event";
	const input = event.tool_input;
	const profile = devinPermissionProfile(root, {
		id: process.env.TEDIX_AGENT_SESSION?.replace(/^devin:/, "") ?? "",
		principalKey: process.env.TEDIX_EXTERNAL_AGENT,
	});
	const base = realpathSync(root);
	const protectedPaths = profile.permissions.deny
		.filter(
			(rule) =>
				rule.startsWith("Read(") ||
				(event.tool_name !== "read" && rule.startsWith("Write(")),
		)
		.map((rule) => {
			const pattern = rule
				.slice(rule.indexOf("(") + 1, -1)
				.replace(/^~\//, homedir() + "/");
			return pattern.startsWith("**/") ? pattern : canonical(pattern);
		});
	const protectedPath = (path: string) => {
		const target = canonical(
			resolve(base, path.replace(/^~\//, homedir() + "/")),
		);
		return protectedPaths.some((pattern) =>
			new Bun.Glob(pattern).match(target),
		);
	};
	if (["read", "write", "edit"].includes(event.tool_name)) {
		const path = input.path ?? input.file_path;
		if (typeof path !== "string")
			return "File tool did not expose its target path";
		if (protectedPath(path))
			return "Lane configuration and secrets are protected";
		const target = canonical(
			resolve(base, path.replace(/^~\//, homedir() + "/")),
		);
		if (
			event.tool_name !== "read" &&
			target !== base &&
			!target.startsWith(base + sep)
		)
			return "Writes must stay inside the lane worktree";
	}
	if (event.tool_name === "exec") {
		if (typeof input.command !== "string")
			return "Exec tool did not expose its command";
		const command = input.command.trim();
		// Do not let Smart mode expand the explicit prefix scope via shell syntax.
		if (/[;&|<>`$\n\r]/.test(command))
			return "Compound or expanded shell commands are outside the lane exec scope";
		const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		if (words.some((word) => protectedPath(word.replace(/^['"]|['"]$/g, ""))))
			return "Lane configuration and secrets are protected";
		if (
			devinSecretPaths().some((path) =>
				command.includes(path.replace(/\/\*\*$/, "")),
			) ||
			/(?:^|[\s/.'"])\.(?:ssh|config|aws|azure|kube|gnupg|devin|claude)(?:[/'"]|$)|\.env(?:[.\s'"/]|$)|\.dev\.vars/.test(
				command,
			)
		)
			return "Lane configuration and secrets are protected";
		if (
			/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:--force(?:-with-lease)?\b|(?:^|\s)-[a-z]*f\b)|\btedix\b[^\n;&|]*\blogin\b|\bwrangler\b[^\n;&|]*\bdeploy\b/.test(
				input.command,
			)
		)
			return "Force pushes, Tedix login and Wrangler deploy are forbidden in lanes";
		const matches = (rule: string) => {
			if (!rule.startsWith("Exec(")) return false;
			const prefix = rule.slice(5, -1);
			return command === prefix || command.startsWith(prefix + " ");
		};
		if (
			profile.permissions.deny.some(matches) ||
			!profile.permissions.allow.some(matches)
		)
			return "Command is outside the lane exec scope";
	}
	return undefined;
}
