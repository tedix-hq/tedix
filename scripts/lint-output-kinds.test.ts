import { describe, expect, test } from "bun:test";
import {
	ALLOWED_OUTPUT_ROUTES,
	ALLOWED_KINDS,
	editorFiles,
	findings,
	outputKinds,
} from "./lint-output-kinds.ts";

const kindsSource = (kinds: string[]) =>
	`export const OsOutputKindSchema = z.enum([\n${kinds.map((kind) => `\t"${kind}",`).join("\n")}\n]);`;

describe("output kind boundary", () => {
	test("passes the current kinds and output routes", () => {
		const kinds = outputKinds(kindsSource(Object.keys(ALLOWED_KINDS)));
		expect(findings(kinds, Object.keys(ALLOWED_OUTPUT_ROUTES))).toEqual([]);
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

	test("fails any native editor module", () => {
		const file = "apps/os/src/components/output-editor.tsx";
		expect(findings([], [file])).toEqual([
			expect.stringContaining("no native Output editor"),
		]);
	});
});
