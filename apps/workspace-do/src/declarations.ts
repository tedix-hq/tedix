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
	"views",
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
	views: `
/**
 * Show a live view (table, facts or a custom layout) under your answer.
 * Use it when a table or panel is clearer than prose; it changes no data.
 * At most 3 views per answer, each under 64 KB. Omit layoutSpec for a table of
 * the first list of records in data, or a panel of its plain fields. A custom
 * layoutSpec is a json-render spec: { root: "id", elements: { id: { type, props, children: string[] } } }
 * with types Stack, Grid, Text, Badge, DataTable, DataChart, StatGrid, KeyValuePanel,
 * BarList, StatusTimeline; bind data with { $state: "/key" }.
 */
interface Views {
  show(input: { title: string; summary?: string; data: Record<string, unknown> | Array<Record<string, unknown>>; layoutSpec?: Record<string, unknown> }): Promise<{ viewId: string; shown: true }>;
}`.trim(),
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
/** Apps installed in this workspace. Code edits preserve the manifest and resource grants. */
interface AppCode { id: string; name: string; revision: number; revisionId: string; manifest: Record<string, unknown>; files: Record<string, string>; proposalId?: string; sequence?: number }
interface Apps {
  /** Read current source, or an earlier revision of this same app for restoration. */
  getCode(input: { appId: string; revisionId?: string }): Promise<AppCode>;
  /** Read one file from this chat's pending draft, or committed code when there is no draft. */
  readFile(input: {appId:string; path:string}): Promise<{appId:string; path:string; revisionId:string; proposalId?:string; sequence?:number; content:string}>;
  /** Literal text search across this chat's app files; capped at 200 matches. */
  grep(input: {appId:string; query:string}): Promise<{revisionId:string; matches:Array<{path:string; line:number; text:string}>; truncated:boolean}>;
  /** Stage one exact replacement; before must be nonempty and match exactly once. Does not publish. */
  editFile(input: {appId:string; path:string; expectedRevisionId:string; proposalId?:string; expectedSequence?:number; before:string; after:string}): Promise<AppCode>;
  /** Stage a new file or replace a file in full. Prefer editFile for small changes. Does not publish. */
  writeFile(input: {appId:string; path:string; expectedRevisionId:string; proposalId?:string; expectedSequence?:number; content:string}): Promise<AppCode>;
  list(): Promise<Array<{ id: string; name: string; description: string | null; status: string; updatedAt: string }>>;
}`.trim(),
	resources: `
/** Connected resources (files, folders, external objects) of this workspace. Read-only. */
interface Resources {
  list(): Promise<Array<{ id: string; name: string; kind: string; status: string }>>;
}`.trim(),
	work: `
/** Work items of the projects this workspace is linked to. */
interface Work {
  /** disposition: "proposed" | "accepted" | "in_progress" | "completed" | "cancelled" | ... ; omit for all. */
  list(options?: { disposition?: string; limit?: number }): Promise<Array<{
    id: string; title: string; disposition: string; workKind: string; priority: string | null; projectId: string | null; updatedAt: string;
  }>>;
  /** Items that are not completed or cancelled. */
  listOpen(): Promise<Array<{ id: string; title: string; disposition: string; workKind: string; priority: string | null }>>;
  /**
   * File a proposed Work Item when the user asks for one. Recorded; needs approval.
   * projectId is required only when the workspace links more than one project.
   * workKind: "coding" | "research" | "document" | "design" | "operations" | "other" | ...; default "other".
   * priority: "low" | "medium" | "high" | "critical"; default "medium".
   */
  create(input: { title: string; description?: string; projectId?: string; workKind?: string; priority?: string }): Promise<{
    id: string; title: string; disposition: string; workKind: string; priority: string | null; projectId: string | null; updatedAt: string;
  }>;
}`.trim(),
};

export function renderEnvDeclarations(): string {
	return [
		SHARED_TYPES,
		...BINDING_NAMES.map((name) => BINDING_DECLARATIONS[name]),
		`interface Env { documents: Documents; sheets: Sheets; presentations: Presentations; outputs: Outputs; apps: Apps; resources: Resources; work: Work; views: Views; }`,
	].join("\n\n");
}

export function describeBinding(name: string): string | null {
	if (!(BINDING_NAMES as readonly string[]).includes(name)) return null;
	return `${SHARED_TYPES}\n\n${BINDING_DECLARATIONS[name as BindingName]}`;
}
