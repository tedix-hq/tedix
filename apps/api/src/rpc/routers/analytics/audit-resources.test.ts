import { describe, expect, it } from "vite-plus/test";
import {
	toolIdCandidatesForAuditResource,
	namespaceSlugCandidatesForAuditResource,
} from "./audit-resources";

describe("audit resource candidates", () => {
	it("derives aggregate audit tool lookup candidates", () => {
		expect(
			toolIdCandidatesForAuditResource("notion-tedix__notion-fetch"),
		).toEqual(["notion-tedix__notion-fetch", "notion-fetch", "notion_fetch"]);
		expect(
			toolIdCandidatesForAuditResource("tedi:cto:workstation_run_job"),
		).toEqual([
			"tedi:cto:workstation_run_job",
			"workstation_run_job",
			"workstation-run-job",
		]);
		expect(
			toolIdCandidatesForAuditResource("cms_globex__content_compare"),
		).toEqual([
			"cms_globex__content_compare",
			"content_compare",
			"content-compare",
		]);
		expect(
			namespaceSlugCandidatesForAuditResource("cms_globex__content_compare"),
		).toEqual(["cms_globex", "cms-globex"]);
		expect(
			namespaceSlugCandidatesForAuditResource("tedi:cto:workstation_run_job"),
		).toEqual(["cto"]);
		expect(namespaceSlugCandidatesForAuditResource("code")).toEqual([]);
	});
});
