import {
  buildExperimentExport,
  type ExperimentExportPayload,
  type ExperimentRecord,
  roundDurationMs,
  sanitizeLocalUploadIdentifier,
} from '../experiments/records';
import { normalizeImageBlob, revokeNormalizedImage } from '../images/normalize';
import { ChromePromptApiAdapter } from '../providers/chrome';
import { TransformersSmolVlmAdapter } from '../providers/transformers';
import type {
  CacheCondition,
  ProviderAdapter,
  ProviderId,
} from '../providers/types';
import type { StatusAnnouncer } from '../ui/announcer';
import { BUNDLED_EXAMPLES, type BundledExample } from './examples';
import {
  type AppState,
  canClearResults,
  canPrepare,
  canRun,
  canStop,
  createInitialAppState,
  getSelectedSlot,
} from './state';

declare global {
  interface Window {
    __MULTIMODAL_TEST_PROVIDERS__?: Partial<
      Record<ProviderId, ProviderAdapter>
    >;
  }
}

export type StateListener = (state: AppState) => void;

export interface ImagePipeline {
  fetchExampleBlob: (assetPath: string) => Promise<Blob>;
  normalize: typeof normalizeImageBlob;
  revoke: typeof revokeNormalizedImage;
}

const DEFAULT_IMAGE_PIPELINE: ImagePipeline = {
  fetchExampleBlob: async (assetPath: string) => {
    const response = await fetch(assetPath);
    if (!response.ok) {
      throw new Error(
        `Failed to load bundled example image (${response.status} ${response.statusText}).`,
      );
    }
    return response.blob();
  },
  normalize: normalizeImageBlob,
  revoke: revokeNormalizedImage,
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class AppController {
  private state: AppState;
  private readonly listeners = new Set<StateListener>();
  private readonly providers: Record<ProviderId, ProviderAdapter>;
  private readonly imagePipeline: ImagePipeline;
  private readonly announcer: StatusAnnouncer | null;

  private activePrepareAbort: AbortController | null = null;
  private activeRunAbort: AbortController | null = null;
  private providerSwitchToken = 0;
  private imageLoadToken = 0;
  private runSequence = 0;

  constructor(options?: {
    providers?: Partial<Record<ProviderId, ProviderAdapter>>;
    imagePipeline?: ImagePipeline;
    announcer?: StatusAnnouncer;
    isTestDoubleMode?: boolean;
  }) {
    const injected =
      typeof window !== 'undefined'
        ? window.__MULTIMODAL_TEST_PROVIDERS__
        : undefined;
    const mergedProviders = { ...injected, ...options?.providers };
    const hasInjectedDoubles = Boolean(
      options?.isTestDoubleMode ??
        (injected && Object.keys(injected).length > 0),
    );

    this.providers = {
      'chrome-prompt-api':
        mergedProviders['chrome-prompt-api'] ?? new ChromePromptApiAdapter(),
      'transformers-smolvlm':
        mergedProviders['transformers-smolvlm'] ??
        new TransformersSmolVlmAdapter(),
    };
    this.imagePipeline = options?.imagePipeline ?? DEFAULT_IMAGE_PIPELINE;
    this.announcer = options?.announcer ?? null;
    this.state = createInitialAppState({
      isTestDoubleMode: hasInjectedDoubles,
    });
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(updater: (prev: AppState) => AppState): void {
    this.state = updater(this.state);
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  async init(): Promise<void> {
    const firstExample = BUNDLED_EXAMPLES[0];
    await Promise.all([
      firstExample ? this.selectExample(firstExample.id) : Promise.resolve(),
      this.checkAvailability(this.state.selectedProvider),
    ]);
  }

  async checkAvailability(providerId: ProviderId): Promise<void> {
    const token = this.providerSwitchToken;
    this.setState((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [providerId]: {
          ...prev.providers[providerId],
          preparationState: 'checking',
          statusReason: `Checking ${this.providers[providerId].label} availability...`,
          progress: null,
        },
      },
    }));

    const result = await this.providers[providerId].checkAvailability();
    if (token !== this.providerSwitchToken) {
      return;
    }

    this.setState((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [providerId]: {
          ...prev.providers[providerId],
          preparationState: result.state,
          statusReason: result.reason,
          details: result.details,
          progress: null,
          lastCheckedAtIso: new Date().toISOString(),
        },
      },
    }));

    if (providerId === this.state.selectedProvider) {
      this.announcer?.announcePolite(
        `${this.providers[providerId].label}: ${result.state.replace('-', ' ')}.`,
      );
    }
  }

  async selectProvider(nextProviderId: ProviderId): Promise<void> {
    if (this.state.selectedProvider === nextProviderId) {
      return;
    }

    const previousProviderId = this.state.selectedProvider;
    const token = ++this.providerSwitchToken;

    // Cancel any active preparation or generation and release previous provider resources first
    if (this.activePrepareAbort) {
      this.activePrepareAbort.abort();
      this.activePrepareAbort = null;
    }
    if (this.activeRunAbort) {
      this.activeRunAbort.abort();
      this.activeRunAbort = null;
    }

    const previousAdapter = this.providers[previousProviderId];
    try {
      await previousAdapter.cancelActive();
    } catch {
      // Proceed to dispose even if cancel rejects
    }
    try {
      await previousAdapter.dispose();
    } catch {
      // Proceed cleanly even if dispose rejects
    }

    if (token !== this.providerSwitchToken) {
      return;
    }

    this.setState((prev) => {
      const wasRunning = prev.requestState === 'running';
      const prevSlot = prev.providers[previousProviderId];
      const nextPrevState =
        prevSlot.preparationState === 'unavailable'
          ? 'unavailable'
          : 'unchecked';

      return {
        ...prev,
        selectedProvider: nextProviderId,
        requestState: wasRunning ? 'cancelled' : prev.requestState,
        activeRequestId: wasRunning ? null : prev.activeRequestId,
        providers: {
          ...prev.providers,
          [previousProviderId]: {
            ...prevSlot,
            preparationState: nextPrevState,
            progress: null,
            preparationMs: null,
            statusReason:
              prevSlot.preparationState === 'unavailable'
                ? prevSlot.statusReason
                : 'Resources released on provider switch.',
          },
        },
      };
    });

    await this.checkAvailability(nextProviderId);
  }

  async selectExample(exampleId: BundledExample['id']): Promise<void> {
    const example = BUNDLED_EXAMPLES.find((item) => item.id === exampleId);
    if (!example) {
      return;
    }

    const loadToken = ++this.imageLoadToken;
    this.setState((prev) => ({
      ...prev,
      imageLoading: true,
      imageError: null,
    }));

    try {
      const blob = await this.imagePipeline.fetchExampleBlob(example.assetPath);
      const normalized = await this.imagePipeline.normalize(blob, example.id);
      if (loadToken !== this.imageLoadToken) {
        this.imagePipeline.revoke(normalized);
        return;
      }

      const previous = this.state.normalizedImage;
      this.setState((prev) => ({
        ...prev,
        selectedExampleId: example.id,
        question: example.presetQuestion,
        normalizedImage: normalized,
        imageLoading: false,
        imageError: null,
      }));
      this.imagePipeline.revoke(previous);
      this.announcer?.announcePolite(
        `Loaded example "${example.label}" (${normalized.width} by ${normalized.height} pixels).`,
      );
    } catch (error) {
      if (loadToken !== this.imageLoadToken) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setState((prev) => ({
        ...prev,
        imageLoading: false,
        imageError: message,
      }));
      this.announcer?.announceAssertive(message);
    }
  }

  async uploadFile(file: File): Promise<void> {
    const loadToken = ++this.imageLoadToken;
    const nextUploadNumber = this.state.uploadCounter + 1;
    const sanitizedLabel = sanitizeLocalUploadIdentifier(nextUploadNumber);

    this.setState((prev) => ({
      ...prev,
      uploadCounter: nextUploadNumber,
      imageLoading: true,
      imageError: null,
    }));

    try {
      const normalized = await this.imagePipeline.normalize(
        file,
        sanitizedLabel,
      );
      if (loadToken !== this.imageLoadToken) {
        this.imagePipeline.revoke(normalized);
        return;
      }

      const previous = this.state.normalizedImage;
      this.setState((prev) => ({
        ...prev,
        selectedExampleId: 'upload',
        normalizedImage: normalized,
        imageLoading: false,
        imageError: null,
      }));
      this.imagePipeline.revoke(previous);
      this.announcer?.announcePolite(
        `Loaded uploaded image (${normalized.width} by ${normalized.height} pixels).`,
      );
    } catch (error) {
      if (loadToken !== this.imageLoadToken) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setState((prev) => ({
        ...prev,
        imageLoading: false,
        imageError: message,
      }));
      this.announcer?.announceAssertive(message);
    }
  }

  setQuestion(question: string): void {
    this.setState((prev) => ({
      ...prev,
      question,
    }));
  }

  applyPresetQuestion(): void {
    const id = this.state.selectedExampleId;
    if (!id || id === 'upload') {
      return;
    }
    const example = BUNDLED_EXAMPLES.find((item) => item.id === id);
    if (example) {
      this.setQuestion(example.presetQuestion);
    }
  }

  setCacheCondition(cacheCondition: CacheCondition): void {
    this.setState((prev) => ({
      ...prev,
      cacheCondition,
    }));
  }

  setHardwareNote(hardwareNote: string): void {
    this.setState((prev) => ({
      ...prev,
      hardwareNote,
    }));
  }

  async prepareSelectedProvider(): Promise<void> {
    if (!canPrepare(this.state)) {
      return;
    }

    const providerId = this.state.selectedProvider;
    const adapter = this.providers[providerId];
    const abortController = new AbortController();
    this.activePrepareAbort = abortController;

    this.setState((prev) => ({
      ...prev,
      runError: null,
      providers: {
        ...prev.providers,
        [providerId]: {
          ...prev.providers[providerId],
          preparationState: 'preparing',
          progress: {
            progress: null,
            statusText: `Preparing ${adapter.label}...`,
          },
          statusReason: `Preparing ${adapter.label}...`,
        },
      },
    }));
    this.announcer?.announcePolite(`Preparing ${adapter.label}.`);

    try {
      const result = await adapter.prepare({
        signal: abortController.signal,
        onProgress: (progress) => {
          if (
            abortController.signal.aborted ||
            this.activePrepareAbort !== abortController
          ) {
            return;
          }
          this.setState((prev) => ({
            ...prev,
            providers: {
              ...prev.providers,
              [providerId]: {
                ...prev.providers[providerId],
                progress,
                statusReason: progress.statusText,
              },
            },
          }));
        },
      });

      if (this.activePrepareAbort !== abortController) {
        return;
      }
      this.activePrepareAbort = null;

      this.setState((prev) => ({
        ...prev,
        providers: {
          ...prev.providers,
          [providerId]: {
            ...prev.providers[providerId],
            preparationState: 'ready',
            preparationMs: result.preparationMs,
            details: result.details,
            progress: { progress: 1, statusText: 'Ready' },
            statusReason: `${adapter.label} is ready.`,
          },
        },
      }));
      this.announcer?.announcePolite(
        `${adapter.label} is ready in ${result.preparationMs} ms.`,
      );
    } catch (error) {
      if (this.activePrepareAbort === abortController) {
        this.activePrepareAbort = null;
      }

      if (isAbortError(error) || abortController.signal.aborted) {
        this.setState((prev) => {
          const slot = prev.providers[providerId];
          if (slot.preparationState === 'unchecked') {
            return prev;
          }
          return {
            ...prev,
            providers: {
              ...prev.providers,
              [providerId]: {
                ...slot,
                preparationState: 'needs-download',
                progress: null,
                preparationMs: null,
                statusReason:
                  'Preparation was cancelled. Click Prepare model to try again.',
              },
            },
          };
        });
        this.announcer?.announcePolite(
          `${adapter.label} preparation cancelled.`,
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.setState((prev) => ({
        ...prev,
        providers: {
          ...prev.providers,
          [providerId]: {
            ...prev.providers[providerId],
            preparationState: 'error',
            progress: null,
            statusReason: message,
          },
        },
      }));
      this.announcer?.announceAssertive(
        `Failed to prepare ${adapter.label}: ${message}`,
      );
    }
  }

  async runExperiment(): Promise<void> {
    if (!canRun(this.state)) {
      return;
    }

    const imageSnapshot = this.state.normalizedImage;
    if (!imageSnapshot) {
      return;
    }

    const providerId = this.state.selectedProvider;
    const adapter = this.providers[providerId];
    const slot = getSelectedSlot(this.state);
    const seq = ++this.runSequence;
    const requestId = `${providerId}-${seq}`;
    const runId = `run-${seq}`;
    const timestampIso = new Date().toISOString();
    const promptSnapshot = this.state.question.trim();
    const inputSourceKind: 'example' | 'upload' =
      this.state.selectedExampleId === 'upload' ? 'upload' : 'example';
    const inputIdentifier = imageSnapshot.sourceLabel;
    const preparationMsSnapshot = slot.preparationMs;
    const cacheConditionSnapshot = this.state.cacheCondition;
    const hardwareNoteSnapshot =
      this.state.hardwareNote.trim().length > 0
        ? this.state.hardwareNote.trim()
        : null;
    const initialDetails =
      slot.details ??
      ({
        providerName: adapter.label,
        runtime: 'Unknown',
        executionContext:
          providerId === 'chrome-prompt-api'
            ? 'main-thread'
            : 'module-web-worker',
        backend: 'Unknown',
        modelId: 'Unknown',
        modelRevision: 'Unknown',
        modelLicense: 'Unknown',
        dtype: 'Unknown',
        promptTemplateNote: 'Unknown',
        generationSettings: {},
      } as const);

    const abortController = new AbortController();
    this.activeRunAbort = abortController;
    const startedAt = performance.now();
    let capturedFirstTextMs: number | null = null;

    this.setState((prev) => ({
      ...prev,
      requestState: 'running',
      activeRequestId: requestId,
      activeDraftText: '',
      activeFirstTextMs: null,
      runError: null,
    }));
    this.announcer?.announcePolite(`Running ${adapter.label} experiment.`);

    try {
      const outcome = await adapter.generate({
        requestId,
        imageBlob: imageSnapshot.blob,
        prompt: promptSnapshot,
        signal: abortController.signal,
        onChunk: (_delta, accumulated) => {
          if (
            abortController.signal.aborted ||
            this.state.activeRequestId !== requestId
          ) {
            return;
          }
          if (capturedFirstTextMs === null && accumulated.length > 0) {
            capturedFirstTextMs = roundDurationMs(
              performance.now() - startedAt,
            );
          }
          this.setState((prev) => {
            if (prev.activeRequestId !== requestId) {
              return prev;
            }
            return {
              ...prev,
              activeDraftText: accumulated,
              activeFirstTextMs: capturedFirstTextMs,
            };
          });
        },
      });

      if (this.activeRunAbort !== abortController) {
        return;
      }
      this.activeRunAbort = null;

      if (this.state.activeRequestId !== requestId) {
        return;
      }

      const record: ExperimentRecord = {
        runId,
        requestId,
        timestampIso,
        providerId,
        providerLabel: adapter.label,
        status: 'completed',
        inputSourceKind,
        inputIdentifier,
        originalDimensions: {
          width: imageSnapshot.originalWidth,
          height: imageSnapshot.originalHeight,
        },
        normalizedDimensions: {
          width: imageSnapshot.width,
          height: imageSnapshot.height,
        },
        prompt: promptSnapshot,
        answerText: outcome.text,
        errorMessage: null,
        preparationMs: preparationMsSnapshot,
        firstTextMs: outcome.firstTextMs ?? capturedFirstTextMs,
        totalLatencyMs: outcome.totalLatencyMs,
        cacheCondition: cacheConditionSnapshot,
        hardwareNote: hardwareNoteSnapshot,
        technicalDetails: outcome.details,
      };

      this.setState((prev) => ({
        ...prev,
        requestState: 'completed',
        activeRequestId: null,
        activeDraftText: outcome.text,
        activeFirstTextMs: record.firstTextMs,
        records: [record, ...prev.records],
      }));
      this.announcer?.announcePolite(
        `${adapter.label} completed in ${record.totalLatencyMs} ms.`,
      );
    } catch (error) {
      if (this.activeRunAbort === abortController) {
        this.activeRunAbort = null;
      }

      if (this.state.activeRequestId !== requestId) {
        return;
      }

      const totalLatencyMs = roundDurationMs(performance.now() - startedAt);
      const cancelled = isAbortError(error) || abortController.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);

      const record: ExperimentRecord = {
        runId,
        requestId,
        timestampIso,
        providerId,
        providerLabel: adapter.label,
        status: cancelled ? 'cancelled' : 'failed',
        inputSourceKind,
        inputIdentifier,
        originalDimensions: {
          width: imageSnapshot.originalWidth,
          height: imageSnapshot.originalHeight,
        },
        normalizedDimensions: {
          width: imageSnapshot.width,
          height: imageSnapshot.height,
        },
        prompt: promptSnapshot,
        answerText: this.state.activeDraftText,
        errorMessage: cancelled ? 'Cancelled by user.' : message,
        preparationMs: preparationMsSnapshot,
        firstTextMs: capturedFirstTextMs,
        totalLatencyMs,
        cacheCondition: cacheConditionSnapshot,
        hardwareNote: hardwareNoteSnapshot,
        technicalDetails: initialDetails,
      };

      this.setState((prev) => ({
        ...prev,
        requestState: cancelled ? 'cancelled' : 'failed',
        activeRequestId: null,
        runError: cancelled ? null : message,
        records: [record, ...prev.records],
      }));

      if (cancelled) {
        this.announcer?.announcePolite(`${adapter.label} run cancelled.`);
      } else {
        this.announcer?.announceAssertive(
          `${adapter.label} run failed: ${message}`,
        );
      }
    }
  }

  async stopActive(): Promise<void> {
    if (!canStop(this.state)) {
      return;
    }

    const providerId = this.state.selectedProvider;
    const adapter = this.providers[providerId];

    if (this.activePrepareAbort) {
      this.activePrepareAbort.abort();
    }
    if (this.activeRunAbort) {
      this.activeRunAbort.abort();
    }

    try {
      const cancelResult = await adapter.cancelActive();
      if (cancelResult.requiresReprepare) {
        this.setState((prev) => ({
          ...prev,
          providers: {
            ...prev.providers,
            [providerId]: {
              ...prev.providers[providerId],
              preparationState: 'needs-download',
              progress: null,
              preparationMs: null,
              statusReason:
                'Worker was reset to stop active work. Click Prepare model before running again.',
            },
          },
        }));
      }
    } catch {
      // Cancellation errors are surfaced through the aborted promise
    }
  }

  clearResults(): void {
    if (!canClearResults(this.state) || canStop(this.state)) {
      return;
    }
    this.setState((prev) => ({
      ...prev,
      requestState: 'idle',
      activeDraftText: '',
      activeFirstTextMs: null,
      runError: null,
      records: [],
    }));
    this.announcer?.announcePolite('Cleared experiment results.');
  }

  exportRecords(): ExperimentExportPayload {
    return buildExperimentExport(this.state.records);
  }

  async dispose(): Promise<void> {
    this.activePrepareAbort?.abort();
    this.activeRunAbort?.abort();
    this.imagePipeline.revoke(this.state.normalizedImage);
    await Promise.all([
      this.providers['chrome-prompt-api'].dispose(),
      this.providers['transformers-smolvlm'].dispose(),
    ]);
  }
}
