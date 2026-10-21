import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";

export function readOsBuildSha(environment: NodeJS.ProcessEnv): string {
	const sha = (
		environment.TEDIX_BUILD_SHA ||
		environment.GIT_SHA ||
		environment.GITHUB_SHA ||
		execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
	).trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
		throw new Error("OS build requires a full Git SHA");
	}
	return sha;
}

export function osVersionPlugin(sha: string): Plugin {
	const source = JSON.stringify({ sha });
	return {
		name: "tedix-os-version",
		generateBundle() {
			if (this.environment.name === "client") {
				this.emitFile({ type: "asset", fileName: "version.json", source });
			}
		},
		configureServer(server) {
			server.middlewares.use("/version.json", (_request, response) => {
				response.setHeader("Content-Type", "application/json");
				response.setHeader("Cache-Control", "no-store");
				response.end(source);
			});
		},
	};
}
