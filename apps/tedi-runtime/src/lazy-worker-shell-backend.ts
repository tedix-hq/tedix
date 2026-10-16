import type { WorkspaceBackend } from "@cloudflare/computer";
import type { WorkerShellBackendOptions } from "@cloudflare/computer/backends/worker-shell";

/** Load the shell and its embedded modules only when a workspace connects it. */
export function lazyWorkerShellBackend(
	options: WorkerShellBackendOptions,
): WorkspaceBackend {
	if (options.source === undefined) {
		if (
			options.loader === undefined ||
			options.workspace === undefined ||
			options.ctx === undefined
		)
			throw new Error(
				"WorkerShellBackend requires `source` or all of `loader`, `workspace`, and `ctx`.",
			);
	} else if (
		options.loader !== undefined ||
		options.workspace !== undefined ||
		options.ctx !== undefined
	) {
		throw new Error(
			"WorkerShellBackend cannot combine `source` with loader options.",
		);
	}
	let backend:
		| Promise<
				import("@cloudflare/computer/backends/worker-shell").WorkerShellBackend
		  >
		| undefined;
	return {
		id: options.id ?? "worker-shell",
		type: "worker-shell",
		// Preserve the native backend's tool description before it is loaded.
		description:
			"A just-bash shell in a Dynamic Worker. Starts fast, with no container and no direct network. Good for cat, grep, sed, awk, jq, head, tail, sort, find, text transformations, and a built-in `git` (clone, status, diff, log) that works through the workspace. Cannot run npm, node, python, or binaries outside its built-in command set.",
		async connect() {
			backend ??= import("@cloudflare/computer/backends/worker-shell").then(
				({ WorkerShellBackend }) => new WorkerShellBackend(options),
			);
			return (await backend).connect();
		},
	};
}
