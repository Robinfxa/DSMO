// API Demo — frontend hot update (AGPL-3.0, API Demo patch set for dsh-Go).
//
// For the early, fast-changing frontend: the page inside the APK is only the
// fallback. `.github/workflows/web.yml` publishes every change to `web/` as
// `web.zip` + `web.json` on the `web-latest` pre-release of this repository;
// the app checks `web.json`, downloads a new bundle, checks its SHA-256 and
// size, unpacks it beside the old one and switches `current.json` over. The
// proxy (proxy.dart) then serves the page from that folder.
//
//   web.json  {version, sha256, size, bridge, commit, builtAt}
//
// - `bridge`: the native bridge the page needs (native/BRIDGE). A bundle that
//   needs a newer one than this APK has (API_DEMO_BRIDGE) is not taken: that
//   change needs a new APK.
// - A bundle that does not start (api_demo_home.dart: the page never talks to
//   the bridge) is rejected for good and the APK's own page comes back.
// - Off with --dart-define=API_DEMO_WEB_UPDATE=false.
//
// The downloaded page runs with the whole bridge, exactly like the bundled one:
// whoever can publish releases on the repository can change it on every phone.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// Where releases come from (the same define as the APK's own update channel).
const apiDemoWebRepo = String.fromEnvironment('API_DEMO_UPDATE_REPO', defaultValue: 'Robinfxa/DSMO');

/// The native bridge this APK provides (native/BRIDGE, passed by native/build-apk.sh).
const apiDemoBridgeVersion = int.fromEnvironment('API_DEMO_BRIDGE', defaultValue: 1);

const apiDemoWebUpdates = bool.fromEnvironment('API_DEMO_WEB_UPDATE', defaultValue: true);

const _tag = 'web-latest';
const _maxZip = 32 * 1024 * 1024;
const _maxUnpacked = 96 * 1024 * 1024;
const _maxFiles = 2000;
const _minInterval = Duration(minutes: 5);

/// A downloaded page: its folder and the version it was published as.
class ApiDemoWebBundle {
  const ApiDemoWebBundle(this.version, this.dir);

  final String version;
  final Directory dir;
}

class ApiDemoWebUpdate {
  ApiDemoWebUpdate._();

  static final instance = ApiDemoWebUpdate._();

  Directory? _base;
  DateTime? _lastCheck;
  Future<bool>? _checking;
  bool _cleaned = false;

  Future<Directory> _root() async =>
      _base ??= Directory('${(await getApplicationSupportDirectory()).path}/api_demo_web');

  File _file(Directory root, String name) => File('${root.path}/$name');

  /// The downloaded page to serve, or null for the one inside the APK.
  Future<ApiDemoWebBundle?> active() async {
    if (!apiDemoWebUpdates) return null;
    try {
      final root = await _root();
      final meta = _file(root, 'current.json');
      if (!meta.existsSync()) return null;
      final m = jsonDecode(await meta.readAsString()) as Map<String, Object?>;
      final version = m['version'] as String?;
      final name = m['dir'] as String?;
      if (version == null || name == null || name.contains('/') || name.contains('..')) return null;
      if (((m['bridge'] as num?)?.toInt() ?? 1) > apiDemoBridgeVersion) return null;
      final dir = Directory('${root.path}/$name');
      if (!_file(dir, 'index.html').existsSync()) return null;
      if (!_cleaned) {
        _cleaned = true;
        await _removeOthers(root, keep: name);
      }
      return ApiDemoWebBundle(version, dir);
    } on Object catch (e) {
      debugPrint('dsmo-web active: $e');
      return null;
    }
  }

  /// [version] did not start: never take it again, and serve the APK's page.
  Future<void> reject(String version) async {
    try {
      final root = await _root();
      final rejected = await _rejected(root)
        ..add(version);
      await _file(root, 'rejected.json').writeAsString(jsonEncode(rejected.toList()));
      final meta = _file(root, 'current.json');
      if (meta.existsSync()) await meta.delete();
      debugPrint('dsmo-web rejected $version');
    } on Object catch (e) {
      debugPrint('dsmo-web reject: $e');
    }
  }

