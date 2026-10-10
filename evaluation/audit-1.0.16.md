# 1.0.16 source audit — microphone question testing

## Changes

Added the “线下面试” capture scenario alongside remote interview and video testing. The selected microphone is the question source, using the existing transcription, semantic decision, contextual follow-up and answer generation pipeline. The optional candidate STT provider is disabled, so offline mode has one speech recognizer and does not transcribe the same microphone twice. Speaking does not lock answer updates in this scenario.

Fixed an existing device-routing defect: an input device specified as `default` or an empty ID previously fell through to output loopback. Input routing now distinguishes one shared input, separate inputs and output loopback. Both default and named microphones can use one shared physical input stream. Offline mode does not change the OS default microphone through the disabled provider.

The control panel and audio settings expose the new mode. Output-device selection is disabled in offline mode; microphone transcript labels, status help and history titles identify the question source. The onboarding guide offers a microphone-test button that selects the scenario and opens device settings without automatically recording. Existing remote/video preferences and model configurations remain available.

All microphone speech enters the question channel; this is a custom question test and does not identify different people sharing the microphone. Background and subsequent questions use the existing bounded dialogue context. No improvement to speech model accuracy itself is claimed.

## Verification completed

- TypeScript checking and the Vite production frontend build passed. A temporary, untracked Node compatibility shim handled the restricted Windows environment's failing native realpath calls; application build configuration was unchanged.
- 11 Node test cases passed, including the new microphone configuration tests plus dialogue context, decision stability, history, model provider selection and prepared introduction routing. The configuration tests cover default/named microphones, local streaming STT, both speech APIs, disabling duplicate candidate recognition and retaining remote/video output capture.
- The two production Rust capture-routing unit tests were compiled and run in an isolated `rustc --test` harness. Both passed. This does not substitute for a full Tauri/Rust suite.
- Expanded the real frontend IPC and onboarding browser tests to cover microphone question routing, follow-up context, speaking without locking, saved scenario settings and opening the mode without automatically starting capture.

## Remaining release gates

The browser suites could not run in the current restricted Windows session: Edge exited during launch with a named-pipe error. Full `cargo test --lib` reached the Tauri build step and failed with access denied; the build cache drive mapping was also denied. A request for the needed filesystem permissions returned no granted permissions. The installed application's microphone input was therefore not physically tested.

No 1.0.16 desktop installer or signed release was produced, and the installed application was not upgraded. The existing public 1.0.15 update channel and installer remain the stable release. Resume full desktop tests, signed build, installation and release when the execution environment permits them.
