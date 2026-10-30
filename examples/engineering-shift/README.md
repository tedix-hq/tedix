# Engineering shift queue

`queue.js` classifies the existing Work list and its latest Attempt summary.
Use it in a scheduled shift before counting assigned Work against queue targets.
Only `queued` candidates fill the waiting queue; running, failed, held, unknown
and succeeded-but-unclosed items remain visible separately. Admission is still
checked when an executor starts an Attempt.

An older server without `latestAttempt` returns `unknown`; do not assume those
items have never run. Copy the function into the versioned workflow asset when
the skill runtime cannot import repository modules. Keep organization IDs,
executor targets and schedules in the skill's own configuration.

Run the regression checks with `bun test examples/engineering-shift/queue.test.js`.
