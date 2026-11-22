// API Demo — the app-local half of the bridge (AGPL-3.0, API Demo patch set
// for dsh-Go). Round 2 of docs/native-pages.md: the pages for things that live
// on the phone, not on the DSH Host, are web pages now; they read and change
// that state through these calls, which go straight to dsh-Go's own
// controllers. No logic is re-implemented here: every call is one controller
// method, so dsh-Go's rules (secrets in the secure store, host keys pinned on
// first use, the runtime's own state machine) stay where they are.
//
// Methods are namespaced: hosts.* engine.* notify.* voiceMode.* update.*
// access.* phone.* share.* (round 3: the on-device engine's files a share code
// reads and writes, as dsh-Go's share import does). Wire format: docs/bridge.md.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/l10n.dart';
import '../performance/performance_state.dart';
import '../runtime/local_footprint.dart';
import '../state/engine_control.dart';
import '../state/onboarding_state.dart';
import '../state/safe_mode_state.dart';
import '../ui/engine/engine_status.dart' show isLocalStartupFailure;
import '../ui/onboarding/setup_progress.dart';
import '../ui/safe_mode/engine_failure_card.dart';
import '../ui/safe_mode/safe_mode_actions.dart';
import '../ui/safe_mode/safe_mode_card.dart' show safeModeReasonText;
import '../usage/usage_net.dart' show UsageBuild;
import '../usage/usage_stats.dart';
import 'api_demo_setup.dart';
import '../remote/ssh/ssh_link.dart';
import '../runtime/runtime_bridge.dart';
import '../share_code/guest_fs.dart';
import '../share_code/restore_point.dart';
import '../share_code/share_models.dart' show SharedSkill;
import '../runtime/runtime_state.dart';
import '../state/access_state.dart';
import '../state/connection_state.dart' show sshTransportFactoryProvider;
import '../state/hosts_state.dart';
import '../state/notify_state.dart';
import '../state/phone_state.dart';
import '../state/settings_state.dart';
import '../state/update_state.dart';
import '../state/voice_settings.dart';

class ApiDemoLocal {
  ApiDemoLocal({required this.ref, required this.event, required this.container}) {
    apiDemoSetup.addListener(_setupChanged);
  }

  final WidgetRef ref;

  /// The app's container, for dsh-Go's EngineControl flows.
  final ProviderContainer Function() container;

  void _setupChanged() => unawaited(event('setup.changed', apiDemoSetup.value?.toJson()));

  /// App → page event (`window.__apiDemo.event`).
  final Future<void> Function(String name, Object? payload) event;

  final _hostKeyAnswers = <String, Completer<bool>>{};
  SshHostLink? _test;
  var _seq = 0;

  static const namespaces = ['hosts.', 'engine.', 'notify.', 'voiceMode.', 'update.', 'access.', 'phone.', 'share.', 'setup.'];
  static bool handles(String method) => namespaces.any(method.startsWith);

  void dispose() {
    apiDemoSetup.removeListener(_setupChanged);
    for (final c in _hostKeyAnswers.values) {
      if (!c.isCompleted) c.complete(false);
    }
    unawaited(_test?.close());
  }

