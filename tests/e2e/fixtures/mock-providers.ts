import type { Page } from '@playwright/test';

export interface MockProviderBehavior {
  availability?: 'unavailable' | 'needs-download' | 'ready' | 'error';
  reason?: string;
  prepareDelayMs?: number;
  prepareFailureMessage?: string;
  streamChunks?: string[];
  chunkDelayMs?: number;
  generateFailureMessage?: string;
  hangPrepareUntilAbort?: boolean;
  hangGenerateUntilAbort?: boolean;
}

export interface MockSuiteConfig {
  chrome?: MockProviderBehavior;
  transformers?: MockProviderBehavior;
}

export async function installMockProviders(
  page: Page,
  config: MockSuiteConfig,
): Promise<void> {
  await page.addInitScript((cfg: MockSuiteConfig) => {
    const logs: {
      prepared: string[];
      cancelled: string[];
      disposed: string[];
      generatedCount: Record<string, number>;
    } = {
      prepared: [],
      cancelled: [],
      disposed: [],
      generatedCount: {},
    };

    (window as unknown as Record<string, unknown>).__MOCK_PROVIDER_LOG__ = logs;

    function makeAdapter(
      id: 'chrome-prompt-api' | 'transformers-smolvlm',
      label: string,
      behavior: MockProviderBehavior,
    ) {
      let prepared = (behavior.availability ?? 'ready') === 'ready';
      let currentReject: ((err: Error) => void) | null = null;
      let activeTimers: Array<ReturnType<typeof setTimeout>> = [];

      const clearTimers = () => {
        for (const t of activeTimers) {
          clearTimeout(t);
        }
        activeTimers = [];
      };

      const metadata = () => ({
        providerName: `${label} (Test Double)`,
        runtime: 'Playwright test double',
        executionContext:
          id === 'chrome-prompt-api'
            ? ('main-thread' as const)
            : ('module-web-worker' as const),
        backend: 'Mock backend',
        modelId: `${id}-mock`,
        modelRevision: 'test-double',
        modelLicense: 'MIT',
        dtype: 'mock',
        promptTemplateNote: 'Test double passthrough',
        generationSettings: { deterministic: true },
      });

      return {
        id,
        label,
        summary: `Test double for ${label}`,
        async checkAvailability() {
          const state = prepared
            ? 'ready'
            : (behavior.availability ?? 'needs-download');
          return {
            state,
            reason:
              behavior.reason ?? `Test double state: ${state} for ${label}.`,
            details: metadata(),
          };
        },
        async prepare({
          onProgress,
          signal,
        }: {
          onProgress: (p: {
            progress: number | null;
            statusText: string;
          }) => void;
          signal: AbortSignal;
        }) {
          logs.prepared.push(id);
          onProgress({
            progress: 0.25,
            statusText: `Preparing ${label} (25%)`,
          });

          return new Promise((resolve, reject) => {
            currentReject = reject;
            const onAbort = () => {
              clearTimers();
              currentReject = null;
              reject(new DOMException('Preparation cancelled', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });

            if (behavior.hangPrepareUntilAbort) {
              return;
            }

            const delay = behavior.prepareDelayMs ?? 60;
            activeTimers.push(
              setTimeout(
                () => {
                  onProgress({
                    progress: 0.85,
                    statusText: `Preparing ${label} (85%)`,
                  });
                },
                Math.floor(delay / 2),
              ),
            );

            activeTimers.push(
              setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                currentReject = null;
                if (behavior.prepareFailureMessage) {
                  reject(new Error(behavior.prepareFailureMessage));
                  return;
                }
                prepared = true;
                resolve({
                  preparationMs: delay,
                  details: metadata(),
                });
              }, delay),
            );
          });
        },
        async generate({
          requestId,
          prompt,
          signal,
          onChunk,
        }: {
          requestId: string;
          imageBlob: Blob;
          prompt: string;
          signal: AbortSignal;
          onChunk: (delta: string, accumulated: string) => void;
        }) {
          logs.generatedCount[id] = (logs.generatedCount[id] ?? 0) + 1;
          const chunks = behavior.streamChunks ?? [
            `[${id}] `,
            `Answer to "${prompt}"`,
          ];
          const stepMs = behavior.chunkDelayMs ?? 30;

          return new Promise((resolve, reject) => {
            currentReject = reject;
            let accumulated = '';
            let index = 0;

            const onAbort = () => {
              clearTimers();
              currentReject = null;
              reject(new DOMException('Generation cancelled', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });

            if (behavior.hangGenerateUntilAbort) {
              activeTimers.push(
                setTimeout(() => {
                  if (!signal.aborted) {
                    const partial = 'Partial output ';
                    accumulated += partial;
                    onChunk(partial, accumulated);
                  }
                }, 15),
              );
              return;
            }

            if (behavior.generateFailureMessage) {
              activeTimers.push(
                setTimeout(() => {
                  signal.removeEventListener('abort', onAbort);
                  currentReject = null;
                  reject(new Error(behavior.generateFailureMessage));
                }, 20),
              );
              return;
            }

            const tick = () => {
              if (signal.aborted) {
                return;
              }
              if (index < chunks.length) {
                const delta = chunks[index] ?? '';
                index += 1;
                accumulated += delta;
                onChunk(delta, accumulated);
                activeTimers.push(setTimeout(tick, stepMs));
              } else {
                signal.removeEventListener('abort', onAbort);
                currentReject = null;
                resolve({
                  requestId,
                  text: accumulated,
                  firstTextMs: stepMs,
                  totalLatencyMs: stepMs * chunks.length,
                  details: metadata(),
                });
              }
            };

            activeTimers.push(setTimeout(tick, stepMs));
          });
        },
        async cancelActive() {
          logs.cancelled.push(id);
          clearTimers();
          if (currentReject) {
            const rej = currentReject;
            currentReject = null;
            rej(new DOMException('Cancelled', 'AbortError'));
          }
          return { requiresReprepare: false };
        },
        async dispose() {
          logs.disposed.push(id);
          clearTimers();
        },
      };
    }

    (
      window as unknown as Record<string, unknown>
    ).__MULTIMODAL_TEST_PROVIDERS__ = {
      'chrome-prompt-api': makeAdapter(
        'chrome-prompt-api',
        'Chrome Prompt API',
        cfg.chrome ?? { availability: 'ready' },
      ),
      'transformers-smolvlm': makeAdapter(
        'transformers-smolvlm',
        'Transformers.js (SmolVLM-256M)',
        cfg.transformers ?? { availability: 'needs-download' },
      ),
    };
  }, config);
}
