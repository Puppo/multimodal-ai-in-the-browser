# Architecture Notes

This demo keeps the two browser AI stacks visible and directly readable so web developers can inspect how each provider prepares resources, receives inputs, streams output, handles cancellation, and releases memory.

## Module Layout

- `src/images/normalize.ts`: Shared input validation and normalization (`inspectImageBytes`, `computeNormalizedDimensions`, `normalizeImageBlob`, `revokeNormalizedImage`).
- `src/providers/types.ts`: Minimal common provider contract (`ProviderAdapter`), orthogonal state enums (`PreparationState`, `RequestState`, `CacheCondition`), and explicit metadata fields (`ProviderTechnicalMetadata`).
- `src/providers/chrome.ts`: Main-thread `ChromePromptApiAdapter` calling `LanguageModel.availability()` and `LanguageModel.create()` with matching English text + image modality constraints.
- `src/providers/transformers.ts` and `src/workers/transformers.worker.ts`: Lazy module Web Worker wrapper (`TransformersSmolVlmAdapter`) and worker script running `@huggingface/transformers` directly against `HuggingFaceTB/SmolVLM-256M-Instruct` (`d039ab0d4b9311b617e8ffec1d06c8464364aeb3`) on WebGPU.
- `src/workers/worker-protocol.ts`: Request-ID-scoped message contract (`WorkerInboundMessage`, `WorkerOutboundMessage`) between main thread and worker.
- `src/app/state.ts` and `src/app/controller.ts`: Orthogonal state model, sequential provider switching with cleanup, immutable run snapshots, and test-double injection seam (`window.__MULTIMODAL_TEST_PROVIDERS__`) reserved for Playwright E2E checks.
- `src/experiments/records.ts`: Monotonic timing capture, local upload filename sanitization (`local-upload-N`), and JSON export serialization.
- `src/ui/render.ts`, `src/ui/markdown.ts`, and `src/ui/announcer.ts`: Safe DOM-node Markdown rendering (`createElement` + `createTextNode`), progressive `<progress>` updates, centralized `aria-live` state announcements, and comparison card rendering.

## Execution Contexts & Lifecycle Isolation

1. **Main-thread vs. module Web Worker boundary:**
   - Chrome's `LanguageModel` API is kept on the main thread inside `ChromePromptApiAdapter` (strictly isolated via `tsconfig.app.json`).
   - `@huggingface/transformers` is only imported inside `src/workers/transformers.worker.ts` (typechecked separately with `"lib": ["ES2023", "WebWorker"]` in `tsconfig.worker.json`), so neither the library nor the ~170 MiB model weights are loaded unless the user explicitly selects and prepares `Transformers.js`.
2. **Sequential execution & resource disposal:**
   - One request runs at a time; duplicate clicks on `Prepare model` or `Run experiment` are ignored while active.
   - Switching providers cancels active work and awaits `previousAdapter.dispose()` before checking availability of the next provider.
   - On `ChromePromptApiAdapter`, each experiment creates a fresh `LanguageModel` session with zero prior turns and calls `session.destroy()` in `finally`.
   - On `TransformersSmolVlmAdapter`, `Prepare model` keeps the compiled WebGPU ONNX sessions warm inside the worker while each run disposes input and output tensors in `finally`; switching away calls `model.dispose()` and terminates the worker.

## Storage & Caching Asymmetry

- **Transformers.js (origin-scoped):** Uses the browser Cache API (`env.useBrowserCache = true`). Clearing site storage for the demo origin reliably restores a cold download state.
- **Chrome Prompt API (browser-wide):** Managed at the Chrome browser profile level rather than per origin. Once Gemini Nano is downloaded in a Chrome profile, clearing site data on the demo origin does not reset `LanguageModel.availability()` back to `"downloadable"`.

## Shared Image Normalization vs. Internal Model Preprocessing

- User files and bundled examples pass through `inspectImageBytes` before full decoding (static JPEG/PNG/WebP magic-byte verification, rejection of SVG, GIF, APNG `acTL`, and animated WebP `VP8X` animation flags, `<= 10 MiB` size limit, `<= 16 MP` dimension limit).
- `normalizeImageBlob` decodes via `createImageBitmap(blob, { imageOrientation: 'from-image' })`, downscales the longest edge to `<= 1,024 px` without upscaling, and re-encodes a lossless `image/png` `Blob` shared identically by both providers.
- Each model still performs internal resizing or patching after receiving that shared PNG (for example, `SmolVLM-256M-Instruct` uses `Idefics3ImageProcessor` to split images above `512 px` into `512x512` patches plus a global overview).

## Cancellation Mechanics

- **Chrome Prompt API:** Uses `AbortController` passed to `LanguageModel.create(..., { signal })` and `session.promptStreaming(..., { signal })` plus `session.destroy()`.
- **Transformers.js worker:** Aborting during `prepare` immediately terminates the worker because active model fetches/compilations cannot be interrupted cleanly inside ONNX Runtime initialization. Aborting during generation first posts `{ type: 'cancel', requestId }` to trigger `InterruptableStoppingCriteria`; if inference is still blocked (for example during vision-encoder prefill) after `1,500 ms`, the main thread terminates the worker and marks the provider as requiring preparation again. Late messages with mismatched `requestId` values are discarded.

## WebGPU Precision & Preparation Latency (`SmolVLM-256M-Instruct`)

- During Phase 1 verification on Chrome 157 (`Apple M2 Pro`, `WebGPU (apple · metal-3)`), using `fp16` on `embed_tokens` and `vision_encoder` caused numerical corruption in generated text.
- Switching to `{ embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' }` eliminated the corruption while shrinking total ONNX weight downloads to ~170.45 MiB (`embed_tokens_quantized.onnx` 27.07 MiB + `vision_encoder_q4.onnx` 60.83 MiB + `decoder_model_merged_q4.onnx` 82.55 MiB).
- `env.backends.onnx.wasm.wasmPaths` is pointed explicitly at Vite-bundled local `onnxruntime-web` assets (`ort-wasm-simd-threaded.asyncify.wasm` and `.mjs`) so cold preparation avoids an external `cdn.jsdelivr.net` roundtrip.
- **Upstream cache-key note (`@huggingface/transformers@4.3.2`):** Even with `revision` pinned and weights cached in `CacheStorage`, subsequent prepares still spend ~0.7–1.5 s probing Hugging Face Hub because `loadTokenizer()` calls `get_tokenizer_files(modelId)` without forwarding `options.revision`, causing `get_file_metadata` to query `/resolve/main/tokenizer_config.json` with `cache: 'no-store'` instead of matching the `/resolve/<revision>/` entry in `CacheStorage`.

## Security & Privacy Model

- All inference runs locally in the browser; no backend API, analytics, or hidden cloud fallback exists.
- Model outputs and image-derived text are treated as untrusted strings: `renderSafeMarkdown` builds explicit safe DOM elements (`p`, `strong`, `em`, `code`, `pre`, `ul`, `ol`, `li`, `blockquote`, `hr`, `br`, and `<p class="md-heading">`) via `document.createElement` and `document.createTextNode`, never using `innerHTML` and never converting Markdown links or images into `<a>` or `<img>` tags.
- JSON export excludes image bytes and strips local upload filenames to sequential generic labels (`local-upload-1`, `local-upload-2`, etc.).
