import { expect, test } from '@playwright/test';
import { installMockProviders } from './fixtures/mock-providers';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test.describe('Multimodal AI demo UI workflows (with Playwright test doubles)', () => {
  test('example links select the image and preset without preparing or running a model', async ({
    page,
  }) => {
    await installMockProviders(page, {
      chrome: { availability: 'needs-download' },
    });

    for (const [query, id, question] of [
      ['scene', 'scene', 'What objects are visible and where are they?'],
      ['text', 'text', 'Transcribe the visible text.'],
      [
        'ambiguous',
        'ambiguous',
        'Can you identify the partly hidden object? Explain any uncertainty.',
      ],
      ['unknown', 'scene', 'What objects are visible and where are they?'],
    ] as const) {
      await page.goto(`/?example=${query}`);
      await expect(page.locator('#question-input')).toHaveValue(question);
      await expect(
        page.locator(`.example-btn[data-example-id="${id}"]`),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#badge-chrome')).toHaveText('needs-download');
      await expect(page.locator('#run-btn')).toBeDisabled();
      await expect(page.locator('#prepare-progress-panel')).toBeHidden();
    }
  });

  test('shows unavailable provider explanation while allowing independent selection and preparation of the other provider', async ({
    page,
  }) => {
    await installMockProviders(page, {
      chrome: {
        availability: 'unavailable',
        reason: 'Prompt API is unavailable in this browser.',
      },
      transformers: {
        availability: 'needs-download',
        prepareDelayMs: 80,
        streamChunks: ['Desk with ', 'laptop and books.'],
      },
    });

    await page.goto('/');

    await expect(page.locator('#test-mode-banner')).toBeVisible();
    await expect(page.locator('#badge-chrome')).toHaveText('unavailable');
    await expect(page.locator('#reason-chrome')).toContainText('unavailable');
    await expect(page.locator('#prepare-btn')).toBeDisabled();
    await expect(page.locator('#run-btn')).toBeDisabled();
    await expect(page.locator('#prepare-progress-panel')).toBeHidden();

    // Switch to Transformers.js
    await page.locator('label[for="provider-transformers"]').click();
    await expect(page.locator('#badge-transformers')).toHaveText(
      'needs-download',
    );
    await expect(page.locator('#prepare-btn')).toBeEnabled();
    await expect(page.locator('#run-btn')).toBeDisabled();
    await expect(page.locator('#prepare-progress-panel')).toBeHidden();

    // Prepare explicitly, verify progress bar, then run
    await page.locator('#prepare-btn').click();
    await expect(page.locator('#prepare-progress-panel')).toBeVisible();
    await expect(page.locator('#badge-transformers')).toHaveText('ready');
    await expect(page.locator('#prepare-progress-panel')).toBeHidden();
    await expect(page.locator('#run-btn')).toBeEnabled();

    await page.locator('#run-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('completed');
    await expect(page.locator('#active-output')).toHaveText(
      'Desk with laptop and books.',
    );
  });

  test('validates uploads, normalizes EXIF orientation 6 JPEGs, and renders untrusted model output as plain text', async ({
    page,
  }) => {
    await installMockProviders(page, {
      chrome: {
        availability: 'ready',
        streamChunks: [
          '<img src=x onerror="window.__xss=1">',
          '<script>window.__xss=2</script>',
        ],
      },
    });

    await page.goto('/');
    await expect(page.locator('#badge-chrome')).toHaveText('ready');
    await expect(page.locator('#preview-meta')).toContainText('1024x682 PNG');

    // Switch example and verify preset question updates + reset button restores edited prompt
    await page.locator('.example-btn[data-example-id="text"]').click();
    await expect(page.locator('#question-input')).toHaveValue(
      'Transcribe the visible text.',
    );
    await page.locator('#question-input').fill('Custom edited question');
    await page.locator('#preset-question-btn').click();
    await expect(page.locator('#question-input')).toHaveValue(
      'Transcribe the visible text.',
    );

    // Reject SVG upload cleanly
    await page.locator('#image-upload').setInputFiles({
      name: 'bad.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    });
    await expect(page.locator('#image-error')).toBeVisible();
    await expect(page.locator('#image-error')).toContainText('SVG');

    // Upload valid local PNG and check sanitized identifier + plain-text XSS protection
    await page.locator('#image-upload').setInputFiles({
      name: 'secret-personal-photo.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    });
    await expect(page.locator('#image-error')).toBeHidden();
    await expect(page.locator('#preview-meta')).toContainText('local-upload-2');
    await expect(page.locator('#preview-meta')).not.toContainText(
      'secret-personal-photo',
    );

    // Generate 40x20 JPEG spliced with EXIF Orientation=6 (90 deg CW -> 20x40 decoded)
    const rotatedJpegBytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 20;
      const ctx = canvas.getContext('2d');
      ctx?.fillRect(0, 0, 40, 20);
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob(
          (b: Blob | null) => resolve(b as Blob),
          'image/jpeg',
          0.9,
        );
      });
      const raw = new Uint8Array(await blob.arrayBuffer());
      // Standard APP1 Exif Orientation=6 header (36 bytes total)
      const app1 = new Uint8Array([
        0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49,
        0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const combined = new Uint8Array(2 + app1.length + (raw.length - 2));
      combined.set(raw.subarray(0, 2), 0);
      combined.set(app1, 2);
      combined.set(raw.subarray(2), 2 + app1.length);
      return Array.from(combined);
    });

    await page.locator('#image-upload').setInputFiles({
      name: 'rotated.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from(rotatedJpegBytes),
    });
    await expect(page.locator('#preview-meta')).toContainText(
      'Original: 20x40 (image/jpeg)',
    );
    await expect(page.locator('#preview-meta')).toContainText(
      'Normalized shared input: 20x40 PNG',
    );

    // Run and assert untrusted HTML/script strings render literally as text
    await page.locator('#run-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('completed');
    await expect(page.locator('#active-output')).toHaveText(
      '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>',
    );
    await expect(page.locator('#active-output img')).toHaveCount(0);
    await expect(page.locator('#active-output script')).toHaveCount(0);
    const xssTriggered = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__xss,
    );
    expect(xssTriggered).toBeUndefined();
  });

  test('renders safe Markdown DOM nodes on screen while preserving raw Markdown in JSON export', async ({
    page,
  }) => {
    const rawMarkdown =
      '**On the Desk/Table:**\n\n  * **Laptop:** Positioned center-left.\n  * **Lamp:** Left of `laptop`.\n\n![blocked](https://evil.example/pixel.png)';
    await installMockProviders(page, {
      chrome: {
        availability: 'ready',
        streamChunks: [
          '**On the Desk/Table:**\n\n  * **Laptop:** ',
          'Positioned center-left.\n  * **Lamp:** Left of `laptop`.\n\n![blocked](https://evil.example/pixel.png)',
        ],
      },
    });

    await page.goto('/');
    await expect(page.locator('#badge-chrome')).toHaveText('ready');
    await page.locator('#run-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('completed');

    await expect(page.locator('#active-output strong')).toHaveText([
      'On the Desk/Table:',
      'Laptop:',
      'Lamp:',
    ]);
    await expect(page.locator('#active-output ul > li')).toHaveCount(2);
    await expect(page.locator('#active-output code')).toHaveText(['laptop']);
    await expect(page.locator('#active-output img')).toHaveCount(0);
    await expect(page.locator('#active-output a')).toHaveCount(0);

    await expect(page.locator('.record-card strong')).toContainText([
      'Chrome Prompt API · scene',
      'On the Desk/Table:',
      'Laptop:',
      'Lamp:',
    ]);
    await expect(page.locator('.record-card ul > li')).toHaveCount(2);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-btn').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(exported.records[0].answerText).toBe(rawMarkdown);
  });

  test('prevents duplicate runs, stops preparation and generation, switches provider mid-run, recovers from error, and exports sanitized JSON', async ({
    page,
  }) => {
    await installMockProviders(page, {
      chrome: {
        availability: 'ready',
        hangGenerateUntilAbort: true,
      },
      transformers: {
        availability: 'needs-download',
        hangPrepareUntilAbort: true,
      },
    });

    await page.goto('/');
    await expect(page.locator('#badge-chrome')).toHaveText('ready');

    // Start Chrome run (hangs with partial chunk until cancelled)
    await page.locator('#run-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('running');
    await expect(page.locator('#run-btn')).toBeDisabled();
    await expect(page.locator('#stop-btn')).toBeEnabled();

    // Stop during generation
    await page.locator('#stop-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('cancelled');
    await expect(page.locator('.record-card')).toHaveCount(1);

    // Start another run and switch provider mid-run
    await page
      .locator('#question-input')
      .fill('Preserved prompt across switch');
    await page.locator('#run-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('running');
    await page.locator('label[for="provider-transformers"]').click();

    await expect(page.locator('#badge-transformers')).toHaveText(
      'needs-download',
    );
    await expect(page.locator('#question-input')).toHaveValue(
      'Preserved prompt across switch',
    );
    const logs = await page.evaluate(
      () =>
        (
          window as unknown as {
            __MOCK_PROVIDER_LOG__: { disposed: string[]; cancelled: string[] };
          }
        ).__MOCK_PROVIDER_LOG__,
    );
    expect(logs.disposed).toContain('chrome-prompt-api');

    // Stop during preparation on Transformers.js
    await page.locator('#prepare-btn').click();
    await expect(page.locator('#badge-transformers')).toHaveText('preparing');
    await expect(page.locator('#stop-btn')).toBeEnabled();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#badge-transformers')).toHaveText(
      'needs-download',
    );

    // Clear results and verify export button disables
    await expect(page.locator('#export-btn')).toBeEnabled();
    await page.locator('#clear-btn').click();
    await expect(page.locator('.record-card')).toHaveCount(0);
    await expect(page.locator('#export-btn')).toBeDisabled();
  });

  test('handles generation errors without stuck controls, retries, exports JSON, and stays keyboard & 375px mobile friendly', async ({
    page,
  }) => {
    await installMockProviders(page, {
      chrome: {
        availability: 'ready',
        generateFailureMessage: 'Simulated WebGPU device lost',
      },
    });

    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.locator('#badge-chrome')).toHaveText('ready');

    // Verify keyboard navigation from top of document reaches skip link
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();

    // Verify no horizontal overflow on narrow mobile viewport
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);

    // Trigger error and check recovery
    await page.locator('#run-btn').click();
    await expect(page.locator('#request-status-badge')).toHaveText('failed');
    await expect(page.locator('#run-error')).toContainText(
      'Simulated WebGPU device lost',
    );
    await expect(page.locator('#run-btn')).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-btn').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(exported.schemaVersion).toBe('1.0.0');
    expect(exported.records).toHaveLength(1);
    expect(exported.records[0].status).toBe('failed');
    expect(exported.records[0].errorMessage).toContain('WebGPU device lost');
  });
});
