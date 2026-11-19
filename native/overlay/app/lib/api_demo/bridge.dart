// API Demo — the thin native bridge (AGPL-3.0, API Demo patch set for dsh-Go).
//
// Decision Q5: the page talks to the engine directly (through the proxy); only
// what a web page can't do comes here. Page → app:
//   ApiDemoNative.postMessage(JSON {id, method, params})
// App → page:
//   window.__apiDemo.reply(id, ok, value) / window.__apiDemo.event(name, payload)
// Wire format and the page's side: web/src/bridge/native.ts, docs/bridge.md.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../links/page_links.dart' show pageForId, pageLinkIds;
import '../share_code/guest_fs.dart';
import '../share_code/share_models.dart' show SharedSkill;
import '../state/attachments.dart';
import '../state/connection_state.dart';
import '../state/hosts_state.dart';
import '../state/sessions_state.dart';
import '../ui/features/feature_catalog.dart' show featureSections;
import 'bridge_local.dart';
import 'bridge_phone.dart';
import 'dictation.dart';

/// Session pages the bridge may open natively (Q6: chat-bound pages are web,
/// these stay native for now and need the conversation).
const apiDemoSessionPages = {'terminal', 'session-detail', 'files', 'artifacts', 'jobs', 'plan-goal', 'skills', 'subagents'};

class ApiDemoBridge {
  ApiDemoBridge({required this.ref, required this.controller, required this.context, required this.onBackResult});

  final WidgetRef ref;
  final WebViewController controller;
  final BuildContext Function() context;
  final void Function(bool handled) onBackResult;
  ApiDemoDictation? _dictation;
  late final _local = ApiDemoLocal(ref: ref, event: event, container: () => ProviderScope.containerOf(context(), listen: false));
  late final _phone = ApiDemoPhone(ref: ref, context: context);

  void dispose() {
    _dictation?.cancel();
    _local.dispose();
  }

  Future<void> handle(String raw) async {
    Map<String, Object?> m;
    try {
      m = (jsonDecode(raw) as Map).cast<String, Object?>();
    } on Object {
      return;
    }
    final id = m['id'] as String? ?? '';
    final method = m['method'] as String? ?? '';
    final params = (m['params'] as Map?)?.cast<String, Object?>() ?? const {};
    try {
      final value = await _dispatch(method, params);
      if (id.isNotEmpty && method != 'backResult') await _reply(id, true, value);
    } on Object catch (e) {
      if (id.isNotEmpty) await _reply(id, false, e is StateError ? e.message : e.toString());
    }
  }

  Future<void> _reply(String id, bool ok, Object? value) =>
      controller.runJavaScript('window.__apiDemo && window.__apiDemo.reply(${jsonEncode(id)}, $ok, ${jsonEncode(value)});');

  Future<void> event(String name, Object? payload) =>
      controller.runJavaScript('window.__apiDemo && window.__apiDemo.event(${jsonEncode(name)}, ${jsonEncode(payload)});');

  Future<Object?> _dispatch(String method, Map<String, Object?> p) async {
    switch (method) {
      case 'info':
        return _info();
      case 'pickFiles':
        return _pickFiles(p['sessionId'] as String? ?? '', p['accept'] as String? ?? 'any');
      case 'switchHost':
        await _switchHost(p['id'] as String? ?? 'local');
        return null;
      case 'openNativePage':
        await _openNativePage(p['page'] as String? ?? '', p['sessionId'] as String?);
        return null;
      case 'session':
        // The page reports the conversation on screen (notifications, launcher recents, native mode).
        ref.read(currentSessionProvider.notifier).select(p['sessionId'] as String?);
        return null;
      case 'notify':
        // ChatAlertHost already alerts natively for every conversation of this host.
        return null;
      case 'openExternal':
        final url = Uri.tryParse(p['url'] as String? ?? '');
        if (url == null || url.scheme != 'https') throw ArgumentError('only https links');
        await launchUrl(url, mode: LaunchMode.externalApplication);
        return null;
      case 'share':
        await SharePlus.instance.share(ShareParams(text: p['text'] as String? ?? ''));
        return null;
      case 'skills.install':
        return _installSkills(p['skills']);
      case 'skills.remove':
        await _removeSkills(p['names']);
        return null;
      case 'pickDocuments':
        // Files read on the device and handed to the page; nothing is uploaded (导入历史对话).
        final out = <Map<String, Object?>>[];
        var total = 0;
        for (final f in await FilePicker.pickFiles()) {
          final bytes = await f.readAsBytes();
          total += bytes.length;
          if (total > 64 * 1024 * 1024) throw ArgumentError('files too large');
          out.add({'name': f.name, 'data': base64Encode(bytes)});
        }
        return out;
      case 'saveFile':
        return _saveFile(p['name'] as String? ?? 'file', p['mimeType'] as String? ?? 'application/octet-stream', p['data'] as String? ?? '');
      case 'storage.get':
        final prefs = await SharedPreferences.getInstance();
        return prefs.getString('api_demo.${p['key']}');
      case 'storage.set':
        final prefs = await SharedPreferences.getInstance();
        final key = 'api_demo.${p['key']}';
        final value = p['value'] as String?;
        if (value == null) {
          await prefs.remove(key);
        } else {
          if (value.length > 1024 * 1024) throw ArgumentError('value too large');
          await prefs.setString(key, value);
        }
        return null;
      case 'voice.start':
        await _dictation?.cancel();
        _dictation = ApiDemoDictation(
          ref: ref,
          onWords: (text) => unawaited(event('voice.partial', {'text': text})),
          onDone: (text) => unawaited(event('voice.final', {'text': text})),
          onError: (message) => unawaited(event('voice.error', {'message': message})),
        );
        await _dictation!.start();
        return null;
      case 'voice.stop':
        await _dictation?.stop();
        return null;
      case 'voice.cancel':
        await _dictation?.cancel();
        _dictation = null;
        return null;
      case 'backResult':
        onBackResult(p['handled'] == true);
        return null;
      default:
        if (ApiDemoLocal.handles(method)) return _local.dispatch(method, p);
        if (ApiDemoPhone.handles(method)) return _phone.dispatch(method, p);
        throw ArgumentError('unknown method $method');
    }
  }

