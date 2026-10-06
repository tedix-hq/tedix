import { describe, expect, it } from "vite-plus/test";

import {
	buildCmsPublishReceipt,
	type CmsPublishReceiptInput,
} from "./publish-receipt";

const commit = "a".repeat(40);
const siteId = "11111111-1111-4111-8111-111111111111";
const jobId = `cms-${siteId}-e0-v39-s${commit}`;

function validInput(): CmsPublishReceiptInput {
	return {
		orgSlug: "tedix-landing",
		siteId,
		restoreEpoch: 0,
		jobId,
		deploy: {
			jobId,
			status: "complete",
			output: { version: 39, url: "https://tedix-landing.cms.tedix.dev" },
		},
		versions: [
			{
				version: 39,
				active: true,
				sourceRevision: { kind: "artifacts_commit", value: commit },
			},
		],
		expectedSourceCommit: commit,
		routeHealth: {
			ok: true,
			checkedAt: "2026-09-27T10:00:00.000Z",
			routes: [
				{
					path: "/",
					url: "https://tedix.dev/",
					status: 200,
					ok: true,
					title: "Tedix — Agents you can hold accountable",
					h1: "Agents you can hold accountable",
					canonical: "https://tedix.dev/",
					lang: "en",
				},
			],
		},
	};
}

describe("CMS publish receipt", () => {
	it("reports a source-pinned deployment ready only with an active bundle and live route proof", () => {
		expect(buildCmsPublishReceipt(validInput())).toMatchObject({
			jobId,
			status: "complete",
			deployedVersion: 39,
			activeVersion: 39,
			sourceRevision: { kind: "artifacts_commit", value: commit },
			ready: true,
			issues: [],
		});
	});

	it("accepts a current site generation without an Artifacts source", () => {
		const input = validInput();
		input.jobId = `cms-${siteId}-e0-v39`;
		input.deploy.jobId = input.jobId;
		input.expectedSourceCommit = undefined;
		input.versions[0]!.sourceRevision = {
			kind: "editable_source_digest",
			value: "b".repeat(64),
		};
		expect(buildCmsPublishReceipt(input).ready).toBe(true);
	});

	it("does not call a queued Workflow published, even when the prior bundle and routes are healthy", () => {
		const input = validInput();
		input.deploy = { jobId, status: "running" };
		expect(buildCmsPublishReceipt(input)).toMatchObject({
			ready: false,
			deployedVersion: null,
			issues: ["Deploy job is running, not complete"],
		});
	});

	it("detects a completed deployment superseded by rollback or another release", () => {
		const input = validInput();
		input.versions[0]!.active = false;
		input.versions.push({
			version: 38,
			active: true,
			sourceRevision: { kind: "editable_source_digest", value: "b".repeat(64) },
		});
		expect(buildCmsPublishReceipt(input)).toMatchObject({
			activeVersion: 38,
			ready: false,
			issues: ["Deployed bundle is no longer active"],
		});
	});

	it("rejects a wrong source and a broken public route despite terminal Workflow success", () => {
		const input = validInput();
		input.versions[0]!.sourceRevision = {
			kind: "artifacts_commit",
			value: "b".repeat(40),
		};
		input.routeHealth!.routes[0]!.ok = false;
		input.routeHealth!.ok = false;
		const receipt = buildCmsPublishReceipt(input);
		expect(receipt.ready).toBe(false);
		expect(receipt.issues).toContain(
			"Deployed source does not match the pinned job commit",
		);
		expect(receipt.issues).toContain(
			"Deployed source does not match the expected commit",
		);
		expect(receipt.issues).toContain(
			"Public route checks are missing or failed",
		);
	});

	it("requires at least one checked public route", () => {
		const input = validInput();
		input.routeHealth = { ok: true, checkedAt: "now", routes: [] };
		expect(buildCmsPublishReceipt(input).ready).toBe(false);
	});

	it("rejects a cross-tenant or mismatched job receipt", () => {
		const input = validInput();
		input.jobId = `cms-22222222-2222-4222-8222-222222222222-e0-v39-s${commit}`;
		expect(() => buildCmsPublishReceipt(input)).toThrow(
			"Deploy job does not belong to this CMS tenant",
		);
		input.jobId = jobId;
		input.deploy.jobId = `cms-${siteId}-e0-v40-s${commit}`;
		expect(() => buildCmsPublishReceipt(input)).toThrow(
			"Deploy status belongs to a different job",
		);
	});

	it("rejects a job from an earlier restore epoch or legacy slug-only identity", () => {
		const input = validInput();
		input.restoreEpoch = 1;
		expect(() => buildCmsPublishReceipt(input)).toThrow(
			"Deploy job does not belong to this CMS tenant",
		);
		input.restoreEpoch = 0;
		input.jobId = `cms-deploy-tedix-landing-v39-s${commit.slice(0, 12)}`;
		expect(() => buildCmsPublishReceipt(input)).toThrow(
			"Deploy job does not belong to this CMS tenant",
		);
	});

	it("fails when the Workflow version differs from the admitted generation", () => {
		const input = validInput();
		input.deploy.output = { version: 40, url: "https://tedix.dev" };
		expect(buildCmsPublishReceipt(input)).toMatchObject({
			ready: false,
			issues: [
				"Deploy result version does not match its job ID",
				"Deployed bundle is absent from version history",
			],
		});
	});
});
