import { describe, expect, it, vi } from "vite-plus/test";
import type { OsOutputContent } from "../schemas/os-workspaces";
import { OsBlueprintDefinitionSchema } from "../schemas/os-workspaces";
import { applyPresentationPatch } from "../utils/presentation-patch";
import { buildSlidesBlueprint, SLIDES_SERVER_SOURCE } from "./slides-blueprint";

type Presentation = Extract<OsOutputContent, { kind: "presentation" }>;

function runtime(content: Presentation = { kind: "presentation", slides: [] }) {
	let current = {
		output: { id: "presentation-output", title: "Launch plan" },
		revision: { revision: 1, content },
	};
	const outputsRead = vi.fn(async () => structuredClone(current));
	const outputsWrite = vi.fn(
		async (
			_slot: string,
			input: { expectedRevision: number; content: Presentation },
		) => {
			if (input.expectedRevision !== current.revision.revision)
				throw new Error("Revision conflict");
			current = {
				...current,
				revision: {
					revision: current.revision.revision + 1,
					content: structuredClone(input.content),
				},
			};
		},
	);
	const outputsPatch = vi.fn(
		async (
			_slot: string,
			input: { expectedRevision: number; ops: unknown },
		) => {
			if (input.expectedRevision !== current.revision.revision)
				throw new Error("Revision conflict");
			current = {
				...current,
				revision: {
					revision: current.revision.revision + 1,
					content: applyPresentationPatch(current.revision.content, input.ops),
				},
			};
		},
	);
	const App = new Function(
		SLIDES_SERVER_SOURCE.replace("export class App", "class App") +
			"\nreturn App;",
	)();
	const app = new App(
		new Proxy(
			{},
			{
				get: () => {
					throw new Error("App storage is unavailable");
				},
			},
		),
		{
			CONFIG: { settings: { slot: "launch_slides" } },
			TEDIX: { outputsRead, outputsWrite, outputsPatch },
		},
	);
	return { app, outputsRead, outputsWrite, outputsPatch };
}

describe("Slides blueprint", () => {
	it("ships reusable code with one independently bound canonical presentation", () => {
		const definition = buildSlidesBlueprint("launch_slides");
		expect(OsBlueprintDefinitionSchema.parse(definition)).toEqual(definition);
		expect(definition.requirements?.outputs).toEqual([
			{
				gadget: "Slides",
				kind: "presentation",
				title: "Untitled presentation",
				slot: "launch_slides",
			},
		]);
		const gadget = definition.gadgets[0]!;
		expect(gadget.manifest.config?.settings).toEqual({
			slot: "launch_slides",
			blueprintVersion: 6,
		});
		expect(gadget.files!["client.js"].length).toBeGreaterThan(30_000);
		expect(gadget.manifest.resourceGrants).toEqual([
			{
				slot: "launch_slides",
				operations: ["outputs.read", "outputs.write", "outputs.patch"],
			},
		]);
		expect(
			gadget.manifest.operations?.map((operation) => [
				operation.name,
				operation.effect,
				operation.outputSlot,
			]),
		).toEqual([
			["readPresentation", "read", "launch_slides"],
			["replacePresentation", "write", "launch_slides"],
			["editSlides", "write", "launch_slides"],
			["exportOutline", "read", "launch_slides"],
		]);
		expect(Object.keys(gadget.files!)).toEqual([
			"client.js",
			"server.js",
			"README.md",
		]);
		expect(() => buildSlidesBlueprint("not-a-slot")).toThrow();
	});
	it("reads, edits and exports the same canonical revision without app storage", async () => {
		const { app, outputsPatch } = runtime();
		const edited = await app.editSlides({
			expectedRevision: 1,
			ops: [
				{
					op: "insert",
					index: 0,
					slide: {
						title: "Launch",
						bullets: ["First step"],
						notes: "Speaker note",
					},
				},
			],
		});
		expect(edited.revision.revision).toBe(2);
		expect(edited.outline).toEqual([
			{ title: "Launch", bullets: ["First step"], notes: "Speaker note" },
		]);
		expect(outputsPatch).toHaveBeenCalledWith("launch_slides", {
			kind: "presentation",
			expectedRevision: 1,
			ops: [
				{
					op: "insert",
					index: 0,
					slide: {
						title: "Launch",
						bullets: ["First step"],
						notes: "Speaker note",
					},
				},
			],
		});
		const exported = await app.exportOutline();
		expect(exported).toMatchObject({
			outputId: "presentation-output",
			revision: 2,
			projection: "semantic_outline",
		});
		expect(exported.text).toContain(
			"# 1. Launch\n\n- First step\n\nNotes: Speaker note",
		);
		await expect(
			app.editSlides({
				expectedRevision: 1,
				ops: [{ op: "delete", index: 0 }],
			}),
		).rejects.toThrow("Revision conflict");
		expect((await app.readPresentation()).revision.revision).toBe(2);
	});
	it("requires positive revision checks before dispatching writes", async () => {
		const { app, outputsWrite, outputsPatch } = runtime();
		await expect(
			app.replacePresentation({
				expectedRevision: 0,
				content: { kind: "presentation", slides: [] },
			}),
		).rejects.toThrow("expected revision");
		await expect(
			app.editSlides({ expectedRevision: 1, ops: [] }),
		).rejects.toThrow("Slide edits");
		expect(outputsWrite).not.toHaveBeenCalled();
		expect(outputsPatch).not.toHaveBeenCalled();
	});
});
