# @tedix/widget-i18n

Translations for the embedded tedi widget (`apps/widget`). `en.json`,
`de.json` and `es.json` carry the same keys; `catalog.ts` loads and validates
them and the test fails on any key drift between languages.

Add a language by copying `en.json`, translating every value, and registering
the file in `catalogs.ts`.

MIT; see `LICENSES/MIT.txt` in the repository.
