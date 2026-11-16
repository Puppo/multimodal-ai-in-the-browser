import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../workers/worker-protocol';
import type {
  AvailabilityResult,
  CancelResult,
  GenerationOutcome,
  GenerationRequest,
  PreparationProgress,
  PrepareResult,
  ProviderAdapter,
  ProviderTechnicalMetadata,
} from './types';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const MODEL_REVISION = 'd039ab0d4b9311b617e8ffec1d06c8464364aeb3';
const CANCEL_TERMINATION_TIMEOUT_MS = 1500;
const DISPOSE_TIMEOUT_MS = 1000;

function createAbortError(message = 'Operation cancelled.'): DOMException {
  return new DOMException(message, 'AbortError');
}

function buildInitialMetadata(
  backend: string,
  extraCapabilities?: Record<string, string | number | boolean | null>,
): ProviderTechnicalMetadata {
  return {
    providerName: 'Transformers.js + SmolVLM-256M-Instruct',
    runtime: '@huggingface/transformers 4.3.2 (loaded on prepare)',
    executionContext: 'module-web-worker',
    backend,
    modelId: MODEL_ID,
    modelRevision: MODEL_REVISION,
    modelLicense: 'Apache-2.0',
    dtype: {
      embed_tokens: 'q8',
      vision_encoder: 'q4',
      decoder_model_merged: 'q4',
    },
    promptTemplateNote:
      'SmolVLM/Idefics3 chat template via processor.apply_chat_template(...); image processor splits up to 512x512 patches + global overview.',
    generationSettings: {
      do_sample: false,
      max_new_tokens: 256,
    },
    packageVersions: {
      '@huggingface/transformers': '4.3.2',
    },
    reportedCapabilities: extraCapabilities,
  };
}

export class TransformersSmolVlmAdapter implements ProviderAdapter {
  readonly id = 'transformers-smolvlm' as const;
  readonly label = 'Transformers.js (SmolVLM-256M)';
  readonly summary =
    'Runs HuggingFaceTB/SmolVLM-256M-Instruct in a dedicated module Web Worker using WebGPU.';

  private worker: Worker | null = null;
  private isPrepared = false;
  private activeOperation: {
    kind: 'prepare' | 'generate';
    requestId: string;
    reject: (error: Error) => void;
    onChunk?: (delta: string, accumulated: string) => void;
    accumulated?: string;
    resolvePrepare?: (result: PrepareResult) => void;
    resolveGenerate?: (result: GenerationOutcome) => void;
    onProgress?: (progress: PreparationProgress) => void;
    cleanupSignal?: () => void;
  } | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private disposeResolver: (() => void) | null = null;
  private requestCounter = 0;

