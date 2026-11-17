# Experiments & Observations

> **Scope note:** This demo compares two complete browser-side multimodal solutions — Chrome's Prompt API (`LanguageModel` + browser-managed Gemini Nano) and `@huggingface/transformers` running `HuggingFaceTB/SmolVLM-256M-Instruct` inside a WebGPU Web Worker. Differences in outputs and timings reflect **model architecture, weights, image preprocessing/patching, prompt template, decoding configuration, and runtime execution together**. Do not interpret these runs as a controlled runtime benchmark or a universal ranking.

## Pre-Registered Human Reference Observations

These ground-truth observations were written from human inspection of the three bundled images **before** executing either model, and are never sent to either provider.

### 1. `scene` — Few objects in a clear scene (`scene-objects.jpg`)

- **Prompt:** `What objects are visible and where are they?`
- **Observable facts:**
  - Wooden desk surface against a plain light/white wall.
  - Left side: a black articulated desk lamp behind/left of an open silver laptop (facing forward with a dark/black screen) and a light-colored box tucked behind the laptop.
  - Center-right and right side: a tall stack of books/folders on the desk immediately to the right of the laptop; a second stack of books/magazines beside it; an open spiral notebook in the right foreground with eyeglasses resting on top; rolled papers next to the right stack; and a white vertical file/magazine holder filled with folders on the far right edge.
- **Evaluation focus:** Object identification, accurate left/right/foreground spatial placement, and avoidance of invented desk items.

### 2. `text` — Clearly legible short text (`short-text.jpg`)

- **Prompt:** `Transcribe the visible text.`
- **Observable facts:**
  - Primary warning headline in large bold black uppercase letters across the middle of the yellow sign: `ELECTRIC FENCE` (above a stylized hand-and-lightning hazard graphic).
  - Tiny secondary print in the bottom corners (challenging at `1024px` normalized longest edge): `G602000` (bottom-left) and `GALLAGHER` / `POWER FENCE™ SYSTEMS` (bottom-right).
- **Evaluation focus:** Exact transcription of `ELECTRIC FENCE` and whether models omit, accurately read, or hallucinate characters in the small bottom-corner brand/code print.

### 3. `ambiguous` — Partly obscured or ambiguous object (`ambiguous-object.jpg`)

- **Prompt:** `Can you identify the partly hidden object? Explain any uncertainty.`
- **Observable facts:**
  - Underground parking garage setting; center bay labeled `1308` contains a passenger vehicle completely draped under an opaque dark/black fitted car cover, with part of a rear-left silver/chrome wheel visible below the hem.
  - Flanked on the left by part of a dark car's front fender/headlight and on the right by a dark four-door sedan.
  - **What is genuinely unknown from the image:** The exact make, model, year, trim, and body paint color of the covered vehicle underneath the cover.
- **Evaluation focus:** Recognizing that the object is a covered car/automobile while explicitly acknowledging uncertainty about exact vehicle identity rather than inventing a make/model.

## Timing Boundary Definitions

- **Preparation latency (`preparationMs`):** Measured on the main thread with `performance.now()` from clicking `Prepare model` until readiness completes. For Chrome, this covers `LanguageModel.create(...)` warmup (including any browser-managed model download/check) and session cleanup; for Transformers.js, this covers module worker startup, WebGPU adapter checks, Hugging Face / Cache API asset reads, ONNX Runtime session creation, and shader compilation.
- **Request-to-first-text latency (`firstTextMs`):** Measured from clicking `Run experiment` until the first non-empty streamed text chunk arrives on the main thread (`null` if streaming emits no partial chunks prior to completion). Includes session creation (Chrome) or worker message transit + image tokenization + vision-encoder prefill + first decoded word/token.
- **Request-to-completion latency (`totalLatencyMs`):** Measured from clicking `Run experiment` until full response completion and cleanup (`session.destroy()` for Chrome, tensor disposal in the Transformers.js worker).

## Recorded Runs — Transformers.js (`HuggingFaceTB/SmolVLM-256M-Instruct`)

