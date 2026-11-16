import { describe, expect, it, vi } from 'vitest';
import { AppController, type ImagePipeline } from '../../src/app/controller';
import type { NormalizedImage } from '../../src/images/normalize';
import type {
  AvailabilityResult,
  CancelResult,
  GenerationOutcome,
  GenerationRequest,
  PreparationProgress,
  PrepareResult,
  ProviderAdapter,
  ProviderTechnicalMetadata,
} from '../../src/providers/types';

function makeImage(label: string): NormalizedImage {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    mimeType: 'image/png',
    previewUrl: `blob:http://localhost/${label}`,
    sourceLabel: label,
    originalMimeType: 'image/jpeg',
    originalByteLength: 1000,
    normalizedByteLength: 800,
    originalWidth: 1280,
    originalHeight: 853,
    width: 1024,
    height: 682,
    wasResized: true,
  };
}

function makeDetails(providerName: string): ProviderTechnicalMetadata {
  return {
    providerName,
    runtime: 'Test Double',
    executionContext: 'main-thread',
    backend: 'Mock',
    modelId: 'mock-model',
    modelRevision: 'mock-rev',
    modelLicense: 'MIT',
    dtype: 'mock',
    promptTemplateNote: 'Mock',
    generationSettings: {},
  };
}

class StubProvider implements ProviderAdapter {
  readonly id;
  readonly label;
  readonly summary = 'Stub';
  availabilityState: AvailabilityResult['state'] = 'needs-download';
  disposedCount = 0;
  cancelledCount = 0;
  onGenerate?: (
    req: GenerationRequest,
    helpers: {
      resolve: (outcome: GenerationOutcome) => void;
      reject: (err: Error) => void;
    },
  ) => void;

  constructor(
    id: 'chrome-prompt-api' | 'transformers-smolvlm',
    label: string,
    availabilityState: AvailabilityResult['state'] = 'needs-download',
  ) {
    this.id = id;
    this.label = label;
    this.availabilityState = availabilityState;
  }

  async checkAvailability(): Promise<AvailabilityResult> {
    return {
      state: this.availabilityState,
      reason: `${this.label}: ${this.availabilityState}`,
      details: makeDetails(this.label),
    };
  }

  async prepare(options: {
    onProgress: (progress: PreparationProgress) => void;
    signal: AbortSignal;
  }): Promise<PrepareResult> {
    options.onProgress({ progress: 0.5, statusText: 'Halfway' });
    return {
      preparationMs: 120,
      details: makeDetails(this.label),
    };
  }

  async generate(request: GenerationRequest): Promise<GenerationOutcome> {
    if (this.onGenerate) {
      return new Promise<GenerationOutcome>((resolve, reject) => {
        this.onGenerate?.(request, { resolve, reject });
      });
    }
    request.onChunk('Hello ', 'Hello ');
    request.onChunk('world', 'Hello world');
    return {
      requestId: request.requestId,
      text: 'Hello world',
      firstTextMs: 10,
      totalLatencyMs: 25,
      details: makeDetails(this.label),
    };
  }

  async cancelActive(): Promise<CancelResult> {
    this.cancelledCount += 1;
    return { requiresReprepare: false };
  }

  async dispose(): Promise<void> {
    this.disposedCount += 1;
  }
}

function makeFakeImagePipeline(): ImagePipeline {
  return {
    fetchExampleBlob: async () =>
      new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
    normalize: async (_blob, label) => makeImage(label),
    revoke: vi.fn(),
  };
}

describe('AppController lifecycle and isolation', () => {
  it('captures immutable prompt and image snapshots on run', async () => {
    const chrome = new StubProvider('chrome-prompt-api', 'Chrome', 'ready');
    const smol = new StubProvider(
      'transformers-smolvlm',
      'SmolVLM',
      'needs-download',
    );
    const captured: { req: GenerationRequest | null } = { req: null };
    let finishRun!: (outcome: GenerationOutcome) => void;

    chrome.onGenerate = (req, { resolve }) => {
      captured.req = req;
      finishRun = resolve;
    };

    const controller = new AppController({
      providers: { 'chrome-prompt-api': chrome, 'transformers-smolvlm': smol },
      imagePipeline: makeFakeImagePipeline(),
    });
    await controller.init();
    controller.setQuestion('Initial question');
    controller.setCacheCondition('prepared-model');

    const runPromise = controller.runExperiment();
    await Promise.resolve();

    // Mutate question & cache condition while run is in flight
    controller.setQuestion('Edited later');
    controller.setCacheCondition('clean-download');

    // Duplicate run call must be ignored
    await controller.runExperiment();
    expect(controller.getState().requestState).toBe('running');

    captured.req?.onChunk('Answer', 'Answer');
    finishRun({
      requestId: captured.req?.requestId ?? '',
      text: 'Answer',
      firstTextMs: 5,
      totalLatencyMs: 15,
      details: makeDetails('Chrome'),
    });
    await runPromise;

    const record = controller.getState().records[0];
    expect(record?.prompt).toBe('Initial question');
    expect(record?.cacheCondition).toBe('prepared-model');
    expect(record?.answerText).toBe('Answer');
  });

  it('ignores stale chunks and disposes previous provider sequentially on switch', async () => {
    const chrome = new StubProvider('chrome-prompt-api', 'Chrome', 'ready');
    const smol = new StubProvider(
      'transformers-smolvlm',
      'SmolVLM',
      'needs-download',
    );

    const first: { req: GenerationRequest | null } = { req: null };
    chrome.onGenerate = (req, { reject }) => {
      first.req = req;
      req.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    };

    const controller = new AppController({
      providers: { 'chrome-prompt-api': chrome, 'transformers-smolvlm': smol },
      imagePipeline: makeFakeImagePipeline(),
    });
    await controller.init();
    controller.setQuestion('Question preserved across switch');

    const runPromise = controller.runExperiment();
    await Promise.resolve();
    await controller.selectProvider('transformers-smolvlm');
    await runPromise;

    // Late stale chunk arriving from old request must not update draft text
    first.req?.onChunk('STALE CHUNK', 'STALE CHUNK');

    expect(chrome.cancelledCount).toBeGreaterThanOrEqual(1);
    expect(chrome.disposedCount).toBe(1);
    expect(controller.getState().selectedProvider).toBe('transformers-smolvlm');
    expect(controller.getState().question).toBe(
      'Question preserved across switch',
    );
    expect(controller.getState().activeDraftText).toBe('');
  });

  it('keeps previous image and question consistent when example fetch fails offline', async () => {
    const chrome = new StubProvider('chrome-prompt-api', 'Chrome', 'ready');
    const smol = new StubProvider('transformers-smolvlm', 'SmolVLM', 'ready');
    let failFetch = false;

    const controller = new AppController({
      providers: { 'chrome-prompt-api': chrome, 'transformers-smolvlm': smol },
      imagePipeline: {
        fetchExampleBlob: async () => {
          if (failFetch) {
            throw new Error('Network offline');
          }
          return new Blob([new Uint8Array([9])], { type: 'image/jpeg' });
        },
        normalize: async (_blob, label) => makeImage(label),
        revoke: vi.fn(),
      },
    });
    await controller.init();
    expect(controller.getState().selectedExampleId).toBe('scene');
    const initialQuestion = controller.getState().question;

    failFetch = true;
    await controller.selectExample('text');

    expect(controller.getState().imageError).toContain('Network offline');
    expect(controller.getState().selectedExampleId).toBe('scene');
    expect(controller.getState().question).toBe(initialQuestion);
    expect(controller.getState().normalizedImage?.sourceLabel).toBe('scene');
  });
});
