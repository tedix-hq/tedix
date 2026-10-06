import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	EvidenceRow,
	EvidenceRowContent,
	EvidenceRowDetail,
	EvidenceRowSignal,
	EvidenceRowStatus,
} from "./evidence-row";

describe("EvidenceRow", () => {
	it("renders the requested element with every slot in place", () => {
		const html = renderToStaticMarkup(
			<EvidenceRow as="li">
				<EvidenceRowSignal>signal</EvidenceRowSignal>
				<EvidenceRowContent>content</EvidenceRowContent>
				<EvidenceRowStatus>status</EvidenceRowStatus>
				<EvidenceRowDetail>detail</EvidenceRowDetail>
			</EvidenceRow>,
		);

		expect(html).toContain('<li data-slot="evidence-row"');
		expect(html).toContain('data-slot="evidence-row-content"');
		expect(html).toContain('data-slot="evidence-row-detail"');
		expect(html).toContain("signal");
		expect(html).toContain("status");
	});
});
