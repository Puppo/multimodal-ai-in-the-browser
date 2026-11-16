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

const CHROME_MODALITIES: LanguageModelCreateCoreOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof DOMException && error.name === 'AbortError';
}

function createAbortError(message = 'Operation cancelled.'): DOMException {
  return new DOMException(message, 'AbortError');
}

function buildChromeMetadata(
  extraCapabilities?: Record<string, string | number | boolean | null>,
): ProviderTechnicalMetadata {
  return {
    providerName: 'Chrome Built-in AI (Prompt API)',
    runtime: 'Browser LanguageModel API (Gemini Nano)',
    executionContext: 'main-thread',
    backend: 'Browser-managed on-device runtime',
    modelId: 'gemini-nano (browser-managed)',
    modelRevision: 'Not exposed or pinnable via LanguageModel web API',
    modelLicense: 'Browser-managed (Google Chrome terms / Gemini Nano)',
    dtype: 'Browser-managed (not exposed)',
    promptTemplateNote:
      'Direct user message array: [{ role: "user", content: [{ type: "image", value: normalizedPngBlob }, { type: "text", value: question }] }]; no hidden system instruction.',
    generationSettings: {
      samplingMode: 'browser default',
    },
    reportedCapabilities: extraCapabilities,
  };
}

export class ChromePromptApiAdapter implements ProviderAdapter {
  readonly id = 'chrome-prompt-api' as const;
  readonly label = 'Chrome Prompt API';
  readonly summary =
    'Uses Chrome’s built-in LanguageModel API on the main thread with browser-managed Gemini Nano weights.';

  private activeSession: LanguageModel | null = null;
  private activeAbortController: AbortController | null = null;
  private warmupAbortController: AbortController | null = null;

  async checkAvailability(): Promise<AvailabilityResult> {
    if (
      typeof LanguageModel === 'undefined' ||
      typeof LanguageModel.availability !== 'function' ||
      typeof LanguageModel.create !== 'function'
    ) {
      return {
        state: 'unavailable',
        reason:
          'LanguageModel API is not exposed in this browser. Chrome Built-in AI with multimodal input is required.',
        details: buildChromeMetadata({ languageModelPresent: false }),
      };
    }

    try {
      const availability = await LanguageModel.availability(CHROME_MODALITIES);
      const details = buildChromeMetadata({
        languageModelPresent: true,
        reportedAvailability: availability,
      });

      switch (availability) {
        case 'available':
          return {
            state: 'ready',
            reason:
              'Chrome Prompt API reports "available" for English text and image input.',
            details,
          };
        case 'downloadable':
          return {
            state: 'needs-download',
            reason:
              'Chrome Prompt API reports "downloadable". Click Prepare model to trigger the browser-managed model download.',
            details,
          };
        case 'downloading':
          return {
            state: 'needs-download',
            reason:
              'Chrome Prompt API reports "downloading". Click Prepare model to monitor progress until ready.',
            details,
          };
        case 'unavailable':
          return {
            state: 'unavailable',
            reason:
              'Chrome Prompt API reports "unavailable" for multimodal English text + image input on this device or browser profile.',
            details,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state: 'error',
        reason: `Failed to query LanguageModel.availability(): ${message}`,
        details: buildChromeMetadata({ languageModelPresent: true }),
      };
    }
  }

  async prepare(options: {
    onProgress: (progress: PreparationProgress) => void;
    signal: AbortSignal;
  }): Promise<PrepareResult> {
    if (
      typeof LanguageModel === 'undefined' ||
      typeof LanguageModel.create !== 'function'
    ) {
      throw new Error(
        'LanguageModel API is not available in this browser context.',
      );
    }

    const combinedController = new AbortController();
    this.warmupAbortController = combinedController;
    const onExternalAbort = () => {
      combinedController.abort();
    };
    options.signal.addEventListener('abort', onExternalAbort, { once: true });

    const startedAt = performance.now();
    options.onProgress({
      progress: null,
      statusText: 'Preparing Chrome Prompt API session...',
    });

    let warmupSession: LanguageModel | null = null;
    try {
      warmupSession = await LanguageModel.create({
        ...CHROME_MODALITIES,
        signal: combinedController.signal,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            let ratio: number | null = null;
            if (Number.isFinite(event.loaded)) {
              if (event.lengthComputable && event.total > 0) {
                ratio = Math.min(1, Math.max(0, event.loaded / event.total));
              } else if (event.loaded >= 0 && event.loaded <= 1) {
                ratio = event.loaded;
              }
            }
            options.onProgress({
              progress: ratio,
              statusText:
                ratio === null
                  ? 'Downloading browser-managed Chrome AI model...'
                  : `Downloading browser-managed Chrome AI model (${Math.round(ratio * 100)}%)`,
            });
          });
        },
      });

