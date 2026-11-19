// API Demo — first run, drawn by the page (AGPL-3.0, API Demo patch set for dsh-Go).
//
// dsh-Go's RootGate still decides which first-run step is due and what each
// one leads to (patch 0006); with API Demo it publishes that here instead of
// showing its own OnboardingFlow, and the page (web/src/setup/) draws the
// step and calls back through the bridge (`setup.*`, bridge_local.dart).

import 'package:flutter/foundation.dart';

import '../ui/onboarding/onboarding_flow.dart' show OnboardingStep;

/// The page draws first run.
const apiDemoTakesSetup = true;

class ApiDemoSetupSpec {
  const ApiDemoSetupSpec({required this.step, required this.chooseRuntime, required this.beside, required this.actions});

  final OnboardingStep step;

  /// The runtime step asks 本机 or 远程主机 first.
  final bool chooseRuntime;

  /// The steps run beside an unpack (first run on this phone).
  final bool beside;

  /// RootGate's callbacks for this step, by name (welcomeDone, local,
  /// appearanceDone, accessDone, runtimeDone, keyDone, finished).
  final Map<String, VoidCallback> actions;

  Map<String, Object?> toJson() => {
    'step': step.name,
    'chooseRuntime': chooseRuntime,
    'beside': beside,
    'actions': actions.keys.toList(),
  };
}

/// The step due now; null once first run is over (or not running).
final apiDemoSetup = ValueNotifier<ApiDemoSetupSpec?>(null);
