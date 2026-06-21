# @bullet/agent

"The brain." The Ollama client (chat with structured-output mode, embeddings, model
pull/status), the extraction → resolution → suggestion pipeline, the **serial inference
queue** (single GPU slot), the apply path, and a weekly-analysis stub.

The Ollama client is defined behind a clean interface so it is **always mocked in tests** —
CI never requires a live model. Depends on `@bullet/core` + `@bullet/db`. See the root
[`CLAUDE.md`](../../CLAUDE.md).

> Task 0 shell — the real implementation lands in Task 3.
