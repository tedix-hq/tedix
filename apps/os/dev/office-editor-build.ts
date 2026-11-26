import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";
import { OFFICE_EDITOR_VERSIONS } from "../../../packages/api-contract/src/assets/office-editor-versions";
import clientShas from "../../../packages/api-contract/src/assets/office-editor-client-shas.json";

export function assertOfficeEditorVersion(
	editor: keyof typeof OFFICE_EDITOR_VERSIONS,
	sha256: string,
	version: number = OFFICE_EDITOR_VERSIONS[editor],
	versions: Readonly<Record<string, string>> = clientShas[editor],
) {
	if (versions[version] !== sha256) {
		throw new Error(
			`${editor} client SHA-256 ${sha256} is not recorded for blueprint version ${version}. ` +
				"Bump its OFFICE_EDITOR_VERSIONS version and append the new version and SHA to " +
				"packages/api-contract/src/assets/office-editor-client-shas.json; preserve existing entries.",
		);
	}
}

export function officeEditorBuildPlugin(): Plugin {
	return {
		name: "tedix-office-editor-versions",
		apply: "build",
		buildStart() {
			for (const editor of ["doc", "sheet", "slides"]) {
				execFileSync(
					"bun",
					[
						fileURLToPath(
							new URL(`../scripts/build-${editor}-client.ts`, import.meta.url),
						),
						"--check",
					],
					{ stdio: "inherit" },
				);
			}
		},
	};
}
