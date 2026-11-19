// API Demo — the app's home (AGPL-3.0, API Demo patch set for dsh-Go).
//
// Takes 网页模式's place (mode_home.dart, patch 0001): the bundled API Demo page
// in a WebView, served by ApiDemoProxy for the active host, with dsh-Go's own
// system integration around it exactly as WebHome has it — notifications and
// their taps (ChatAlertHost), links, share sheet and launcher entries.
// Decision Q1: dsh-Go's runtime and native layer stay; only the UI is ours.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../links/app_links.dart';
import '../notify/notify_channel.dart' show NotifyTap;
import '../share_code/share_codec.dart' show shareFileExtension;
import '../share_code/share_link.dart' show shareLandingRoute, shareLinkHost;
import '../state/bots_state.dart' show dsBotTapRoom;
import '../state/hosts_state.dart' show activeHostProvider;
import '../state/update_state.dart' show appUpdateProvider;
import '../ui/bots/bot_alerts.dart' show BotAlertsHost, dsBotTapHandler;
import '../runtime/runtime_state.dart';
import '../state/sessions_state.dart';
import '../state/ui_mode_state.dart' show webOpenProvider;
import '../ui/remote/remote_screen.dart';
import '../ui/forum/forum_link_host.dart';
import '../ui/notify/chat_alert_host.dart';
import '../ui/web/dsh_web_launcher.dart';
import '../ui/web/web_home.dart' show WebEntryHost;
import '../ui/web/web_target.dart';
import 'bridge.dart';
import 'proxy.dart';

class ApiDemoHome extends ConsumerStatefulWidget {
  const ApiDemoHome({super.key, this.initial});

  /// Where to land first (a switch from the native interface).
  final DshWebTarget? initial;

  @override
  ConsumerState<ApiDemoHome> createState() => _ApiDemoHomeState();
}

class _ApiDemoHomeState extends ConsumerState<ApiDemoHome> with WidgetsBindingObserver {
  WebViewController? _controller;
  ApiDemoBridge? _bridge;
  ApiDemoProxy? _proxy;
  Object? _key;
  String? _error;
  String? _pageSession;
  Completer<bool>? _back;
  DateTime? _pausedAt;

  /// Events for a page that is still loading (a host switch reloads it).
  final _later = <(String, Object?)>[];
  final _off = <VoidCallback>[];

  void _emit(String name, Object? payload, {bool later = false}) {
    final bridge = _bridge;
    if (bridge == null || later) return _later.add((name, payload));
    unawaited(bridge.event(name, payload));
  }

  /// Share codes (dsh-Go's ShareCodeHost), opened by the page's import screen.
  Future<bool> _shareLink(Uri uri) async {
    _emit('share.incoming', {'text': uri.toString(), 'origin': 'link'});
    return true;
  }

  Future<bool> _shareFile(Uri uri) async {
    try {
      final file = File(uri.toFilePath());
      if (await file.length() > 8 * 1024 * 1024) return false;
      _emit('share.incoming', {'text': await file.readAsString(), 'origin': 'file'});
      return true;
    } on Object {
      return false;
    }
  }

