import { ACCOUNT_SIGN_IN } from '../account/account';
import type { ComponentChildren } from 'preact';
import { importHistory, openImportedPage } from '../history/ui';
import { imported } from '../history/imported';
import { useEffect, useRef, useState } from 'preact/hooks';
import { native } from '../bridge/native';
import { PanelFrame } from '../plugins/panel';
import { DshGoPanel } from '../plugins/DshGoPanel';
import { contributions, openPanel } from '../plugins/dshgo';
import { CHAT_ITEMS, SETTINGS_ITEMS, openFeature } from './pages/registry';
import { findPlugin, pluginCssSuspended } from '../plugins/frontend';
import {
  type Overlay,
  catalog,
  clearApiKey,
  closeOverlay,
  openPage,
  confirm,
  copyText,
  credential,
  currentId,
  currentSelection,
  deleteAll,
  getClient,
  nativeInfo,
  openOverlay,
  openSession,
  isMobile,
  overlays,
  pickModel,
  prefs,
  saveApiKey,
  sessions,
  setPref,
  showToast,
  topSessions,
  archived,
  errText,
} from '../state/store';
import { inUse, readProviderStatus, type ProviderStatus } from '../engine/providers';
import { Ic, Select, Switch, useAsync } from './common';
import { Protected } from './Protected';
import { REGIONS } from './regions';

/** Renders the overlay stack with enter / leave animations. */
export function Overlays() {
  const list = overlays.value;
  const [shown, setShown] = useState<{ o: Overlay; id: number; open: boolean }[]>([]);
  const ids = useRef(new Map<Overlay, number>());
  const seq = useRef(0);
  useEffect(() => {
    setShown((prev) => {
      const next = list.map((o) => {
        let id = ids.current.get(o);
        if (id === undefined) ids.current.set(o, (id = ++seq.current));
        return { o, id, open: prev.some((p) => p.id === id && p.open) };
      });
      const leaving = prev.filter((p) => !list.includes(p.o)).map((p) => ({ ...p, open: false }));
      for (const l of leaving) setTimeout(() => setShown((s) => s.filter((x) => x.id !== l.id)), 320);
      return [...next, ...leaving].sort((a, b) => a.id - b.id);
    });
    const t = requestAnimationFrame(() => requestAnimationFrame(() => setShown((s) => s.map((x) => (list.includes(x.o) ? { ...x, open: true } : x)))));
    return () => cancelAnimationFrame(t);
  }, [list]);
  return (
    <>
      {shown.map(({ o, id, open }) => (
        <div class={`overlay ${open ? 'open' : ''}`} data-kind={o.kind} key={id} onKeyDown={(e) => e.key === 'Escape' && list.includes(o) && closeOverlay()}>
          <button class="scrim" type="button" aria-label="关闭" tabIndex={-1} onClick={() => list[list.length - 1] === o && closeOverlay()} />
          <OverlayBody o={o} />
        </div>
      ))}
    </>
  );
}

function Head({ title }: { title: string }) {
  return (
    <div class="p-head">
      <h2 class="p-title">{title}</h2>
      <button class="ib xs pri p-close" type="button" aria-label="关闭" onClick={closeOverlay}>
        <Ic n="IconCloseOutline16" />
      </button>
    </div>
  );
}

