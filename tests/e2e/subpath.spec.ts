import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const SUBPATH = '/multimodal-ai-in-the-browser/';
const OUT_DIR = path.resolve(process.cwd(), 'dist-subpath');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

let server: http.Server | null = null;
let serverUrl = '';

test.describe('Production subpath build', () => {
  test.beforeAll(async () => {
    execSync('npx vite build --outDir dist-subpath', {
      env: { ...process.env, VITE_BASE_PATH: SUBPATH },
      stdio: 'inherit',
    });

    server = http.createServer((req, res) => {
      const reqPath = (req.url ?? '/').split('?')[0] ?? '/';
      if (!reqPath.startsWith(SUBPATH)) {
        res.statusCode = 404;
        res.end('Not found outside subpath');
        return;
      }
      const relative = reqPath.slice(SUBPATH.length) || 'index.html';
      const filePath = path.join(OUT_DIR, relative);
      if (!filePath.startsWith(OUT_DIR) || !fs.existsSync(filePath)) {
        res.statusCode = 404;
        res.end('Missing asset');
        return;
      }
      const ext = path.extname(filePath);
      res.setHeader(
        'Content-Type',
        MIME_TYPES[ext] ?? 'application/octet-stream',
      );
      fs.createReadStream(filePath).pipe(res);
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          serverUrl = `http://127.0.0.1:${address.port}${SUBPATH}`;
        }
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  });

  test('loads assets and real worker script under repository subpath without 404s', async ({
    page,
  }) => {
    const failedUrls: string[] = [];
    const loadedWorkerUrls: string[] = [];

    page.on('response', (res) => {
      if (
        res.status() >= 400 &&
        res.url().startsWith(serverUrl.split(SUBPATH)[0] ?? '')
      ) {
        failedUrls.push(`${res.status()} ${res.url()}`);
      }
      if (res.url().includes('transformers.worker') && res.status() === 200) {
        loadedWorkerUrls.push(res.url());
      }
    });

    // Ensure WebGPU capability check resolves cleanly in headless CI without GPU
    // so clicking Prepare triggers the real bundled worker URL under SUBPATH.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: {
          async requestAdapter() {
            return {
              info: { vendor: 'stub', architecture: 'headless' },
              async requestDevice() {
                return { destroy() {} };
              },
            };
          },
        },
      });
    });

    // Abort external Hugging Face model downloads so the subpath test stays offline-safe and fast
    await page.route('https://huggingface.co/**', (route) => route.abort());

    await page.goto(serverUrl, { waitUntil: 'networkidle' });
    await expect(page.locator('#preview-meta')).toContainText('1024x682 PNG');

    // Switch example to verify all subpath example assets resolve
    await page.locator('.example-btn[data-example-id="text"]').click();
    await expect(page.locator('#preview-meta')).toContainText('Source: text');

    // Select real Transformers.js provider and trigger worker spawn
    await page.locator('label[for="provider-transformers"]').click();
    await expect(page.locator('#badge-transformers')).toHaveText(
      'needs-download',
    );
    await page.locator('#prepare-btn').click();

    await expect
      .poll(() => loadedWorkerUrls.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(loadedWorkerUrls[0]).toContain(
      `${SUBPATH}assets/transformers.worker-`,
    );

    if (await page.locator('#stop-btn').isEnabled()) {
      await page.locator('#stop-btn').click();
    }
    expect(failedUrls).toEqual([]);
  });
});
