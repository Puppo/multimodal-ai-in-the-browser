export type ProviderId = 'chrome-prompt-api' | 'transformers-smolvlm';

export type PreparationState =
  | 'unchecked'
  | 'checking'
  | 'unavailable'
  | 'needs-download'
  | 'preparing'
  | 'ready'
  | 'error';

export type RequestState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type CacheCondition =
  | 'clean-download'
  | 'cached-new-session'
  | 'prepared-model'
  | 'unknown';

export interface PreparationProgress {
  progress: number | null; // 0..1 when known, null for indeterminate
  statusText: string;
  file?: string;
}

export interface ProviderTechnicalMetadata {
  providerName: string;
  runtime: string;
  executionContext: 'main-thread' | 'module-web-worker';
  backend: string;
  modelId: string;
  modelRevision: string;
  modelLicense: string;
  dtype: Record<string, string> | string;
  promptTemplateNote: string;
  generationSettings: Record<string, string | number | boolean>;
  packageVersions?: Record<string, string>;
  reportedCapabilities?: Record<string, string | number | boolean | null>;
}

export interface AvailabilityResult {
  state: Extract<
    PreparationState,
    'unavailable' | 'needs-download' | 'preparing' | 'ready' | 'error'
  >;
  reason: string;
  details: ProviderTechnicalMetadata;
}

export interface PrepareResult {
  preparationMs: number;
  details: ProviderTechnicalMetadata;
}

export interface GenerationRequest {
  requestId: string;
  imageBlob: Blob;
  prompt: string;
  signal: AbortSignal;
  onChunk: (delta: string, accumulated: string) => void;
}

export interface GenerationOutcome {
  requestId: string;
  text: string;
  firstTextMs: number | null;
  totalLatencyMs: number;
  details: ProviderTechnicalMetadata;
}

export interface CancelResult {
  requiresReprepare: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly summary: string;
  checkAvailability(): Promise<AvailabilityResult>;
  prepare(options: {
    onProgress: (progress: PreparationProgress) => void;
    signal: AbortSignal;
  }): Promise<PrepareResult>;
  generate(request: GenerationRequest): Promise<GenerationOutcome>;
  cancelActive(): Promise<CancelResult>;
  dispose(): Promise<void>;
}
