import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";

const reads = vi.hoisted(() => ({
	workspace: vi.fn(),
	output: vi.fn(),
	revision: vi.fn(),
	resource: vi.fn(),
	install: vi.fn(),
}));

vi.mock("../rpc/routers/os-workspaces-shared", async (original) => ({
	...(await original<typeof import("../rpc/routers/os-workspaces-shared")>()),
	queryDb: () => ({}),
	requireWorkspace: reads.workspace,
	requireOutput: reads.output,
}));
vi.mock("./workspace-output-storage", () => ({
	getOsOutputRevision: reads.revision,
}));
vi.mock("@tedix/db/queries/os-workspaces/install-app", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/os-workspaces/install-app")
	>()),
	findWorkspaceOutputResource: reads.resource,
	installWorkspaceApp: reads.install,
}));

import { installOutputEditor } from "./os-output-editor";

describe("editor read concurrency", () => {
	it("overlaps independent reads but refuses an unverifiable source before installation", async () => {
		const workspace = Promise.withResolvers<unknown>();
		const output = Promise.withResolvers<unknown>();
		const revision = Promise.withResolvers<unknown>();
		const resource = Promise.withResolvers<unknown>();
		const secondWave = Promise.withResolvers<void>();
		reads.workspace.mockReturnValueOnce(workspace.promise);
		reads.output.mockReturnValueOnce(output.promise);
		reads.revision.mockImplementationOnce(() => {
			secondWave.resolve();
			return revision.promise;
		});
		reads.resource.mockReturnValueOnce(resource.promise);
		const pending = installOutputEditor(
			{ workspaceId: "workspace-1", outputId: "output-1", kind: "document" },
			{ db: {}, organizationId: "org-1" } as BaseContext,
		);
		const refused = pending.catch((error: unknown) => error);
		expect(reads.workspace).toHaveBeenCalledOnce();
		expect(reads.output).toHaveBeenCalledOnce();
		expect(reads.revision).not.toHaveBeenCalled();
		workspace.resolve({ id: "workspace-1", organizationId: "org-1" });
		output.resolve({
			id: "output-1",
			workspaceId: "workspace-1",
			kind: "document",
			status: "active",
			currentRevisionId: "revision-1",
		});
		await secondWave.promise;
		expect(reads.revision).toHaveBeenCalledOnce();
		expect(reads.resource).toHaveBeenCalledOnce();
		expect(reads.install).not.toHaveBeenCalled();
		revision.resolve({ accessEnvelope: null });
		resource.resolve(undefined);
		expect(await refused).toMatchObject({
			message: "Output source access is unavailable",
		});
		expect(reads.install).not.toHaveBeenCalled();
	});
});

describe("editor for an output this request created", () => {
	const workspace = { id: "workspace-1", organizationId: "org-1" };
	const output = {
		id: "output-1",
		workspaceId: "workspace-1",
		kind: "document",
		status: "active",
		currentRevisionId: "revision-1",
	};
	const context = { db: {}, organizationId: "org-1" } as BaseContext;
	const input = {
		workspaceId: "workspace-1",
		outputId: "output-1",
		kind: "document",
	} as const;

	it("reuses the created rows without re-reading them, then still checks source access", async () => {
		reads.workspace.mockClear();
		reads.output.mockClear();
		reads.revision.mockClear();
		reads.resource.mockClear();
		reads.install.mockClear();
		const refused = await installOutputEditor(input, context, {
			workspace,
			output,
			revision: { id: "revision-1", accessEnvelope: null },
			resource: undefined,
		} as unknown as Parameters<typeof installOutputEditor>[2]).catch(
			(error: unknown) => error,
		);
		expect(refused).toMatchObject({
			message: "Output source access is unavailable",
		});
		expect(reads.workspace).not.toHaveBeenCalled();
		expect(reads.output).not.toHaveBeenCalled();
		expect(reads.revision).not.toHaveBeenCalled();
		expect(reads.resource).not.toHaveBeenCalled();
		expect(reads.install).not.toHaveBeenCalled();
	});

	it("refuses rows that do not describe the requested current output", async () => {
		const known = (override: object) =>
			({
				workspace,
				output,
				revision: { id: "revision-1", accessEnvelope: null },
				resource: undefined,
				...override,
			}) as unknown as Parameters<typeof installOutputEditor>[2];
		for (const rows of [
			known({ revision: { id: "revision-0", accessEnvelope: null } }),
			known({ workspace: { id: "workspace-2", organizationId: "org-1" } }),
			known({ output: { ...output, id: "output-2" } }),
		])
			expect(
				await installOutputEditor(input, context, rows).catch(
					(error: unknown) => error,
				),
			).toMatchObject({ message: "Active workspace output not found" });
		expect(reads.install).not.toHaveBeenCalled();
	});
});
