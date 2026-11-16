import { describe, expect, it } from 'vitest';
import {
  buildExperimentExport,
  type ExperimentRecord,
  sanitizeLocalUploadIdentifier,
  serializeExperimentExport,
} from '../../src/experiments/records';

function sampleRecord(
  overrides: Partial<ExperimentRecord> = {},
): ExperimentRecord {
  return {
    runId: 'run-1',
    requestId: 'transformers-smolvlm-1',
    timestampIso: '2026-11-16T18:00:00.000Z',
    providerId: 'transformers-smolvlm',
    providerLabel: 'Transformers.js (SmolVLM-256M)',
    status: 'completed',
    inputSourceKind: 'upload',
    inputIdentifier: sanitizeLocalUploadIdentifier(1),
    originalDimensions: { width: 1600, height: 1200 },
    normalizedDimensions: { width: 1024, height: 768 },
    prompt: 'What objects are visible and where are they?',
    answerText: 'A desk with a laptop and books.',
    errorMessage: null,
    preparationMs: 1234.5,
    firstTextMs: null,
    totalLatencyMs: 2450.2,
    cacheCondition: 'cached-new-session',
    hardwareNote: 'Apple M2 Pro',
    technicalDetails: {
      providerName: 'Transformers.js + SmolVLM-256M-Instruct',
      runtime: '@huggingface/transformers 4.3.2',
      executionContext: 'module-web-worker',
      backend: 'WebGPU',
      modelId: 'HuggingFaceTB/SmolVLM-256M-Instruct',
      modelRevision: 'd039ab0d4b9311b617e8ffec1d06c8464364aeb3',
      modelLicense: 'Apache-2.0',
      dtype: {
        embed_tokens: 'q8',
        vision_encoder: 'q4',
        decoder_model_merged: 'q4',
      },
      promptTemplateNote: 'SmolVLM chat template',
      generationSettings: { do_sample: false, max_new_tokens: 256 },
    },
    ...overrides,
  };
}

describe('experiment records and JSON export', () => {
  it('sanitizes local upload identifiers without original filenames', () => {
    expect(sanitizeLocalUploadIdentifier(1)).toBe('local-upload-1');
    expect(sanitizeLocalUploadIdentifier(3)).toBe('local-upload-3');
  });

  it('serializes records with null firstTextMs, notices, and zero image bytes', () => {
    const payload = buildExperimentExport([sampleRecord()], {
      exportedAtIso: '2026-11-16T18:10:00.000Z',
      userAgent: 'TestAgent/1.0',
    });
    const json = serializeExperimentExport(payload);
    const parsed = JSON.parse(json);

    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.exportedAtIso).toBe('2026-11-16T18:10:00.000Z');
    expect(parsed.comparisonNotice).toContain('controlled runtime benchmark');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].firstTextMs).toBeNull();
    expect(parsed.records[0].inputIdentifier).toBe('local-upload-1');
    expect(json).not.toContain('data:image');
  });
});
