import { expect, it } from "vite-plus/test";
import { OFFICE_EDITOR_VERSIONS } from "../../../packages/api-contract/src/assets/office-editor-versions";
import clientShas from "../../../packages/api-contract/src/assets/office-editor-client-shas.json";
import { assertOfficeEditorVersion } from "./office-editor-build";

it.each(["document", "sheet", "presentation"] as const)(
	"requires a new recorded version for a changed %s client",
	(editor) => {
		const version = OFFICE_EDITOR_VERSIONS[editor];
		const versions: Record<string, string> = clientShas[editor];
		const changedSha = "a".repeat(64);
		expect(() =>
			assertOfficeEditorVersion(editor, versions[version]!),
		).not.toThrow();
		expect(() => assertOfficeEditorVersion(editor, changedSha)).toThrow(
			"Bump its OFFICE_EDITOR_VERSIONS version",
		);
		expect(() =>
			assertOfficeEditorVersion(editor, changedSha, version + 1),
		).toThrow();
		const upgraded = { ...versions, [version + 1]: changedSha };
		expect(() =>
			assertOfficeEditorVersion(editor, changedSha, version + 1, upgraded),
		).not.toThrow();
		expect(() =>
			assertOfficeEditorVersion(editor, changedSha, version, upgraded),
		).toThrow();
	},
);
