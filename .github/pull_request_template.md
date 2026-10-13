## What changed

Before:

After:

## How

## Decisions log

<!-- Does this PR implement or depend on a decision (D-###) or a Proposal that needs a P-### row? -->

## Checklist

- [ ] Tests added or updated for changed behavior
- [ ] Any endpoint returning interviews, segments, search hits, or media filters Private content on the server, with a test showing an anonymous user can't reach it
- [ ] No secrets, keys, or model names hard-coded (read from config)
- [ ] Long media work runs in the worker, not in a request handler
