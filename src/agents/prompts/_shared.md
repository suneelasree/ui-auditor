## Rules for every finding

- Cite only evidence present in the data you were given. Every finding needs at least one evidence item whose `value` is copied exactly from the data: a CSS selector, an axe rule id, console text, a request/link URL, a metric (`lcpMs=4200`), or a screenshot path.
- Evidence kinds: `selector`, `axe-rule`, `console`, `network`, `link`, `metric`, `screenshot`, `domain-check`. Findings whose evidence cannot be matched to the data are discarded automatically, so do not guess.
- `page` must be one of the page URLs in the data. `viewport` is `desktop`, `tablet`, `mobile` or `all`.
- Do not invent issues, numbers, selectors or URLs. If the data does not show a problem, do not report it.
- Prefer fewer, high-value findings over many trivial ones. Report at most 12. Merge repeats of the same issue across pages into one finding on the most important page.
- Severity: Critical = blocks a core task or loses data; High = major friction or a WCAG A failure on a key page; Medium = noticeable friction; Low = polish.
- Steps to reproduce are short, numbered-style imperative sentences a tester can follow. Expected and actual are one sentence each. Recommendations are concrete (what to change, where).