  Future<Object?> dispatch(String method, Map<String, Object?> p) async {
    switch (method) {
      // ------------------------------------------------------------ 远程主机
      case 'hosts.list':
        final hosts = ref.read(hostsProvider.notifier);
        await hosts.ready;
        final active = ref.read(activeHostProvider);
        return {
          'active': {'kind': active.kind.name, 'id': active.id},
          'ssh': [for (final h in ref.read(hostsProvider).ssh) h.toJson()],
          'autoConnect': ref.read(remoteAutoConnectProvider),
        };
      case 'hosts.save':
        final config = _config(p['config']);
        // Blank secrets on an edit keep what is stored (the page never sees them).
        final secrets = _secrets(p['secrets']);
        final ok = await ref.read(hostsProvider.notifier).saveSsh(config, secrets: secrets);
        if (!ok) throw StateError('could not save the host');
        return config.toJson();
      case 'hosts.remove':
        await ref.read(hostsProvider.notifier).removeSsh(_str(p['id']));
        return null;
      case 'hosts.setAutoConnect':
        await ref.read(remoteAutoConnectProvider.notifier).set(p['value'] == true);
        return null;
      case 'hosts.test':
        return _testHost(p);
      case 'hosts.cancelTest':
        await _test?.close();
        return null;
      case 'hosts.hostKeyAnswer':
        _hostKeyAnswers.remove(_str(p['requestId']))?.complete(p['ok'] == true);
        return null;

      // ------------------------------------------------------------ 本机引擎
      case 'engine.status':
        final s = ref.read(localRuntimeProvider);
        final st = s.status;
        final progress = s.progress;
        return {
          'available': s.available,
          'phase': st.phase.name,
          'busy': st.phase.isBusy,
          'mode': st.mode.name,
          'safeState': st.safeState.name,
          'installedVersion': st.installedVersion,
          'bundledVersion': st.bundledVersion,
          'dshVersion': st.dshVersion,
          'nodeVersion': st.nodeVersion,
          'abi': st.abi,
          'error': st.error,
          'networkBlocked': st.networkBlocked,
          if (progress != null) 'progress': {'step': progress.step, 'done': progress.done, 'total': progress.total},
          'autoStart': ref.read(settingsProvider).autoStartLocal,
          'startupFailure': isLocalStartupFailure(st),
          'failure': await _failureCard(st),
          'safe': {
            'on': st.inSafeMode,
            'probation': st.onProbation,
            'reason': st.inSafeMode ? safeModeReasonText(st) : null,
            'auto': st.autoSafe,
          },
          // The account sign-in's callback goes to the engine itself (account/startSignIn).
          'loopback': st.isRunning ? st.baseUrl : null,
        };
      case 'engine.recover':
        return _recover(_str(p['action']), p);
      case 'engine.preflight':
        return [
          for (final h in await ref.read(runtimeBridgeProvider).safePreflight())
            {'path': h.path, 'kind': h.kind, 'detail': h.detail},
        ];
      case 'engine.lastKnownGood':
        final lkg = await ref.read(runtimeBridgeProvider).lastKnownGood();
        return {'available': lkg.available, 'useful': lkg.useful, 'text': lkg.useful ? SafeModeActions.describeRestore(lkg) : null};
      case 'engine.failureLog':
        var lines = await ref.read(runtimeBridgeProvider).failureLog();
        if (lines.isEmpty) {
          final logs = ref.read(localRuntimeLogsProvider);
          lines = logs.length > 300 ? logs.sublist(logs.length - 300) : logs;
        }
        return lines;
      case 'engine.setAutoSafe':
        await ref.read(runtimeBridgeProvider).setAutoSafe(p['value'] == true);
        return null;
      case 'engine.repairPrompt':
        return repairPrompt(ref.read(localRuntimeProvider).status);
      case 'engine.start':
        await ref.read(localRuntimeProvider.notifier).start();
        return null;
      case 'engine.stop':
        await ref.read(localRuntimeProvider.notifier).stop();
        return null;
      case 'engine.restart':
        // Starts again in the current mode (dsh-Go's 重试).
        return EngineControl.restart(container());
      case 'engine.install':
        await ref.read(localRuntimeProvider.notifier).install();
        return null;
      case 'engine.logs':
        final lines = ref.read(localRuntimeLogsProvider);
        final n = (p['limit'] as num?)?.toInt() ?? 300;
        return lines.length > n ? lines.sublist(lines.length - n) : lines;
      case 'engine.setAutoStart':
        await ref.read(settingsProvider.notifier).setAutoStartLocal(p['value'] == true);
        return null;
      case 'engine.reset':
        // Deletes the conversations (.dsh/sessions) and plugin data (.dsh/storages): dsh-Go's
        // ResetKeep only offers ui+skills and plugins+settings. What else to keep comes from the page.
        await ref
            .read(localRuntimeProvider.notifier)
            .resetKeeping(ResetKeep(uiAndSkills: p['keepSkills'] != false, pluginsAndSettings: p['keepPlugins'] == true));
        return null;

      // ------------------------------------------------------------ 通知
      case 'notify.get':
        final prefs = ref.read(notifyPrefsProvider);
        ref.invalidate(notifySystemStatusProvider);
        final sys = await ref.read(notifySystemStatusProvider.future);
        return {
          'enabled': prefs.enabled,
          'done': prefs.done,
          'failed': prefs.failed,
          'approval': prefs.approval,
          'question': prefs.question,
          'live': prefs.live,
          'system': {'native': sys.native, 'enabled': sys.enabled, 'done': sys.done, 'attention': sys.attention},
        };
      case 'notify.set':
        final c = ref.read(notifyPrefsProvider.notifier);
        final v = p['value'] == true;
        await switch (_str(p['key'])) {
          'enabled' => c.setEnabled(v),
          'done' => c.setDone(v),
          'failed' => c.setFailed(v),
          'approval' => c.setApproval(v),
          'question' => c.setQuestion(v),
          'live' => c.setLive(v),
          final k => throw ArgumentError('unknown key $k'),
        };
        return null;
      case 'notify.requestPermission':
        return ref.read(notifyChannelProvider).requestPermission();
      case 'notify.openSettings':
        return ref.read(notifyChannelProvider).openSettings(channel: p['channel'] as String?);

      // ------------------------------------------------------------ 语音识别方式
      case 'voiceMode.get':
        return (await ref.read(voiceSettingsProvider.notifier).ready()).name;
      case 'voiceMode.set':
        final mode = VoiceMode.values.firstWhere((m) => m.name == p['mode'], orElse: () => throw ArgumentError('mode'));
        await ref.read(voiceSettingsProvider.notifier).setMode(mode);
        return null;

      // ------------------------------------------------------------ 更新
      case 'update.get':
        final u = ref.read(appUpdateProvider);
        final latest = u.latest;
        return {
          'current': u.current.name,
          'installable': u.installable,
          'noticeOnly': u.noticeOnly,
          'autoCheck': u.autoCheck,
          'check': u.check.name,
          'task': u.task.name,
          'received': u.received,
          'total': u.total,
          'problem': u.problem?.name,
          'lastCheckedAt': u.lastCheckedAt?.toIso8601String(),
          'skippedVersion': u.skippedVersion,
          if (latest != null) 'latest': {'version': latest.version.name, 'tag': latest.tag, 'notes': latest.notes},
        };
      case 'update.check':
        return (await ref.read(appUpdateProvider.notifier).check()).name;
      case 'update.autoCheck':
        // The daily automatic check (dsh-Go's UpdateLaunchCheck); true when a version not skipped waits.
        return ref.read(appUpdateProvider.notifier).autoCheckIfDue();
      case 'update.download':
        unawaited(ref.read(appUpdateProvider.notifier).startDownload());
        return null;
      case 'update.cancel':
        ref.read(appUpdateProvider.notifier).cancelDownload();
        return null;
      case 'update.install':
        await ref.read(appUpdateProvider.notifier).install();
        return null;
      case 'update.requestPermission':
        // The system's 「安装未知应用」 switch for this app; coming back resumes the install (onAppResumed).
        await ref.read(appUpdateProvider.notifier).requestInstallPermission();
        return null;
      case 'update.skip':
        await ref.read(appUpdateProvider.notifier).skipLatest();
        return null;
      case 'update.setAutoCheck':
        await ref.read(appUpdateProvider.notifier).setAutoCheck(p['value'] == true);
        return null;

      // ------------------------------------------------------------ 系统权限
      case 'access.get':
        final r = await ref.read(accessReadingsProvider.notifier).refresh();
        return {for (final item in AccessItem.values) item.name: r.granted(item)};
      case 'access.open':
        final item = AccessItem.values.firstWhere((i) => i.name == p['item'], orElse: () => throw ArgumentError('item'));
        await ref.read(accessVisitedProvider.notifier).mark(item);
        return ref.read(accessDriverProvider).open(item);
      case 'access.openAppInfo':
        return ref.read(accessDriverProvider).openAppInfo();

      // ------------------------------------------------------------ 手机操控
      case 'phone.get':
        final c = ref.read(phoneProvider.notifier);
        await c.refresh();
        final s = ref.read(phoneProvider);
        final st = s.status;
        return {
          'loaded': s.loaded,
          'disclosureAccepted': s.disclosureAccepted,
          'toggling': s.toggling,
          'ready': st.ready,
          'error': st.error,
          'enabled': st.enabled,
          'a11y': {'enabled': st.a11y.enabled, 'connected': st.a11y.serviceConnected},
          'overlay': st.overlay,
          'notifications': st.notifications,
          'busy': st.anyTaskBusy,
          'tasks': st.tasks.length,
        };
      case 'phone.acceptDisclosure':
        await ref.read(phoneProvider.notifier).acceptDisclosure();
        return null;
      case 'phone.setEnabled':
        final r = await ref.read(phoneProvider.notifier).setEnabled(p['value'] == true);
        return {'ok': r.ok, 'restarting': r.restarting};
      case 'phone.openAccessibility':
        return ref.read(phoneProvider.notifier).openAccessibilitySettings();
      case 'phone.testScreen':
        final r = await ref.read(phoneProvider.notifier).testScreen();
        return {'ok': r.ok, 'text': r.text, 'reason': r.reason};
      case 'phone.stopTask':
        return ref.read(phoneProvider.notifier).stopTask();

      // ------------------------------------------------------------ 首次启动 (api_demo_setup.dart, patch 0006)
      case 'setup.get':
        return _setupState();
      case 'setup.do':
        final action = apiDemoSetup.value?.actions[_str(p['action'])];
        if (action == null) throw StateError('not a step action now');
        action();
        return null;
      case 'setup.install':
        ref.read(installEtaProvider);
        await ref.read(runtimeInstallProvider.notifier).install();
        return null;
      case 'setup.setApiKey':
        await ref.read(settingsProvider.notifier).setApiKey(_str(p['key']));
        await ref.read(onboardingPrefsProvider.notifier).setKeySkipped(false);
        return null;
      case 'setup.skipKey':
        await ref.read(onboardingPrefsProvider.notifier).setKeySkipped(true);
        return null;
      case 'setup.startEngine':
        // The sign-in needs the engine as soon as the runtime is there.
        await EngineControl.ensureStarted(container());
        return null;
      case 'setup.setUsage':
        await ref.read(usageStatsProvider.notifier).setEnabled(p['value'] == true);
        return null;
      case 'setup.usageNoticed':
        await ref.read(usageStatsProvider.notifier).markNoticed();
        return null;
      case 'setup.setTheme':
        await ref.read(settingsProvider.notifier).setThemeMode(switch (p['mode']) {
          'light' => ThemeMode.light,
          'dark' => ThemeMode.dark,
          _ => ThemeMode.system,
        });
        return null;

      // ------------------------------------------------------------ 分享码 (the on-device engine's own files)
      case 'share.localFiles':
        final fs = await _guest();
        return {
          'skills': [
            for (final s in await fs.readUserSkills()) {'name': s.name, 'description': s.description, 'files': s.skill.files},
          ],
          'agentsMd': await fs.readUserAgentsMd(),
        };
      case 'share.readSkill':
        final bytes = (await _guest()).readSkillForImport(_str(p['name']));
        return bytes?.map((path, value) => MapEntry(path, utf8.decode(value)));
      case 'share.readAgentsMd':
        return (await _guest()).readImportedAgentsMd();
      case 'share.pinRestorePoint':
        return RestorePoint(await _guest()).pinCurrentProfile(now: DateTime.now());
      case 'share.writeSkill':
        final fs = await _guest();
        final point = RestorePoint(fs);
        // The same folder and backup as dsh-Go's share import (validated as a share code is).
        point.replaceSkill(point.backupDir(DateTime.now()), SharedSkill.fromJson(p['skill']));
        return null;
      case 'share.writeAgentsMd':
        final fs = await _guest();
        final point = RestorePoint(fs);
        await point.backupAgentsMd(point.backupDir(DateTime.now()));
        await fs.writeImportedAgentsMd(_str(p['text']));
        return null;
    }
    throw ArgumentError('unknown method $method');
  }

