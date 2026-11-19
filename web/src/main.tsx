import { render } from 'preact';
import { loadImported } from './history/imported';
import { loadVersions } from './state/versions';
import './styles/theme.css';
import './styles/app.css';
import './styles/v1.css';
import './styles/mobile.css';
import './styles/plugins.css';
import { App } from './ui/App';
import { boot } from './state/store';
import { loadInstalled } from './plugins/frontend';
import { startGuard } from './plugins/guard';
import { loadContributions, setDshGoTransport } from './plugins/dshgo';

async function main() {
  if (__PROTOTYPE__) {
    const { mockDshGo } = await import('./mock/dshgo');
    setDshGoTransport(mockDshGo);
  }
  render(<App />, document.getElementById('app')!);
  await loadInstalled();
  await loadVersions();
  void loadImported();
  startGuard();
  await boot();
  void loadContributions();
}
void main();
