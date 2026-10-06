# Supplier review

The example from the main README: give Tedix one supplier folder, get a
decision note that cites its sources, and a follow-up email that is drafted but
not sent.

![The supplier folder in a Tedix OS workspace](../../docs/public/assets/tedix-os-supplier-review.png)

[`supplier-folder/`](supplier-folder) holds three made-up files about a
supplier, Globex Components. [`supplier-review.ts`](supplier-review.ts) talks
to your local Tedix OS through the typed API client (`@tedix/api-client`).

## Run it offline (about 5 minutes, no account)

1. From the repository root, start Tedix:

   ```sh
   bun run-local
   ```

2. Open `http://localhost:3030` and name your organization, for example
   **Acme**.
3. In a second terminal, from the repository root:

   ```sh
   bun examples/supplier-review/supplier-review.ts
   ```

4. In Tedix OS, choose **Workspaces > Supplier review**. The folder is saved
   there as the document **Supplier folder: Globex Components**.

Running the script again reuses the workspace and the document when it matches
the fixture files. If an earlier import or your edits differ, the script stops
without changing the saved document or asking the model to use different files.
To replace an old import, close its editor and run:

```sh
bun examples/supplier-review/supplier-review.ts --refresh-import
```

`--refresh-import` explicitly replaces the saved folder content with the current
fixture files, including any saved edits. It uses the revision you just read;
a concurrent saved change is rejected rather than overwritten. It does not merge
an open editor's draft. To keep your edits instead, use a different workspace
and folder title in the script. Adding `--ask` also requests a new decision note.

## Get the decision note (needs model calls)

Writing the note needs a model. Restart with Workers AI on your own
Cloudflare account (billed to that account; everything else stays local):

In the first terminal, sign in and start Tedix with inference:

```sh
bunx wrangler login && bunx wrangler whoami   # note your account id
bun run-local --inference --workers-ai-account=<account-id>
```

Leave that terminal running. In a second terminal, from the repository root:

```sh
bun examples/supplier-review/supplier-review.ts --ask
```

`--ask` sends one Home message with the three files, scoped to the
workspace, waits for the reply, prints it, and saves it as **Decision note:
Globex Q3 quote**. The prompt tells Home not to send the email or call tools.
Open **Chat** in Tedix OS to see the run behind the note.

The script supplies source-labelled arithmetic and delivery-date comparisons
computed directly from the fixture files alongside the files themselves. These
ground the model's answer; they are not a canned decision note.

The saved note uses native headings, lists and text formatting. A calculation
check compares the model's summary with the files: the price increase,
additional order cost, on-time delivery count and whether the quote has expired
as of today's UTC date. The original answer stays unchanged. Missing or incorrect
summary values are reported as **Needs review** at the top of the note, and the script exits with code 1
after saving the note. This is not a check of every claim or recommendation;
review the note and unsent email yourself.

Without inference, `--ask` stops with a message telling you to restart with
`--inference`.

## Make it yours

Replace the files in `supplier-folder/` with your own Markdown notes and
change `WORKSPACE_NAME`, `FOLDER_TITLE`, the prompt in `supplier-review.ts`, and
the fixture-specific checks in `supplier-review-quality.ts`. Set `TEDIX_OS_URL` if your OS is not on
`http://localhost:3030`.

Run the example's offline checks with
`bun test examples/supplier-review/supplier-review.test.ts`.