  // ------------------------------------------------------------ helpers

  /// The engine-page / home failure card, as dsh-Go words it (FailureCardModel); null when none shows.
  Future<Map<String, Object?>?> _failureCard(RuntimeStatus st) async {
    final failure = st.failure;
    if (failure == null || !EngineFailureCard.visibleFor(st)) return null;
    var lkgUseful = false;
    if ((failure.kind.isFatal || failure.causeUnknown) && !failure.safeMode) {
      try {
        lkgUseful = (await ref.read(runtimeBridgeProvider).lastKnownGood()).useful;
      } on Object {
        // Not offered.
      }
    }
    final model = FailureCardModel.of(failure, lkgUseful: lkgUseful, held: !EngineControl.shouldAutoStart(st));
    return {
      'kind': failure.kind.name,
      'title': model.title,
      'body': model.body,
      'detail': model.detail,
      'culprits': model.culprits,
      'tone': model.tone.name,
      'primary': {'id': model.primary.name, 'label': model.primary.label},
      'secondary': [
        for (final a in model.secondary) {'id': a.name, 'label': a.label},
      ],
    };
  }

  /// The failure card's and the safe-mode section's actions; confirmations are the page's.
  Future<Object?> _recover(String action, Map<String, Object?> p) async {
    final c = container();
    try {
      switch (action) {
        case 'retry':
          await EngineControl.restart(c);
        case 'startNormal':
        case 'leaveSafe':
          await EngineControl.leaveSafeMode(c);
        case 'enterSafe':
          await EngineControl.enterSafeMode(c, moveAside: [for (final x in (p['moveAside'] as List?) ?? const []) '$x']);
        case 'restoreLkg':
          await EngineControl.restoreLastKnownGood(c);
        case 'dismiss':
          await ref.read(runtimeBridgeProvider).clearFailure();
        default:
          throw ArgumentError('unknown recovery $action');
      }
    } on PlatformException catch (e) {
      throw StateError(switch (e.code) {
        'runtime_not_stopped' => appL10n.phoneSafeStopIncomplete,
        'runtime_not_stopped_after_recovery' => appL10n.phoneSafeRestartIncomplete,
        _ => appL10n.commonFailedTryAgain,
      });
    }
    return null;
  }

