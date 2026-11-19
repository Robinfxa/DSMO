#!/usr/bin/env python3
"""Renames the app in dsh-Go's user-visible strings: "DSH Go" -> "DSMO".

    python3 native/brand/rename_strings.py <path-to-dsh-go>

Used to make native patch 0008; rerun it on a new dsh-Go base and regenerate the patch
instead of merging string edits by hand. Touches:

- app/lib/l10n/parts/*_{zh,en}.arb, the string sources; then app/tool/l10n_merge.py
  --no-gen writes app_{zh,en}.arb. The generated app/lib/l10n/gen/*.dart get the same
  edit here (flutter regenerates them on build anyway: pubspec has `generate: true`);
- app/android/app/src/main/res/values*/ strings;
- the Kotlin notification titles that spell the name out.

Strings that must keep naming DSH Go stay as they are (KEEP): attribution, the plugin
protocol and minimum versions (they are dsh-Go's), share formats both apps read, real
folder names, and the usage statistics, which go to dsh-Go's server.

The app's own folders move with the name: Download/DSMO, Pictures/DSMO, Movies/DSMO
(the Kotlin constants, the Dart paths shown to the user, the agent's storage note and
the strings that mention them change together). Also the app's identity: AppInfo name
and wordmark, android:label, and the default applicationId (io.github.dsmo.app).
"""
import json
import os
import re
import subprocess
import sys
from collections import OrderedDict

KEEP = {
    # attribution and the upstream project
    'botsProjectHome', 'hubAboutAuthor', 'starPromptTitle', 'starPromptBody', 'starSettingsTitle',
    # dsh-Go's plugin protocol, its versions and its components
    'marketSectionAdapted', 'marketTierAdapted', 'marketFlagNotAdapted', 'marketFlagNotAdaptedBody',
    'marketRequiresApp', 'marketNeedsApp', 'plugslotsIssueNeedsApp', 'workshopMinApp',
    'companionMemoryUnsupportedHint', 'shellSkillInstallPrompt',
    # share formats both apps open
    'pluginsProfileTitle', 'pluginsPluginShareTitle', 'viewContinueHeader', 'viewShareLinkText', 'tavernStorybookMadeWith',
    # the AI is given dsh-Go's own usage guide
    'askAiAboutApp', 'askAiWithGuide', 'askAiNoGuide', 'askAiQuestionOverview',
    # usage statistics are sent to dsh-Go's server (go.dshtui.com)
    'usageStatsSection', 'usageStatsFooter', 'usageUpgradeNotice',
}
SPECIAL = {
    # both are on the hook, not just the fork
    'phoneUnlockDisclaimer3': [('DSH Go 及其开发者', 'DSMO 及 DSH Go 的开发者'), ('DSH Go and its developers', 'DSMO, DSH Go and their developers')],
    'searchKwAbout': [(',dsh-go', ',dsmo,dsh-go')],
}
NAME = re.compile(r'DSH Go|dsh-Go|DSH-Go')
# Where a bare "DSH" means the app: the accessibility service's name in system settings, the
# pairing notification. Elsewhere a bare "DSH" is DeepSeek's engine and stays.
PHRASES = [('DSH 手机操控', 'DSMO 手机操控'), ('DSH Phone Control', 'DSMO Phone Control'), ('DSH 的无障碍服务', 'DSMO 的无障碍服务'),
           # the app sends the pairing notification and owns the accessibility service
           ('填进 DSH 的通知', '填进 DSMO 的通知'), ('DSH 会发一条通知', 'DSMO 会发一条通知'),
           ('in DSH’s notification', 'in DSMO’s notification'), ('DSH sends a notification', 'DSMO sends a notification'),
           ('打开 DSH。', '打开「DSMO 手机操控」。'), ('turn on DSH.', 'turn on DSMO Phone Control.'),
           ('Turn on DSH directly', 'Turn on DSMO Phone Control directly')]


def phrases(text):
    for a, b in PHRASES:
        text = text.replace(a, b)
    return text


def rename(key, text):
    if key in KEEP:
        return text
    for a, b in SPECIAL.get(key, []):
        text = text.replace(a, b)
    if key == 'searchKwAbout':
        return text
    return phrases(NAME.sub('DSMO', text))


def arb_parts(app):
    changed = {}
    parts = os.path.join(app, 'lib', 'l10n', 'parts')
    for name in sorted(os.listdir(parts)):
        if not name.endswith('.arb'):
            continue
        path = os.path.join(parts, name)
        raw = open(path, encoding='utf-8').read()
        data = json.loads(raw, object_pairs_hook=OrderedDict)
        hit = False
        for k, v in data.items():
            if k.startswith('@') or not isinstance(v, str):
                continue
            nv = rename(k, v)
            if nv != v:
                data[k] = nv
                changed.setdefault(k, []).append((v, nv))
                hit = True
        if hit:
            # keep the file's own layout: rewrite only the changed values in place
            for k, pairs in changed.items():
                for old, new in pairs:
                    raw = raw.replace(f'"{k}": {json.dumps(old, ensure_ascii=False)}', f'"{k}": {json.dumps(new, ensure_ascii=False)}')
            assert json.loads(raw, object_pairs_hook=OrderedDict) == data, f'{name}: an edit did not apply'
            open(path, 'w', encoding='utf-8').write(raw)
    return changed