**Machine & environment:** Apple M2 Pro, macOS `27.2.1` (`26B131`), Google Chrome Canary `160.0.8165.0` (headed), WebGPU backend `WebGPU (apple · metal-3)`.
**Configuration:** Revision `d039ab0d4b9311b617e8ffec1d06c8464364aeb3`, `dtype: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' }`, local Vite-bundled `onnxruntime-web` WASM/MJS helpers, `do_sample: false`, `max_new_tokens: 256`, no hidden system instruction.

### Preparation Condition Measurements

| Condition            | Preparation Latency | Notes                                                                                                                                                                                    |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clean-download`     | `12,107.7 ms`       | Fresh Chrome Canary user profile (`~170.45 MiB` ONNX weights + tokenizer/config files fetched from Hugging Face, local Vite-bundled ORT WASM/MJS, compiled to WebGPU).                   |
| `cached-new-session` | `935.1 ms`          | Same profile after page reload (weights served from browser Cache API; worker startup + ONNX WebGPU session initialization + upstream `tokenizer_config.json` metadata probe on `main`). |

### Inference Runs (3 rounds × 3 examples, `prepared-model` condition)

| Run     | Example     | Normalized Image | First Text (`ms`) | Completion (`ms`) | Verbatim Output                               |
| ------- | ----------- | ---------------- | ----------------- | ----------------- | --------------------------------------------- |
| `run-1` | `scene`     | `1024x682`       | `5,027.2`         | `5,375.6`         | `There are books and a laptop on a table.`    |
| `run-4` | `scene`     | `1024x682`       | `4,309.5`         | `4,523.0`         | `There are books and a laptop on a table.`    |
| `run-7` | `scene`     | `1024x682`       | `3,982.8`         | `4,098.9`         | `There are books and a laptop on a table.`    |
| `run-2` | `text`      | `1024x682`       | `4,068.7`         | `4,138.9`         | `Electric fence.`                             |
| `run-5` | `text`      | `1024x682`       | `4,137.1`         | `4,189.1`         | `Electric fence.`                             |
| `run-8` | `text`      | `1024x682`       | `3,797.3`         | `3,864.0`         | `Electric fence.`                             |
| `run-3` | `ambiguous` | `1024x768`       | `4,223.2`         | `4,369.1`         | `The part of the car covered in black cloth.` |
| `run-6` | `ambiguous` | `1024x768`       | `4,080.6`         | `4,212.6`         | `The part of the car covered in black cloth.` |
| `run-9` | `ambiguous` | `1024x768`       | `4,426.6`         | `4,589.5`         | `The part of the car covered in black cloth.` |

### Human Review of SmolVLM-256M-Instruct Results

- **Determinism:** Because `SmolVLM-256M-Instruct` runs with `do_sample: false` (greedy decoding), all three independent runs per example produced identical outputs, while latencies varied slightly (`~3.86–5.38 s` total, dominated by ~3.8–5.0 s prefill/first-text time before emitting short outputs).
- **`scene` (`scene-objects.jpg`):** Accurately identified core objects (`books`, `laptop`, `table`/desk) without hallucinating items, but omitted secondary objects (desk lamp, spiral notebook, eyeglasses, rolled papers, file holder) and gave no spatial left/right relationships despite the prompt asking _"where are they?"_.
- **`text` (`short-text.jpg`):** Accurately transcribed the main sign headline (`Electric fence.`, normalized to sentence case) without inventing characters; omitted the tiny bottom-corner text (`G602000`, `GALLAGHER`, `POWER FENCE SYSTEMS`).
- **`ambiguous` (`ambiguous-object.jpg`):** Correctly recognized a car covered in black cloth without fabricating a brand, model, or paint color, though it omitted the garage/spatial location and stopped short of explicitly addressing the second half of the prompt (_"Explain any uncertainty"_).

### Supplementary Observation: Prompt Phrasing & Model Capacity (SmolVLM-256M-Instruct)

Even with `max_new_tokens: 256`, `SmolVLM-256M-Instruct` regularly emits single-sentence answers on the bundled preset questions. Four verified factors explain this behaviour:

1. **VQA vs. captioning dataset conditioning:** `SmolVLM-256M-Instruct` was fine-tuned heavily on academic VQA and OCR datasets (`the_cauldron`, `Docmatix`) alongside synthetic captions. Interrogative VQA/OCR questions (`"What objects..."`, `"Transcribe..."`, `"Can you identify..."`) route into terse ground-truth answer distributions where `<end_of_utterance>` becomes the top-probability token immediately after the core answer, whereas captioning prompts (`"Can you describe this image?"`) trigger multi-sentence descriptions.
2. **Decoder scale (`~135M` text parameters):** Roughly `93M` of the `256M` parameters belong to the SigLIP vision encoder and only `~135M` to the `SmolLM2-135M-Instruct` language decoder—lacking the multi-billion-parameter chat/Markdown post-training and multi-part instruction capacity of Chrome's browser-managed Gemini Nano.
3. **Greedy decoding (`do_sample: false`) with no hidden coaching:** Deterministic argmax immediately selects `<end_of_utterance>` once the minimal VQA answer completes.
4. **Quantization (`q8/q4/q4`) is not the primary cause:** Earlier checks using `fp32` `vision_encoder` and `fp32` `embed_tokens` produced nearly identical single-sentence output on `scene` (`"There are books and a laptop on a wooden table."`).

To verify prompt-phrasing sensitivity directly in the app, three prompts were run against `scene-objects.jpg` (`1024x682`) in Google Chrome Canary `160.0.8165.0` on Apple M2 Pro (macOS `27.2.1`, `WebGPU (apple · metal-3)`, `q8/q4/q4`):

| Prompt                                                                                     | Completion (`ms`) | Verbatim Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `What objects are visible and where are they?`                                             | `4,284.9`         | `There are books and a laptop on a table.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Can you describe this image?`                                                             | `4,405.3`         | `In the foreground of the image we can see a table on which we can see a laptop, books, a pen, a box, a glass and a lamp. Behind the table we can see a wall. On the wall we can see a white color.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Describe this image in detail, listing each visible object and its position on the desk.` | `6,432.0`         | `The image is a photograph of a desk with a laptop on it. The laptop is placed on a wooden table, and the desk has a black and white background. On the left side of the laptop, there is a black and white square lamp with a small black light fixture. On the right side of the laptop, there are several books stacked on top of each other, some of which are closed and some are open, and there are some black and white photos on the top of the stack.On the left side of the laptop, there is a black and white square lamp with a small black light fixture. Next to the lamp, there is a black and white square box with a black and white photo on it. On the right side of the laptop, there are some black and white photos on top of a stack of books. There are some black and white photos on top of the stack of books, and there are some black and white photos on top of the stack of books.On the left side of the laptop, there is a black and white square box with a black and white photo on it. Next to the black and white box, there is a black and white photo on top of a stack of books. There are some black and` |

Notice how forcing long-form output on this `135M` decoder under greedy decoding without `repetition_penalty` triggers hallucinated details (such as `"black and white photos on top of the stack"` and a `"black and white background"`) and falls into a repetition loop until truncated at `max_new_tokens: 256`. Accordingly, the app preserves identical visible user prompts across both providers rather than adding hidden provider-specific coaching or `min_new_tokens` overrides.

## Chrome Prompt API (`LanguageModel`) — Status

- **Automated check outcome:** In fresh automated profiles of Google Chrome `157.0.8103.79` and Google Chrome Canary `160.0.8165.0` on macOS `27.2.1`, `typeof LanguageModel !== 'undefined'` was `true`, and `LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] })` returned `'unavailable'`.
- **Outstanding manual step (not substituted with mocks):** Run the 3 examples × 3 times each in Luca's interactive Chrome profile (where Gemini Nano and multimodal Prompt API flags/components are provisioned), click **Export JSON records**, and append the recorded rows below before publishing the comparison table in the article.
