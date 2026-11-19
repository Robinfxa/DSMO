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
import { loadInstalled, settleEngineSetups } from './plugins/frontend';
import { watchConflicts } from './plugins/conflicts';
import { onNative } from './bridge/native';
import { startGuard } from './plugins/guard';
import { loadContributions, setDshGoTransport } from './plugins/dshgo';

async function main() {
  if (__PROTOTYPE__) {
    const { mockDshGo } = await import('./mock/dshgo');
    setDshGoTransport(mockDshGo);
  }
  render(<App />, document.getElementById('app')!);
  await loadInstalled();
  void watchConflicts();
  await loadVersions();
  void loadImported();
  startGuard();
  await boot();
  void loadContributions();
  // An engine plugin's one-time setup that is still owed (engine was off, or needed a restart).
  void settleEngineSetups();
  onNative('engine.changed', (p) => {
    if ((p as { running?: boolean } | null)?.running) setTimeout(() => void settleEngineSetups(), 3000);
  });
}
void main();
