import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	applyOutputPatch,
	diffOutputContent,
	type OutputPatch,
} from "@tedix/api-contract/utils/output-patch";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	createOutputSync,
	type OutputSyncBridge,
	type SyncedOutput,
} from "./output-sync";

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
type Saved = SyncedOutput<Sheet> & { output: { id: string; title: string } };

const sheet = (...values: (string | null)[]): Sheet => ({
	kind: "sheet",
	columns: ["A"],
	rows: values.map((value) => [value]),
});

/** A server holding numbered revisions, and a host that speaks for it. */
function server(first: Sheet) {
	const revisions = new Map<number, Sheet>([[1, first]]);
	let current = 1;
	const output = { id: "file", title: "Budget" };
	const full = (revision = current): Saved => ({
		output,
		revision: { revision, content: revisions.get(revision)! },
	});
	const call = vi.fn(async (method: string, args?: unknown) => {
		const input = args as {
			baseRevision: number;
			sinceRevision: number;
			revision: number;
			patch: OutputPatch;
		};
		if (method === "outputs.patch") {
			const sent = applyOutputPatch(
				revisions.get(input.baseRevision)!,
				input.patch,
			);
			// The server may store more than was sent; here, a trailing mark.
			const stored: Sheet =
				sent.rows.length > 2
					? { ...sent, rows: [...sent.rows, ["stored"]] }
					: sent;
			revisions.set(++current, stored);
			return {
				output,
				revision: { revision: current },
				mergedWith: null,
				catchUp: diffOutputContent(sent, stored),
			};
		}
		if (method === "outputs.changes") {
			const since = revisions.get(input.sinceRevision);
			return {
				output,
				revision: { revision: current },
				patch: since ? diffOutputContent(since, revisions.get(current)!) : null,
				...(since ? {} : { content: revisions.get(current)! }),
			};
		}
		if (method === "outputs.readRevision") return full(input.revision);
		throw new Error(`unexpected ${method}`);
	});
	return {
		call,
		bridge: { call } as unknown as OutputSyncBridge,
		full,
		readFull: vi.fn(async () => full()),
		external(next: Sheet) {
			revisions.set(++current, next);
		},
		drop(revision: number) {
			revisions.delete(revision);
		},
		calls: (method: string) =>
			call.mock.calls.filter(([name]) => name === method),
	};
}

