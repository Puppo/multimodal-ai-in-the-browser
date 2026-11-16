import './styles.css';
import { AppController } from './app/controller';
import { StatusAnnouncer } from './ui/announcer';
import { mountAppUI } from './ui/render';

const announcer = new StatusAnnouncer();
announcer.mount(
  document.querySelector<HTMLElement>('#polite-announcer'),
  document.querySelector<HTMLElement>('#assertive-announcer'),
);

const controller = new AppController({ announcer });
const unsubscribe = mountAppUI(controller);

window.addEventListener('pagehide', () => {
  unsubscribe();
  void controller.dispose();
});

void controller.init();
