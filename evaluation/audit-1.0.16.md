# 1.0.16 release audit

## Changes

Added microphone question testing (线下面试). The selected microphone supplies the question channel through the existing streaming transcription, semantic decision, contextual follow-up and answer pipeline. Candidate recognition is disabled in this scenario, so the same microphone does not create two speech recognizers. Speaking does not lock answer updates. The capture router now distinguishes shared input, separate inputs and output loopback, including default device IDs. Remote/video configurations are retained.

Reworked preparation into four items: generation connection, downloaded speech model, audio endpoint availability and optional personalization. API and local branches include their actual connection controls. A chat response marks generation readiness; complete model files mark speech readiness; native input/output format checks mark device availability. Branch selection and persisted connection markers do not count as proof. Personalization is detected from supplied fields or explicitly skipped. Only after all four items are ready does the guide introduce double-clicking the upper-left icon. The other workspace offers fixed Bilibili video BV1XzyWY6EJC or a microphone question test. Selecting a branch does not record; pressing Start uses an explicit settings snapshot to prevent the previous capture mode being used. Transcription, question understanding and answer completion indicators derive from actual events.

Both workspaces use one resizable panel layout with keyboard and pointer support, saved proportions and correct placement for hidden panels. Narrow assist layouts retain transcript/answer/setup priority; narrow initial practice prioritizes the guide. Panels constrain their own scroll content, avoiding old responsive overflow into neighbours. Window resizing has eight handles aligned to the visible frame (26 px corners, 10 px edges).

Windows version detection uses RtlGetVersion rather than manifest-sensitive version APIs. Builds before 19041 use WDA_MONITOR, with a visible compatibility-blackout explanation. Newer systems use WDA_EXCLUDEFROMCAPTURE. This does not guarantee support by every screen capture program. Unknown versions fall back conservatively to the blackout mechanism.

Resume analysis now requests quoted JSON keys and bounded string arrays, with a 2048-token output allowance. Practice requests validate JSON objects centrally and permit at most one format-only repair for malformed output. Known length-truncated responses fail immediately. Resume fields are type-checked and extraneous fields removed before display. Existing per-request consent remains required. Structural validation and repair cannot establish factual accuracy; the analysis must be checked against the resume source.

README describes simulation practice only, with the API branch, model download sources, device preparation, optional profile, resume handling and layout controls.

## Verification completed

- Rust library: 100 passed, 0 failed, 1 ignored. Includes device routing, strict JSON objects, resume field types, Windows version capability branches, download mirror headers/failure/retry/integrity/extraction and packaged speech runtime checks.
- Frontend: all 44 tests passed in Edge, including narrow layouts across themes and viewport sizes, actual pointer movement on panel dividers, resize cursors, four automatic completion items, gated fifth instruction, download phases/errors, consent, direct microphone start and correct per-party capture settings. Existing dialogue, formula, concurrency, cancellation, history, profile, updater and prepared introduction cases remain passing.
- TypeScript/Vite and signed Windows NSIS build succeeded. Portable runtime check examined the executable and three packaged speech binaries and found no CUDA ordinary or delayed DLL imports.
- Covered the installed 1.0.15 with 1.0.16. Configuration files were byte-identical immediately after installation; installed executable matched the bundled build, and Chinese desktop/Start shortcuts retained the original path.
- Installed app started with a Windows-only PATH and no CUDA environment, entered practice, applied startup privacy without errors, exposed recommendations and closed normally after flushing the profile. Cancellation interrupted deliberately stalled loopback HTTP headers in 7 ms.
- Native synthetic HTTP tests verified API resume consent, successful format repair, exactly one repair attempt, immediate failure on length truncation and rejection of non-string resume array values. No personal resume or real API was used.
- Native audio checks verified default endpoints and rejection of missing input/output IDs in their respective roles. Default microphone question capture opened and stopped using a downloaded local streaming model, disabled duplicate candidate recognition, wrote no recording file and made no cloud request.
- Native version detection verified the current Windows build and exclusion mechanism; older Windows branches were tested with build 18363 and 19041 in Rust and UI fixtures.

## Limits

No older Windows 10 machine was available for end-to-end capture testing; OS compatibility conclusions follow Microsoft's documented affinity behaviour and version-branch tests. The microphone audit checks native startup/routing, not speech recognition accuracy across user voices or hardware. Audio preparation tests endpoint availability and supported format without recording; the explicit test step is still needed for complete transcription and question quality. Networks, mirrors, API services and model factual quality remain variable. One format repair may incur one additional API request, and truncation is reported rather than silently completed.