describe("editor file sync", () => {
	it("sends only what changed and holds what is stored afterwards", async () => {
		const host = server(sheet("a", "b"));
		const sync = createOutputSync<Sheet, Saved>(host.bridge, "slot");
		sync.remember(await host.readFull());
		const saved = await sync.save(sheet("a", "B"), 1, host.readFull);
		expect(host.calls("outputs.patch")).toEqual([
			[
				"outputs.patch",
				{
					slot: "slot",
					baseRevision: 1,
					patch: {
						kind: "sheet",
						ops: [{ op: "set", path: ["rows", 1, 0], value: "B" }],
					},
				},
			],
		]);
		expect(saved.revision).toEqual({ revision: 2, content: sheet("a", "B") });
		expect(saved.output).toEqual({ id: "file", title: "Budget" });
		// The next save compares with what was just stored, not the first read.
		await sync.save(sheet("a", "B", "c"), 2, host.readFull);
		expect(host.calls("outputs.patch")[1]![1]).toMatchObject({
			baseRevision: 2,
			patch: { ops: [{ op: "splice", path: ["rows"] }] },
		});
		expect(host.readFull).toHaveBeenCalledTimes(1);
		// A save someone asked for says so; the editor's own saves do not.
		await sync.save(sheet("a", "B", "c", "d"), 3, host.readFull, true);
		expect(host.calls("outputs.patch")[2]![1]).toMatchObject({
			baseRevision: 3,
			explicit: true,
		});
		expect(host.calls("outputs.patch")[1]![1]).not.toHaveProperty("explicit");
	});

	it("applies what the server stored beyond what was sent", async () => {
		const host = server(sheet("a", "b"));
		const sync = createOutputSync<Sheet, Saved>(host.bridge, "slot");
		sync.remember(await host.readFull());
		const saved = await sync.save(sheet("a", "b", "c"), 1, host.readFull);
		expect(saved.revision.content).toEqual(sheet("a", "b", "c", "stored"));
		expect(saved.revision.content).toEqual(host.full().revision.content);
	});

	it("sends nothing when nothing differs", async () => {
		const host = server(sheet("a"));
		const sync = createOutputSync<Sheet, Saved>(host.bridge, "slot");
		const first = sync.remember(await host.readFull());
		expect(await sync.save(sheet("a"), 1, host.readFull)).toBe(first);
		expect(host.call).not.toHaveBeenCalled();
	});

	it("catches up with someone else's save by fetching only the change", async () => {
		const host = server(sheet("a", "b"));
		const sync = createOutputSync<Sheet, Saved>(host.bridge, "slot");
		const first = sync.remember(await host.readFull());
		expect(await sync.latest(host.readFull)).toBe(first);
		host.external(sheet("a", "theirs"));
		const latest = await sync.latest(host.readFull);
		expect(latest.revision).toEqual({
			revision: 2,
			content: sheet("a", "theirs"),
		});
		expect(host.calls("outputs.changes").at(-1)![1]).toEqual({
			slot: "slot",
			sinceRevision: 1,
		});
		expect(host.readFull).toHaveBeenCalledTimes(1);
		// The copy handed out earlier was not changed in place.
		expect(first.revision.content).toEqual(sheet("a", "b"));
	});

	it("takes the whole content when the server cannot make a patch", async () => {
		const host = server(sheet("a"));
		const sync = createOutputSync<Sheet, Saved>(host.bridge, "slot");
		sync.remember(await host.readFull());
		host.external(sheet("z"));
		host.drop(1);
		expect((await sync.latest(host.readFull)).revision.content).toEqual(
			sheet("z"),
		);
	});

	it("reads the whole file from a host that cannot report changes", async () => {
		const host = server(sheet("a"));
		const older = {
			call: vi.fn(async () => {
				throw Object.assign(new Error("host_unavailable"), {
					code: "host_unavailable",
				});
			}),
		};
		const sync = createOutputSync<Sheet, Saved>(
			older as unknown as OutputSyncBridge,
			"slot",
		);
		sync.remember(await host.readFull());
		host.external(sheet("b"));
		expect((await sync.latest(host.readFull)).revision.revision).toBe(2);
		expect(host.readFull).toHaveBeenCalledTimes(2);
		// Any other failure is the editor's to handle.
		const denied = createOutputSync<Sheet, Saved>(
			{
				call: vi.fn(async () => {
					throw new Error("Source access denied");
				}),
			} as unknown as OutputSyncBridge,
			"slot",
		);
		denied.remember(await host.readFull());
		await expect(denied.latest(host.readFull)).rejects.toThrow("denied");
	});

	it("compares unsaved changes from an earlier visit with the revision they were made from", async () => {
		const host = server(sheet("a", "b"));
		const sync = createOutputSync<Sheet, Saved>(host.bridge, "slot");
		host.external(sheet("a", "b", "theirs"));
		sync.remember(await host.readFull());
		// The draft changed row 0 of revision 1; the file is at revision 2.
		await sync.save(sheet("mine", "b"), 1, host.readFull);
		expect(host.calls("outputs.readRevision")).toEqual([
			["outputs.readRevision", { slot: "slot", revision: 1 }],
		]);
		expect(host.calls("outputs.patch")[0]![1]).toEqual({
			slot: "slot",
			baseRevision: 1,
			patch: {
				kind: "sheet",
				ops: [{ op: "set", path: ["rows", 0, 0], value: "mine" }],
			},
		});
	});
});
