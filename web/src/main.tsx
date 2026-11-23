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
import { finishPendingRemovals, loadInstalled, retryAutoUpdates, settleEngineSetups } from './plugins/frontend';
import { afterUpdate } from './plugins/PluginsPage';
import { watchConflicts } from './plugins/conflicts';
import { watchMaidshScope } from './maidsh/scope';
import { watchLore } from './ui/lore/pick';
import { watchBackground } from './plugins/background';
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
  watchMaidshScope();
  watchLore();
  watchBackground();
  await loadVersions();
  void loadImported();
  startGuard();
  await boot();
  void loadContributions();
  // An engine plugin's one-time setup that is still owed (engine was off, or needed a restart).
  void settleEngineSetups();
  // Plugins switched off when uninstalled because the engine couldn't remove them while running.
  void finishPendingRemovals().catch(() => {});
  // Official plugins the market has a newer version of update themselves (their data stays).
  const autoUpdate = () => void retryAutoUpdates().then((r) => afterUpdate(r.updated, r.restart)).catch(() => {});
  setTimeout(autoUpdate, 5000);
  onNative('engine.changed', (p) => {
    if ((p as { running?: boolean } | null)?.running) {
      setTimeout(() => void settleEngineSetups(), 3000);
      setTimeout(() => void finishPendingRemovals().catch(() => {}), 4000);
      setTimeout(autoUpdate, 6000);
    }
  });
}
void main();
