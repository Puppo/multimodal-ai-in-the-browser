# Environment Manifest

Resolved at implementation start on **2026-11-16**.

## Runtime & Tooling

| Component                   | Exact Version           | Source / Verification                                                                                                                    |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                     | `26.13.1` (LTS Lithium) | Official Node.js release feed (`https://nodejs.org/dist/index.json`), pinned in `.nvmrc` and `"engines": { "node": ">=26.0.0 <27.0.0" }` |
| npm                         | `11.20.0`               | Bundled with Node `26.13.1`                                                                                                              |
| TypeScript                  | `7.0.2`                 | npm registry (`typescript@7.0.2`)                                                                                                        |
| Vite                        | `8.3.8`                 | npm registry (`vite@8.3.8`)                                                                                                              |
| Biome                       | `2.6.8`                 | npm registry (`@biomejs/biome@2.6.8`)                                                                                                    |
| Vitest                      | `5.1.0`                 | npm registry (`vitest@5.1.0`)                                                                                                            |
| Playwright                  | `1.65.1`                | npm registry (`@playwright/test@1.65.1`)                                                                                                 |
| `@huggingface/transformers` | `4.3.2`                 | npm registry (`@huggingface/transformers@4.3.2`)                                                                                         |
| `@types/dom-chromium-ai`    | `0.0.18`                | npm registry (`@types/dom-chromium-ai@0.0.18`)                                                                                           |
| `@types/node`               | `26.6.6`                | npm registry (`@types/node@26.6.6`)                                                                                                      |

> **Transitive dependency note:** `@huggingface/transformers@4.3.2` declares `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` as an upstream dependency in its own published manifest. That version comes from the upstream stable `@huggingface/transformers` package rather than an independent prerelease choice in this repository.

## Development Machine & Browsers

- **OS:** macOS `27.2.1` (Build `26B131`)
- **Processor / GPU:** Apple M2 Pro (manually inspected via `sysctl`; WebGPU adapter reports `apple · metal-3`)
- **Primary Desktop Browser:** Google Chrome `157.0.8103.79`
- **Additional Tested / Installed Desktop Browsers:**
  - Playwright Firefox (`Mozilla/5.0 ... Firefox/159.0`; local system Firefox `160.0` installed)
  - Google Chrome Canary `160.0.8165.0`
  - Brave Browser `157.1.99.57`
  - Safari `27.2` (installed on macOS)

## Model Artifacts & Verified Settings

- **Transformers.js model:** `HuggingFaceTB/SmolVLM-256M-Instruct`
  - **Repository:** `https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct`
  - **Pinned revision:** `d039ab0d4b9311b617e8ffec1d06c8464364aeb3`
  - **License:** Apache-2.0
  - **Verified WebGPU `dtype` configuration:**
    - `embed_tokens: 'q8'` (`onnx/embed_tokens_quantized.onnx`, `27.07 MiB`)
    - `vision_encoder: 'q4'` (`onnx/vision_encoder_q4.onnx`, `60.83 MiB`)
    - `decoder_model_merged: 'q4'` (`onnx/decoder_model_merged_q4.onnx`, `82.55 MiB`)
    - Total ONNX weights fetched for this configuration: `~170.45 MiB` (plus tokenizer/config JSONs; ONNX Runtime Web `ort-wasm-simd-threaded.asyncify.{wasm,mjs}` helpers are bundled locally via Vite assets instead of fetched from `cdn.jsdelivr.net`).
    - **Precision check note:** Initial Phase 1 testing with `embed_tokens: 'fp16'` and `vision_encoder: 'fp16'` produced corrupted output tokens on Apple M2 Pro `metal-3` WebGPU. Switching `vision_encoder` to `'q4'` and `embed_tokens` to `'q8'` (verified alongside `'fp32'`) eliminated the numerical corruption while reducing total ONNX weight size by ~81.2 MiB.
  - **Verified generation settings:** `do_sample: false`, `max_new_tokens: 256` (greedy decoding; no hidden system prompt).
- **Chrome Prompt API model:** Browser-managed Gemini Nano (`LanguageModel`)
  - **Documentation:** `https://developer.chrome.com/docs/ai/prompt-api`
  - **Revision pinning:** Not exposed or pinnable by web pages through the browser API.
  - **Decoding settings:** Browser default (`samplingMode` unset; no hidden system prompt).

## Reference Links

- Chrome Prompt API: https://developer.chrome.com/docs/ai/prompt-api
- Transformers.js: https://huggingface.co/docs/transformers.js/index
- Transformers.js dtypes guide: https://huggingface.co/docs/transformers.js/guides/dtypes
- Vite features and workers: https://vite.dev/guide/features
- Vite static deployment: https://vite.dev/guide/static-deploy
- Biome: https://biomejs.dev/guides/getting-started/
- Node.js releases: https://nodejs.org/en/download
