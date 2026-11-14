# Topic reference eligibility

References to other topics remain available even when they form an indirect
cycle. Direct self references and references to targets without saved weights
are prohibited. Private visibility rules are unchanged. Scene identity is
specific: another scene may be referenced, while the current scene itself may
not.

The workspace Add controls, search results and reference selector now share the
same eligibility check. The save/preview service also rejects direct self and
empty targets, so bypassing the disabled UI cannot create those references.
Neither save validation nor UI eligibility traverses the graph to reject
indirect cycles; the existing absorbing-chain calculation handles them.

How It Works describes the requirement for saved weights and the direct-self
restriction. No data migration is needed. Release the frontend and service
together, rebuild home/index assets, and restart the app for the service change.
No production data was changed in this cloud task.

Verification includes atomic rejection tests for self/empty targets, concurrent
opposing-reference saves, transitive scene references, existing cyclic-scoring
tests and unchanged private boundaries. Browser checks pass against source and
built assets in WebKit and Chromium at 390 and 1440 px: self/empty Add controls
are disabled without writes, while an eligible other topic can be saved.

The test database now supplies real nonempty target configurations, and its
weight-availability query matches the service's all-age eligibility. Remaining
showcase density contracts were also aligned with the preceding compact-card
change. Focused tests, ESLint, both builds and whitespace checks pass.
