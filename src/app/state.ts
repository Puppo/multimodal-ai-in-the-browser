import type { ExperimentRecord } from '../experiments/records';
import type { NormalizedImage } from '../images/normalize';
import type {
  CacheCondition,
  PreparationProgress,
  PreparationState,
  ProviderId,
  ProviderTechnicalMetadata,
  RequestState,
} from '../providers/types';
import { BUNDLED_EXAMPLES, type BundledExample } from './examples';

export interface ProviderSlotState {
  preparationState: PreparationState;
  statusReason: string;
  progress: PreparationProgress | null;
  preparationMs: number | null;
  details: ProviderTechnicalMetadata | null;
  lastCheckedAtIso: string | null;
}

export interface AppState {
  selectedProvider: ProviderId;
  providers: Record<ProviderId, ProviderSlotState>;
  requestState: RequestState;
  activeRequestId: string | null;
  activeDraftText: string;
  activeFirstTextMs: number | null;
  selectedExampleId: BundledExample['id'] | 'upload' | null;
  uploadCounter: number;
  normalizedImage: NormalizedImage | null;
  imageLoading: boolean;
  imageError: string | null;
  question: string;
  cacheCondition: CacheCondition;
  hardwareNote: string;
  runError: string | null;
  records: ExperimentRecord[];
  isTestDoubleMode: boolean;
}

const VALID_PREPARATION_TRANSITIONS: Record<
  PreparationState,
  ReadonlySet<PreparationState>
> = {
  unchecked: new Set([
    'checking',
    'unavailable',
    'needs-download',
    'ready',
    'error',
  ]),
  checking: new Set(['unavailable', 'needs-download', 'ready', 'error']),
  unavailable: new Set(['checking', 'unavailable']),
  'needs-download': new Set([
    'checking',
    'preparing',
    'ready',
    'unavailable',
    'error',
  ]),
  preparing: new Set(['ready', 'needs-download', 'unchecked', 'error']),
  ready: new Set([
    'checking',
    'preparing',
    'unchecked',
    'needs-download',
    'error',
  ]),
  error: new Set(['checking', 'preparing', 'needs-download', 'unchecked']),
};

const VALID_REQUEST_TRANSITIONS: Record<
  RequestState,
  ReadonlySet<RequestState>
> = {
  idle: new Set(['running']),
  running: new Set(['completed', 'cancelled', 'failed']),
  completed: new Set(['idle', 'running']),
  cancelled: new Set(['idle', 'running']),
  failed: new Set(['idle', 'running']),
};

export function isValidPreparationTransition(
  from: PreparationState,
  to: PreparationState,
): boolean {
  if (from === to) {
    return true;
  }
  return VALID_PREPARATION_TRANSITIONS[from].has(to);
}

export function isValidRequestTransition(
  from: RequestState,
  to: RequestState,
): boolean {
  if (from === to) {
    return true;
  }
  return VALID_REQUEST_TRANSITIONS[from].has(to);
}

function createInitialProviderSlot(initialReason: string): ProviderSlotState {
  return {
    preparationState: 'unchecked',
    statusReason: initialReason,
    progress: null,
    preparationMs: null,
    details: null,
    lastCheckedAtIso: null,
  };
}

export function createInitialAppState(options?: {
  isTestDoubleMode?: boolean;
}): AppState {
  const firstExample = BUNDLED_EXAMPLES[0];
  return {
    selectedProvider: 'chrome-prompt-api',
    providers: {
      'chrome-prompt-api': createInitialProviderSlot(
        'Checking Chrome Prompt API availability...',
      ),
      'transformers-smolvlm': createInitialProviderSlot(
        'Not checked yet. Select this provider to verify WebGPU availability.',
      ),
    },
    requestState: 'idle',
    activeRequestId: null,
    activeDraftText: '',
    activeFirstTextMs: null,
    selectedExampleId: firstExample?.id ?? null,
    uploadCounter: 0,
    normalizedImage: null,
    imageLoading: false,
    imageError: null,
    question: firstExample?.presetQuestion ?? '',
    cacheCondition: 'unknown',
    hardwareNote: '',
    runError: null,
    records: [],
    isTestDoubleMode: options?.isTestDoubleMode ?? false,
  };
}

export function getSelectedSlot(state: AppState): ProviderSlotState {
  return state.providers[state.selectedProvider];
}

export function canPrepare(state: AppState): boolean {
  if (state.requestState === 'running') {
    return false;
  }
  const prep = getSelectedSlot(state).preparationState;
  return prep === 'needs-download' || prep === 'error';
}

export function canRun(state: AppState): boolean {
  if (state.requestState === 'running') {
    return false;
  }
  const prep = getSelectedSlot(state).preparationState;
  if (prep !== 'ready') {
    return false;
  }
  if (state.imageLoading || !state.normalizedImage) {
    return false;
  }
  return state.question.trim().length > 0;
}

export function canStop(state: AppState): boolean {
  const prep = getSelectedSlot(state).preparationState;
  return state.requestState === 'running' || prep === 'preparing';
}

export function canClearResults(state: AppState): boolean {
  return (
    state.records.length > 0 ||
    state.activeDraftText.length > 0 ||
    state.runError !== null
  );
}
