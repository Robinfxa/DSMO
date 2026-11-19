// API Demo — local proxy (AGPL-3.0, part of the API Demo patch set for dsh-Go).
//
// The API Demo page ships inside the APK, but DSH's browser fence only accepts
// pages it serves itself: a request whose Origin differs from its Host, or that
// is marked cross-site, is refused. So the app runs this small HTTP server on
// 127.0.0.1 (a fixed port, so the page keeps its storage; a random one if taken):
//
//   /__enter?k=<secret>  sets an HttpOnly cookie holding a per-launch secret and
//                        redirects to /. Every other request must carry it, so
//                        other apps on the phone can't use the proxy's engine login.
//   /__picks/<token>     a file the person picked, streamed from the app cache (picks.dart)
//   /api/*, /dsh-go/*    forwarded to the engine (HTTP and the mux WebSocket) with
//                        the engine's own auth cookie, Host rewritten, Origin and
//                        Referer dropped — to the engine it is a same-origin client.
//   everything else      the bundled page (assets/api_demo/).
//
// The engine login is the launch token, exactly as dsh-Go's WebView uses it:
// GET /?token=… answers 303 with a `dsh-auth-*` cookie, kept here only.
//
// The page is served with no engine at all (first run, an engine that is
// stopped, starting or failed): /api/* then answers 503 `api-demo-proxy/no-engine`
// and the page shows its own engine screens. [retarget] points the proxy at
// the engine once it runs (or at nothing again) without reloading the page.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart' show AssetBundle, rootBundle;

import 'picks.dart';

/// Where the page's assets live in the Flutter bundle.
const apiDemoAssetRoot = 'assets/api_demo';

class ApiDemoProxy {
  ApiDemoProxy({Uri? engine, String? token, AssetBundle? assets, this.webRoot}) : _assets = assets ?? rootBundle {
    _engine = engine;
    _token = token;
  }

  /// A downloaded page (web_update.dart) to serve instead of the APK's; null for the APK's.
  /// Changing it takes effect on the page's next load.
  Directory? webRoot;

  /// The engine's origin, e.g. http://127.0.0.1:3080 (local) or the SSH forward; null when none runs.
  Uri? _engine;
  Uri? get engine => _engine;

  /// The engine's launch token.
  String? _token;
  final AssetBundle _assets;

  final String _secret = _randomHex(24);
  final Map<String, String> _engineCookies = {};
  final HttpClient _http = HttpClient()
    ..autoUncompress = false
    ..idleTimeout = const Duration(seconds: 30);
  HttpServer? _server;
  Future<void>? _loggingIn;

  int get port => _server!.port;
  String get origin => 'http://127.0.0.1:$port';

  /// What the WebView loads first.
  Uri get entry => Uri.parse('$origin/__enter?k=$_secret');

  /// A fixed port keeps the page's origin the same across launches and host
  /// switches, and with it the page's localStorage and IndexedDB (its settings,
  /// imported conversations). The per-launch secret still guards the proxy.
  static const _homePort = 47615;