      const capabilities: Record<string, string | number | boolean | null> = {
        languageModelPresent: true,
        contextWindow:
          typeof warmupSession.contextWindow === 'number'
            ? warmupSession.contextWindow
            : null,
      };

      return {
        preparationMs: roundMs(performance.now() - startedAt),
        details: buildChromeMetadata(capabilities),
      };
    } catch (error) {
      if (isAbortError(error, combinedController.signal)) {
        throw createAbortError('Chrome model preparation was cancelled.');
      }
      throw error;
    } finally {
      options.signal.removeEventListener('abort', onExternalAbort);
      if (this.warmupAbortController === combinedController) {
        this.warmupAbortController = null;
      }
      warmupSession?.destroy();
    }
  }

  async generate(request: GenerationRequest): Promise<GenerationOutcome> {
    if (
      typeof LanguageModel === 'undefined' ||
      typeof LanguageModel.create !== 'function'
    ) {
      throw new Error(
        'LanguageModel API is not available in this browser context.',
      );
    }
    if (request.signal.aborted) {
      throw createAbortError();
    }

    const controller = new AbortController();
    this.activeAbortController = controller;
    const onExternalAbort = () => {
      controller.abort();
    };
    request.signal.addEventListener('abort', onExternalAbort, { once: true });

    const startedAt = performance.now();
    let session: LanguageModel | null = null;
    let reader: ReadableStreamDefaultReader<string> | null = null;

    try {
      session = await LanguageModel.create({
        ...CHROME_MODALITIES,
        signal: controller.signal,
      });
      this.activeSession = session;

      const contextWindow =
        typeof session.contextWindow === 'number'
          ? session.contextWindow
          : null;

      const promptInput: LanguageModelPrompt = [
        {
          role: 'user',
          content: [
            { type: 'image', value: request.imageBlob },
            { type: 'text', value: request.prompt },
          ],
        },
      ];

      const stream = session.promptStreaming(promptInput, {
        signal: controller.signal,
      });
      reader = stream.getReader();

      let accumulated = '';
      let firstTextMs: number | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (typeof value !== 'string' || value.length === 0) {
          continue;
        }

        if (firstTextMs === null) {
          firstTextMs = roundMs(performance.now() - startedAt);
        }
        accumulated += value;
        request.onChunk(value, accumulated);
      }

      const totalLatencyMs = roundMs(performance.now() - startedAt);
      const contextUsage =
        typeof session.contextUsage === 'number' ? session.contextUsage : null;

      return {
        requestId: request.requestId,
        text: accumulated,
        firstTextMs,
        totalLatencyMs,
        details: buildChromeMetadata({
          languageModelPresent: true,
          contextWindow,
          contextUsage,
        }),
      };
    } catch (error) {
      if (isAbortError(error, controller.signal)) {
        throw createAbortError('Chrome inference was cancelled.');
      }
      throw error;
    } finally {
      request.signal.removeEventListener('abort', onExternalAbort);
      if (reader) {
        try {
          reader.releaseLock();
        } catch {
          // Ignore already-released stream lock
        }
      }
      if (session) {
        try {
          session.destroy();
        } catch {
          // Ignore teardown errors on cancelled/destroyed session
        }
      }
      if (this.activeSession === session) {
        this.activeSession = null;
      }
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  async cancelActive(): Promise<CancelResult> {
    this.warmupAbortController?.abort();
    this.activeAbortController?.abort();
    try {
      this.activeSession?.destroy();
    } catch {
      // Ignore already destroyed session
    }
    this.activeSession = null;
    return { requiresReprepare: false };
  }

  async dispose(): Promise<void> {
    await this.cancelActive();
  }
}