  Future<Map<String, Object?>> _setupState() async {
    final spec = apiDemoSetup.value;
    final s = ref.read(localRuntimeProvider);
    final progress = s.progress;
    final eta = ref.read(installEtaProvider);
    LocalFootprint? footprint;
    try {
      footprint = await ref.read(localFootprintProvider.future);
    } on Object {
      // Figures unknown.
    }
    final available = s.available;
    final String localDetail;
    var localWarn = false;
    if (!available) {
      localDetail = appL10n.localEnvUnavailable;
    } else if (footprint != null && footprint.lowStorage) {
      localDetail = appL10n.localEnvLowStorage(footprint.requiredRoundedMb!);
      localWarn = true;
    } else if (footprint?.unpackedMb case final unpacked?) {
      localDetail = appL10n.localEnvThisPhoneDetail(LocalFootprint.round(unpacked), LocalFootprint.engineMemoryMb);
    } else {
      localDetail = appL10n.localEnvThisPhoneDetailShort(LocalFootprint.engineMemoryMb);
    }
    final prefs = ref.read(onboardingPrefsProvider);
    final settings = ref.read(settingsProvider);
    return {
      'spec': spec?.toJson(),
      'runtime': {
        'setup': ref.read(setupRuntimeProvider).name,
        'phase': s.status.phase.name,
        'error': s.status.error,
        if (progress != null) 'progress': {'step': progress.step, 'done': progress.done, 'total': progress.total},
        if (eta != null) 'etaSeconds': eta.inSeconds,
        'upgrade': s.status.installedVersion != null && s.status.installedVersion != s.status.bundledVersion,
      },
      'local': {
        'available': available,
        'detail': localDetail,
        'warn': localWarn,
        'suggestRemote': !available || ref.read(performanceDefaultsProvider).recommendRemote || (footprint?.suggestRemote ?? false),
      },
      // DSMO sends no statistics unless a build names its own endpoint (patch 0009).
      'usage': {'enabled': ref.read(usageStatsProvider).enabled, 'available': UsageBuild.active},
      'connected': settings.hasModelAccess || prefs.keySkipped,
      'hasApiKey': settings.hasApiKey,
      'theme': settings.themeMode.name,
    };
  }

