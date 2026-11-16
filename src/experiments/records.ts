import type {
  CacheCondition,
  ProviderId,
  ProviderTechnicalMetadata,
} from '../providers/types';

export interface ExperimentRecord {
  runId: string;
  requestId: string;
  timestampIso: string;
  providerId: ProviderId;
  providerLabel: string;
  status: 'completed' | 'cancelled' | 'failed';
  inputSourceKind: 'example' | 'upload';
  inputIdentifier: string;
  originalDimensions: {
    width: number;
    height: number;
  };
  normalizedDimensions: {
    width: number;
    height: number;
  };
  prompt: string;
  answerText: string;
  errorMessage: string | null;
  preparationMs: number | null;
  firstTextMs: number | null;
  totalLatencyMs: number;
  cacheCondition: CacheCondition;
  hardwareNote: string | null;
  technicalDetails: ProviderTechnicalMetadata;
}

export interface ExperimentExportPayload {
  schemaVersion: '1.0.0';
  exportedAtIso: string;
  comparisonNotice: string;
  privacyNotice: string;
  environmentHints: {
    userAgent: string;
    appVersion: string;
    packageVersions: Record<string, string>;
  };
  records: ExperimentRecord[];
}

export function sanitizeLocalUploadIdentifier(uploadIndex: number): string {
  const safeIndex = Math.max(1, Math.trunc(uploadIndex));
  return `local-upload-${safeIndex}`;
}

export function roundDurationMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export function buildExperimentExport(
  records: readonly ExperimentRecord[],
  options?: {
    exportedAtIso?: string;
    userAgent?: string;
  },
): ExperimentExportPayload {
  const userAgent =
    options?.userAgent ??
    (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown');

  return {
    schemaVersion: '1.0.0',
    exportedAtIso: options?.exportedAtIso ?? new Date().toISOString(),
    comparisonNotice:
      'Each record captures a complete browser-side solution (model weights, preprocessing, prompt template, decoding defaults, and runtime). Differences must not be interpreted as a controlled runtime benchmark.',
    privacyNotice:
      'Contains prompts, plain-text model outputs, timings, and technical metadata. Image bytes and original local upload filenames are excluded.',
    environmentHints: {
      userAgent,
      appVersion: '0.1.0',
      packageVersions: {
        '@huggingface/transformers': '4.3.2',
        vite: '8.3.8',
      },
    },
    records: records.map((record) => ({
      ...record,
      originalDimensions: { ...record.originalDimensions },
      normalizedDimensions: { ...record.normalizedDimensions },
      technicalDetails: {
        ...record.technicalDetails,
        generationSettings: { ...record.technicalDetails.generationSettings },
      },
    })),
  };
}

export function serializeExperimentExport(
  payload: ExperimentExportPayload,
): string {
  return JSON.stringify(payload, null, 2);
}
