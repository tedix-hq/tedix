# Sheet editor capacity measurements — 16 November 2026

Baseline: `66af61f48`. [Raw samples](sheet-capacity-performance.results.json)
record the results.

The question was whether to raise the Sheet editor's 1,000 × 64 limit. That
limit was already replaced on 11 November (`3ab527164`): a tab may hold
50,000 rows × 702 columns, a file 8 MB, and the editor draws only the rows and
columns near the view.

`src/lib/sheet-capacity.test.ts` mounts the real editor client under happy-dom
with a host that copies every content crossing it, as a frame boundary does.
happy-dom does no layout or paint, and neither Chromium nor WebKit could start
where this was measured, so frame times in a real browser are not measured.
Times are script time on one laptop. Filled sheets hold a value in about half
their cells; "bare" sheets store only their shape, every row empty.

## What is drawn

About 23 rows and at most 3,332 elements at every size. An arrow key takes
0.3–10 ms. A jump to the last cell takes 28–530 ms. Drawing is not what limits
the size of a sheet.

## What an edit costs

| Sheet       | File    | Enter holds the page | New result shown | Save answered |
| ----------- | ------- | -------------------: | ---------------: | ------------: |
| 30 × 10     | 0.01 MB |                46 ms |            90 ms |        0.27 s |
| 1,000 × 64  | 1.4 MB  |               220 ms |            0.7 s |         1.2 s |
| 2,000 × 64  | 2.8 MB  |               312 ms |            0.9 s |         2.6 s |
| 4,000 × 64  | 5.7 MB  |               279 ms |            1.4 s |         2.5 s |
| 20,000 × 10 | 4.7 MB  |               215 ms |            0.6 s |         2.6 s |
| 50,000 × 4  | 5.3 MB  |               444 ms |            6.4 s |         5.3 s |
| 300 × 702   | 4.7 MB  |               181 ms |            2.5 s |         1.7 s |

The cost follows the file's size, not the grid's. Every edit copies the whole
sheet for undo (up to 50 copies are kept), again for each calculation sent to
the host and back, and again for the draft kept for the next visit. The save
itself stays small: a one-cell edit sends a 125-byte patch, so per-cell checks
on the server are unchanged.

## The largest shape cannot be used

An edit fills every row out to the sheet's full width (`pad` in
`src/gadgets/sheet-client.ts`), and `projectWorkbook` writes a value for every
row and column. A sheet's cost is therefore rows × columns, however few cells
have content:

- 10,000 × 702 bare (a 0.06 MB file): 2.7 s per Enter, 23 s until the save
  answered, about 1.6 GB of memory.
- 50,000 × 702 bare: the run ended when a 4 GB heap was exhausted.
- 5,000 × 702 bare, calculated once: 0.03 MB became 17.6 MB, over the 8 MB a
  file may hold.

## Recommendation

1. Do not raise the row or column limits.
2. Limit the cells in one tab (rows × columns) to about 250,000–500,000, or
   stop filling empty cells, so nobody meets the 8 MB limit or a frozen tab by
   widening a tall sheet.
3. Make an edit cost what changed: undo from patches, calculation without
   sending the whole sheet both ways.
4. Measure frame times once in a real browser.

Run `SHEET_CAPACITY=/tmp/sheet-capacity.jsonl bun run --cwd apps/os test:unit
src/lib/sheet-capacity.test.ts`. It takes about five minutes and appends one
line per size. Without `SHEET_CAPACITY` the measurements are skipped. Memory
figures are approximate; negative ones are the collector running mid-measure.
