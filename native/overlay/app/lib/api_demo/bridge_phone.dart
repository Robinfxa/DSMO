// Bridge namespaces for round 6's pages (docs/bridge.md):
//
//   phoneBg.*    不打扰模式 (background operation through Shizuku, Sui, root or the
//                app's own wireless-debugging ADB), 自动恢复无障碍 and the action log
//                — dsh-Go's PhoneController (state/phone_state.dart)
//   shell.*      Android Shell — dsh-Go's AndroidShellChannel (phone/android_shell_channel.dart)
//   voiceModel.* 本机语音模型 — dsh-Go's VoiceModelController (state/voice_model_state.dart)
//
// The page draws everything; this file only reads state and calls the same
// controller methods dsh-Go's native pages call. Nothing here picks a channel,
// asks for a permission or runs su unless the page asked for exactly that
// (the native pages' rule). The risk notices (root, Android Shell) are shown
// by the page before it calls.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../phone/android_shell_channel.dart';
import '../state/phone_state.dart';
import '../state/voice_model_state.dart';
import '../ui/common/app_dialog.dart';
import '../ui/phone/action_log_page.dart' show phoneDecisionLabel;
import '../ui/phone/background_preview.dart';
import '../ui/phone/restricted_settings_guide.dart' show RomFamily;

class ApiDemoPhone {
  ApiDemoPhone({required this.ref, required this.context});

  final WidgetRef ref;
  final BuildContext Function() context;

  static const namespaces = ['phoneBg.', 'shell.', 'voiceModel.'];
  static bool handles(String method) => namespaces.any(method.startsWith);

  static const _shell = AndroidShellChannel();
  bool _previewOpen = false;

  PhoneController get _phone => ref.read(phoneProvider.notifier);

  Future<Object?> dispatch(String method, Map<String, Object?> p) async {
    switch (method) {
      // ------------------------------------------------------------ 不打扰模式
      case 'phoneBg.get':
        if (p['refresh'] == true) await _phone.refreshStatus();
        return _background();
      case 'phoneBg.use':
        return _result(await _phone.setPrivilegedMode(_mode(p['mode'])));
      case 'phoneBg.close':
        return _result(await _phone.setPrivilegedMode(PhonePrivilegedMode.off));
      case 'phoneBg.authorize':
        return _phone.requestPrivilegedPermission(_mode(p['mode']));
      case 'phoneBg.adbStartPairing':
        return _result(await _phone.adbStartPairing());
      case 'phoneBg.adbPair':
        return _result(await _phone.adbPair('${p['code'] ?? ''}', port: _port(p['port'])));
      case 'phoneBg.adbConnect':
        return _result(await _phone.adbConnect(port: _port(p['port'])));
      case 'phoneBg.setKeep':
        return _result(await _phone.setBackgroundKeep(_mode(p['mode']), p['value'] == true));
      case 'phoneBg.setParallel':
        return _result(await _phone.setBackgroundParallelLimit((p['limit'] as num?)?.toInt() ?? 1));
      case 'phoneBg.setViewport':
        final preset = p['preset'] == 'landscape' ? PhoneBackgroundViewport.landscape : PhoneBackgroundViewport.portrait;
        return _result(await _phone.setBackgroundViewport(preset));
      case 'phoneBg.setPreview':
        return _phone.setBackgroundPreview(p['value'] == true);
      case 'phoneBg.preview':
        await _preview((p['taskId'] as num).toInt());
        return null;
      // 自动恢复无障碍 (dsh-Go's A11yRestoreSheet)
      case 'phoneBg.grantSecure':
        return _result(await _phone.grantSecureSettings());
      case 'phoneBg.prepareRoot':
        return _result(await _phone.prepareRoot());
      // 最近的操作 (never screen contents)
      case 'phoneBg.log':
        await _phone.refreshLog(limit: 100);
        return [
          for (final e in ref.read(phoneProvider).log)
            {
              'time': e.time?.millisecondsSinceEpoch,
              'tool': e.tool.replaceFirst('mcp__phone__', ''),
              'app': e.app,
              'summary': e.summary,
              'decision': e.decision.name,
              'label': phoneDecisionLabel(e),
            },
        ];

      // ------------------------------------------------------------ Android Shell
      case 'shell.get':
        return _shellStatus(await _shell.status());
      case 'shell.configure':
        final backend = p['backend'] == 'adb' ? AndroidShellBackend.adb : AndroidShellBackend.shizuku;
        if (p['enabled'] == true) {
          final s = ref.read(phoneProvider);
          if (!s.loaded || !s.status.ready || !s.status.enabled) return {'ok': false, 'errorCode': 'disabled'};
        }
        return _shellResult(await _shell.configure(enabled: p['enabled'] == true, backend: backend));
      case 'shell.requestPermission':
        final ok = await _shell.requestPermission();
        return {'ok': ok, if (!ok) 'errorCode': 'permissionRequired'};
      case 'shell.startPairing':
        return _shellResult(await _shell.startPairing());
      case 'shell.pair':
        return _shellResult(await _shell.pair('${p['code'] ?? ''}', port: _port(p['port'])));
      case 'shell.connect':
        return _shellResult(await _shell.connect(port: _port(p['port'])));
      case 'shell.stop':
        return _shell.stop();

      // ------------------------------------------------------------ 本机语音模型
      case 'voiceModel.get':
        if (p['refresh'] == true) await ref.read(voiceModelProvider.notifier).refresh();
        return _voiceModel();
      case 'voiceModel.metered':
        return ref.read(voiceModelProvider.notifier).metered();
      case 'voiceModel.download':
        final c = ref.read(voiceModelProvider.notifier);
        unawaited(p['again'] == true ? c.redownload() : c.download());
        return null;
      case 'voiceModel.cancel':
        await ref.read(voiceModelProvider.notifier).cancel();
        return null;
      case 'voiceModel.delete':
        return ref.read(voiceModelProvider.notifier).delete();
    }
    throw ArgumentError('unknown method $method');
  }

