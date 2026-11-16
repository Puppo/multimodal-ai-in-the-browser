# Multimodal AI in the Browser

Educational companion demo for Luca Del Puppo’s Nearform article comparing two browser-side multimodal inference approaches on one shared normalized image and question:

1. **Chrome Built-in AI (`LanguageModel` / Prompt API)** on the main thread with browser-managed Gemini Nano.
2. **Transformers.js (`@huggingface/transformers`)** running `HuggingFaceTB/SmolVLM-256M-Instruct` inside a module Web Worker on **WebGPU**.

> **Comparison caveat:** This demo compares two complete browser-side solutions (model architecture and weights, image preprocessing/patching, prompt formatting, decoding defaults, and execution runtime). Results must not be read as a controlled runtime benchmark.

## Quick Start

### Prerequisites

- **Node.js `26.13.1`** (see [.nvmrc](.nvmrc); `engines.node` requires `>=26.0.0 <27.0.0`)
- **For Transformers.js (SmolVLM-256M):** A desktop browser with **WebGPU** enabled and enough memory/storage for the ~170 MiB ONNX download (CPU/WASM fallback is intentionally disabled in this first release so WebGPU and browser-managed execution stay honestly separated).
- **For Chrome Prompt API:** Google Chrome with built-in AI (`LanguageModel`) and multimodal image input enabled and downloaded in your browser profile.

### Run Locally

```bash
nvm use
npm ci
npm run dev
```

Or preview a production build:

```bash
npm run build
npm run preview
```

## What Happens on First Use

- **No hidden uploads or analytics:** Images and prompts stay on your device. No backend service, prompt telemetry, or cloud fallback exists.
- **Explicit download consent:** Nothing downloads model weights automatically on page load. Selecting a provider only checks capability; clicking **Prepare model** initiates model download/initialization and displays honest progress.
- **Shared image normalization:** Bundled examples and uploaded local images (static JPEG, PNG, or WebP; max `10 MiB`, max `16 MP`; SVG and animated PNG/WebP rejected) are oriented from EXIF and normalized to a lossless PNG with at most a `1,024 px` longest edge without upscaling before either provider runs. Each model still performs its own internal resizing/patching afterward.
- **Sequential isolation:** Only one inference runs at a time. Switching providers cancels active work and releases the previous provider's resources before checking the next provider. Previous run cards stay visible in memory for side-by-side comparison until cleared or the page closes.

## Bundled Examples

Three CC0-licensed photographs from Wikimedia Commons are included in [public/examples/](public/examples) (full provenance and SHA-256 hashes in [public/examples/ATTRIBUTION.md](public/examples/ATTRIBUTION.md)):

1. **Few objects in a clear scene** (`scene-objects.jpg`): _"What objects are visible and where are they?"_
2. **Clearly legible short text** (`short-text.jpg`): _"Transcribe the visible text."_
3. **Partly obscured or ambiguous object** (`ambiguous-object.jpg`): _"Can you identify the partly hidden object? Explain any uncertainty."_

## Scripts & Verification

- `npm run dev` — Start Vite development server
- `npm run build` — Run TypeScript typechecking (`app`, `worker`, `node`) and Vite production build
- `npm run preview` — Serve the production build locally
- `npm run typecheck` — Run `tsc --noEmit` across main-thread, worker, and tooling configs
- `npm run lint` / `npm run format` — Check or apply Biome formatting and lint rules
- `npm run test` — Run deterministic Vitest unit tests (image validation, state transitions, controller lifecycle, JSON export)
- `npm run test:e2e` — Run deterministic Playwright UI tests (using test-only browser doubles) plus production subpath build verification
- `npm run check` — Run `typecheck`, `lint`, `test`, `build`, and `test:e2e`

Note: Automated tests in CI verify application logic, state handling, safe Markdown XSS protection, keyboard/mobile layout, and subpath bundling without downloading ~170 MiB models. Real model inference is documented separately in [docs/experiments.md](docs/experiments.md) and [docs/manual-validation.md](docs/manual-validation.md).

## Static Deployment Under a Subpath

The Vite `base` path is configurable via `VITE_BASE_PATH` (default `/`):

```bash
VITE_BASE_PATH=/multimodal-ai-in-the-browser/ npm run build
```

## Documentation & Licensing

- [Environment Manifest](docs/environment.md)
- [Architecture Notes](docs/architecture.md)
- [Experiments & Pre-Registered Observations](docs/experiments.md)
- [Manual Browser Validation Matrix](docs/manual-validation.md)
- [Bundled Example Attribution](public/examples/ATTRIBUTION.md)

Licenses:

- Application source code: [MIT License](LICENSE)
- Bundled example images: CC0 1.0 Universal (Public Domain Dedication)
- `HuggingFaceTB/SmolVLM-256M-Instruct`: Apache-2.0 (`https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct`)
- Chrome Built-in AI (Gemini Nano): Subject to Google Chrome terms

## Troubleshooting

- **Chrome Prompt API shows `unavailable`:** Check that you are running a compatible Chrome version on supported desktop hardware, ensure **On-device AI** is enabled in `chrome://settings/ai`, inspect `chrome://on-device-internals`, and confirm multimodal Prompt API support is enabled in your Chrome profile. You can still test **Transformers.js (SmolVLM-256M)** independently.
- **Transformers.js shows `unavailable`:** Verify WebGPU is supported and enabled in your browser (`navigator.gpu` + adapter/device available). Firefox without WebGPU enabled or restricted virtualized environments will report unavailable rather than silently falling back to CPU/WASM.
- **Model preparation cancelled mid-way:** If you click **Stop** while SmolVLM is downloading or stuck in WebGPU prefill, the worker is terminated cleanly to free resources; click **Prepare model** again before running another experiment.
