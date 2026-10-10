# 1.0.15 validation — 2026-10-10

## Download findings

The old HTTP client supplied no User-Agent. Full-file requests to both configured ModelScope mirror URLs reproduced HTTP 403 without a User-Agent; the same requests with `MockInterview/1.0.15` returned HTTP 200 and archive bytes. Range probes alone returned HTTP 206 and therefore would have missed the full-download failure. This is a confirmed application defect, not evidence that every previous user's failure had this single cause.

Two additional defects masked or prevented recovery: the low-level downloader emitted an empty terminal error before ModelManager emitted the actual cause, and the UI discarded that later event; old active-job detection used leftover files rather than a finished job flag. The practice page also did not show the application's general error. Fixed these paths, retained progress across the background command's return, and exposed specific native errors.

Recommended bilingual model downloads now identify the application, prefer a direct domestic mirror connection, fall back to system/environment proxy configuration after a connection failure, retain TLS validation, and bound connect/read/total timeouts. Failed transfers remove their temporary file. Extraction validates in a temporary directory before replacing a model, retaining a previous model if preparation fails.

## User workflow and fault checks

- 41 frontend tests passed, including an empty first-use profile, API selection without starting Ollama, connection checks, all download phases, unrelated progress filtering, visible failure/retry, missing-files rejection, path selection, per-request API resume consent, persisted completion marks, legacy Ollama settings, and narrow-window layout.
- Guide and settings expose ModelScope mirror / Hugging Face / Ollama / GitHub download routes, conditional network requirements, browser fallback and model folder instructions. VPN is not marked mandatory for every user.
- 95 Rust tests passed, including synthetic HTTP 403/404/503, HTML instead of a model, interrupted bodies, checksum mismatch, receive inactivity timeout, unusable target directories, cancellation, safe retries, a broken proxy route with fallback, and atomic extraction/replacement. The production client header is checked against a synthetic server that otherwise returns 403.
- The opt-in live download audit separately passed: approximately 737 MB total, both Paraformer and Zipformer from the configured domestic mirror, exact byte counts, pinned SHA-256 hashes, full extraction and required model files. It used a new Chinese/spaced temporary directory, no existing models, no Ollama, and removed its temporary data afterward.
- Model deletion tests confirm cancellation sends no deletion command, approval deletes only the selected model and refreshes state, and API users can manage existing Ollama models. Backend tests protect other model files, reject active download removal and restrict Ollama deletion to loopback root endpoints.

## Installed package checks

- Signed Windows CPU build passed the ordinary and delayed CUDA import checks for all four runtime binaries.
- Cover installation verified version 1.0.15, unchanged configuration/runtime files and the existing Chinese desktop/Start menu shortcuts.
- Installed program started with Windows-only PATH and no CUDA environment; simulation page, guide recommendations and startup privacy state passed. A synthetic stalled HTTP request cancelled in 6 ms. Native window close flushed configuration and exited normally.
- `native-api-resume.cjs` confirmed the installed command supports API resume analysis: two unconsented calls were rejected before HTTP, one explicitly approved call used the selected endpoint. Only synthetic resume text went to a loopback server; no actual cloud API was called.
- The same native fixture verified `DELETE /api/delete` with a selected synthetic Ollama model and rejection of remote endpoints. No real user model was deleted.

## Boundaries

These checks combine isolated first-use state, controlled faults and complete live mirror downloads. They are not a test of every user's ISP, corporate policy, proxy, certificate store or disk. Those failures now have visible causes and a browser/manual preparation route. Automatic retries restart the entire download; resumable transfer is not implemented. Manually supplied model folders are checked for file layout, not archive SHA-256.

API resume analysis requires explicit consent on every request; Ollama is not a prerequisite. The “about 1 yuan per interview” text is a budgeting example requested for the guide, not a measured fixed price. Billing depends on duration, request frequency, provider pricing and caching. Existing internal application identity and executable name remain unchanged to preserve settings.
