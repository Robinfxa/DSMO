// API Demo — voice input for the page (AGPL-3.0, API Demo patch set for dsh-Go).
//
// Android's WebView has no speech recognition, so the page asks the app. This
// reuses dsh-Go's own dictation (VoiceInputController: system / on-device /
// cloud recognizer, the same choices as 设置 › 语音) on a private text field
// and streams that field's text back to the page.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../speech/voice_cloud.dart';
import '../state/account_state.dart';
import '../state/android_features.dart';
import '../state/connection_state.dart';
import '../state/hosts_state.dart';
import '../state/streaming_asr_state.dart';
import '../state/streaming_pcm_state.dart';
import '../state/voice_model_state.dart';
import '../state/voice_settings.dart';
import '../state/voice_state.dart';
import '../ui/chat/voice/voice_controller.dart';
import '../voice/live_words.dart';
import '../voice/live_words_model.dart';
import '../voice/streaming_pcm.dart';

class ApiDemoDictation {
  ApiDemoDictation({required this.ref, required this.onWords, required this.onDone, required this.onError});

  final WidgetRef ref;
  final void Function(String text) onWords;
  final void Function(String text) onDone;
  final void Function(String message) onError;

  final _field = TextEditingController();
  VoiceInputController? _voice;
  bool _finished = false;

  Future<void> start() async {
    _field.addListener(() => onWords(_field.text));
    final voice = _voice = VoiceInputController(
      input: _field,
      bridge: ref.read(voiceBridgeProvider),
      mode: () async {
        final mode = await ref.read(voiceSettingsProvider.notifier).ready();
        return ref.read(harmonyLocalVoiceProvider) ? voiceModeOnHarmonyLocal(mode) : mode;
      },
      harmony: () => ref.read(operatingSystemProvider) == 'ohos',
      cloud: (mode) => ref.read(voiceCloudProvider)(mode),
      cloudLikely: () => ref.read(voiceCloudLikelyProvider)(),
      signedIn: () => ref.read(accountProvider).signedIn,
      liveWords: (words) async {
        try {
          final chosen = await liveWordsModel(ref);
          if (chosen == null) return null;
          final live = LiveWords(ref.read(streamingPcmCaptureProvider), ref.read(streamingAsrProvider), chosen.model, StreamingPcmSource.dictation, words, trial: chosen.trial);
          await live.start();
          return live;
        } on Object {
          return null;
        }
      },
      modelReady: () => (ref.read(activeConnectionProvider).value?.isLocal ?? false) && ref.read(voiceModelProvider).status == VoiceModelStatus.ready,
      client: () => ref.read(activeConnectionProvider).value?.client,
      inputOwner: () => ref.read(activeHostProvider),
    );
    // What the controller would show under the composer (no microphone
    // permission, no recognizer, …): the page shows it as the error.
    String? said;
    voice.onMessage = (message) => said = message.text;
    // The controller also notifies while idle (its capability probe), so only
    // an idle that follows a run is the end of this dictation.
    var ran = false;
    voice.addListener(() {
      if (voice.active) {
        ran = true;
        return;
      }
      if (!ran || _finished) return;
      // Back to idle after a stop: the field holds the final text.
      _finished = true;
      if (_field.text.isEmpty && said != null) {
        onError(said!);
      } else {
        onDone(_field.text);
      }
    });
    try {
      await voice.refresh();
      if (!voice.available) throw StateError('语音输入不可用：到「设置 › 语音」里选一个识别方式');
      await voice.start();
      // start() returned without ever leaving idle (the app is not in front).
      if (!ran && !voice.active && !_finished) {
        _finished = true;
        onError(said ?? '语音输入没能开始');
      }
    } on Object catch (e) {
      _finished = true;
      onError(e is StateError ? e.message : '语音输入没能开始');
    }
  }

  Future<void> stop() async => _voice?.stop();

  Future<void> cancel() async {
    _finished = true;
    await _voice?.cancel();
    _voice?.dispose();
    _field.dispose();
  }
}