  async checkAvailability(): Promise<AvailabilityResult> {
    if (typeof Worker === 'undefined') {
      return {
        state: 'unavailable',
        reason: 'Web Workers are not supported in this browser.',
        details: buildInitialMetadata('Unavailable (no Web Worker)'),
      };
    }

    if (!('gpu' in navigator) || !navigator.gpu) {
      return {
        state: 'unavailable',
        reason:
          'WebGPU is not available in this browser. Transformers.js SmolVLM requires WebGPU (CPU/WASM fallback is intentionally disabled for this comparison).',
        details: buildInitialMetadata('Unavailable (navigator.gpu missing)', {
          webgpuPresent: false,
        }),
      };
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        return {
          state: 'unavailable',
          reason: 'No WebGPU adapter could be obtained on this device/browser.',
          details: buildInitialMetadata('Unavailable (no WebGPU adapter)', {
            webgpuPresent: true,
            adapterObtained: false,
          }),
        };
      }

      const device = await adapter.requestDevice();
      const info = adapter.info;
      const parts = [
        info?.vendor,
        info?.architecture,
        info?.description,
      ].filter(
        (part): part is string =>
          typeof part === 'string' && part.trim().length > 0,
      );
      const backend =
        parts.length > 0 ? `WebGPU (${parts.join(' · ')})` : 'WebGPU';
      device.destroy();

      if (this.isPrepared && this.worker) {
        return {
          state: 'ready',
          reason: 'SmolVLM-256M-Instruct is loaded in the Web Worker.',
          details: buildInitialMetadata(backend, {
            webgpuPresent: true,
            adapterObtained: true,
            deviceObtained: true,
          }),
        };
      }

      return {
        state: 'needs-download',
        reason:
          'WebGPU is available. Click Prepare model to start the worker and load SmolVLM-256M-Instruct (~170 MiB ONNX weights; cached locally after first download).',
        details: buildInitialMetadata(backend, {
          webgpuPresent: true,
          adapterObtained: true,
          deviceObtained: true,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state: 'unavailable',
        reason: `WebGPU initialization check failed: ${message}`,
        details: buildInitialMetadata('Unavailable (WebGPU check failed)', {
          webgpuPresent: true,
        }),
      };
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(
      new URL('../workers/transformers.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      this.handleWorkerMessage(event.data);
    };
    worker.onerror = (event) => {
      const op = this.activeOperation;
      this.terminateWorkerImmediate();
      if (op) {
        op.cleanupSignal?.();
        op.reject(
          new Error(event.message || 'Transformers.js worker crashed.'),
        );
      }
    };
    this.worker = worker;
    return worker;
  }

  private postToWorker(message: WorkerInboundMessage): void {
    this.worker?.postMessage(message);
  }

  private clearCancelTimer(): void {
    if (this.cancelTimer !== null) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
  }

  private terminateWorkerImmediate(): void {
    this.clearCancelTimer();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.isPrepared = false;
    this.activeOperation = null;
    if (this.disposeResolver) {
      this.disposeResolver();
      this.disposeResolver = null;
    }
  }

  private handleWorkerMessage(message: WorkerOutboundMessage): void {
    if (message.type === 'disposed') {
      this.terminateWorkerImmediate();
      return;
    }

    const op = this.activeOperation;
    if (!op || message.requestId !== op.requestId) {
      // Ignore late/stale worker messages from cancelled or superseded requests
      return;
    }

    switch (message.type) {
      case 'prepare-progress':
        if (op.kind === 'prepare') {
          op.onProgress?.(message.progress);
        }
        break;

      case 'prepare-complete':
        if (op.kind === 'prepare') {
          this.isPrepared = true;
          this.activeOperation = null;
          op.cleanupSignal?.();
          op.resolvePrepare?.({
            preparationMs: message.preparationMs,
            details: message.details,
          });
        }
        break;

      case 'generate-chunk':
        if (op.kind === 'generate') {
          const nextAccumulated = (op.accumulated ?? '') + message.delta;
          op.accumulated = nextAccumulated;
          op.onChunk?.(message.delta, nextAccumulated);
        }
        break;

      case 'generate-complete':
        if (op.kind === 'generate') {
          this.clearCancelTimer();
          this.activeOperation = null;
          op.cleanupSignal?.();
          op.resolveGenerate?.({
            requestId: message.requestId,
            text: message.text || op.accumulated || '',
            firstTextMs: message.firstTextMs,
            totalLatencyMs: message.totalLatencyMs,
            details: message.details,
          });
        }
        break;

      case 'cancelled':
        this.clearCancelTimer();
        this.activeOperation = null;
        op.cleanupSignal?.();
        op.reject(createAbortError('Transformers.js operation was cancelled.'));
        break;

      case 'error':
        this.clearCancelTimer();
        this.activeOperation = null;
        op.cleanupSignal?.();
        if (message.phase === 'prepare') {
          this.isPrepared = false;
        }
        op.reject(new Error(message.message));
        break;
    }
  }

  async prepare(options: {
    onProgress: (progress: PreparationProgress) => void;
    signal: AbortSignal;
  }): Promise<PrepareResult> {
    if (options.signal.aborted) {
      throw createAbortError('Preparation cancelled.');
    }

    const requestId = `prep-${++this.requestCounter}`;
    const worker = this.ensureWorker();

    return new Promise<PrepareResult>((resolve, reject) => {
      const onAbort = () => {
        const op = this.activeOperation;
        this.terminateWorkerImmediate();
        if (op) {
          op.cleanupSignal?.();
        }
        reject(
          createAbortError('SmolVLM preparation cancelled; worker reset.'),
        );
      };

      options.signal.addEventListener('abort', onAbort, { once: true });

      this.activeOperation = {
        kind: 'prepare',
        requestId,
        onProgress: options.onProgress,
        resolvePrepare: resolve,
        reject,
        cleanupSignal: () => {
          options.signal.removeEventListener('abort', onAbort);
        },
      };

      worker.postMessage({
        type: 'prepare',
        requestId,
      } satisfies WorkerInboundMessage);
    });
  }

  async generate(request: GenerationRequest): Promise<GenerationOutcome> {
    if (!this.worker || !this.isPrepared) {
      throw new Error(
        'SmolVLM-256M-Instruct is not prepared. Click Prepare model first.',
      );
    }
    if (request.signal.aborted) {
      throw createAbortError('Generation cancelled.');
    }

    return new Promise<GenerationOutcome>((resolve, reject) => {
      const onAbort = () => {
        if (
          !this.activeOperation ||
          this.activeOperation.requestId !== request.requestId
        ) {
          return;
        }
        this.postToWorker({
          type: 'cancel',
          requestId: request.requestId,
        });
        this.clearCancelTimer();
        this.cancelTimer = setTimeout(() => {
          const op = this.activeOperation;
          this.terminateWorkerImmediate();
          if (op) {
            op.cleanupSignal?.();
            op.reject(
              createAbortError(
                'Worker terminated because inference did not stop cooperatively; re-prepare model to continue.',
              ),
            );
          }
        }, CANCEL_TERMINATION_TIMEOUT_MS);
      };

      request.signal.addEventListener('abort', onAbort, { once: true });

      this.activeOperation = {
        kind: 'generate',
        requestId: request.requestId,
        onChunk: request.onChunk,
        accumulated: '',
        resolveGenerate: resolve,
        reject,
        cleanupSignal: () => {
          request.signal.removeEventListener('abort', onAbort);
        },
      };

      this.postToWorker({
        type: 'generate',
        requestId: request.requestId,
        imageBlob: request.imageBlob,
        prompt: request.prompt,
      });
    });
  }

  async cancelActive(): Promise<CancelResult> {
    const op = this.activeOperation;
    if (!op) {
      return { requiresReprepare: !this.isPrepared };
    }

    if (op.kind === 'prepare') {
      op.cleanupSignal?.();
      this.terminateWorkerImmediate();
      op.reject(createAbortError('Model preparation cancelled; worker reset.'));
      return { requiresReprepare: true };
    }

    this.postToWorker({ type: 'cancel', requestId: op.requestId });

    // Wait briefly for cooperative InterruptableStoppingCriteria, else hard-terminate worker
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.activeOperation === null) {
          clearInterval(checkInterval);
          clearTimeout(hardKillTimer);
          resolve();
        }
      }, 50);

      const hardKillTimer = setTimeout(() => {
        clearInterval(checkInterval);
        const currentOp = this.activeOperation;
        this.terminateWorkerImmediate();
        if (currentOp) {
          currentOp.cleanupSignal?.();
          currentOp.reject(
            createAbortError(
              'Worker terminated after cancellation timeout; re-prepare required.',
            ),
          );
        }
        resolve();
      }, CANCEL_TERMINATION_TIMEOUT_MS);
    });

    return { requiresReprepare: !this.isPrepared };
  }

  async dispose(): Promise<void> {
    if (!this.worker) {
      this.isPrepared = false;
      this.activeOperation = null;
      return;
    }

    const op = this.activeOperation;
    if (op) {
      op.cleanupSignal?.();
      this.activeOperation = null;
      op.reject(createAbortError('Provider disposed.'));
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.terminateWorkerImmediate();
        resolve();
      }, DISPOSE_TIMEOUT_MS);

      this.disposeResolver = () => {
        clearTimeout(timer);
        resolve();
      };

      this.postToWorker({ type: 'dispose' });
    });
  }
}