  /// A tapped DS Bot notification opens the Bot or group in the page, not dsh-Go's page.
  bool _botTap(NotifyTap tap) {
    final switching = ref.read(activeHostProvider) != tap.host;
    ref.read(activeHostProvider.notifier).select(tap.host);
    Navigator.of(context, rootNavigator: true).popUntil((route) => route.isFirst);
    _emit('bots.open', {'kind': tap.kind == dsBotTapRoom ? 'room' : 'bot', 'id': tap.sessionId}, later: switching);
    return true;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _pageSession = widget.initial?.sessionId;
    dsBotTapHandler = _botTap;
    final router = ref.read(linkRouterProvider);
    _off
      ..add(router.registerLinkHandler(shareLinkHost, _shareLink))
      ..add(router.registerLinkHandler(shareLandingRoute, _shareLink))
      ..add(router.registerFileHandler(shareFileExtension, _shareFile));
    // A notification tap, a launcher recent: the page opens that conversation.
    ref.listenManual(currentSessionProvider, (_, next) {
      if (next == null || next == _pageSession) return;
      _pageSession = next;
      unawaited(_bridge?.event('openSession', {'sessionId': next}));
    });
    // A share or 新对话 from the launcher: a new conversation with the text in the composer.
    ref.listenManual(webOpenProvider, (_, request) {
      if (request == null) return;
      ref.read(webOpenProvider.notifier).taken(request);
      final compose = request.compose;
      unawaited(_bridge?.event('compose', {
        'newSession': request.target.newSession,
        'sessionId': request.target.sessionId,
        'text': compose?.text ?? '',
      }));
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (dsBotTapHandler == _botTap) dsBotTapHandler = null;
    for (final off in _off) {
      off();
    }
    _bridge?.dispose();
    unawaited(_proxy?.close());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) _pausedAt = DateTime.now();
    if (state == AppLifecycleState.resumed) {
      // Android suspends the page in the background; its socket may be gone.
      final away = _pausedAt == null ? Duration.zero : DateTime.now().difference(_pausedAt!);
      unawaited(_bridge?.event('resumed', {'awayMs': away.inMilliseconds}));
      // An update install waiting on 「安装未知应用」 carries on (dsh-Go's UpdateLaunchCheck does this).
      unawaited(ref.read(appUpdateProvider.notifier).onAppResumed());
    }
  }

  /// Starts the proxy and the page for a host (a host switch reloads the page);
  /// the same host's engine coming and going only retargets the proxy, so the
  /// page stays and shows its own engine screens meanwhile.
  Future<void> _open(Object key, Uri? engine, String? token) async {
    if (_key == key) {
      if (_proxy case final proxy?) {
        if (await proxy.retarget(engine, token)) unawaited(_bridge?.event('engine.changed', {'running': engine != null}));
      }
      return;
    }
    _key = key;
    // Opaque, in the app's own colour: a page that fails to draw shows as an empty
    // page (or its error text) instead of a black screen.
    final background = Theme.of(context).scaffoldBackgroundColor;
    final old = _proxy;
    _proxy = null;
    _bridge?.dispose();
    setState(() {
      _controller = null;
      _error = null;
    });
    // The next proxy takes the same port (the page's origin stays the same).
    await old?.close();
    if (!mounted || _key != key) return;
    try {
      final proxy = ApiDemoProxy(engine: engine, token: token);
      await proxy.start();
      if (!mounted || _key != key) return unawaited(proxy.close());
      _proxy = proxy;
      final controller = WebViewController();
      final bridge = ApiDemoBridge(
        ref: ref,
        controller: controller,
        context: () => context,
        onBackResult: (handled) => _back?.complete(handled),
      );
      _bridge = bridge;
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.setBackgroundColor(background);
      // chrome://inspect works on the installed app (HANDOFF.md › 装好后检查一遍).
      if (controller.platform is AndroidWebViewController) await AndroidWebViewController.enableDebugging(true);
      // The page's own errors reach `adb logcat` (tag flutter, prefix dsmo-page).
      await controller.setOnConsoleMessage((m) {
        if (m.level == JavaScriptLogLevel.error || m.level == JavaScriptLogLevel.warning) {
          debugPrint('dsmo-page ${m.level.name}: ${m.message}');
        }
      });
      await controller.addJavaScriptChannel('ApiDemoNative', onMessageReceived: (m) => unawaited(bridge.handle(m.message)));
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (req) {
            if (req.url.startsWith(proxy.origin) || req.url == 'about:blank' || req.url.startsWith('about:srcdoc')) {
              return NavigationDecision.navigate;
            }
            // Anything else leaves the app: dshgo:// links to the app router, the rest to the browser.
            final uri = Uri.tryParse(req.url);
            if (uri != null && uri.scheme == 'dshgo') ref.read(appLinksProvider).add(uri);
            return NavigationDecision.prevent;
          },
          onWebResourceError: (error) {
            // No URL here: the first one carries the proxy's per-launch secret.
            debugPrint('dsmo-page load error ${error.errorCode} ${error.errorType?.name} mainFrame=${error.isForMainFrame}: ${error.description}');
            if ((error.isForMainFrame ?? false) && mounted && identical(_bridge, bridge)) {
              setState(() => _error = '${error.description}（${error.errorCode}）');
            }
          },
          onHttpError: (error) {
            debugPrint('dsmo-page http ${error.response?.statusCode} ${error.request?.uri.path}');
          },
          onPageFinished: (_) {
            if (_pageSession case final id?) unawaited(bridge.event('openSession', {'sessionId': id}));
            // The page installs its listeners as it starts; give it a moment.
            Timer(const Duration(milliseconds: 900), () {
              if (!identical(_bridge, bridge)) return;
              for (final (name, payload) in _later) {
                unawaited(bridge.event(name, payload));
              }
              _later.clear();
            });
          },
        ),
      );
      await controller.loadRequest(proxy.entry);
      if (mounted && _key == key) setState(() => _controller = controller);
    } on Object catch (e) {
      if (mounted && _key == key) setState(() => _error = '$e');
    }
  }

  Future<bool> _onBack() async {
    final bridge = _bridge;
    if (bridge == null) return false;
    _back = Completer<bool>();
    await bridge.event('back', null);
    return _back!.future.timeout(const Duration(milliseconds: 600), onTimeout: () => false);
  }

  @override
  Widget build(BuildContext context) {
    final access = ref.watch(dshWebAccessProvider);
    final Widget body;
    switch (access) {
      case LocalDshWeb():
        // The page opens whatever the engine is doing: first run, starting,
        // stopped and failed are its own screens (engine.* and setup.* on the bridge).
        final status = ref.watch(localRuntimeProvider.select((s) => s.status));
        final running = status.isRunning && status.baseUrl != null && status.token != null;
        final engine = running ? Uri.parse(status.baseUrl!) : null;
        final token = running ? status.token : null;
        WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_open('local', engine, token)));
        body = _page();
      case SshDshWeb(:final url):
        final token = url.queryParameters['token'] ?? '';
        final engine = url.replace(query: '', path: '');
        final origin = Uri.parse('${engine.scheme}://${engine.authority}');
        WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_open(('ssh', origin.toString()), origin, token)));
        body = _page();
      case NoDshWeb(:final reason):
        _key = null;
        // Q5: relay hosts are not supported by this frontend.
        body = _Notice(title: '这个主机用不了 DSMO', message: reason, action: ('切换主机', () => _push(const RemoteScreen())));
    }
    return ChatAlertHost(
      child: PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) async {
          if (didPop) return;
          if (!await _onBack()) await SystemNavigator.pop();
        },
        // BotAlertsHost keeps DS Bot's notifications coming (and its team's Sessions out of the chat alerts).
        child: Stack(fit: StackFit.expand, children: [body, const LinkHost(), const WebEntryHost(), const ForumLinkHost(), const BotAlertsHost()]),
      ),
    );
  }

  Widget _page() {
    final c = _controller;
    if (_error != null) return _Notice(title: '页面没能打开', message: _error!, action: ('重试', () => setState(() => _key = null)));
    if (c == null) return const ColoredBox(color: Colors.transparent, child: Center(child: CircularProgressIndicator.adaptive()));
    // The Scaffold shrinks the page by the keyboard's height, so the composer stays above it.
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(bottom: false, child: WebViewWidget(controller: c)),
    );
  }

  /// Until the engine pages are rebuilt in the bundled page (docs/native-pages.md), these open dsh-Go's.
  Future<void> _push(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
}

class _Notice extends StatelessWidget {
  const _Notice({required this.title, required this.message, required this.action});

  final String title;
  final String message;
  final (String, VoidCallback) action;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
                const SizedBox(height: 8),
                Text(message, textAlign: TextAlign.center),
                const SizedBox(height: 20),
                FilledButton(onPressed: action.$2, child: Text(action.$1)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
