import {
  AutoModelForVision2Seq,
  AutoProcessor,
  env,
  InterruptableStoppingCriteria,
  type PreTrainedModel,
  type Processor,
  type ProgressInfo,
  RawImage,
  StoppingCriteriaList,
  type Tensor,
  TextStreamer,
} from '@huggingface/transformers';
import ortWasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import type { ProviderTechnicalMetadata } from '../providers/types';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './worker-protocol';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: ortWasmMjsUrl,
    wasm: ortWasmBinaryUrl,
  };
}

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const MODEL_REVISION = 'd039ab0d4b9311b617e8ffec1d06c8464364aeb3';
const MODEL_LICENSE = 'Apache-2.0';
const MAX_NEW_TOKENS = 256;

const MODEL_DTYPE = {
  embed_tokens: 'q8',
  vision_encoder: 'q4',
  decoder_model_merged: 'q4',
} as const;

let processorInstance: Processor | null = null;
let modelInstance: PreTrainedModel | null = null;
let activeStoppingCriteria: InterruptableStoppingCriteria | null = null;
let activeRequestId: string | null = null;
let webgpuAdapterDescription = 'WebGPU';

function post(message: WorkerOutboundMessage): void {
  self.postMessage(message);
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function buildMetadata(): ProviderTechnicalMetadata {
  return {
    providerName: 'Transformers.js + SmolVLM-256M-Instruct',
    runtime: `@huggingface/transformers ${env.version}`,
    executionContext: 'module-web-worker',
    backend: webgpuAdapterDescription,
    modelId: MODEL_ID,
    modelRevision: MODEL_REVISION,
    modelLicense: MODEL_LICENSE,
    dtype: { ...MODEL_DTYPE },
    promptTemplateNote:
      'SmolVLM/Idefics3 chat template via processor.apply_chat_template([{ role: "user", content: [{ type: "image" }, { type: "text", text: question }] }], { add_generation_prompt: true }); image processor splits up to 512x512 patches + global overview.',
    generationSettings: {
      do_sample: false,
      max_new_tokens: MAX_NEW_TOKENS,
    },
    packageVersions: {
      '@huggingface/transformers': env.version,
    },
  };
}

async function detectWebGpuDescription(): Promise<string> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new Error('WebGPU is not exposed inside the worker.');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error(
      'Unable to acquire a WebGPU adapter inside the module worker.',
    );
  }
  const info = adapter.info;
  const parts = [info?.vendor, info?.architecture, info?.description].filter(
    (part): part is string =>
      typeof part === 'string' && part.trim().length > 0,
  );
  return parts.length > 0 ? `WebGPU (${parts.join(' · ')})` : 'WebGPU';
}

function createProgressHandler(requestId: string) {
  const fileTotals = new Map<string, { loaded: number; total: number }>();

  return (info: ProgressInfo): void => {
    if (info.status === 'progress_total') {
      const ratio = Number.isFinite(info.progress)
        ? Math.min(1, Math.max(0, info.progress / 100))
        : null;
      const pct = ratio === null ? null : Math.round(ratio * 100);
      post({
        type: 'prepare-progress',
        requestId,
        progress: {
          progress: ratio,
          statusText:
            pct === null
              ? 'Loading SmolVLM model files...'
              : pct >= 100
                ? 'Initializing WebGPU sessions and compiling shaders (100%)...'
                : `Loading SmolVLM model files (${pct}%)`,
        },
      });
      return;
    }

    if (info.status === 'progress') {
      fileTotals.set(info.file, { loaded: info.loaded, total: info.total });
      let loadedSum = 0;
      let totalSum = 0;
      for (const entry of fileTotals.values()) {
        loadedSum += entry.loaded;
        totalSum += entry.total;
      }
      const ratio =
        totalSum > 0 ? Math.min(1, Math.max(0, loadedSum / totalSum)) : null;
      post({
        type: 'prepare-progress',
        requestId,
        progress: {
          progress: ratio,
          file: info.file,
          statusText:
            ratio === null
              ? `Loading ${info.file}...`
              : `Loading ${info.file} (${Math.round(ratio * 100)}%)`,
        },
      });
      return;
    }

    if (info.status === 'initiate' || info.status === 'download') {
      post({
        type: 'prepare-progress',
        requestId,
        progress: {
          progress: null,
          file: info.file,
          statusText: `Fetching ${info.file}...`,
        },
      });
    }
  };
}

