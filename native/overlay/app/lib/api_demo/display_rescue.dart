// 页面显示不出来时的自救面板（华为 / 荣耀、老安卓的 WebView 白屏或卡住）。
// 由 Flutter 自己画，不依赖 WebView：WebView 一片空白时也看得见、点得动。
// 能看到这台手机的 WebView 版本、当前显示方式、页面有没有启动、页面报的错；能换显示方式重开、复制诊断信息。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// WebView 怎么放到屏幕上。auto：华为 / 荣耀和 Android 10 及以下用混合合成，其他用普通（纹理）。
enum WebDisplay { auto, texture, hybrid }

class WebDisplayPrefs {
  static const _mode = 'dsmo.webview.display';
  static const _confirmed = 'dsmo.webview.confirmed';

  static Future<WebDisplay> load() async {
    final p = await SharedPreferences.getInstance();
    return WebDisplay.values.asNameMap()[p.getString(_mode)] ?? WebDisplay.auto;
  }

  static Future<void> save(WebDisplay d) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_mode, d.name);
    // 换了显示方式：再确认一次画面正常
    await p.remove(_confirmed);
  }

  /// 用户说过「画面正常」：不再主动提示（自动检测到页面没启动时仍会弹）。
  static Future<bool> confirmed() async => (await SharedPreferences.getInstance()).getBool(_confirmed) ?? false;
  static Future<void> confirm() async => (await SharedPreferences.getInstance()).setBool(_confirmed, true);
}

/// 诊断信息（面板里显示，也能复制给开发者）。
class DisplayDiagnostics {
  DisplayDiagnostics({required this.mode, required this.hybrid, required this.alive, required this.device, required this.ua, required this.log, required this.page});

  final WebDisplay mode;
  final bool hybrid;
  final bool alive;
  final String device;
  final String? ua;
  final List<String> log;
  final String page;

  String get modeText => switch (mode) {
        WebDisplay.auto => '自动（${hybrid ? '混合合成' : '普通'}）',
        WebDisplay.texture => '普通（手动选的）',
        WebDisplay.hybrid => '混合合成（手动选的）',
      };

  /// UA 里的 WebView 内核版本，比如 Chrome/99.0.4844.88。
  String get webview {
    final u = ua ?? '';
    final m = RegExp(r'Chrome/([\d.]+)').firstMatch(u);
    final huawei = u.contains('HuaweiBrowser') || u.contains('HUAWEI') || u.contains('HONOR') ? '，华为内核' : '';
    return m == null ? (u.isEmpty ? '读不到' : u) : 'Chrome ${m.group(1)}$huawei';
  }

  String get text => [
        'DSMO 显示诊断',
        '显示方式：$modeText',
        '页面：${alive ? '已启动' : '没有启动'}（$page）',
        'WebView：$webview',
        '设备：$device',
        if (ua != null) 'UA：$ua',
        if (log.isNotEmpty) '页面报错：\n${log.join('\n')}',
      ].join('\n');
}

/// 页面上方的一个小提示：「画面空白？」（只在容易出问题的手机上、刚打开的一会儿里出现）。
class RescueChip extends StatelessWidget {
  const RescueChip({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.bottomCenter,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.only(bottom: 96),
          child: Material(
            color: Theme.of(context).colorScheme.inverseSurface,
            borderRadius: BorderRadius.circular(20),
            elevation: 3,
            child: InkWell(
              borderRadius: BorderRadius.circular(20),
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Text('画面空白或卡住了？点这里', style: TextStyle(color: Theme.of(context).colorScheme.onInverseSurface, fontSize: 14)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 自救面板。
class RescuePanel extends StatelessWidget {
  const RescuePanel({super.key, required this.info, required this.onSwitch, required this.onUpdate, required this.onReload, required this.onClose, required this.onFine});

  final DisplayDiagnostics info;
  final VoidCallback onSwitch;

  /// 马上检查界面更新，有就换上；返回要告诉用户的一句话。
  final Future<String> Function() onUpdate;
  final VoidCallback onReload;
  final VoidCallback onClose;
  final VoidCallback onFine;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final other = info.hybrid ? '普通' : '混合合成';
    Widget row(String k, String v) => Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 72, child: Text(k, style: t.bodySmall)),
            Expanded(child: Text(v, style: t.bodyMedium)),
          ]),
        );
    return ColoredBox(
      color: Theme.of(context).scaffoldBackgroundColor,
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
          children: [
            Text('页面显示不出来？', style: t.titleLarge),
            const SizedBox(height: 8),
            Text('有些手机（特别是华为、荣耀和较老的安卓）自带的网页组件显示有问题。可以先换一种显示方式试试；还不行就把诊断信息复制发给开发者。', style: t.bodyMedium),
            const SizedBox(height: 20),
            row('显示方式', info.modeText),
            row('页面', info.alive ? '已启动（页面代码在运行，只是可能没画出来）' : '没有启动（${info.page}）'),
            row('界面版本', info.page),
            row('网页组件', info.webview),
            row('设备', info.device),
            if (info.log.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text('页面报错', style: t.bodySmall),
              const SizedBox(height: 4),
              for (final l in info.log.take(6)) Text(l, style: t.bodySmall?.copyWith(fontFamily: 'monospace'), maxLines: 3, overflow: TextOverflow.ellipsis),
            ],
            const SizedBox(height: 24),
            FilledButton(onPressed: onSwitch, child: Text('换成「$other」显示方式，重新打开')),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: info.text));
                if (context.mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('诊断信息已复制，可以粘贴发给开发者')));
              },
              child: const Text('复制诊断信息'),
            ),
            const SizedBox(height: 8),
            _UpdateButton(onUpdate: onUpdate),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: onReload, child: const Text('重新加载页面')),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: TextButton(onPressed: onClose, child: const Text('先关掉'))),
              Expanded(child: TextButton(onPressed: onFine, child: const Text('画面正常，不再提示'))),
            ]),
          ],
        ),
      ),
    );
  }
}

/// 「检查界面更新」：下载要一会儿，按下后显示进度、不能连点。
class _UpdateButton extends StatefulWidget {
  const _UpdateButton({required this.onUpdate});

  final Future<String> Function() onUpdate;

  @override
  State<_UpdateButton> createState() => _UpdateButtonState();
}

class _UpdateButtonState extends State<_UpdateButton> {
  bool _busy = false;

  Future<void> _run() async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.maybeOf(context);
    String text;
    try {
      text = await widget.onUpdate();
    } on Object catch (e) {
      text = '没能检查更新：$e';
    }
    if (mounted) setState(() => _busy = false);
    messenger?.showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) => OutlinedButton(
        onPressed: _busy ? null : _run,
        child: Text(_busy ? '正在检查和下载界面…' : '检查界面更新'),
      );
}
