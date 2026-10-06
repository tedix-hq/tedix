import { describe, expect, it } from "vite-plus/test";
import { splitConvertedPdf } from "./content-ingestion-pdf";

/**
 * `splitConvertedPdf` is the seam between `env.AI.toMarkdown` and what gets
 * written to R2, so the shapes below are copied from real conversions rather
 * than invented — `# <name>` / `## Metadata` / `## Contents`.
 */
describe("splitConvertedPdf", () => {
	const converted = [
		"# fw9.pdf",
		"## Metadata",
		"- PDFFormatVersion=1.7",
		"- Author=SE:W:CAR:MP",
		"- Title=Form W-9 (Rev. March 2024)",
		"- Producer=Designer 6.5",
		"",
		"## Contents",
		"### Page 1",
		"Request for Taxpayer Identification Number",
	].join("\n");

	it("takes the title from the PDF's own metadata", () => {
		const { title } = splitConvertedPdf(
			converted,
			"https://www.irs.gov/pub/irs-pdf/fw9.pdf",
		);
		expect(title).toBe("Form W-9 (Rev. March 2024)");
	});

	it("drops the metadata head so producer noise is not indexed as body", () => {
		const { body } = splitConvertedPdf(converted, "https://example.com/a.pdf");
		expect(body).toBe("### Page 1\nRequest for Taxpayer Identification Number");
		expect(body).not.toContain("PDFFormatVersion");
	});

	it("falls back to the URL filename when the PDF declares no title", () => {
		const noTitle = [
			"# dummy.pdf",
			"## Metadata",
			"- Producer=OpenOffice.org 2.1",
			"",
			"## Contents",
			"### Page 1",
			"Dummy PDF file",
		].join("\n");
		const { title } = splitConvertedPdf(
			noTitle,
			"https://example.com/docs/handbook.pdf",
		);
		expect(title).toBe("handbook.pdf");
	});

	it("treats an empty Title= as absent", () => {
		const emptyTitle = converted.replace(
			"- Title=Form W-9 (Rev. March 2024)",
			"- Title=   ",
		);
		const { title } = splitConvertedPdf(
			emptyTitle,
			"https://example.com/report.pdf",
		);
		expect(title).toBe("report.pdf");
	});

	it("keeps the whole document when there is no Contents marker", () => {
		const { title, body } = splitConvertedPdf(
			"Just text, no head at all.",
			"https://example.com/plain.pdf",
		);
		expect(body).toBe("Just text, no head at all.");
		expect(title).toBe("plain.pdf");
	});

	it("still yields a title when the URL has no filename segment", () => {
		const { title } = splitConvertedPdf(
			"## Contents\nbody",
			"https://example.com/",
		);
		expect(title).toBe("PDF Document");
	});
});
