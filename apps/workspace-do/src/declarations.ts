import { SHEETS_DECLARATION } from "./sheet-declarations";
import { PRESENTATION_BINDING_DECLARATION } from "./presentation-bindings";

/**
 * TypeScript declarations of the sandbox `env` the model writes code against.
 * One string, stable per workspace, so it sits in the cached part of the
 * system prompt; `describe(name)` returns one binding's section whole.
 */

export const BINDING_NAMES = [
	"outputs",
	"documents",
	"sheets",
	"presentations",
	"apps",
	"resources",
	"work",
] as const;
export type BindingName = (typeof BINDING_NAMES)[number];

const SHARED_TYPES = `
type OutputKind = "document" | "sheet" | "presentation" | "video";
interface OutputSummary {
  id: string; kind: OutputKind; title: string; status: "active" | "archived";
  revision: number; revisionId: string | null; updatedAt: string;
}
/** Body shapes follow the workspace output content schema. */
type DocumentBlock = { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph" | "quote" | "callout"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "checklist"; items: Array<{text:string;checked:boolean}> }
  | { type: "toggle"; summary:string; text:string }
  | { type: "divider" }
  | { type: "table"; headers:string[]; rows: string[][]; align?:Array<"left" | "center" | "right" | null>; widths?:number[] }
  | { type: "code"; language?: string; text: string };
/** Preserve richText/file fields when replacing a body; edit() rebuilds rich text from semantic blocks. */
interface DocumentContent { kind:"document"; blocks:DocumentBlock[]; richText?:{type:"doc";content:unknown[]}; file?:{workspaceId:string;resourceId:string} }
interface DocumentDetail extends OutputSummary {content:DocumentContent}
type SheetCell = string | number | boolean | null;
type OutputContent =
  | DocumentContent
  | { kind: "sheet"; columns: string[]; rows: SheetCell[][] }
  | { kind: "presentation"; slides: Array<{ title: string; bullets?: string[]; notes?: string }> };
interface OutputDetail extends OutputSummary { content: OutputContent | null }
`.trim();

export const BINDING_DECLARATIONS: Record<BindingName, string> = {
	sheets: SHEETS_DECLARATION,
	presentations: PRESENTATION_BINDING_DECLARATION,
	documents: `
/** Typed document operations on the same canonical outputs used by Doc apps. */
interface Documents {
  read(input: { outputId: string }): Promise<DocumentDetail>;
  /** Replaces content; recorded and may need approval. */
  replace(input: { outputId: string; expectedRevision: number; content: DocumentContent }): Promise<DocumentDetail>;
  /** Applies ordered block edits; recorded and may need approval. */
  edit(input: { outputId: string; expectedRevision: number; ops: Array<{op:"insert" | "replace"; index:number; block:DocumentBlock} | {op:"delete"; index:number}> }): Promise<DocumentDetail>;
}`.trim(),
	outputs: `
/** Documents, sheets and presentations that belong to this workspace. */
interface Outputs {
  /** Every output, newest first. Read-only. */
  list(options?: { kind?: OutputKind; status?: "active" | "archived" }): Promise<OutputSummary[]>;
  /** One output with its current body. Read-only. */
  get(outputId: string): Promise<OutputDetail | null>;
  /** Create a new output. Writes a revision; recorded and may need approval. */
  create(input: { title: string; content: OutputContent }): Promise<OutputDetail>;
  /** Replace the body. expectedRevision must equal the current revision. Recorded; may need approval. */
  revise(input: { outputId: string; content: OutputContent; expectedRevision: number; note?: string }): Promise<OutputDetail>;
}`.trim(),
	apps: `
/** Apps installed in this workspace. Read-only. */
interface Apps {
  list(): Promise<Array<{ id: string; name: string; description: string | null; status: string; updatedAt: string }>>;
}`.trim(),
	resources: `
/** Connected resources (files, folders, external objects) of this workspace. Read-only. */
interface Resources {
  list(): Promise<Array<{ id: string; name: string; kind: string; status: string }>>;
}`.trim(),
	work: `
/** Work items of the projects this workspace is linked to. Read-only. */
interface Work {
  /** disposition: "proposed" | "accepted" | "in_progress" | "completed" | "cancelled" | ... ; omit for all. */
  list(options?: { disposition?: string; limit?: number }): Promise<Array<{
    id: string; title: string; disposition: string; workKind: string; priority: string | null; projectId: string | null; updatedAt: string;
  }>>;
  /** Items that are not completed or cancelled. */
  listOpen(): Promise<Array<{ id: string; title: string; disposition: string; workKind: string; priority: string | null }>>;
}`.trim(),
};

export function renderEnvDeclarations(): string {
	return [
		SHARED_TYPES,
		...BINDING_NAMES.map((name) => BINDING_DECLARATIONS[name]),
		`interface Env { documents: Documents; sheets: Sheets; presentations: Presentations; outputs: Outputs; apps: Apps; resources: Resources; work: Work; }`,
	].join("\n\n");
}

export function describeBinding(name: string): string | null {
	if (!(BINDING_NAMES as readonly string[]).includes(name)) return null;
	return `${SHARED_TYPES}\n\n${BINDING_DECLARATIONS[name as BindingName]}`;
}