  Future<void> start() async {
    for (var attempt = 0; _server == null && attempt < 10; attempt++) {
      try {
        _server = await HttpServer.bind(InternetAddress.loopbackIPv4, _homePort);
      } on SocketException {
        // The proxy of the previous host may still be closing.
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    }
    // Something else holds the port: a random one works, the page just starts with fresh storage.
    _server ??= await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen((r) => unawaited(_handle(r).catchError((Object e) => _fail(r, 502, '$e'))));
    if (_engine != null) await _login().catchError((Object _) {});
  }

  /// Points at another engine run (a restart gets a new port and token), or at none.
  /// True when it changed.
  Future<bool> retarget(Uri? engine, String? token) async {
    if (engine == _engine && token == _token) return false;
    _engine = engine;
    _token = token;
    _engineCookies.clear();
    if (engine != null) await _login().catchError((Object _) {});
    return true;
  }

  Future<void> close() async {
    await _server?.close(force: true);
    _http.close(force: true);
  }

  // ------------------------------------------------------------------ engine login

  Future<void> _login() => _loggingIn ??= () async {
    try {
      final engine = _engine;
      if (engine == null) throw const HttpException('no engine');
      final req = await _http.getUrl(engine.replace(path: '/', queryParameters: {'token': _token ?? ''}));
      req.followRedirects = false;
      final res = await req.close();
      _keepCookies(res);
      await res.drain<void>();
      if (_engineCookies.isEmpty) throw const HttpException('engine login returned no session cookie');
    } finally {
      _loggingIn = null;
    }
  }();

  void _keepCookies(HttpClientResponse res) {
    for (final c in res.cookies) {
      if (c.value.isEmpty || (c.expires?.isBefore(DateTime.now()) ?? false)) {
        _engineCookies.remove(c.name);
      } else {
        _engineCookies[c.name] = c.value;
      }
    }
  }

  String get _cookieHeader => _engineCookies.entries.map((e) => '${e.key}=${e.value}').join('; ');

  // ------------------------------------------------------------------ requests

  Future<void> _handle(HttpRequest r) async {
    // DNS rebinding: only our own authority.
    if (r.headers.value(HttpHeaders.hostHeader) != '127.0.0.1:$port') return _fail(r, 421, 'wrong host');
    final path = r.uri.path;
    if (path == '/__enter') {
      if (r.uri.queryParameters['k'] != _secret) return _fail(r, 403, 'forbidden');
      r.response
        ..statusCode = HttpStatus.found
        ..headers.set(HttpHeaders.locationHeader, '/')
        ..headers.set(HttpHeaders.cacheControlHeader, 'no-store')
        ..headers.add(HttpHeaders.setCookieHeader, 'ad_k=$_secret; Path=/; HttpOnly; SameSite=Strict');
      return r.response.close();
    }
    final cookie = r.cookies.where((c) => c.name == 'ad_k').map((c) => c.value).firstOrNull;
    if (cookie != _secret) return _fail(r, 403, 'forbidden');
    final origin = r.headers.value('origin');
    if (origin != null && origin != this.origin && origin != 'null') return _fail(r, 403, 'cross-origin');

    if (path.startsWith(ApiDemoPicks.route)) return _servePick(r);
    if (path.startsWith('/api/') || path.startsWith('/dsh-go/')) {
      if (_engine == null) return _fail(r, 503, 'no-engine');
      if (WebSocketTransformer.isUpgradeRequest(r)) return _proxySocket(r);
      return _forward(r);
    }
    return _serveAsset(r);
  }

  static const _dropRequestHeaders = {
    'host', 'origin', 'referer', 'cookie', 'connection', 'upgrade', 'keep-alive', 'content-length',
    'transfer-encoding', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  };
  static const _dropResponseHeaders = {'set-cookie', 'connection', 'keep-alive', 'transfer-encoding'};

  Future<void> _forward(HttpRequest r) async {
    // Small bodies (RPC JSON) are buffered so a request can be retried once after a re-login.
    final length = r.contentLength;
    Uint8List? body;
    if (length >= 0 && length <= 8 * 1024 * 1024) {
      final b = BytesBuilder(copy: false);
      await r.forEach(b.add);
      body = b.takeBytes();
    }
    var res = await _send(r, body);
    if ((res.statusCode == 401 || res.statusCode == 403) && body != null) {
      await res.drain<void>();
      _engineCookies.clear();
      await _login();
      res = await _send(r, body);
    }
    _keepCookies(res);
    r.response.statusCode = res.statusCode;
    res.headers.forEach((name, values) {
      if (_dropResponseHeaders.contains(name)) return;
      for (final v in values) {
        r.response.headers.add(name, v, preserveHeaderCase: true);
      }
    });
    r.response.contentLength = res.contentLength;
    // Server-sent events (DS Bot's feed) go out as they come, not when a buffer fills.
    if (res.headers.contentType?.mimeType == 'text/event-stream') r.response.bufferOutput = false;
    await r.response.addStream(res);
    await r.response.close();
  }

  Future<HttpClientResponse> _send(HttpRequest r, Uint8List? body) async {
    final target = _engine!.replace(path: r.uri.path, query: r.uri.hasQuery ? r.uri.query : null);
    final out = await _http.openUrl(r.method, target);
    out.followRedirects = false;
    r.headers.forEach((name, values) {
      if (_dropRequestHeaders.contains(name) || name.startsWith('sec-')) return;
      for (final v in values) {
        out.headers.add(name, v);
      }
    });
    if (_engineCookies.isNotEmpty) out.headers.set(HttpHeaders.cookieHeader, _cookieHeader);
    if (body != null) {
      out.contentLength = body.length;
      out.add(body);
    } else {
      out.contentLength = r.contentLength;
      await out.addStream(r);
    }
    return out.close();
  }

  Future<void> _proxySocket(HttpRequest r) async {
    final engine = _engine!;
    final url = engine.replace(scheme: engine.scheme == 'https' ? 'wss' : 'ws', path: r.uri.path, query: r.uri.hasQuery ? r.uri.query : null);
    WebSocket up;
    try {
      up = await WebSocket.connect(url.toString(), headers: {if (_engineCookies.isNotEmpty) 'cookie': _cookieHeader});
    } on Object {
      _engineCookies.clear();
      await _login();
      up = await WebSocket.connect(url.toString(), headers: {'cookie': _cookieHeader});
    }
    final down = await WebSocketTransformer.upgrade(r);
    up.pingInterval = const Duration(seconds: 15);
    down.pingInterval = const Duration(seconds: 15);
    down.listen(up.add, onDone: () => up.close(down.closeCode ?? 1000, down.closeReason), onError: (_) => up.close(1011));
    up.listen(down.add, onDone: () => down.close(up.closeCode ?? 1000, up.closeReason), onError: (_) => down.close(1011));
  }

  // ------------------------------------------------------------------ assets

  static const _types = {
    'html': 'text/html; charset=utf-8',
    'js': 'text/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'webp': 'image/webp',
    'woff2': 'font/woff2',
    'ico': 'image/x-icon',
  };

  /// A file the person picked (picks.dart), streamed; it never goes to the engine.
  Future<void> _servePick(HttpRequest r) async {
    if (r.method != 'GET') return _fail(r, 405, 'method');
    final file = ApiDemoPicks.instance.lookup(r.uri.path);
    if (file == null || !await file.exists()) return _fail(r, 404, 'gone');
    r.response
      ..statusCode = HttpStatus.ok
      ..headers.contentType = ContentType.binary
      ..headers.contentLength = await file.length()
      ..headers.set(HttpHeaders.cacheControlHeader, 'no-store');
    await r.response.addStream(file.openRead());
    await r.response.close();
  }

  Future<void> _serveAsset(HttpRequest r) async {
    if (r.method != 'GET' && r.method != 'HEAD') return _fail(r, 405, 'method');
    var path = Uri.decodeComponent(r.uri.path);
    if (path == '/' || path.isEmpty) path = '/index.html';
    if (path.contains('..') || path.contains('\\')) return _fail(r, 400, 'bad path');
    final ByteData data;
    final root = webRoot;
    if (root != null) {
      // The downloaded page: only its own files (a mix of two versions would not work).
      var file = File('${root.path}$path');
      if (!file.existsSync()) {
        file = File('${root.path}/index.html');
        path = '/index.html';
      }
      data = ByteData.sublistView(await file.readAsBytes());
    } else {
      ByteData loaded;
      try {
        loaded = await _assets.load('$apiDemoAssetRoot$path');
      } on Object {
        // Client-side routes fall back to the page.
        loaded = await _assets.load('$apiDemoAssetRoot/index.html');
        path = '/index.html';
      }
      data = loaded;
    }
    final ext = path.split('.').last.toLowerCase();
    r.response
      ..statusCode = 200
      ..headers.set(HttpHeaders.contentTypeHeader, _types[ext] ?? 'application/octet-stream')
      ..headers.set(HttpHeaders.cacheControlHeader, path == '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable')
      ..headers.set('x-content-type-options', 'nosniff')
      ..headers.set('referrer-policy', 'no-referrer');
    if (r.method == 'GET') r.response.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
    await r.response.close();
  }

  Future<void> _fail(HttpRequest r, int status, String message) async {
    // Path only: /__enter's query is the per-launch secret.
    debugPrint('dsmo-proxy $status ${r.method} ${r.uri.path}: $message');
    try {
      r.response
        ..statusCode = status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'code': status == 503 ? 'api-demo-proxy/no-engine' : 'api-demo-proxy/$status', 'message': message}));
      await r.response.close();
    } on Object {
      // The response was already started; nothing more to say.
    }
  }
}

String _randomHex(int bytes) {
  final rnd = Random.secure();
  return List.generate(bytes, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}