  static PhonePrivilegedMode _mode(Object? wire) => PhonePrivilegedMode.tryParse(wire) ?? PhonePrivilegedMode.off;

  static int? _port(Object? v) {
    final n = v is num ? v.toInt() : int.tryParse('${v ?? ''}'.trim());
    return n != null && n > 0 && n < 65536 ? n : null;
  }

  static Map<String, Object?> _result(PhoneResult r) => {'ok': r.ok, 'reason': r.reason, 'pending': r.pending};

  Map<String, Object?> _background() {
    final s = ref.read(phoneProvider);
    final st = s.status;
    final bg = st.background;
    final keeper = st.a11yKeeper;
    final privileged = bg.privileged;
    final grantPath = privileged?.grantPath ?? keeper.path;
    final rootLost = grantPath == 'setup' && (privileged?.rootSelected ?? false);
    final modern = bg.parallelism != null || st.task.backgroundSlot != null || st.tasks.any((t) => t.backgroundSlot != null);
    final previewTasks = (modern ? st.tasks : [st.task]).where(
      (t) => t.active && t.id != null && t.id! > 0 && (!modern || t.backgroundSlot == true),
    );
    final cap = bg.parallelism;
    return {
      'loaded': s.loaded,
      'ready': st.ready,
      'enabled': st.enabled,
      'androidOk': bg.androidOk,
      'mode': bg.effectiveMode.name,
      'channelReady': bg.effectiveReady,
      'reason': bg.effectiveReason,
      'supportedModes': [for (final m in bg.supportedModes) m.name],
      'privileged': privileged != null,
      'shizuku': {
        'provider': bg.shizuku.provider,
        // The Shizuku app (or a binder it serves), not Sui speaking its interface.
        'installed': bg.shizuku.provider == 'shizuku' || (bg.shizuku.appInstalled ?? bg.shizuku.installed),
        'running': bg.shizuku.running,
        'granted': bg.shizuku.granted,
      },
      'root': {'checked': bg.root.checked, 'connected': bg.root.connected, 'starting': bg.root.starting},
      'adb': {'paired': bg.adb.paired, 'connected': bg.adb.connected},
      'keep': {'enabled': bg.keep.enabled, 'phase': bg.keep.phase.name, 'reasonCode': bg.keep.reasonCode},
      'parallel': cap == null
          ? null
          : {'configured': cap.configuredLimit, 'effective': cap.effectiveLimit, 'held': cap.heldSlots, 'reason': cap.reason},
      'viewport': bg.viewport?.name,
      'preview': {
        'available': bg.previewVersion == 1,
        'enabled': bg.previewEnabled,
        'slots': modern,
        'tasks': [
          for (final t in previewTasks) {'id': t.id, 'app': t.app},
        ],
      },
      'device': {'sdk': st.device.sdkInt, 'xiaomi': RomFamily.of(st.device.manufacturer) == RomFamily.xiaomi},
      'a11yKeeper': {
        'granted': keeper.granted,
        'path': grantPath,
        'command': keeper.command,
        'rootLost': rootLost,
        'offerRoot': grantPath == 'setup' && !rootLost && bg.supportedModes.contains(PhonePrivilegedMode.root),
      },
    };
  }

  /// dsh-Go's live preview of the hidden screen, over the page (frames stay on the phone).
  Future<void> _preview(int taskId) async {
    final status = ref.read(phoneProvider).status;
    if (_previewOpen || !status.ready || !status.background.previewEnabled) return;
    final ctx = context();
    if (!ctx.mounted) return;
    _previewOpen = true;
    try {
      await showAppDialog<void>(
        context: ctx,
        builder: (_) => Consumer(
          builder: (_, ref, _) => PhoneBackgroundPreviewDialog(
            channel: ref.read(phoneChannelProvider),
            taskId: taskId,
            enabled: ref.watch(phoneProvider.select((s) => s.status.ready)),
          ),
        ),
      );
    } finally {
      _previewOpen = false;
    }
  }

  static Map<String, Object?> _shellStatus(AndroidShellStatus s) => {
    'supported': s.supported,
    'enabled': s.enabled,
    'backend': s.backend.name,
    'ready': s.ready,
    'uid': s.uid,
    'reasonCode': s.reasonCode,
    'shizuku': {'installed': s.shizuku.installed, 'running': s.shizuku.running, 'granted': s.shizuku.granted},
    'adb': {'paired': s.adb.paired, 'connected': s.adb.connected},
    'limits': s.limits,
  };

  static Map<String, Object?> _shellResult(AndroidShellResult r) => {'ok': r.ok, 'errorCode': r.ok ? null : r.errorCode ?? 'invalidResponse'};

  Map<String, Object?> _voiceModel() {
    final m = ref.read(voiceModelProvider);
    return {
      'status': m.status.name,
      'doneBytes': m.doneBytes,
      'totalBytes': m.totalBytes,
      'failure': m.failure?.name,
      'neededBytes': m.neededBytes,
      'wanted': m.wanted,
    };
  }
}
