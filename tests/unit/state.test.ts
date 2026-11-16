import { describe, expect, it } from 'vitest';
import {
  canPrepare,
  canRun,
  canStop,
  createInitialAppState,
  isValidPreparationTransition,
  isValidRequestTransition,
} from '../../src/app/state';
import type { NormalizedImage } from '../../src/images/normalize';

const FAKE_IMAGE: NormalizedImage = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  mimeType: 'image/png',
  previewUrl: 'blob:http://localhost/test',
  sourceLabel: 'scene',
  originalMimeType: 'image/jpeg',
  originalByteLength: 1000,
  normalizedByteLength: 800,
  originalWidth: 1280,
  originalHeight: 853,
  width: 1024,
  height: 682,
  wasResized: true,
};

describe('state machine transitions and action guards', () => {
  it('allows only legal preparation and request transitions', () => {
    expect(isValidPreparationTransition('unchecked', 'checking')).toBe(true);
    expect(isValidPreparationTransition('checking', 'needs-download')).toBe(
      true,
    );
    expect(isValidPreparationTransition('needs-download', 'preparing')).toBe(
      true,
    );
    expect(isValidPreparationTransition('preparing', 'ready')).toBe(true);
    expect(isValidPreparationTransition('unavailable', 'ready')).toBe(false);

    expect(isValidRequestTransition('idle', 'running')).toBe(true);
    expect(isValidRequestTransition('running', 'completed')).toBe(true);
    expect(isValidRequestTransition('running', 'cancelled')).toBe(true);
    expect(isValidRequestTransition('idle', 'completed')).toBe(false);
  });

  it('gates Prepare, Run, and Stop actions strictly by current state', () => {
    const state = createInitialAppState();
    expect(canPrepare(state)).toBe(false);
    expect(canRun(state)).toBe(false);
    expect(canStop(state)).toBe(false);

    state.providers['chrome-prompt-api'].preparationState = 'needs-download';
    expect(canPrepare(state)).toBe(true);
    expect(canRun(state)).toBe(false);

    state.providers['chrome-prompt-api'].preparationState = 'preparing';
    expect(canPrepare(state)).toBe(false);
    expect(canStop(state)).toBe(true);

    state.providers['chrome-prompt-api'].preparationState = 'ready';
    state.normalizedImage = FAKE_IMAGE;
    expect(canRun(state)).toBe(true);

    state.question = '   ';
    expect(canRun(state)).toBe(false);

    state.question = 'What is here?';
    state.requestState = 'running';
    expect(canRun(state)).toBe(false);
    expect(canStop(state)).toBe(true);
  });
});
