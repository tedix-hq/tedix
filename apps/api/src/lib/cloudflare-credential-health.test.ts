import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { getAlertState } from "@tedix/db/queries/ops-alert-state";
import { opsAlertState } from "@tedix/db/schema/ops-alert-state";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { GatewayIngestionResult } from "../jobs/gateway-cost-ingestion";
import {
	classifyCloudflareCredentialProbe,
	CLOUDFLARE_CREDENTIAL_CONDITION_KEY,
	CLOUDFLARE_CREDENTIAL_REMEDIATION_URL,
	reconcileCloudflareCredentialFinding,
} from "./cloudflare-credential-health";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(opsAlertState));
	return createDbClient(createD1Facade(sqlite));
}

function result(
	gatewayId: GatewayIngestionResult["gatewayId"],
	failure: string | null,
): GatewayIngestionResult {
	return { gatewayId, failure, ingested: 0, skipped: 0 };
}

const alertEnv = {} as CloudflareEnv;

describe("Cloudflare credential health", () => {
	it("classifies account-path and token failures without retaining raw errors", () => {
		const probe = classifyCloudflareCredentialProbe([
			result(
				"tedix-llm-production",
				"7003: route missing for account secret-value-that-must-not-survive",
			),
			result("default", "9106: Authentication failed token=also-secret"),
		]);
		expect(probe).toMatchObject({
			status: "firing",
			finding: {
				workerName: "tedix-api-production",
				bindingNames: ["CF_ACCOUNT_ID", "CF_AI_GATEWAY_TOKEN"],
				gatewayIds: ["default", "tedix-llm-production"],
				remediationUrl: CLOUDFLARE_CREDENTIAL_REMEDIATION_URL,
			},
		});
		if (probe.status !== "firing") throw new Error("expected finding");
		expect(probe.finding.detail).not.toContain("secret-value");
		expect(probe.finding.detail).not.toContain("also-secret");
	});

	it("creates one finding, refreshes its last-seen time, then resolves after repair", async () => {
		const db = fixture();
		const failure = [
			result("tedix-llm-production", "7000: no route for that account"),
			result("default", "7003: route missing"),
		];
		const firstSeen = "2026-08-09T05:00:00.000Z";
		const lastSeen = "2026-08-09T05:15:00.000Z";
		const repairedAt = "2026-08-09T05:30:00.000Z";

		await expect(
			reconcileCloudflareCredentialFinding(db, alertEnv, failure, firstSeen),
		).resolves.toMatchObject({ lifecycle: "new" });
		await expect(
			reconcileCloudflareCredentialFinding(db, alertEnv, failure, lastSeen),
		).resolves.toMatchObject({ lifecycle: "ongoing" });

		const open = await getAlertState(db, CLOUDFLARE_CREDENTIAL_CONDITION_KEY);
		expect(open).toMatchObject({
			status: "open",
			firstSeenAt: firstSeen,
			lastSeenAt: lastSeen,
			notifyCount: 1,
		});
		expect(open?.detail).toContain("worker=tedix-api-production");
		expect(open?.detail).toContain("bindings=CF_ACCOUNT_ID");
		expect(open?.detail).toContain(CLOUDFLARE_CREDENTIAL_REMEDIATION_URL);

		await expect(
			reconcileCloudflareCredentialFinding(
				db,
				alertEnv,
				[result("tedix-llm-production", null), result("default", null)],
				repairedAt,
			),
		).resolves.toMatchObject({ lifecycle: "resolved" });
		await expect(
			getAlertState(db, CLOUDFLARE_CREDENTIAL_CONDITION_KEY),
		).resolves.toMatchObject({ status: "resolved", lastSeenAt: repairedAt });
	});

	it("does not clear an open finding on an indeterminate provider failure", async () => {
		const db = fixture();
		await reconcileCloudflareCredentialFinding(
			db,
			alertEnv,
			[result("default", "9106: Authentication failed")],
			"2026-08-09T05:00:00.000Z",
		);
		await expect(
			reconcileCloudflareCredentialFinding(
				db,
				alertEnv,
				[result("default", "upstream timeout")],
				"2026-08-09T05:15:00.000Z",
			),
		).resolves.toMatchObject({ lifecycle: "unchanged" });
		await expect(
			getAlertState(db, CLOUDFLARE_CREDENTIAL_CONDITION_KEY),
		).resolves.toMatchObject({
			status: "open",
			lastSeenAt: "2026-08-09T05:00:00.000Z",
		});
	});
});