  /// The on-device engine's files; only while it is the host the page talks to.
  Future<GuestFs> _guest() async {
    if (!ref.read(activeHostProvider).isLocal) throw StateError('只能读写本机引擎的文件');
    final fs = await GuestFs.local();
    if (fs == null) throw StateError('本机引擎还没有安装');
    return fs;
  }

  String _str(Object? v) => v is String ? v : throw ArgumentError('expected text');

  SshHostConfig _config(Object? raw) {
    final m = (raw as Map?)?.cast<String, Object?>() ?? const {};
    final withId = {...m, 'id': (m['id'] is String && (m['id'] as String).isNotEmpty) ? m['id'] : SshHostConfig.newId()};
    return SshHostConfig.fromJson(withId) ?? (throw ArgumentError('host and user are required'));
  }

  SshSecrets? _secrets(Object? raw) {
    final m = (raw as Map?)?.cast<String, Object?>();
    if (m == null) return null;
    String? s(String k) => (m[k] is String && (m[k] as String).isNotEmpty) ? m[k] as String : null;
    final secrets = SshSecrets(password: s('password'), privateKey: s('privateKey'), passphrase: s('passphrase'), attachToken: s('attachToken'));
    final any = secrets.password != null || secrets.privateKey != null || secrets.attachToken != null;
    return any ? secrets : null;
  }

