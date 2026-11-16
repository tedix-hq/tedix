import { describe, expect, it } from "vite-plus/test";
import { deriveSkillDocumentUse } from "./skill-documents";

describe("deriveSkillDocumentUse", () => {
	it("reads documents and sheets from tool names", () => {
		const use = deriveSkillDocumentUse({
			content: "x",
			tools: [
				"os.get_os_output",
				"os.set_os_sheet_range",
				"os.patch_os_document",
				"github.list_issues",
			],
		});
		expect(use).toEqual([
			{ kind: "document", access: "reads" },
			{ kind: "sheet", access: "writes" },
			{ kind: "document", access: "writes" },
		]);
	});

	it("says nothing when no document call is named", () => {
		expect(deriveSkillDocumentUse({ content: "x" })).toEqual([]);
	});
});