function disposeTensorRecord(record: Record<string, unknown>): void {
  for (const value of Object.values(record)) {
    if (
      value &&
      typeof value === 'object' &&
      'dispose' in value &&
      typeof (value as Tensor).dispose === 'function'
    ) {
      try {
        (value as Tensor).dispose();
      } catch {
        // Ignore already-disposed tensors
      }
    }
  }
}

async function handlePrepare(requestId: string): Promise<void> {
  const startedAt = performance.now();
  try {
    webgpuAdapterDescription = await detectWebGpuDescription();

    if (!processorInstance || !modelInstance) {
      const progress_callback = createProgressHandler(requestId);
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID, {
          revision: MODEL_REVISION,
          progress_callback,
        }),
        AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
          revision: MODEL_REVISION,
          device: 'webgpu',
          dtype: { ...MODEL_DTYPE },
          progress_callback,
        }),
      ]);
      processorInstance = processor;
      modelInstance = model;
    }

    post({
      type: 'prepare-complete',
      requestId,
      preparationMs: roundMs(performance.now() - startedAt),
      details: buildMetadata(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: 'error',
      requestId,
      phase: 'prepare',
      message,
    });
  }
}

async function handleGenerate(
  requestId: string,
  imageBlob: Blob,
  prompt: string,
): Promise<void> {
  if (!processorInstance || !modelInstance || !processorInstance.tokenizer) {
    post({
      type: 'error',
      requestId,
      phase: 'generate',
      message: 'SmolVLM model is not prepared yet.',
    });
    return;
  }

  activeRequestId = requestId;
  const stoppingCriteria = new InterruptableStoppingCriteria();
  activeStoppingCriteria = stoppingCriteria;
  const stoppingList = new StoppingCriteriaList();
  stoppingList.push(stoppingCriteria);

  const startedAt = performance.now();
  let firstTextMs: number | null = null;
  let streamedText = '';
  let inputsRecord: Record<string, unknown> | null = null;
  let sequencesOutput: unknown = null;

  try {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'image' }, { type: 'text', text: prompt }],
      },
    ];
    const formattedPrompt = processorInstance.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    });
    const rawImage = await RawImage.fromBlob(imageBlob);
    const inputs = (await processorInstance(formattedPrompt, [
      rawImage,
    ])) as Record<string, unknown>;
    inputsRecord = inputs;

    const streamer = new TextStreamer(processorInstance.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (delta: string) => {
        if (delta.length === 0 || activeRequestId !== requestId) {
          return;
        }
        if (firstTextMs === null) {
          firstTextMs = roundMs(performance.now() - startedAt);
        }
        streamedText += delta;
        post({ type: 'generate-chunk', requestId, delta });
      },
    });

    sequencesOutput = await modelInstance.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      streamer,
      stopping_criteria: stoppingList,
    });

    if (stoppingCriteria.interrupted) {
      post({ type: 'cancelled', requestId });
      return;
    }

    const totalLatencyMs = roundMs(performance.now() - startedAt);
    post({
      type: 'generate-complete',
      requestId,
      text: streamedText.trim(),
      firstTextMs,
      totalLatencyMs,
      details: buildMetadata(),
    });
  } catch (error) {
    if (stoppingCriteria.interrupted) {
      post({ type: 'cancelled', requestId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: 'error',
      requestId,
      phase: 'generate',
      message,
    });
  } finally {
    if (inputsRecord) {
      disposeTensorRecord(inputsRecord);
    }
    if (
      sequencesOutput &&
      typeof sequencesOutput === 'object' &&
      'dispose' in sequencesOutput &&
      typeof (sequencesOutput as Tensor).dispose === 'function'
    ) {
      try {
        (sequencesOutput as Tensor).dispose();
      } catch {
        // Ignore already-disposed output tensor
      }
    }
    if (activeRequestId === requestId) {
      activeRequestId = null;
    }
    if (activeStoppingCriteria === stoppingCriteria) {
      activeStoppingCriteria = null;
    }
  }
}

async function handleDispose(): Promise<void> {
  try {
    activeStoppingCriteria?.interrupt();
    if (modelInstance) {
      await modelInstance.dispose();
    }
  } finally {
    modelInstance = null;
    processorInstance = null;
    activeRequestId = null;
    activeStoppingCriteria = null;
    post({ type: 'disposed' });
  }
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'prepare':
      void handlePrepare(message.requestId);
      break;
    case 'generate':
      void handleGenerate(message.requestId, message.imageBlob, message.prompt);
      break;
    case 'cancel':
      if (activeRequestId === message.requestId) {
        activeStoppingCriteria?.interrupt();
      }
      break;
    case 'dispose':
      void handleDispose();
      break;
  }
};
