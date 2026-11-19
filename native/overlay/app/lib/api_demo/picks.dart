// DSMO — files the person picked, served to the page by the local proxy
// (AGPL-3.0, part of the DSMO patch set for dsh-Go).
//
// The bridge used to read a picked file whole and send it to the page as one
// base64 string, so exports over 64 MB (a long DeepSeek history) were refused
// and big ones strained memory. Now each picked file is streamed into the app's
// cache (as dsh-Go's own pickers do) and the page reads it as a stream from
// GET /__picks/<token> on the proxy, behind the proxy's per-launch cookie. The
// page can read it more than once (a preview pass, then the import) and lets
// go of it with `releaseDocuments`; leftovers are cleared at the next launch.
// Nothing leaves the phone.

import 'dart:io';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:path_provider/path_provider.dart';

class ApiDemoPicks {
  ApiDemoPicks._();
  static final instance = ApiDemoPicks._();

  static const route = '/__picks/';
  final Map<String, File> _files = {};
  bool _cleared = false;

  Future<Directory> _dir() async {
    final dir = Directory('${(await getTemporaryDirectory()).path}/api_demo_picks');
    if (!_cleared) {
      _cleared = true;
      if (await dir.exists()) await dir.delete(recursive: true);
    }
    return dir.create(recursive: true);
  }

  /// Copies the picked files into the cache; `[{name, size, url}]` for the page.
  Future<List<Map<String, Object?>>> take(List<PlatformFile> picked) async {
    final out = <Map<String, Object?>>[];
    final dir = await _dir();
    for (final f in picked) {
      final token = _token();
      final file = File('${dir.path}/$token');
      final sink = file.openWrite();
      try {
        await sink.addStream(f.readAsByteStream());
      } catch (_) {
        await sink.close();
        if (await file.exists()) await file.delete();
        rethrow;
      }
      await sink.close();
      _files[token] = file;
      out.add({'name': f.name, 'size': await file.length(), 'url': '$route$token'});
    }
    return out;
  }

  /// The cached file behind a `/__picks/<token>` path, or null.
  File? lookup(String path) => path.startsWith(route) ? _files[path.substring(route.length)] : null;

  Future<void> release(Iterable<String> urls) async {
    for (final url in urls) {
      if (!url.startsWith(route)) continue;
      final file = _files.remove(url.substring(route.length));
      if (file != null && await file.exists()) await file.delete();
    }
  }

  static String _token() {
    final r = Random.secure();
    return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }
}
