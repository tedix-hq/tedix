import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { isObject } from "./hook-io";

function canonical(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	if (parent === path) return path;
	return resolve(canonical(parent), relative(parent, path));
}

/** File-tool fence; arbitrary approved runtime code still requires trusted repository contents. */
export function devinPermissionBlock(
	raw: string,
	root: string,
): string | undefined {
	const event = JSON.parse(raw);
	if (!isObject(event) || !isObject(event.tool_input))
		return "Malformed Devin tool event";
	const input = event.tool_input;
	if (["write", "edit"].includes(event.tool_name)) {
		const path = input.path ?? input.file_path;
		if (typeof path !== "string")
			return "Write tool did not expose its target path";
		const base = realpathSync(root);
		const target = canonical(resolve(base, path));
		if (target !== base && !target.startsWith(base + sep))
			return "Writes must stay inside the lane worktree";
		if (
			/(?:^|\/)\.(?:devin|ssh)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.dev.vars$/.test(
				target,
			)
		)
			return "Lane configuration and secrets are protected";
	}
	if (event.tool_name === "exec") {
		if (typeof input.command !== "string")
			return "Exec tool did not expose its command";
		if (
			/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:--force(?:-with-lease)?\b|(?:^|\s)-[a-z]*f\b)|\btedix\b[^\n;&|]*\blogin\b|\bwrangler\b[^\n;&|]*\bdeploy\b/.test(
				input.command,
			)
		)
			return "Force pushes, Tedix login and Wrangler deploy are forbidden in lanes";
	}
	return undefined;
}
