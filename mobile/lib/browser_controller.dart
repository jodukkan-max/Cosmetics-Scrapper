// BrowserController — wraps a WebView that "acts as a browser".
//   - getHtml(): reads document.documentElement.outerHTML (the getTabHtml port).
//   - runScraper(): injects a scraper body into the page context and runs it,
//     receiving the JSON result back over a JavaScriptChannel (reliable on both
//     iOS WKWebView and Android WebView, and async-safe).
//
// The scraper code runs in the page's real browser context, so it has DOMParser,
// document, fetch, atob/btoa, etc. — exactly what the predefined module expects.

import 'dart:async';
import 'dart:convert';

import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';
import 'package:webview_flutter/webview_flutter.dart';

class BrowserController extends ChangeNotifier {
  WebViewController? controller;
  final Map<int, Completer<String>> _pending = {};
  int _nextId = 1;
  String currentUrl = '';
  bool _pageFinished = false;

  /// True once the current page has finished loading (onPageFinished fired).
  bool get isLoaded => _pageFinished;

  static const String _channelName = 'ScraperChannel';

  void init() {
    controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFFFFFFF))
      ..addJavaScriptChannel(_channelName, onMessageReceived: _onMessage)
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (url) {
          currentUrl = url;
          _pageFinished = false;
          notifyListeners();
        },
        onPageFinished: (url) {
          currentUrl = url;
          _pageFinished = true;
          notifyListeners();
        },
      ))
      ..loadRequest(Uri.parse('about:blank'));
    notifyListeners();
  }

  void _onMessage(JavaScriptMessage msg) {
    try {
      final m = jsonDecode(msg.message);
      if (m is! Map || m['id'] is! int) return;
      final id = m['id'] as int;
      final c = _pending.remove(id);
      if (c != null) {
        c.complete(jsonEncode(m['payload']));
      }
    } catch (_) {}
  }

  Future<void> navigate(String raw) {
    var url = raw.trim();
    if (url.isEmpty) return Future.value();
    if (!RegExp(r'^[a-z][a-z0-9+.-]*://', caseSensitive: false)
        .hasMatch(url)) {
      url = 'https://$url';
    }
    currentUrl = url;
    notifyListeners();
    return controller!.loadRequest(Uri.parse(url));
  }

  Future<bool> canGoBack() async {
    final c = controller;
    if (c == null) return false;
    return await c.canGoBack();
  }

  Future<void> goBack() async {
    await controller?.goBack();
  }

  Future<String> getHtml() async {
    // Wait for the page to finish loading before reading the DOM. Reading
    // `outerHTML` mid-load (e.g. right after navigation starts) returns the
    // previous page or a blank document, missing the <head> JSON-LD that the
    // predefined scrapers rely on. This race is most visible on Android.
    final deadline = DateTime.now().add(const Duration(seconds: 8));
    while (!_pageFinished && DateTime.now().isBefore(deadline)) {
      await Future.delayed(const Duration(milliseconds: 150));
    }

    for (var attempt = 0; attempt < 3; attempt++) {
      final r = await controller!
          .runJavaScriptReturningResult('document.documentElement.outerHTML');
      final s = r is String ? r : '';
      // A real page is far larger than a blank/empty document.
      if (s.trim().length > 500) return s;
      await Future.delayed(const Duration(milliseconds: 300));
    }
    final r = await controller!
        .runJavaScriptReturningResult('document.documentElement.outerHTML');
    return r is String ? r : '';
  }

  /// Fetches the raw server HTML of the current page using the WebView's own
  /// `fetch()` (Chrome's network stack) and returns it over the JavaScript
  /// channel. This avoids two Android problems with the other paths:
  ///   - `document.documentElement.outerHTML` can be truncated/incomplete
  ///     while the page is still rendering.
  ///   - Dart's `http` client can receive JSON-escaped markup (e.g. `\u003C`)
  ///     from some CDN edges.
  Future<String> getHtmlViaFetch() async {
    final id = _nextId++;
    final completer = Completer<String>();
    _pending[id] = completer;
    final js = '''
(async function () {
  try {
    var r = await fetch(location.href, { credentials: 'include' });
    var t = await r.text();
    ${_channelName}.postMessage(JSON.stringify({ id: $id, payload: t }));
  } catch (e) {
    ${_channelName}.postMessage(JSON.stringify({ id: $id, payload: null }));
  }
})();
''';
    try {
      await controller!.runJavaScript(js);
      final result =
          await completer.future.timeout(const Duration(seconds: 25));
      if (result == 'null') return '';
      final decoded = jsonDecode(result);
      return decoded is String ? decoded : '';
    } catch (e) {
      _pending.remove(id);
      return '';
    }
  }

  /// Runs a materializable scraper body against [html]. `code` must be a
  /// complete script body that ends with a `return` statement (it is executed
  /// via `new Function('ctx', code)`), exactly like the desktop core.
  Future<Map<String, dynamic>> runScraper({
    required String code,
    required String url,
    required String html,
    required String productType,
  }) async {
    final id = _nextId++;
    final js = _runner(id, code, url, html, productType);
    final completer = Completer<String>();
    _pending[id] = completer;
    try {
      await controller!.runJavaScript(js);
      final result = await completer.future.timeout(const Duration(seconds: 40));
      final decoded = jsonDecode(result);
      if (decoded is Map<String, dynamic>) {
        return _sanitizeRows(decoded);
      }
      return {'ok': false, 'error': 'Bad scraper result'};
    } catch (e) {
      _pending.remove(id);
      return {'ok': false, 'error': e.toString()};
    }
  }

  // Drop obviously-broken image URLs (template placeholders like "$img" /
  // "${img}") so one bad URL can't make WooCommerce reject the whole product.
  Map<String, dynamic> _sanitizeRows(Map<String, dynamic> decoded) {
    final rows = decoded['rows'];
    if (rows is List) {
      decoded['rows'] = rows.map((r) {
        if (r is! Map) return r;
        final c = Map<String, dynamic>.from(r);
        for (final k in ['Images', 'Rey Variations extra images']) {
          final v = c[k];
          if (v is List) {
            c[k] = v
                .map((u) => (u ?? '').toString().trim())
                .where((u) =>
                    u.isNotEmpty &&
                    !RegExp(r'[\$\{\}]').hasMatch(u) &&
                    (u.startsWith('http://') ||
                        u.startsWith('https://') ||
                        u.startsWith('//') ||
                        u.startsWith('data:')))
                .toList();
          }
        }
        return c;
      }).toList();
    }
    return decoded;
  }

  String _runner(int id, String code, String url, String html, String type) {
    // jsonEncode output is a valid JS string literal (JSON escaping is a subset
    // of JS string-literal escaping), so embed it directly — no JSON.parse.
    // U+2028/U+2029 are legal in JSON but illegal in JS string literals, so
    // escape them explicitly.
    String jsLit(String s) => s
        .replaceAll('\u2028', r'\u2028')
        .replaceAll('\u2029', r'\u2029');
    final codeJson = jsLit(jsonEncode(code));
    final urlJson = jsLit(jsonEncode(url));
    final htmlJson = jsLit(jsonEncode(html));
    final typeJson = jsLit(jsonEncode(type));
    return '''
(async function () {
  try {
    var CODE = $codeJson;
    var ctx = {
      url: $urlJson,
      mainHtml: $htmlJson,
      productType: $typeJson,
      fetchText: function (u, o) {
        return fetch(u, Object.assign({ credentials: 'include' }, o || {}))
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u); return r.text(); });
      },
      fetchJson: function (u, o) {
        return fetch(u, Object.assign({ credentials: 'include' }, o || {}))
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u); return r.json(); });
      }
    };
    var out = await (new Function('ctx', CODE))(ctx);
    ${_channelName}.postMessage(JSON.stringify({ id: $id, payload: {
      ok: true,
      rows: (out && out.rows) || [],
      title: (out && out.title) || '',
      site: (out && out.site) || '',
      brand: (out && out.brand) || ''
    }}));
  } catch (e) {
    ${_channelName}.postMessage(JSON.stringify({ id: $id, payload: {
      ok: false,
      error: String((e && e.message) || e)
    }}));
  }
})();
''';
  }
}