  /// 测试连接, as the native form does it: a throwaway link; the host key is
  /// asked about on the page (event `hosts.hostKey`, answer `hosts.hostKeyAnswer`)
  /// and comes back to be pinned when the host is saved.
  Future<Object?> _testHost(Map<String, Object?> p) async {
    await _test?.close();
    final config = _config(p['config']);
    final given = _secrets(p['secrets']);
    final stored = await ref.read(hostsProvider.notifier).loadSecrets(config.id);
    final secrets = given ?? stored;
    String? keyType, keyFingerprint;
    final link = SshHostLink(
      config: config,
      loadSecrets: () async => secrets,
      promptHostKey: (prompt) {
        final id = 'k${++_seq}';
        final answer = Completer<bool>();
        _hostKeyAnswers[id] = answer;
        unawaited(event('hosts.hostKey', {
          'requestId': id,
          'hostName': prompt.hostName,
          'address': prompt.address,
          'type': prompt.key.shortType,
          'fingerprint': prompt.key.fingerprint,
        }));
        return answer.future.timeout(const Duration(minutes: 5), onTimeout: () => false);
      },
      pinHostKey: (key) async {
        keyType = key.type;
        keyFingerprint = key.fingerprint;
      },
      transportFactory: ref.read(sshTransportFactoryProvider),
      retryFirstOpen: false,
    );
    _test = link;
    final sub = link.statuses.listen((s) {
      if (s.phase == HostLinkPhase.idle) return;
      unawaited(event('hosts.testStatus', {
        'phase': s.phase.name,
        'step': s.step?.name,
        'completed': [for (final c in s.completed) c.name],
        'detail': s.detail,
        if (s.error != null) 'error': s.error!.message,
      }));
    });
    try {
      await link.open();
      return {'ok': true, 'keyType': keyType ?? config.hostKeyType, 'keyFingerprint': keyFingerprint ?? config.hostKeyFingerprint};
    } catch (e) {
      return {'ok': false, 'error': '$e'};
    } finally {
      await sub.cancel();
      if (identical(_test, link)) _test = null;
      // The remote dsh keeps running for the real connection; only the test closes.
      await link.close();
    }
  }
}
