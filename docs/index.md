# Browser AI Lab — documentation

A frontend-only TypeScript app that runs five AI capabilities locally in the browser using WebGPU.

---

## Documentation

| Section | What's inside |
|---------|---------------|
| [Bug report](bugs/index.md) | All bugs found during live debugging, with root cause analysis and fixes |
| [Bug 001](bugs/bug-001-worker-terminated-by-strictmode.md) | LLM never loads — worker silently killed by React StrictMode |
| [Bug 002](bugs/bug-002-token-doubling-in-state-updater.md) | Chat tokens doubled — mutation in state updater detected by StrictMode |
| [Bug 003](bugs/bug-003-transformers-local-model-cache.md) | Image classification fails — corrupted HTML cached as model weights |

> **New here?** Start with the [bug overview](bugs/index.md) for a summary of all issues, then drill into individual docs for the full root-cause analysis.
