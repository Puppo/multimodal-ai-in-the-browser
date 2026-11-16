export class StatusAnnouncer {
  private politeEl: HTMLElement | null = null;
  private assertiveEl: HTMLElement | null = null;

  mount(politeEl: HTMLElement | null, assertiveEl: HTMLElement | null): void {
    this.politeEl = politeEl;
    this.assertiveEl = assertiveEl;
  }

  announcePolite(message: string): void {
    if (!this.politeEl) {
      return;
    }
    this.politeEl.textContent = '';
    queueMicrotask(() => {
      if (this.politeEl) {
        this.politeEl.textContent = message;
      }
    });
  }

  announceAssertive(message: string): void {
    if (!this.assertiveEl) {
      return;
    }
    this.assertiveEl.textContent = '';
    queueMicrotask(() => {
      if (this.assertiveEl) {
        this.assertiveEl.textContent = message;
      }
    });
  }
}