  /// Asks the repository for a newer page; true when one was downloaded and is
  /// now [active]. At most every few minutes unless [force].
  Future<bool> check({bool force = false}) {
    if (!apiDemoWebUpdates) return Future.value(false);
    return _checking ??= _check(force).whenComplete(() => _checking = null);
  }

  Uri _asset(String name) => Uri.parse('https://github.com/$apiDemoWebRepo/releases/download/$_tag/$name');

  Future<bool> _check(bool force) async {
    final now = DateTime.now();
    if (!force && _lastCheck != null && now.difference(_lastCheck!) < _minInterval) return false;
    _lastCheck = now;
    final client = http.Client();
    try {
      final root = await _root();
      final res = await client.get(_asset('web.json')).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return false;
      final m = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, Object?>;
      final version = m['version'] as String?;
      final sha = m['sha256'] as String?;
      final size = (m['size'] as num?)?.toInt();
      final bridge = (m['bridge'] as num?)?.toInt() ?? 1;
      if (version == null || sha == null || size == null || size <= 0 || size > _maxZip) return false;
      if (!RegExp(r'^[A-Za-z0-9._-]{1,64}$').hasMatch(version)) return false;
      if (bridge > apiDemoBridgeVersion) {
        debugPrint('dsmo-web $version needs bridge $bridge, this APK has $apiDemoBridgeVersion');
        return false;
      }
      if ((await active())?.version == version) return false;
      if ((await _rejected(root)).contains(version)) return false;

      final zip = await client.get(_asset('web.zip')).timeout(const Duration(minutes: 3));
      final bytes = zip.bodyBytes;
      if (zip.statusCode != 200 || bytes.length != size) return false;
      // web.json and web.zip are replaced one after the other: a mismatch is the next one landing.
      if (crypto.sha256.convert(bytes).toString() != sha) return false;

      final name = 'v-${now.millisecondsSinceEpoch}';
      final staging = Directory('${root.path}/$name.part');
      if (staging.existsSync()) await staging.delete(recursive: true);
      await _unpack(bytes, staging);
      final dir = await staging.rename('${root.path}/$name');
      final tmp = _file(root, 'current.json.tmp');
      await tmp.writeAsString(jsonEncode({'version': version, 'dir': name, 'bridge': bridge}));
      await tmp.rename(_file(root, 'current.json').path);
      debugPrint('dsmo-web now $version (${dir.path})');
      // The folder the page may still be loading from stays until the next launch.
      return true;
    } on Object catch (e) {
      debugPrint('dsmo-web check: $e');
      return false;
    } finally {
      client.close();
    }
  }

  Future<Set<String>> _rejected(Directory root) async {
    try {
      final f = _file(root, 'rejected.json');
      if (!f.existsSync()) return <String>{};
      return {...(jsonDecode(await f.readAsString()) as List).whereType<String>()};
    } on Object {
      return <String>{};
    }
  }

  Future<void> _unpack(Uint8List bytes, Directory into) async {
    final archive = ZipDecoder().decodeBytes(bytes);
    if (archive.files.length > _maxFiles) throw StateError('too many files');
    var total = 0;
    var hasIndex = false;
    for (final member in archive.files) {
      if (!member.isFile) continue;
      final name = member.name.replaceAll('\\', '/');
      final parts = name.split('/');
      if (name.startsWith('/') || parts.any((p) => p.isEmpty || p == '.' || p == '..')) {
        throw StateError('bad path $name');
      }
      total += member.size;
      if (total > _maxUnpacked) throw StateError('too large');
      if (name == 'index.html') hasIndex = true;
      final out = OutputMemoryStream();
      member.writeContent(out);
      final file = File('${into.path}/$name');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(out.getBytes(), flush: true);
    }
    if (!hasIndex) throw StateError('no index.html');
  }

  Future<void> _removeOthers(Directory root, {required String keep}) async {
    try {
      await for (final e in root.list()) {
        final name = e.path.split('/').last;
        if (e is Directory && name.startsWith('v-') && name != keep) await e.delete(recursive: true);
      }
    } on Object {
      // Left for the next launch.
    }
  }
}
