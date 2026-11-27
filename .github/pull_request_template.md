## What changed

Before:

After:

## How

## Design decisions

<!-- Any choice reviewers should know about (a new setting, route, table or dependency), and why. The repository is the record, so put lasting rules in the docs too. -->

## Checklist

- [ ] Tests added or updated for changed behavior
- [ ] Any endpoint returning interviews, segments, search hits, or media filters Private content on the server, with a test showing an anonymous user can't reach it
- [ ] No secrets, keys, or model names hard-coded (read from config)
- [ ] Long media work runs in the worker, not in a request handler
