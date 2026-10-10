# 1.0.14 validation — 2026-10-10

## Checks performed

- Frontend production build passed.
- 40 frontend tests passed, including persisted practice history after reload, search, export, deletion, stable-transcript gating, recorder ordering, incomplete stream flush and storage error reporting.
- 88 Rust tests passed, including SQLite upsert/order/cascade deletion and SSE usage after a finish-reason frame.
- Signed Windows CPU build passed the existing CUDA import and delayed-import checks.
- Cover installation verified the installed binary against the built NSIS payload, version 1.0.14, unchanged configuration/runtime files, and existing Chinese desktop/Start menu shortcuts.
- Installed program started with Windows-only PATH and no CUDA environment. Practice guide and default privacy state were verified. Cancelling a synthetic stalled HTTP response completed in 9 ms; native window close flushed and exited normally.
- `evaluation/native-history.cjs` used only synthetic local HTTP responses and its own UUID session. Verified nonstream decision usage, streamed answer usage, cache-hit fields, local-date search, JSON export, persistence across native process restart, and deletion. Test records were removed. No saved credentials, real API calls, resume content or existing history were read by the fixture.

## Measurement boundaries

History begins with this version; previously unsaved sessions cannot be reconstructed. Stable transcript text, questions, model output, practice feedback and returned model usage are stored locally in a separate SQLite database. It does not contain raw audio or API keys.

Usage is grouped by stage, provider and model. Cache-hit tokens are a subset of prompt tokens. Providers may omit usage, and cancelled/failed requests may incur charges without a usable usage response. The table is not a billing ledger. Prices are not hardcoded into the application.

Manual question testing bypasses semantic classification. Incremental real-time classification may issue repeated requests with context, including requests that return wait/keep; task revisions and JSON repair can issue additional requests. DeepSeek calls already disable thinking. Stable-only classification is an optional setting, off by default to retain existing latency behavior. It reduces partial-transcript classification requests but may delay a first hint and does not eliminate calls on stable background statements.

No assertion is made about the distribution of any prior account charge: previous versions did not retain the necessary per-request usage evidence.
