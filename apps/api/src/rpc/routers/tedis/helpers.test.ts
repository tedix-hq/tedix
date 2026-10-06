import type { Tedi } from "@tedix/db/schema/tedis";
import { describe, expect, it } from "vite-plus/test";

import {
	fetchLiveTediRuntime,
	projectIsolateRuntimeStatus,
	toTediDto,
} from "./helpers";

function baseTedi(overrides: Partial<Tedi>): Tedi {
	return {
		id: "5eed0038-0000-4000-8000-000000000038",
		organizationId: "00000000-0000-0000-0000-000000000000",
		name: "Echo",
		slug: "echo",
		status: "active",
		runtimeState: "standby",
		runtimeKind: "agent",
		runtimeStatus: "error",
		lastSeenAt: null,
		lastSyncAt: null,
		...overrides,
	} as unknown as Tedi;
}

describe("isolate tedi runtime projection", () => {
	it("does not invent execution or a recent heartbeat for local inventory", async () => {
		const env = {
			ENVIRONMENT: "development",
			DESCOPE_PROJECT_ID: "local-development-disabled",
		} as CloudflareEnv;
		const worker = baseTedi({
			runtimeStatus: "running",
			lastSeenAt: new Date().toISOString(),
		});
		expect(await fetchLiveTediRuntime(worker, env)).toBeNull();
		expect(toTediDto(worker, { env })).toMatchObject({
			runtimeStatus: "unknown",
			lastSeenAt: null,
		});
		expect(
			toTediDto(worker, { env: { ...env, ENVIRONMENT: "production" } }),
		).toMatchObject({
			runtimeStatus: "running",
			lastSeenAt: worker.lastSeenAt,
		});
	});
	it("projects active isolate tedis as routeable instead of stale container errors", () => {
		expect(
			projectIsolateRuntimeStatus({
				status: "active",
				runtimeState: "standby",
			} as Pick<Tedi, "runtimeState" | "status">),
		).toBe("running");
		expect(toTediDto(baseTedi({})).runtimeStatus).toBe("running");
	});

	it("does not call container provisioning for isolate live status", async () => {
		const live = await fetchLiveTediRuntime(baseTedi({}), {} as CloudflareEnv);

		expect(live).toMatchObject({
			normalizedRuntimeStatus: "running",
			runtimeVersion: null,
			processCount: 0,
		});
	});
});
