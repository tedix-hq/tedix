export const SHEETS_DECLARATION = `
/** Canonical Sheet outputs. Formula strings start with '='; preserve workbook fields on replacement. */
interface SheetContent {
  kind:"sheet"; columns:string[]; rows:Array<Array<string|number|boolean|null>>;
  workbook?:Record<string,unknown>;
}
interface SheetDetail extends OutputSummary {content:SheetContent}
interface Sheets {
  read(input:{outputId:string}):Promise<SheetDetail>;
  /** Replaces the sheet at its current revision; recorded and may need approval. */
  replace(input:{outputId:string;expectedRevision:number;content:SheetContent}):Promise<SheetDetail>;
  /** Writes a bounded rectangle into the active sheet, preserving other sheets and cell formats. Does not recalculate formula values. Recorded; may need approval. */
  edit(input:{outputId:string;expectedRevision:number;startRow:number;startColumn:number;cells:Array<Array<string|number|boolean|null>>}):Promise<SheetDetail>;
}`.trim();
