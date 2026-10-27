---
"@tedix/cli": patch
---

`tedix lane serve` no longer holds code Work just because its text mentions consent, credentials, tokens, sign-in, sending, publishing or deleting. A lane now asks for the owner's Delegation comment only when the item tells the executor to do a human-reserved act itself: grant or revoke consent, issue, rotate or enter credentials, pay, send an outside message, publish, delete live data, sign an agreement or change a live customer's settings. Prohibitions such as "no consent, payment or publication" no longer count as requests.