function Panel({ label, cls, children }: { label: string; cls?: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = (ref.current?.querySelector('[data-autofocus]') as HTMLElement | null) ?? ref.current;
    el?.focus({ preventScroll: true });
  }, []);
  return (
    <div class={`panel ${cls ?? ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
      {children}
    </div>
  );
}

function OverlayBody({ o }: { o: Overlay }) {
  switch (o.kind) {
    case 'settings':
      return <Settings tab={o.tab} />;
    case 'model':
      return <ModelPicker />;
    case 'chat':
      return <ChatMenu />;
    case 'host':
      return <HostPicker />;
    case 'login':
      return <Login />;
    case 'search':
      return <Search />;
    case 'input':
      return <InputDialog o={o} />;
    case 'image':
      return (
        <button class="img-view" type="button" aria-label="关闭图片" onClick={closeOverlay}>
          <img src={o.src} alt={o.alt} />
        </button>
      );
    case 'confirm':
      if (isMobile.value)
        return (
          <div class="m-alert" role="alertdialog" aria-modal="true" aria-label={o.title}>
            <div class="m-alert-t">{o.title}</div>
            {o.body && <div class="m-alert-b">{o.body}</div>}
            <div class="m-alert-btns">
              <button type="button" onClick={closeOverlay}>
                取消
              </button>
              <button type="button" class={o.danger ? 'danger' : 'primary'} data-autofocus onClick={() => (o.answered = true, closeOverlay(), o.onOk())}>
                {o.ok}
              </button>
            </div>
          </div>
        );
      return (
        <div class="panel" role="alertdialog" aria-modal="true" aria-label={o.title}>
          <div class="p-head">
            <h2 class="p-title">{o.title}</h2>
          </div>
          <div class="p-body">{o.body}</div>
          <div class="p-foot">
            <button class="btn" type="button" onClick={closeOverlay}>
              取消
            </button>
            <button class={`btn ${o.danger ? 'danger' : 'primary'}`} type="button" data-autofocus onClick={() => (o.answered = true, closeOverlay(), o.onOk())}>
              {o.ok}
            </button>
          </div>
        </div>
      );
    case 'sheet':
      if (isMobile.value)
        return (
          <div class="m-bsheet" role="dialog" aria-modal="true" aria-label={o.title}>
            <div class="m-bsheet-t">{o.title}</div>
            <div class="m-bsheet-b">{o.body()}</div>
          </div>
        );
      return (
        <Panel label={o.title} cls="form sheet">
          <Head title={o.title} />
          <div class="p-scroll">{o.body()}</div>
        </Panel>
      );
    case 'text':
      return (
        <Panel label={o.title} cls="form">
          <Head title={o.title} />
          <div class="p-scroll">{o.mono ? <pre class="code">{o.body}</pre> : <div class="p-body pre">{o.body}</div>}</div>
          <div class="p-foot">
            <button class="btn" type="button" onClick={() => copyText(o.body)}>
              复制
            </button>
          </div>
        </Panel>
      );
    case 'file':
      return <FilePreview path={o.path} />;
    case 'plugin':
      return null;
    case 'dshgo': {
      const pl = contributions.value.find((x) => x.pkg === o.pkg);
      return (
        <Panel label="插件面板" cls="form plugin-panel">
          <Head title={pl?.panels.find((x) => x.id === o.id)?.title ?? pl?.title ?? '插件'} />
          <DshGoPanel pkg={o.pkg} id={o.id} />
        </Panel>
      );
    }
    case 'panel':
      return (
        <Panel label="插件面板" cls="form plugin-panel">
          <Head title={findPlugin(o.pluginId)?.title ?? '插件'} />
          <PanelFrame pluginId={o.pluginId} panel={o.panel} />
        </Panel>
      );
  }
}

// ------------------------------------------------------------------ settings

function Settings({ tab: initial }: { tab?: 'general' | 'data' }) {
  const [tab, setTab] = useState(initial ?? 'general');
  const p = prefs.value;
  const cities = REGIONS[p.province] ?? [];
  const acc = credential.value;
  return (
    <Panel label="设置" cls="settings">
      <Head title="设置" />
      <div class="set-main">
        <div class="set-nav" role="tablist">
          {(
            [
              ['general', '通用设置', 'IconSettingsOutline16'],
              ['data', '数据管理', 'IconDataOutline16'],
            ] as const
          ).map(([k, t, ico]) => (
            <button class="nav-item" type="button" role="tab" aria-selected={tab === k} key={k} onClick={() => setTab(k)}>
              <Ic n={ico} />
              {t}
            </button>
          ))}
        </div>
        <div class="set-content" role="tabpanel">
          {tab === 'data' ? (
            <>
              <div class="cell">
                <div class="cell-text">
                  <div>导出所有对话</div>
                  <div class="cell-desc">把对话列表复制成 JSON；完整记录在对话的「导出对话日志」</div>
                </div>
                <button class="btn" type="button" onClick={() => copyText(JSON.stringify(topSessions.value.map((s) => ({ id: s.sessionId, title: s.title, updatedAt: s.updatedAt })), null, 2))}>
                  复制
                </button>
              </div>
              <div class="cell">
                <div class="cell-text">
                  <div>导入历史对话</div>
                  <div class="cell-desc">DeepSeek、ChatGPT 网页导出的文件或本应用导出的 JSON；导入后出现在对话列表里，可以接着聊</div>
                </div>
                <button class="btn" type="button" onClick={() => void importHistory()}>
                  导入
                </button>
              </div>
              {imported.value.length > 0 && (
                <div class="cell">
                  <div class="cell-text">
                    <div>保存在这台设备上的对话</div>
                    <div class="cell-desc">{imported.value.length} 个</div>
                  </div>
                  <button class="btn" type="button" onClick={() => (closeOverlay(), openImportedPage())}>
                    查看
                  </button>
                </div>
              )}
              <div class="cell">
                <div class="cell-text">
                  <div>删除所有对话</div>
                  <div class="cell-desc">移出列表（归档），引擎里的记录不会被抹掉</div>
                </div>
                <button class="btn danger" type="button" onClick={() => confirm('删除后，所有对话都将从列表中移除', '可以在引擎的归档里找回。', '删除', () => void deleteAll())}>
                  删除
                </button>
              </div>
              <div class="note">版本 {__BUILD__} UTC{__PROTOTYPE__ ? ' · 原型' : ''}</div>
            </>
          ) : (
            <>
              <div class="theme">
                主题
                <div class="theme-opts" role="radiogroup" aria-label="主题">
                  {(
                    [
                      ['light', '浅色', 'IconLightOutline16'],
                      ['dark', '深色', 'IconDarkOutline16'],
                      ['system', '跟随系统', 'IconFollowsystemOutline16'],
                    ] as const
                  ).map(([k, t, ico]) => (
                    <button class="theme-opt" type="button" role="radio" aria-checked={p.theme === k} key={k} onClick={() => setPref('theme', k)}>
                      <Ic n={ico} />
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div class="cell">
                <div class="cell-text">
                  <div>语言</div>
                </div>
                <Select label="语言" value={p.lang} options={[['zh', '简体中文'], ['en', 'English']]} onChange={(v) => setPref('lang', v as 'zh' | 'en')} />
              </div>
              <div class="cell">
                <div class="cell-text">
                  <div>位置信息</div>
                  <div class="cell-desc">打开后，发消息时会附上所选地区，用于回答和所在地有关的问题</div>
                </div>
                <Switch on={p.locationOn} label="位置信息" onChange={(v) => setPref('locationOn', v)} />
                <div class={`loc-fields ${p.locationOn ? '' : 'closed'}`}>
                  <div class="loc-in">
                    <Select label="省份/地区" value={p.province} placeholder="请选择省份/地区" options={Object.keys(REGIONS).map((x) => [x, x])} onChange={(v) => (setPref('province', v), setPref('city', ''))} />
                    <Select label="市" value={p.city} placeholder="请选择市" options={cities.map((c) => [c, c])} onChange={(v) => setPref('city', v)} />
                  </div>
                </div>
              </div>
              <div class="cell">
                <div class="cell-text">
                  <div>高级模式</div>
                  <div class="cell-desc">在对话里显示进阶界面：模型选择、过程步骤、插件和全部功能。关闭时与 chat-demo 保持一致。</div>
                </div>
                <Switch on={p.advanced} label="高级模式" onChange={(v) => setPref('advanced', v)} />
              </div>
              {p.advanced && (
                <>
                  {SETTINGS_ITEMS.filter((it) => ['models', 'providers', 'engine-settings', 'engine-plugins', 'remote', 'engine', 'phone', 'notify-settings', 'voice-settings', 'access', 'update'].includes(it.id)).map((it) => (
                    <div class="cell" key={it.id}>
                      <div class="cell-text">
                        <div>{it.title}</div>
                        <div class="cell-desc">{it.sub}</div>
                      </div>
                      <button class="btn" type="button" onClick={() => (closeOverlay(), setTimeout(() => openFeature(it.id), 120))}>
                        {'native' in it.to ? '打开' : '选择'}
                      </button>
                    </div>
                  ))}
                  <div class="cell">
                    <div class="cell-text">
                      <div>思考过程翻译</div>
                      <div class="cell-desc">展开思考后可以点「翻译」，需要引擎装了翻译组件</div>
                    </div>
                    <Switch on={p.cotTranslate} label="思考过程翻译" onChange={(v) => setPref('cotTranslate', v)} />
                  </div>
                  <div class="cell">
                    <div class="cell-text">
                      <div>展开思考过程</div>
                      <div class="cell-desc">关闭时只显示「已思考」，点一下再展开</div>
                    </div>
                    <Switch on={p.thinkExpanded} label="展开思考过程" onChange={(v) => setPref('thinkExpanded', v)} />
                  </div>
                  <div class="cell">
                    <div class="cell-text">
                      <div>回复完成时通知</div>
                      <div class="cell-desc">不在这个对话或 App 在后台时提醒</div>
                    </div>
                    <Switch on={p.notifyDone} label="回复完成时通知" onChange={(v) => setPref('notifyDone', v)} />
                  </div>
                </>
              )}
              <div class="cell">
                <div class="cell-text">
                  <div>语音输入</div>
                </div>
                <Switch on={p.voiceInput} label="语音输入" onChange={(v) => setPref('voiceInput', v)} />
              </div>
              <div class="cell">
                <div class="cell-text">
                  <div>账号</div>
                  <div class="cell-desc">
                    {acc?.configured ? (acc.source === 'env' ? '已连接 · 由启动环境提供的 API Key' : '已连接 · API Key 保存在引擎所在设备') : '未登录'}
                  </div>
                </div>
                {acc?.configured ? (
                  acc.writable && (
                    <button class="btn" type="button" onClick={() => confirm('退出登录？', '会删除保存在引擎里的 API Key，之后需要重新填写。', '退出', () => void clearApiKey().then(() => showToast('已退出登录')))}>
                      退出登录
                    </button>
                  )
                ) : (
                  <button class="btn primary" type="button" onClick={() => (closeOverlay(), setTimeout(() => openOverlay({ kind: 'login' }), 120))}>
                    登录
                  </button>
                )}
              </div>
              <ProviderCell />
              {pluginCssSuspended.value && (
                <div class="note warn">有插件的样式遮住了授权卡或登录框，已暂停所有插件样式。到「插件」里停用或移除它后再打开。</div>
              )}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ chat menu (top right)

/** Everything that is about the open conversation. */
function ChatMenu() {
  const go = (id: string) => {
    closeOverlay();
    openFeature(id);
  };
  const tabPanels = contributions.value.flatMap((p) => p.panels.filter((x) => x.placement.includes('session.tab')).map((x) => ({ pkg: p.pkg, id: x.id, title: x.title, plugin: p.title })));
  return (
    <Panel label="这个对话" cls="chat-menu">
      <Head title="这个对话" />
      <div class="p-scroll">
        {CHAT_ITEMS.map(([group, items]) => (
          <div key={group}>
            <div class="group-h">{group}</div>
            {items.map((it) => (
              <button class="cm-item" type="button" key={it.id} onClick={() => go(it.id)}>
                <span class="cm-item-t">{it.title}</span>
                <span class="cm-item-s">{it.sub}</span>
                {'native' in it.to && <span class="cm-item-e">原生</span>}
              </button>
            ))}
          </div>
        ))}
        {tabPanels.length > 0 && (
          <div>
            <div class="group-h">插件</div>
            {tabPanels.map((x) => (
              <button class="cm-item" type="button" key={x.pkg + x.id} onClick={() => (closeOverlay(), openPanel(x.pkg, x.id))}>
                <span class="cm-item-t">{x.title}</span>
                <span class="cm-item-s">{x.plugin}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ pickers

function ModelPicker() {
  const cat = catalog.value;
  const sel = currentSelection();
  const models = cat?.groups.flatMap((g) => g.models) ?? [];
  const m = models.find((x) => x.id === sel?.model && x.provider === sel?.provider) ?? models[0];
  const effort = sel?.effort ?? m?.defaultEffort;
  return (
    <Panel label="选择模型">
      <Head title="选择模型" />
      {!cat && <div class="p-body">正在读取模型列表…</div>}
      <div class="opts" role="radiogroup">
        {models.map((x) => (
          <button
            class="opt-row"
            type="button"
            role="radio"
            key={x.provider + x.id}
            aria-checked={x === m}
            onClick={() => void pickModel(x.provider, x.id, x.efforts.some((e) => e.id === effort) ? effort : x.defaultEffort)}
          >
            <span class="opt-text">
              <span class="opt-label">{x.name}</span>
              {x.description && <span class="opt-sub">{x.description}</span>}
            </span>
            <span class="opt-check">
              <Ic n="IconCheckOutline16" />
            </span>
          </button>
        ))}
      </div>
      {m && m.efforts.length > 0 && (
        <>
          <div class="sub-h">思考深度</div>
          <div class="efforts" role="radiogroup" aria-label="思考深度">
            {m.efforts.map((e) => (
              <button class="effort" type="button" role="radio" aria-checked={e.id === effort} title={e.description} key={e.id} onClick={() => void pickModel(m.provider, m.id, e.id)}>
                {e.name}
              </button>
            ))}
          </div>
        </>
      )}
      {!currentId.value && <div class="note">会用在下一个新对话里</div>}
    </Panel>
  );
}

function HostPicker() {
  const info = nativeInfo.value;
  return (
    <Panel label="切换主机">
      <Head title="切换主机" />
      <div class="opts" role="radiogroup">
        {(info?.hosts ?? []).map((h) => (
          <button
            class="opt-row"
            type="button"
            role="radio"
            key={h.id}
            aria-checked={h.current}
            onClick={async () => {
              try {
                await native.switchHost(h.id);
                nativeInfo.value = await native.info();
                closeOverlay();
                showToast('已切换到' + h.label);
              } catch (e) {
                showToast(errText(e));
              }
            }}
          >
            <span class="opt-text">
              <span class="opt-label">{h.label}</span>
              <span class="opt-sub">{h.sub}</span>
            </span>
            <span class="opt-status">{h.status}</span>
            <span class="opt-check">
              <Ic n="IconCheckOutline16" />
            </span>
          </button>
        ))}
      </div>
      <div class="p-foot">
        <button class="btn" type="button" onClick={() => (closeOverlay(), openPage('hosts'))}>
          管理主机
        </button>
      </div>
      {!info?.inApp && <div class="note">原型里只切换显示；在 App 里会重新连接到所选主机的引擎。</div>}
    </Panel>
  );
}

// ------------------------------------------------------------------ login (protected)

function Login() {
  const [key, setKey] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const acc = credential.value;
  const valid = agree && key.trim().length >= 8;
  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (!valid || busy) return setErr(!agree ? '请先勾选同意用户协议与隐私政策' : '请填写 API Key');
    setBusy(true);
    setErr('');
    try {
      await saveApiKey(key);
      closeOverlay();
      showToast('已登录');
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel label="登录" cls="login">
      <Head title="登录" />
      <button class="ib xl pri login-back" type="button" aria-label="返回" onClick={closeOverlay}>
        <Ic n="Back" />
      </button>
      <h1 class="login-h">登录 DSMO</h1>
      <p class="login-p">填入 DeepSeek API Key。Key 只写进引擎所在设备的凭据文件，页面和插件都读不到。</p>
      <Protected zone="login">
        <form onSubmit={submit} autocomplete="off">
          {acc && !acc.writable && <div class="err">当前 Key 由启动环境提供，这里不能修改。</div>}
          <div class="field">
            <label for="lKey">API Key</label>
            <div class="inp">
              <input
                id="lKey"
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="sk-..."
                value={key}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <div class="note">没有 Key？在 DeepSeek 开放平台创建一个。</div>
          {err && <div class="err">{err}</div>}
          <label class="field" style="display:flex;gap:8px;align-items:flex-start;font-size:13px">
            <input type="checkbox" style="flex:none;margin-top:4px" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} />
            <span>我已阅读并同意用户协议与隐私政策</span>
          </label>
          <button class="btn primary wide" type="submit" disabled={busy || (acc ? !acc.writable : false)} aria-disabled={!valid}>
            {busy ? '正在验证…' : '登录'}
          </button>
        </form>
        {ACCOUNT_SIGN_IN && nativeInfo.value?.inApp && (
          <button class="link" type="button" style="display:block;margin:14px auto 0" onClick={() => void native.openNativePage('account')}>
            用 DeepSeek 账号登录（手机号）
          </button>
        )}
      </Protected>
    </Panel>
  );
}

// ------------------------------------------------------------------ search

function Search() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ sessionId: string; snippet: string }[] | null>(null);
  useEffect(() => {
    const query = q.trim();
    if (!query) return setRes(null);
    const t = setTimeout(async () => {
      try {
        // deleted (archived) conversations stay out of the results too
        setRes((await getClient().searchSessions(query)).items.filter((x) => !archived.value.has(x.sessionId)));
      } catch {
        // Older engines: fall back to titles.
        setRes(topSessions.value.filter((s) => (s.title ?? '').includes(query)).map((s) => ({ sessionId: s.sessionId, snippet: s.title ?? '' })));
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Panel label="搜索对话" cls="form">
      <Head title="搜索对话" />
      <div class="search">
        <Ic n="IconSearchOutline16" />
        <input type="search" placeholder="按标题和正文查找" value={q} data-autofocus onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="p-scroll s-results">
        {res === null && <div class="note">输入关键词开始搜索</div>}
        {res?.length === 0 && <div class="note">没有找到</div>}
        {res?.map((r) => {
          const s = sessions.value.find((x) => x.sessionId === r.sessionId);
          return (
            <div class="lrow" key={r.sessionId}>
              <button class="lrow-main" type="button" onClick={() => (closeOverlay(), openSession(r.sessionId))}>
                <span class="lrow-title">{s?.title ?? '对话'}</span>
                <span class="lrow-sub one">{r.snippet}</span>
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ files

function FilePreview({ path }: { path: string }) {
  const sid = currentId.value!;
  const { data, error, loading } = useAsync(() => getClient().readFile(sid, path, 1, 2000), [path]);
  return (
    <Panel label={path} cls="form">
      <Head title={path.split('/').pop() ?? path} />
      <div class="pg-sub">{path}</div>
      <div class="p-scroll">
        {loading && <div class="note">正在读取…</div>}
        {error && <div class="note">{/not-text/.test(String((error as any).code)) ? '这是二进制文件，没法直接预览' : errText(error)}</div>}
        {data && <pre class="code">{data.text}</pre>}
        {data && !data.eof && <div class="note">只显示了前 2000 行</div>}
      </div>
      {data && (
        <div class="p-foot">
          <button class="btn" type="button" onClick={() => copyText(data.text)}>
            复制
          </button>
          <button class="btn" type="button" onClick={() => void native.saveFile(path.split('/').pop() ?? 'file.txt', 'text/plain', new Blob([data.text]))}>
            保存
          </button>
        </div>
      )}
    </Panel>
  );
}


function InputDialog({ o }: { o: { title: string; value: string; placeholder?: string; ok: string; allowEmpty?: boolean; onOk: (v: string) => void } }) {
  const [v, setV] = useState(o.value);
  const done = () => {
    if (!v.trim() && !o.allowEmpty) return;
    closeOverlay();
    o.onOk(v.trim());
  };
  return (
    <div class={isMobile.value ? 'm-alert' : 'panel'} role="dialog" aria-modal="true" aria-label={o.title}>
      <div class={isMobile.value ? 'm-alert-t' : 'p-head'}>{isMobile.value ? o.title : <h2 class="p-title">{o.title}</h2>}</div>
      <div class={isMobile.value ? 'm-alert-b' : 'p-body'}>
        <input class="dlg-input" data-autofocus value={v} placeholder={o.placeholder} onInput={(e) => setV((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && done()} />
      </div>
      {isMobile.value ? (
        <div class="m-alert-btns">
          <button type="button" onClick={closeOverlay}>
            取消
          </button>
          <button type="button" class="primary" disabled={!v.trim() && !o.allowEmpty} onClick={done}>
            {o.ok}
          </button>
        </div>
      ) : (
        <div class="p-foot">
          <button class="btn" type="button" onClick={closeOverlay}>
            取消
          </button>
          <button class="btn primary" type="button" disabled={!v.trim() && !o.allowEmpty} onClick={done}>
            {o.ok}
          </button>
        </div>
      )}
    </div>
  );
}

/** 设置 › 账号: which provider is in use, and whether the others are ready (the phone's 账号管理 has the full list). */
function ProviderCell() {
  const [list, setList] = useState<ProviderStatus[] | null>(null);
  const cat = catalog.value;
  const keyed = credential.value?.configured;
  useEffect(() => {
    let live = true;
    readProviderStatus().then(
      (x) => live && setList(x),
      () => live && setList([]),
    );
    return () => void (live = false);
  }, [cat, keyed]);
  const use = inUse();
  const bad = (list ?? []).filter((p) => !p.ok);
  return (
    <div class="cell">
      <div class="cell-text">
        <div>模型提供方</div>
        <div class="cell-desc">
          {use ? `正在用 ${use.name} · ${use.model}` : '还没选模型'}
          {bad.length > 0 && `；${bad.map((p) => `${p.name}：${p.status}`).join('；')}`}
        </div>
      </div>
      <button class="btn" type="button" onClick={() => (closeOverlay(), openPage('providers'))}>
        管理
      </button>
    </div>
  );
}
