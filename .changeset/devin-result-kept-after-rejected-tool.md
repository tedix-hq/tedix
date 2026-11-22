---
"@tedix/cli": patch
---

A Devin run that had one tool call refused in headless mode but still finished and reported success is no longer marked failed. Its reported result now goes through delivery and settlement like any other run. A Devin run that reports nothing after a refused tool call still fails, as before.
