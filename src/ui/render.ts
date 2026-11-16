import type { AppController } from '../app/controller';
import { BUNDLED_EXAMPLES } from '../app/examples';
import {
  type AppState,
  canClearResults,
  canPrepare,
  canRun,
  canStop,
  getSelectedSlot,
} from '../app/state';
import {
  type ExperimentRecord,
  serializeExperimentExport,
} from '../experiments/records';
import type {
  CacheCondition,
  PreparationState,
  ProviderTechnicalMetadata,
  RequestState,
} from '../providers/types';
import { renderSafeMarkdown } from './markdown';

function renderPlaceholderText(container: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'output-placeholder';
  p.textContent = text;
  container.replaceChildren(p);
}

function badgeToneForPrep(
  state: PreparationState,
): 'ready' | 'warn' | 'error' | 'neutral' {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'needs-download':
    case 'preparing':
    case 'checking':
      return 'warn';
    case 'unavailable':
    case 'error':
      return 'error';
    default:
      return 'neutral';
  }
}

function badgeToneForRequest(
  state: RequestState,
): 'ready' | 'warn' | 'error' | 'neutral' {
  switch (state) {
    case 'completed':
      return 'ready';
    case 'running':
    case 'cancelled':
      return 'warn';
    case 'failed':
      return 'error';
    default:
      return 'neutral';
  }
}

function formatMs(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  return `${ms.toFixed(1)} ms`;
}

