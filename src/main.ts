// Bootstrap + jednoduchý hash router: #/ | #/storey/:id | #/wall/:id | #/print
import { loadProject } from './db';
import { renderHome } from './ui/home';
import { renderViewer3d } from './ui/viewer3d';
import { renderElevation } from './ui/elevation';
import { renderPrint } from './ui/print';

const app = document.getElementById('app')!;

async function route(): Promise<void> {
  const hash = location.hash || '#/';
  const [, screen, id] = hash.split('/');
  app.innerHTML = '';
  if (screen === 'storey' && id) await renderViewer3d(app, id);
  else if (screen === 'wall' && id) await renderElevation(app, id);
  else if (screen === 'print') await renderPrint(app);
  else await renderHome(app);
}

window.addEventListener('hashchange', route);

loadProject().then(route);
