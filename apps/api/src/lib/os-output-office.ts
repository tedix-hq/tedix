/**
 * Office exports of a Tedix OS output, generated from the content model.
 *
 * The rendered formats (pdf, png) go through Browser Rendering because they
 * are pictures of a laid-out page. These three are the opposite: nothing is
 * rendered, the revision body is written directly as OOXML, so a spreadsheet
 * arrives as cells and formulas rather than as an image of a grid.
 *
 * Everything under `./ooxml` is dependency-free and uses only platform APIs
 * (`TextEncoder`, `Blob`, `CompressionStream`), all of which workerd
 * implements — no Node `zlib`, `fs`, `Buffer` or stream shim is reachable from
 * this path.
 */

import type {
	OsOutputContent,
	OsOutputExportFormat,
} from "@tedix/api-contract/schemas/os-workspaces";
import { buildDocx } from "./ooxml/docx";
import { buildPptx } from "./ooxml/pptx";
import { buildXlsx } from "./ooxml/xlsx";

export type OsOfficeExportFormat = Extract<
	OsOutputExportFormat,
	"xlsx" | "docx" | "pptx"
>;

/**
 * Write one Office file for a revision body.
 *
 * The caller has already checked that the format applies to the output's kind;
 * the mismatch branches here exist so a future kind cannot silently produce an
 * empty file.
 */
export async function buildOsOutputOfficeExport(
	format: OsOfficeExportFormat,
	content: OsOutputContent,
	title: string,
): Promise<Uint8Array> {
	if (format === "xlsx") {
		if (content.kind !== "sheet") {
			throw new Error(`xlsx export needs a sheet body, got ${content.kind}`);
		}
		return buildXlsx(content);
	}
	if (format === "docx") {
		if (content.kind !== "document") {
			throw new Error(`docx export needs a document body, got ${content.kind}`);
		}
		return buildDocx(content, title);
	}
	if (content.kind !== "presentation") {
		throw new Error(
			`pptx export needs a presentation body, got ${content.kind}`,
		);
	}
	return buildPptx(content);
}