  Map<String, Object?> _info() {
    final active = ref.read(activeHostProvider);
    final ssh = ref.read(hostsProvider).ssh;
    final connected = ref.read(activeConnectionProvider).value != null;
    return {
      'appVersion': const String.fromEnvironment('API_DEMO_VERSION', defaultValue: '0.1.0'),
      'hosts': [
        {'id': 'local', 'label': '本机', 'sub': '这台设备上的引擎', 'status': active.isLocal ? (connected ? '运行中' : '未启动') : '', 'current': active.isLocal},
        for (final h in ssh)
          {
            'id': h.id,
            'label': h.name,
            'sub': 'SSH · ${h.user}@${h.host}',
            'status': active.kind == HostKind.ssh && active.id == h.id ? (connected ? '已连接' : '连接中') : '',
            'current': active.kind == HostKind.ssh && active.id == h.id,
          },
      ],
      'nativePages': [...pageLinkIds, ...apiDemoSessionPages],
      'voice': true,
      'notifications': true,
    };
  }

  Future<List<Map<String, Object?>>> _pickFiles(String sessionId, String accept) async {
    final picker = ref.read(attachmentPickerProvider);
    final picked = switch (accept) {
      'camera' => [?await picker.takePhoto()],
      'image' => await picker.pickImages(limit: 9),
      _ => await () async {
        final files = await picker.pickFiles();
        // Too large, too many: the picker says why in the person's language.
        if (files.attachments.isEmpty && files.problem != null) throw StateError(files.problem!);
        return files.attachments;
      }(),
    };
    final client = ref.read(activeConnectionProvider).value?.client;
    final out = <Map<String, Object?>>[];
    for (final a in picked) {
      if (a.isImage) {
        out.add({'kind': 'image', 'name': a.name, 'mimeType': a.mediaType, 'data': base64Encode(a.bytes), 'size': a.size});
      } else {
        if (client == null || sessionId.isEmpty) throw StateError('no connection');
        final receipt = await client.uploadFile(sessionId, a.bytes, name: a.name);
        out.add({'kind': 'file', 'name': a.name, 'receiptId': receipt.receiptId, 'size': a.size});
      }
    }
    return out;
  }

  /// The on-device rootfs, only while this phone's own engine is the host:
  /// DSH has no Remote that writes skills (dsh-Go's share import uses the same folder).
  Future<GuestFs> _localFs() async {
    if (!ref.read(activeHostProvider).isLocal) throw StateError('skills install to this phone only');
    final fs = await GuestFs.local();
    if (fs == null) throw StateError('the local runtime is not installed');
    return fs;
  }

  Future<List<String>> _installSkills(Object? raw) async {
    final skills = [for (final s in (raw as List? ?? const [])) SharedSkill.fromJson(s)]; // validates names, paths, sizes
    final fs = await _localFs();
    final backup = '${GuestFs.dshHome}/backups/api-demo-${DateTime.now().millisecondsSinceEpoch}';
    for (final skill in skills) {
      final existing = fs.dir('${GuestFs.skillsRoot}/${skill.name}');
      if (existing.existsSync()) {
        // A same-named skill the person had: keep a copy outside the skills root.
        final to = fs.dir('$backup/${skill.name}')..parent.createSync(recursive: true);
        existing.renameSync(to.path);
      }
      fs.writeSkill(skill);
    }
    return [for (final s in skills) s.name];
  }

  Future<void> _removeSkills(Object? raw) async {
    final fs = await _localFs();
    for (final name in (raw as List? ?? const []).whereType<String>()) {
      if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$').hasMatch(name)) continue;
      final folder = fs.dir('${GuestFs.skillsRoot}/$name');
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    }
  }

  Future<void> _switchHost(String id) async {
    final host = id == 'local' ? HostRef.local : HostRef.ssh(id);
    // ApiDemoHome rebuilds for the new host: a new proxy and a fresh page.
    ref.read(activeHostProvider.notifier).select(host);
  }

  Future<void> _openNativePage(String id, String? sessionId) async {
    Widget? page = pageForId(id, sessionId);
    if (page == null && sessionId != null && apiDemoSessionPages.contains(id)) {
      // dshgo:// links refuse pages that need a conversation; the bridge has one.
      for (final section in featureSections) {
        for (final item in section.items) {
          if (item.id == id && item.native != null) page = item.native!(sessionId);
        }
      }
    }
    if (page == null) throw ArgumentError('no native page $id');
    final ctx = context();
    if (!ctx.mounted) return;
    await Navigator.of(ctx).push(MaterialPageRoute<void>(builder: (_) => page!));
  }

  Future<String> _saveFile(String name, String mimeType, String data) async {
    final safe = name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}/$safe');
    await file.writeAsBytes(base64Decode(data));
    // The share sheet lets the person pick 「保存到文件」 or any app.
    await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: mimeType, name: safe)]));
    return file.path;
  }
}
