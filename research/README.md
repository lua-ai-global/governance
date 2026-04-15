# research/

Experimental artifacts that are not part of the published `governance-sdk` surface.

Code here is not published to npm, not covered by the SDK's stability guarantees, and may move or change shape between releases. It lives in the repo because it is useful for evaluating the shipped SDK, not because it is itself product.

## Contents

- **`governance-benchmark/`** — Agent Governance Benchmark (AGB). Evaluation dataset and harness for AI agent injection detection. Used to produce the F1 / precision / recall numbers published in the SDK README. No ML model is shipped here — this is the data + evaluation runner only.
