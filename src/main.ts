import './styles.css';
import { App } from './app/app';

const root = document.getElementById('app');
if (root) {
  const app = new App();
  // expose for debugging and the end-to-end tests
  (window as unknown as { __app: App }).__app = app;
  app.boot(root).catch((e) => {
    console.error('Whale Lab failed to start', e);
    root.innerHTML = `<p style="padding:2rem;font:16px system-ui;color:#fff">Something went wrong starting the lab: ${String(e?.message ?? e)}. Try reloading; your lab is stored in this browser.</p>`;
  });
}