function buildDetailsDefinitionList(
  details: ProviderTechnicalMetadata | null,
  imageDims?: {
    originalWidth: number;
    originalHeight: number;
    width: number;
    height: number;
  } | null,
): HTMLElement {
  if (!details) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent =
      'Check or prepare the provider to inspect technical metadata.';
    return p;
  }

  const dl = document.createElement('dl');
  dl.className = 'tech-kv';

  const entries: Array<[string, string]> = [
    ['Provider', details.providerName],
    ['Runtime', details.runtime],
    ['Execution context', details.executionContext],
    ['Backend', details.backend],
    ['Model ID', details.modelId],
    ['Model revision', details.modelRevision],
    ['Model license', details.modelLicense],
    [
      'Dtype / quantization',
      typeof details.dtype === 'string'
        ? details.dtype
        : JSON.stringify(details.dtype),
    ],
    ['Prompt template', details.promptTemplateNote],
    ['Decoding settings', JSON.stringify(details.generationSettings)],
  ];

  if (imageDims) {
    entries.push([
      'Shared normalized image',
      `${imageDims.width}x${imageDims.height} PNG (from ${imageDims.originalWidth}x${imageDims.originalHeight})`,
    ]);
  }

  if (details.reportedCapabilities) {
    entries.push([
      'Reported capabilities',
      JSON.stringify(details.reportedCapabilities),
    ]);
  }

  for (const [key, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  return dl;
}

function renderRecordCard(record: ExperimentRecord): HTMLElement {
  const article = document.createElement('article');
  article.className = 'record-card';

  const header = document.createElement('div');
  header.className = 'record-card-header';

  const title = document.createElement('strong');
  title.textContent = `${record.providerLabel} · ${record.inputIdentifier}`;

  const statusBadge = document.createElement('span');
  statusBadge.className = 'status-badge';
  statusBadge.textContent = record.status;
  statusBadge.dataset.tone =
    record.status === 'completed'
      ? 'ready'
      : record.status === 'cancelled'
        ? 'warn'
        : 'error';

  header.append(title, statusBadge);

  const metaLine = document.createElement('p');
  metaLine.className = 'record-meta-line';
  metaLine.textContent =
    `Prep: ${formatMs(record.preparationMs)} · First text: ${formatMs(record.firstTextMs)} · ` +
    `Total: ${formatMs(record.totalLatencyMs)} · Cache: ${record.cacheCondition} · ` +
    `Image: ${record.normalizedDimensions.width}x${record.normalizedDimensions.height}`;

  const promptLine = document.createElement('p');
  promptLine.className = 'record-prompt';
  promptLine.textContent = `Q: ${record.prompt}`;

  const answerBox = document.createElement('div');
  answerBox.className = 'output-surface';
  const answerMarkdown = document.createElement('div');
  answerMarkdown.className = 'output-markdown';
  if (record.answerText.length > 0) {
    renderSafeMarkdown(answerMarkdown, record.answerText);
  } else {
    renderPlaceholderText(
      answerMarkdown,
      record.errorMessage ?? '(no text emitted)',
    );
  }
  answerBox.append(answerMarkdown);

  const details = document.createElement('details');
  details.className = 'tech-details';
  const summary = document.createElement('summary');
  summary.textContent = `Run details (${record.runId})`;
  const body = document.createElement('div');
  body.className = 'tech-details-body';
  body.append(
    buildDetailsDefinitionList(record.technicalDetails, {
      originalWidth: record.originalDimensions.width,
      originalHeight: record.originalDimensions.height,
      width: record.normalizedDimensions.width,
      height: record.normalizedDimensions.height,
    }),
  );
  details.append(summary, body);

  article.append(header, metaLine, promptLine, answerBox, details);
  return article;
}

export function mountAppUI(controller: AppController): () => void {
  const testModeBanner =
    document.querySelector<HTMLElement>('#test-mode-banner');
  const chromeRadio =
    document.querySelector<HTMLInputElement>('#provider-chrome');
  const transformersRadio = document.querySelector<HTMLInputElement>(
    '#provider-transformers',
  );
  const chromeBadge = document.querySelector<HTMLElement>('#badge-chrome');
  const transformersBadge = document.querySelector<HTMLElement>(
    '#badge-transformers',
  );
  const chromeReason = document.querySelector<HTMLElement>('#reason-chrome');
  const transformersReason = document.querySelector<HTMLElement>(
    '#reason-transformers',
  );

  const exampleButtonsContainer =
    document.querySelector<HTMLElement>('#example-buttons');
  const fileInput = document.querySelector<HTMLInputElement>('#image-upload');
  const imageErrorEl = document.querySelector<HTMLElement>('#image-error');
  const previewImage =
    document.querySelector<HTMLImageElement>('#preview-image');
  const previewMeta = document.querySelector<HTMLElement>('#preview-meta');

  const form = document.querySelector<HTMLFormElement>('#experiment-form');
  const questionInput =
    document.querySelector<HTMLTextAreaElement>('#question-input');
  const presetQuestionBtn = document.querySelector<HTMLButtonElement>(
    '#preset-question-btn',
  );
  const cacheConditionSelect =
    document.querySelector<HTMLSelectElement>('#cache-condition');
  const hardwareNoteInput =
    document.querySelector<HTMLInputElement>('#hardware-note');

  const prepareBtn = document.querySelector<HTMLButtonElement>('#prepare-btn');
  const runBtn = document.querySelector<HTMLButtonElement>('#run-btn');
  const stopBtn = document.querySelector<HTMLButtonElement>('#stop-btn');
  const clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn');

  const progressPanel = document.querySelector<HTMLElement>(
    '#prepare-progress-panel',
  );
  const progressLabel = document.querySelector<HTMLElement>(
    '#prepare-progress-label',
  );
  const progressEl =
    document.querySelector<HTMLProgressElement>('#prepare-progress');

  const requestStatusBadge = document.querySelector<HTMLElement>(
    '#request-status-badge',
  );
  const runErrorEl = document.querySelector<HTMLElement>('#run-error');
  const activeOutputEl = document.querySelector<HTMLElement>('#active-output');
  const timingPrepEl = document.querySelector<HTMLElement>('#timing-prep');
  const timingFirstTextEl =
    document.querySelector<HTMLElement>('#timing-first-text');
  const timingTotalEl = document.querySelector<HTMLElement>('#timing-total');
  const activeTechDetailsEl = document.querySelector<HTMLElement>(
    '#active-tech-details',
  );

  const exportBtn = document.querySelector<HTMLButtonElement>('#export-btn');
  const recordsListEl = document.querySelector<HTMLElement>('#records-list');

  // Build bundled example buttons once
  const exampleButtons = new Map<string, HTMLButtonElement>();
  if (exampleButtonsContainer) {
    for (const example of BUNDLED_EXAMPLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'example-btn';
      btn.dataset.exampleId = example.id;
      btn.setAttribute('aria-pressed', 'false');

      const title = document.createElement('span');
      title.className = 'example-btn-title';
      title.textContent = example.label;

      const desc = document.createElement('span');
      desc.className = 'example-btn-desc';
      desc.textContent = example.shortDescription;

      btn.append(title, desc);
      btn.addEventListener('click', () => {
        void controller.selectExample(example.id);
      });
      exampleButtonsContainer.append(btn);
      exampleButtons.set(example.id, btn);
    }
  }

  chromeRadio?.addEventListener('change', () => {
    if (chromeRadio.checked) {
      void controller.selectProvider('chrome-prompt-api');
    }
  });
  transformersRadio?.addEventListener('change', () => {
    if (transformersRadio.checked) {
      void controller.selectProvider('transformers-smolvlm');
    }
  });

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      void controller.uploadFile(file);
    }
    fileInput.value = '';
  });

  questionInput?.addEventListener('input', () => {
    controller.setQuestion(questionInput.value);
  });

  presetQuestionBtn?.addEventListener('click', () => {
    controller.applyPresetQuestion();
  });

  cacheConditionSelect?.addEventListener('change', () => {
    controller.setCacheCondition(cacheConditionSelect.value as CacheCondition);
  });

  hardwareNoteInput?.addEventListener('input', () => {
    controller.setHardwareNote(hardwareNoteInput.value);
  });

  prepareBtn?.addEventListener('click', () => {
    void controller.prepareSelectedProvider();
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void controller.runExperiment();
  });

  stopBtn?.addEventListener('click', () => {
    void controller.stopActive();
  });

  clearBtn?.addEventListener('click', () => {
    controller.clearResults();
  });

  exportBtn?.addEventListener('click', () => {
    const payload = controller.exportRecords();
    const json = serializeExperimentExport(payload);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `multimodal-experiments-${payload.exportedAtIso.replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  let lastRenderedRecordsRef: AppState['records'] | null = null;
  let lastPreviewUrl: string | null = null;
  let lastRenderedOutputKey: string | null = null;

  return controller.subscribe((state) => {
    if (testModeBanner) {
      testModeBanner.hidden = !state.isTestDoubleMode;
    }

    if (chromeRadio) {
      chromeRadio.checked = state.selectedProvider === 'chrome-prompt-api';
    }
    if (transformersRadio) {
      transformersRadio.checked =
        state.selectedProvider === 'transformers-smolvlm';
    }

    const chromeSlot = state.providers['chrome-prompt-api'];
    const transformersSlot = state.providers['transformers-smolvlm'];

    if (chromeBadge) {
      chromeBadge.textContent = chromeSlot.preparationState;
      chromeBadge.dataset.tone = badgeToneForPrep(chromeSlot.preparationState);
    }
    if (chromeReason) {
      chromeReason.textContent = chromeSlot.statusReason;
    }

    if (transformersBadge) {
      transformersBadge.textContent = transformersSlot.preparationState;
      transformersBadge.dataset.tone = badgeToneForPrep(
        transformersSlot.preparationState,
      );
    }
    if (transformersReason) {
      transformersReason.textContent = transformersSlot.statusReason;
    }

    for (const [id, btn] of exampleButtons) {
      btn.setAttribute(
        'aria-pressed',
        state.selectedExampleId === id ? 'true' : 'false',
      );
    }

    if (imageErrorEl) {
      imageErrorEl.hidden = state.imageError === null;
      imageErrorEl.textContent = state.imageError ?? '';
    }

    if (previewImage && previewMeta) {
      if (state.normalizedImage) {
        if (lastPreviewUrl !== state.normalizedImage.previewUrl) {
          previewImage.src = state.normalizedImage.previewUrl;
          lastPreviewUrl = state.normalizedImage.previewUrl;
        }
        const matchedExample = BUNDLED_EXAMPLES.find(
          (ex) => ex.id === state.selectedExampleId,
        );
        previewImage.alt =
          matchedExample?.altText ??
          `Uploaded image (${state.normalizedImage.sourceLabel})`;
        previewImage.hidden = false;
        previewMeta.textContent =
          `Source: ${state.normalizedImage.sourceLabel} · Original: ${state.normalizedImage.originalWidth}x${state.normalizedImage.originalHeight} (${state.normalizedImage.originalMimeType}) · ` +
          `Normalized shared input: ${state.normalizedImage.width}x${state.normalizedImage.height} PNG ` +
          `${state.normalizedImage.wasResized ? '(downscaled)' : '(original size kept)'}. Each model may apply additional internal resizing or patching.`;
      } else {
        previewImage.hidden = true;
        previewMeta.textContent = state.imageLoading
          ? 'Validating and normalizing image...'
          : 'No image selected.';
      }
    }

    if (questionInput && document.activeElement !== questionInput) {
      questionInput.value = state.question;
    }
    if (presetQuestionBtn) {
      const hasPreset =
        state.selectedExampleId !== null &&
        state.selectedExampleId !== 'upload';
      presetQuestionBtn.disabled =
        !hasPreset || state.requestState === 'running';
    }
    if (
      cacheConditionSelect &&
      document.activeElement !== cacheConditionSelect
    ) {
      cacheConditionSelect.value = state.cacheCondition;
    }
    if (hardwareNoteInput && document.activeElement !== hardwareNoteInput) {
      hardwareNoteInput.value = state.hardwareNote;
    }

    const activeSlot = getSelectedSlot(state);
    if (prepareBtn) {
      prepareBtn.disabled = !canPrepare(state);
    }
    if (runBtn) {
      runBtn.disabled = !canRun(state);
    }
    if (stopBtn) {
      stopBtn.disabled = !canStop(state);
    }
    if (clearBtn) {
      clearBtn.disabled = !canClearResults(state) || canStop(state);
    }

    if (progressPanel && progressLabel && progressEl) {
      if (activeSlot.preparationState === 'preparing') {
        progressPanel.hidden = false;
        progressLabel.textContent =
          activeSlot.progress?.statusText ?? 'Preparing provider...';
        if (
          activeSlot.progress &&
          activeSlot.progress.progress !== null &&
          Number.isFinite(activeSlot.progress.progress)
        ) {
          progressEl.value = Math.round(activeSlot.progress.progress * 100);
        } else {
          progressEl.removeAttribute('value');
        }
      } else {
        progressPanel.hidden = true;
        progressEl.value = 0;
      }
    }

    if (requestStatusBadge) {
      requestStatusBadge.textContent = state.requestState;
      requestStatusBadge.dataset.tone = badgeToneForRequest(state.requestState);
    }

    if (runErrorEl) {
      runErrorEl.hidden = state.runError === null;
      runErrorEl.textContent = state.runError ?? '';
    }

    if (activeOutputEl) {
      const outputKey = `${state.requestState}\0${state.activeDraftText}`;
      if (lastRenderedOutputKey !== outputKey) {
        lastRenderedOutputKey = outputKey;
        if (state.activeDraftText.length > 0) {
          renderSafeMarkdown(activeOutputEl, state.activeDraftText);
        } else if (state.requestState === 'running') {
          renderPlaceholderText(
            activeOutputEl,
            'Running inference on device...',
          );
        } else if (state.requestState === 'cancelled') {
          renderPlaceholderText(
            activeOutputEl,
            'Run cancelled before text output arrived.',
          );
        } else if (state.requestState === 'failed') {
          renderPlaceholderText(
            activeOutputEl,
            'Run failed. See error details above.',
          );
        } else {
          renderPlaceholderText(
            activeOutputEl,
            'Prepare a provider and run an experiment to view model output.',
          );
        }
      }
    }

    const latestForSelected = state.records[0] ?? null;
    if (timingPrepEl) {
      timingPrepEl.textContent = formatMs(activeSlot.preparationMs);
    }
    if (timingFirstTextEl) {
      const firstText =
        state.requestState === 'running'
          ? state.activeFirstTextMs
          : latestForSelected &&
              latestForSelected.providerId === state.selectedProvider
            ? latestForSelected.firstTextMs
            : state.activeFirstTextMs;
      timingFirstTextEl.textContent = formatMs(firstText);
    }
    if (timingTotalEl) {
      const total =
        state.requestState === 'running'
          ? null
          : latestForSelected &&
              latestForSelected.providerId === state.selectedProvider
            ? latestForSelected.totalLatencyMs
            : null;
      timingTotalEl.textContent = formatMs(total);
    }

    if (activeTechDetailsEl) {
      activeTechDetailsEl.replaceChildren(
        buildDetailsDefinitionList(
          activeSlot.details,
          state.normalizedImage
            ? {
                originalWidth: state.normalizedImage.originalWidth,
                originalHeight: state.normalizedImage.originalHeight,
                width: state.normalizedImage.width,
                height: state.normalizedImage.height,
              }
            : null,
        ),
      );
    }

    if (exportBtn) {
      exportBtn.disabled = state.records.length === 0;
    }

    if (recordsListEl && lastRenderedRecordsRef !== state.records) {
      lastRenderedRecordsRef = state.records;
      if (state.records.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No recorded runs yet.';
        recordsListEl.replaceChildren(empty);
      } else {
        recordsListEl.replaceChildren(
          ...state.records.map((record) => renderRecordCard(record)),
        );
      }
    }
  });
}
