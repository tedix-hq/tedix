import { describe, expect, test } from "bun:test";
import {
	ALLOWED_EDITOR_FILES,
	ALLOWED_KINDS,
	editorFiles,
	findings,
	outputKinds,
} from "./lint-output-kinds.ts";

const kindsSource = (kinds: string[]) =>
	`export const OsOutputKindSchema = z.enum([\n${kinds.map((kind) => `\t"${kind}",`).join("\n")}\n]);`;

describe("output kind boundary", () => {
	test("passes the current kinds and editors", () => {
		const kinds = outputKinds(kindsSource(Object.keys(ALLOWED_KINDS)));
		expect(findings(kinds, Object.keys(ALLOWED_EDITOR_FILES))).toEqual([]);
	});

	test("fails a new Output kind without a decision reference", () => {
		const kinds = outputKinds(
			kindsSource([...Object.keys(ALLOWED_KINDS), "whiteboard"]),
		);
		expect(findings(kinds, [])).toEqual([
			expect.stringContaining('Output kind "whiteboard"'),
		]);
	});

	test("fails a new Output editor route or module", () => {
		const editors = editorFiles([
			"apps/os/src/routes/_session/_tenant/outputs_.$outputId.board.tsx",
			"apps/os/src/components/output-editor-board.tsx",
			"apps/os/src/components/output-editor-board.test.tsx",
			"apps/os/src/components/outputs-page.tsx",
			"apps/os/src/routes/_session/_tenant/workspaces.tsx",
		]);
		expect(editors).toEqual([
			"apps/os/src/routes/_session/_tenant/outputs_.$outputId.board.tsx",
			"apps/os/src/components/output-editor-board.tsx",
		]);
		expect(findings([], editors)).toHaveLength(2);
	});
});