def gen_dart(app, keys):
    for loc in ('zh', 'en'):
        path = os.path.join(app, 'lib', 'l10n', 'gen', f'app_localizations_{loc}.dart')
        src = open(path, encoding='utf-8').read()
        blocks = src.split('  @override\n')
        for i, b in enumerate(blocks):
            m = re.match(r'\s*String (?:get )?(\w+)', b)
            if m and m.group(1) in keys:
                key = m.group(1)
                for a, c in SPECIAL.get(key, []):
                    b = b.replace(a, c)
                if key != 'searchKwAbout':
                    b = phrases(NAME.sub('DSMO', b))
                blocks[i] = b
        open(path, 'w', encoding='utf-8').write('  @override\n'.join(blocks))


def gen_base(app, keys):
    """The abstract L10n class quotes each zh string in its doc comment."""
    path = os.path.join(app, 'lib', 'l10n', 'gen', 'app_localizations.dart')
    lines, out, doc = open(path, encoding='utf-8').read().split('\n'), [], []
    for line in lines:
        if line.lstrip().startswith('///'):
            doc.append(line)
            continue
        m = re.match(r'\s*String (?:get )?(\w+)', line)
        if doc and m and m.group(1) in keys and m.group(1) != 'searchKwAbout':
            doc = [phrases(NAME.sub('DSMO', d)) for d in doc]
            for a, b in SPECIAL.get(m.group(1), []):
                doc = [d.replace(a, b) for d in doc]
        out += doc + [line]
        doc = []
    open(path, 'w', encoding='utf-8').write('\n'.join(out + doc))


def android(root):
    res = os.path.join(root, 'app', 'android', 'app', 'src', 'main', 'res')
    for d in sorted(os.listdir(res)):
        if not d.startswith('values'):
            continue
        for name in os.listdir(os.path.join(res, d)):
            path = os.path.join(res, d, name)
            if not name.endswith('.xml'):
                continue
            s = open(path, encoding='utf-8').read()
            # string values only, not resource names or comments
            ns = re.sub(r'(<string [^>]*>)(.*?)(</string>)', lambda m: m.group(1) + phrases(NAME.sub('DSMO', m.group(2))) + m.group(3), s, flags=re.S)
            if ns != s:
                open(path, 'w', encoding='utf-8').write(ns)
    kt = os.path.join(root, 'app', 'android', 'app', 'src', 'main', 'kotlin')
    for dirpath, _, files in os.walk(kt):
        for name in files:
            if not name.endswith('.kt'):
                continue
            path = os.path.join(dirpath, name)
            s = open(path, encoding='utf-8').read()
            # inside string literals only, never comments: "DSH Go", "DSH Go · …", Download/DSH-Go
            out = []
            for line in s.split('\n'):
                if not line.lstrip().startswith(('//', '*', '/*')):
                    line = re.sub(r'"(?:[^"\\\n]|\\.)*"', lambda m: m.group(0).replace('DSH Go', 'DSMO').replace('DSH-Go', 'DSMO'), line)
                out.append(line)
            ns = '\n'.join(out)
            if ns != s:
                open(path, 'w', encoding='utf-8').write(ns)


# Dart literals naming the app or its folders (not comments, not dsh-Go internals).
DART = {
    'lib/state/app_info.dart': [("static const name = 'DSH Go';", "static const name = 'DSMO';"),
                                ("static const wordmark = 'DSH';", "static const wordmark = 'DSMO';")],
    'lib/media/gallery.dart': [("'Pictures/DSH Go/$name'", "'Pictures/DSMO/$name'"), ("'Movies/DSH Go/$name'", "'Movies/DSMO/$name'")],
    'lib/state/artifacts.dart': [("/Download/DSH-Go';", "/Download/DSMO';"), ("'Download/DSH-Go/$name'", "'Download/DSMO/$name'")],
    'lib/diagnostics/diagnostics_markdown.dart': [("'# DSH Go 本机诊断'", "'# DSMO 本机诊断'")],
    'lib/share_code/conversation_html.dart': [("· DSH Go')", "· DSMO')")],
}
IDENTITY = {
    'app/android/app/src/main/AndroidManifest.xml': [('android:label="API Demo"', 'android:label="DSMO"')],
    'app/android/app/build.gradle.kts': [('?: "io.github.apidemo.app"', '?: "io.github.dsmo.app"')],
}


def literal_edits(root):
    for rel, edits in [(f'app/{k}', v) for k, v in DART.items()] + list(IDENTITY.items()):
        path = os.path.join(root, rel)
        s = open(path, encoding='utf-8').read()
        for a, b in edits:
            if a not in s:
                sys.exit(f'{rel}: "{a}" not found (dsh-Go changed; update rename_strings.py)')
            s = s.replace(a, b)
        open(path, 'w', encoding='utf-8').write(s)


def main():
    root = os.path.abspath(sys.argv[1])
    app = os.path.join(root, 'app')
    changed = arb_parts(app)
    subprocess.run([sys.executable, 'tool/l10n_merge.py', '--no-gen'], cwd=app, check=True)
    gen_dart(app, set(changed))
    gen_base(app, set(changed))
    android(root)
    literal_edits(root)
    print(f'renamed {len(changed)} strings; kept {len(KEEP)} that must say DSH Go')


if __name__ == '__main__':
    main()
