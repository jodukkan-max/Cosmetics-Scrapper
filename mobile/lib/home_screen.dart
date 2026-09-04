import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'brands.dart';
import 'browser_controller.dart';
import 'scraper_engine.dart';
import 'supabase_client.dart';
import 'theme.dart';

const _stepLabels = <int, String>{
  1: 'Read page HTML',
  2: 'Ask AI to check the page',
  3: 'Product page?',
  4: 'Simple or variable product?',
  5: 'Attributes',
  6: 'Attribute names',
  7: 'Color swatches',
  8: 'Generate scraper (AI)',
  9: 'Scraping the product',
};

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen>
    with TickerProviderStateMixin {
  late final BrowserController _browser;
  late final ScraperEngine _engine;

  List<Map<String, dynamic>> _rows = [];
  String _type = 'variable';
  int _tab = 0;

  // IDs (as strings) of the variation rows selected for import/export.
  final Set<String> _selectedIds = {};

  final Map<int, Map<String, String>> _steps = {};
  String _thought = '';
  String _statusMsg = '';
  String _statusType = '';
  bool _showDone = false;
  bool _showChat = false; // conversational "fix the scraper" panel
  final List<Map<String, String>> _chat = []; // {role: user|agent, text}
  final TextEditingController _chatController = TextEditingController();
  bool _chatBusy = false;
  bool _busy = false;
  bool _cancelled = false;
  bool _notProduct = false; // true when the current page is not a product page
  bool _showSuccess = false; // brief animated checkmark overlay

  // Bottom sheet snap points, as fractions of the screen height:
  // 0.0 = collapsed footer, 0.65 and 0.90 = expanded stops.
  static const double _footerH = 56.0;
  static const List<double> _snapFractions = [0.0, 0.65, 0.90];
  static const double _maxFraction = 0.90;
  late final AnimationController _sheetAnim;
  late final AnimationController _pulseAnim;
  double _screenH = 600;

  List<Map<String, dynamic>> _stores = [];
  final Map<String, String> _storeTestState = {}; // id -> loading|ok|error
  final Map<String, String> _storeTestMsg = {}; // id -> message

  List<Map<String, dynamic>> _websites = [];
  bool _websitesLoaded = false;
  bool _websitesLoading = false;
  String? _websitesError;
  String _websiteSearch = '';

  final _urlController = TextEditingController();

  static const _simpleCols = [
    'SKU', 'Name', 'tags', 'Product URL', 'Description', 'Short Description',
    'Regular Price', 'Images',
  ];
  static const _variableCols = [
    'ID', 'Parent', 'Type', 'SKU', 'Name', 'tags', 'Product URL', 'Images',
    'Description', 'Short Description', 'Regular Price',
    'Attribute 1 name', 'Attribute 1 value(s)',
    'Attribute 2 name', 'Attribute 2 value(s)',
    'Color Code', 'Rey Swatches',
  ];

  @override
  void initState() {
    super.initState();
    _browser = BrowserController();
    _browser.init();
    _sheetAnim = AnimationController(
        vsync: this,
        duration: AppMotion.normal,
        lowerBound: 0.0,
        upperBound: _maxFraction,
        value: _maxFraction);
    _pulseAnim = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 900))
      ..repeat(reverse: true);
    _engine = ScraperEngine(
      sb: SupabaseClient(),
      runScraper: ({
        required String code,
        required String url,
        required String html,
        required String productType,
      }) =>
          _browser.runScraper(
              code: code, url: url, html: html, productType: productType),
      onProgress: (step, state, detail) {
        if (!mounted) return;
        setState(() {
          _steps[step] = {'state': state, 'detail': detail};
          if (step == 8 && state != 'running') _thought = '';
        });
      },
      onThinking: (text) {
        if (!mounted) return;
        setState(() => _thought = text);
      },
      isCancelled: () => _cancelled,
    );
    _loadStores();
  }

  @override
  void dispose() {
    _urlController.dispose();
    _chatController.dispose();
    _browser.dispose();
    _sheetAnim.dispose();
    _pulseAnim.dispose();
    super.dispose();
  }

  Future<void> _loadStores() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('stores');
    if (raw != null) {
      final list = jsonDecode(raw) as List;
      _stores = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
    }
    if (mounted) setState(() {});
  }

  Future<void> _saveStores() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('stores', jsonEncode(_stores));
  }

  String get _domain {
    return ScraperEngine.domainOf(_browser.currentUrl);
  }

  bool get _loaded =>
      _browser.currentUrl.isNotEmpty && _browser.currentUrl != 'about:blank';

  void _status(String type, String msg) {
    setState(() {
      _statusType = type;
      _statusMsg = msg;
    });
  }

  void _clearStatus() => _status('', '');

  void _cancel() {
    if (!_busy || _cancelled) return;
    setState(() {
      _cancelled = true;
      _statusType = 'warn';
      _statusMsg = 'Cancelling…';
    });
  }

  void _finishCancelled() {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _cancelled = false;
      _statusType = 'warn';
      _statusMsg = 'Cancelled.';
    });
  }

  void _onScrapeSuccess() {
    _expandSheet();
    HapticFeedback.mediumImpact();
    setState(() => _showSuccess = true);
    Future.delayed(const Duration(milliseconds: 900), () {
      if (mounted) setState(() => _showSuccess = false);
    });
  }

  void _retryLast() {
    if (_steps.isNotEmpty) {
      _addScraper();
    } else {
      _scrape();
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  Future<void> _navigate() async {
    final raw = _urlController.text.trim();
    if (raw.isEmpty) return;
    await _browser.navigate(raw);
  }

  Future<void> _goBack() async {
    if (await _browser.canGoBack()) {
      await _browser.goBack();
    } else {
      _resetToScrape();
    }
  }

  Future<String> _currentHtml() async {
    // 1) Live rendered DOM — exactly what the extension reads
    //    (document.documentElement.outerHTML). This keeps the app and extension
    //    scraping the SAME content (including any JS-rendered markup), and it is
    //    instant (no extra network round-trip).
    final dom = await _browser.getHtml();
    if (_looksLikeRealPage(dom)) return dom;

    // 2) Fallback: raw server HTML via the WebView's own fetch (handles the
    //    Android case where outerHTML is truncated while the page is still
    //    rendering).
    final viaFetch = _unwrapHtml(await _browser.getHtmlViaFetch());
    if (_looksLikeRealPage(viaFetch)) return viaFetch;

    // 3) Fallback: Dart HTTP fetch of the raw server HTML (some CDN edges).
    try {
      final url = _browser.currentUrl;
      final resp = await http
          .get(Uri.parse(url),
              headers: const {
                'User-Agent':
                    'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36',
                'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              })
          .timeout(const Duration(seconds: 20));
      if (resp.statusCode == 200) {
        final body = _unwrapHtml(resp.body);
        if (_looksLikeRealPage(body)) return body;
      }
    } catch (_) {}

    return dom;
  }

  /// True if [html] looks like a real, complete HTML page (not a JSON shell,
  /// blank doc, or an error page).
  bool _looksLikeRealPage(String html) {
    if (html.trim().length < 2000) return false;
    final lower = html.toLowerCase();
    return lower.contains('<html') ||
        lower.contains('<!doctype') ||
        lower.contains('<body') ||
        lower.contains('<head');
  }

  /// Some CDN edges / proxies return the HTML JSON-stringified (markup escaped
  /// as `\u003C`, `\u003E`, etc). Decode that back to real markup so the
  /// scrapers see a literal `<script type="application/ld+json">` tag.
  String _unwrapHtml(String raw) {
    var t = raw.trim();
    // Strip surrounding quotes if this arrived as a JSON string literal.
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      t = t.substring(1, t.length - 1);
    }
    if (!t.contains(r'\u')) return raw;

    final sb = StringBuffer();
    var i = 0;
    while (i < t.length) {
      final c = t[i];
      if (c == r'\' && i + 1 < t.length) {
        final n = t[i + 1];
        if (n == 'u' && i + 5 < t.length) {
          final code = int.tryParse(t.substring(i + 2, i + 6), radix: 16);
          if (code != null) {
            sb.writeCharCode(code);
            i += 6;
            continue;
          }
        }
        switch (n) {
          case 'n':
            sb.write('\n');
            i += 2;
            continue;
          case 'r':
            sb.write('\r');
            i += 2;
            continue;
          case 't':
            sb.write('\t');
            i += 2;
            continue;
          case '"':
            sb.write('"');
            i += 2;
            continue;
          case r'\':
            sb.write(r'\');
            i += 2;
            continue;
          case '/':
            sb.write('/');
            i += 2;
            continue;
        }
      }
      sb.write(c);
      i += 1;
    }
    final decoded = sb.toString();
    return decoded.contains('<') ? decoded : raw;
  }

  Future<void> _scrape() async {
    if (!_loaded) return _status('error', 'Open a product page first.');
    setState(() {
      _showDone = false;
      _showChat = false;
      _busy = true;
      _cancelled = false;
      _notProduct = false;
    });
    _status('loading', 'Scraping…');
    try {
      final url = _browser.currentUrl;
      final html = await _currentHtml();
      final res = await _engine.handleScrape(url: url, html: html);
      if (_cancelled) return _finishCancelled();
      if (res['ok'] != true) throw Exception(res['error']);
      _rows = (res['rows'] as List).cast<Map<String, dynamic>>();
      _type = _rows.isNotEmpty && _rows.first.containsKey('Type')
          ? 'variable'
          : 'simple';
      _resetSelection();
      final brand = (res['brand'] ?? '').toString().isNotEmpty
          ? res['brand'].toString()
          : brandNameForDomain(_domain);
      for (final r in _rows) {
        r['tags'] = brand;
        r['Product URL'] = url;
      }
      _clearStatus();
      _onScrapeSuccess();
    } catch (e) {
      _status('error', e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addScraper() async {
    if (!_loaded) return _status('error', 'Open a product page first.');
    setState(() {
      _steps.clear();
      _thought = '';
      _showDone = false;
      _showChat = false;
      _busy = true;
      _cancelled = false;
      _notProduct = false;
    });
    _status('loading', 'Checking with AI…');
    try {
      final url = _browser.currentUrl;
      final html = await _currentHtml();
      final res = await _engine.handleAddScraper(url: url, html: html);
      if (_cancelled || res['cancelled'] == true) return _finishCancelled();
      if (res['productPage'] == true) {
        _status('success', res['message'] ?? 'This is a product page.');
        _websitesLoaded = false;
        final pType = (res['productType'] == 'simple' ||
                res['productType'] == 'variable')
            ? res['productType'].toString()
            : 'auto';
        _setStep(9, 'running', 'Scraping…');
        final ok = await _runScrapeUrl(url, pType);
        if (_cancelled) return _finishCancelled();
        _setStep(9, ok ? 'done' : 'fail', ok ? 'Done' : 'Failed');
        if (ok && res['alreadyExists'] != true) {
          _openChat();
        }
      } else if (res['notProduct'] == true) {
        _setStep(9, 'skip', '—');
        _notProduct = true;
        _status('warn', res['message'] ?? 'This page is not a product page.');
      } else {
        _status('error', res['error'] ?? 'Failed to check page.');
      }
    } catch (e) {
      _setStep(9, 'fail', e.toString());
      _status('error', e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _runScrapeUrl(String url, String pType) async {
    try {
      final html = await _currentHtml();
      final res = await _engine.handleScrape(
          url: url, html: html, productType: pType);
      if (_cancelled) return false;
      if (res['ok'] != true) throw Exception(res['error']);
      _rows = (res['rows'] as List).cast<Map<String, dynamic>>();
      _type = _rows.isNotEmpty && _rows.first.containsKey('Type')
          ? 'variable'
          : 'simple';
      _resetSelection();
      final brand = (res['brand'] ?? '').toString().isNotEmpty
          ? res['brand'].toString()
          : brandNameForDomain(ScraperEngine.domainOf(url));
      for (final r in _rows) {
        r['tags'] = brand;
        r['Product URL'] = url;
      }
      _clearStatus();
      _onScrapeSuccess();
      return true;
    } catch (e) {
      _status('error', e.toString());
      setState(() {});
      return false;
    }
  }

  void _setStep(int step, String state, String detail) {
    if (!mounted) return;
    setState(() {
      _steps[step] = {'state': state, 'detail': detail};
      if (step == 8 && state != 'running') _thought = '';
    });
  }

  Future<void> _finishScraper() async {
    if (_loaded) {
      await _engine.verifyScraper(url: _browser.currentUrl, type: _type);
    }
    setState(() {
      _showChat = false;
      _showDone = true;
    });
    _status('success', 'Scraper saved.');
  }

  void _openChat() {
    setState(() {
      _chat.clear();
      _chat.add({
        'role': 'agent',
        'text':
            'I scraped ${_rows.length} row${_rows.length == 1 ? '' : 's'}. If anything looks wrong, just tell me what to fix — for example "missing variants", "wrong price", or "images are swapped" — and I\'ll update the scraper.'
      });
      _showChat = true;
    });
  }

  Future<void> _sendChat() async {
    final text = _chatController.text.trim();
    if (text.isEmpty || _chatBusy) return;
    _chatController.clear();
    setState(() => _chat.add({'role': 'user', 'text': text}));
    _chatBusy = true;
    _status('loading', 'Talking to the AI agent…');
    try {
      final url = _browser.currentUrl;
      final html = await _currentHtml();
      final history = _chat.length > 1
          ? _chat.sublist(1, _chat.length - 1)
          : const <Map<String, String>>[];
      final res = await _engine.chatFixScraper(
        url: url,
        html: html,
        type: _type,
        feedback: text,
        history: history,
      );
      if (!mounted) return;
      if (res['ok'] != true) {
        setState(() {
          _chat.add({
            'role': 'agent',
            'text': 'Sorry, I couldn\'t fix it: ${res['error']}'
          });
        });
        _status('error', res['error']?.toString() ?? 'Fix failed.');
        return;
      }
      _rows = (res['rows'] as List).cast<Map<String, dynamic>>();
      _type = _rows.isNotEmpty && _rows.first.containsKey('Type')
          ? 'variable'
          : 'simple';
      _resetSelection();
      setState(() {
        _chat.add({
          'role': 'agent',
          'text':
              'Done — I updated the scraper. It now returns ${_rows.length} row${_rows.length == 1 ? '' : 's'}. Anything else to fix, or does this look right?'
        });
      });
      _status('success', 'Scraper updated.');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _chat.add({
          'role': 'agent',
          'text': 'Something went wrong: ${e.toString()}'
        });
      });
      _status('error', e.toString());
    } finally {
      if (mounted) setState(() => _chatBusy = false);
    }
  }

  // ── Export helpers ─────────────────────────────────────────────────────────
  String _cell(dynamic v) => v == null ? '' : (v is List ? v.join(', ') : v.toString());

  List<String> _variationIds() => _rows
      .where((r) => r['Type'] == 'variation')
      .map((r) => r['ID'].toString())
      .toList();

  void _resetSelection() {
    _selectedIds
      ..clear()
      ..addAll(_variationIds());
  }

  // Rows to export/import: keep the parent row and only the checked variations,
  // and recompute the parent's "Attribute 1 value(s)" to the kept variants.
  List<Map<String, dynamic>> _exportRows() {
    if (_type != 'variable') return _rows;
    final kept = _rows
        .where((r) =>
            r['Type'] != 'variation' || _selectedIds.contains(r['ID'].toString()))
        .toList();
    return kept.map((r) {
      if (r['Type'] != 'variable') return r;
      final ref = 'id:${r['ID']}';
      final variants = kept
          .where((x) => x['Type'] == 'variation' && x['Parent'] == ref)
          .toList();
      final names = variants
          .map((x) => (x['Attribute 1 value(s)'] ?? '').toString())
          .where((s) => s.isNotEmpty)
          .toSet()
          .join(',');
      final names2 = variants
          .map((x) => (x['Attribute 2 value(s)'] ?? '').toString())
          .where((s) => s.isNotEmpty)
          .toSet()
          .join(',');
      final copy = Map<String, dynamic>.from(r);
      copy['Attribute 1 value(s)'] = names;
      copy['Attribute 2 value(s)'] = names2;
      return copy;
    }).toList();
  }

  // Port of the extension's buildReySwatches(): a computed column that emits the
  // Rey theme's swatch JSON for the variable (parent) row.
  String _reySwatches(Map<String, dynamic> parentRow) {
    if (parentRow['Type'] != 'variable') return '';
    final attrName =
        (parentRow['Attribute 1 name'] ?? 'Color').toString().toLowerCase();
    final parentRef = 'id:${parentRow['ID']}';
    final variations = _rows
        .where((r) =>
            r['Type'] == 'variation' && r['Parent'] == parentRef)
        .toList();
    final isImageSwatch = variations.any(
        (v) => (v['Color Code'] ?? '').toString().trim().startsWith('http'));
    final terms = <String, Map<String, String>>{};
    for (final v in variations) {
      final colorName = (v['Attribute 1 value(s)'] ?? '').toString();
      final cc = (v['Color Code'] ?? '').toString().trim();
      if (colorName.isEmpty) continue;
      terms[colorName] = isImageSwatch
          ? {'name': colorName, 'rey_attribute_image': cc}
          : {
              'name': colorName,
              'rey_attribute_color': cc.isEmpty ? '#000000' : cc
            };
    }
    if (isImageSwatch) {
      return jsonEncode({
        'Image': {'name': 'Image', 'type': 'rey_image', 'terms': terms}
      });
    }
    if (attrName != 'color') return '';
    return jsonEncode({
      attrName: {'name': attrName, 'type': 'rey_color', 'terms': terms}
    });
  }

  String _colValue(String c, Map<String, dynamic> r) {
    if (c == 'Rey Swatches') return _reySwatches(r);
    return _cell(r[c]);
  }

  String _csv() {
    final cols = _type == 'simple' ? _simpleCols : _variableCols;
    final esc = (String s) => RegExp(r'[",\n]').hasMatch(s)
        ? '"${s.replaceAll('"', '""')}"'
        : s;
    final lines = <String>[
      cols.map(esc).join(','),
      for (final r in _exportRows())
        cols.map((c) {
          if (c == 'Images' || c == 'Rey Variations extra images') {
            final v = r[c];
            final list = v is List ? v : (v == null ? [] : [v]);
            return esc(list.join('|'));
          }
          return esc(_colValue(c, r));
        }).join(','),
    ];
    return lines.join('\n');
  }

  // ── Store import ───────────────────────────────────────────────────────────
  Future<void> _importToStores(bool skipResize, {Set<String>? selectedIds}) async {
    if (_stores.isEmpty) return _status('error', 'Add a store first.');
    final targets = selectedIds == null
        ? _stores
        : _stores
            .where((s) => selectedIds.contains(s['id']?.toString()))
            .toList();
    if (targets.isEmpty) return _status('error', 'No store selected.');
    final csv = _csv();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => _ImportProgressSheet(
        engine: _engine,
        stores: targets,
        csv: csv,
        skipResize: skipResize,
      ),
    );
  }

  Future<void> _showImportPicker() async {
    if (_stores.isEmpty) return _status('error', 'Add a store first.');
    final selected = <String>{
      for (final s in _stores) s['id']?.toString() ?? ''
    }..remove('');
    final result = await showModalBottomSheet<Set<String>>(
      context: context,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final ids = selected;
          final allSelected = ids.length == _stores.length;
          return SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Import to stores',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  const Text(
                      'Choose which stores to import the scraped product into.',
                      style: TextStyle(color: AppColors.muted, fontSize: 12)),
                  const SizedBox(height: 12),
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      children: _stores.map((s) {
                        final id = s['id']?.toString() ?? '';
                        return CheckboxListTile(
                          value: ids.contains(id),
                          onChanged: (v) => setSheetState(() {
                            if (v == true) {
                              ids.add(id);
                            } else {
                              ids.remove(id);
                            }
                          }),
                          title: Text(s['name'] ?? ''),
                          subtitle: Text(s['url'] ?? '',
                              style: const TextStyle(fontSize: 11)),
                          controlAffinity: ListTileControlAffinity.leading,
                          dense: true,
                          activeColor: AppColors.accent,
                        );
                      }).toList(),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(children: [
                    TextButton(
                      onPressed: () => setSheetState(() {
                        if (allSelected) {
                          ids.clear();
                        } else {
                          ids
                            ..clear()
                            ..addAll(_stores.map((s) => s['id']?.toString() ?? ''));
                        }
                        ids.remove('');
                      }),
                      child: Text(allSelected ? 'Deselect all' : 'Select all'),
                    ),
                    const Spacer(),
                    FilledButton(
                      onPressed: () =>
                          Navigator.pop(ctx, Set<String>.from(ids)),
                      child: Text('Import (${ids.length})'),
                    ),
                  ]),
                ],
              ),
            ),
          );
        },
      ),
    );
    if (result == null || result.isEmpty) return;
    if (!mounted) return;
    await _importToStores(true, selectedIds: result);
  }

  Future<void> _loadWebsites() async {
    if (_websitesLoaded || _websitesLoading) return;
    _websitesLoading = true;
    _websitesError = null;
    if (mounted) setState(() {});
    try {
      final scrapers = await SupabaseClient().listScrapers();
      final byDomain = <String, List<Map<String, dynamic>>>{};
      for (final s in scrapers) {
        if (s is! Map || s['domain'] == null) continue;
        byDomain
            .putIfAbsent(s['domain'] as String, () => [])
            .add(s.cast<String, dynamic>());
      }
      final list = <Map<String, dynamic>>[];
      byDomain.forEach((domain, rows) {
        final first = rows.first;
        final types = rows.map((r) => r['type'].toString()).where((t) => t.isNotEmpty).toList();
        final predefined = rows.every((r) => r['is_predefined'] == true);
        list.add({
          'domain': domain,
          'brand': (first['brand'] ?? '').toString(),
          'types': types,
          'example': (first['example'] ?? '').toString(),
          'predefined': predefined,
        });
      });
      list.sort((a, b) => (a['brand'] ?? '').toString().compareTo((b['brand'] ?? '').toString()));
      _websites = list;
      _websitesLoaded = true;
    } catch (e) {
      _websitesError = e.toString();
    } finally {
      _websitesLoading = false;
      if (mounted) setState(() {});
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            _screenH = constraints.maxHeight;
            return Stack(
              children: [
                Column(
                  children: [
                    _buildUrlBar(),
                    Expanded(child: _buildBrowser()),
                  ],
                ),
                AnimatedBuilder(
                  animation: _sheetAnim,
                  builder: (context, _) {
                    final t = _sheetAnim.value;
                    final h = _screenH * t < _footerH ? _footerH : _screenH * t;
                    return Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: h,
                      child: _buildSheet(h),
                    );
                  },
                ),
                if (_showSuccess)
                  Positioned.fill(
                    child: IgnorePointer(
                      child: Center(
                        child: TweenAnimationBuilder<double>(
                          tween: Tween(begin: 0.6, end: 1.0),
                          duration: AppMotion.fast,
                          curve: Curves.elasticOut,
                          builder: (context, scale, child) =>
                              Transform.scale(scale: scale, child: child),
                          child: Container(
                            width: 84,
                            height: 84,
                            decoration: BoxDecoration(
                              color: AppColors.success,
                              shape: BoxShape.circle,
                              boxShadow: [
                                BoxShadow(
                                  color: AppColors.success
                                      .withValues(alpha: 0.4),
                                  blurRadius: 24,
                                  offset: const Offset(0, 6),
                                ),
                              ],
                            ),
                            child: const Icon(Icons.check,
                                size: 48, color: Colors.white),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildUrlBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      color: AppColors.surface,
      child: Row(
        children: [
          IconButton(
            onPressed: _goBack,
            icon: const Icon(Icons.arrow_back, size: 20),
            tooltip: 'Back',
            color: AppColors.text,
          ),
          const SizedBox(width: 4),
          Expanded(
            child: TextField(
              controller: _urlController,
              keyboardType: TextInputType.url,
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'https://example.com/product',
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                filled: true,
                fillColor: AppColors.surface,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: AppColors.border),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: AppColors.border),
                ),
              ),
              onSubmitted: (_) => _navigate(),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: _navigate,
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            ),
            child: const Text('Go'),
          ),
        ],
      ),
    );
  }

  Widget _buildBrowser() {
    final c = _browser.controller;
    if (c == null) return const SizedBox.shrink();
    return ClipRect(child: WebViewWidget(controller: c));
  }

  // ── Bottom sheet ───────────────────────────────────────────────────────────
  Widget _buildSheet(double h) {
    // Only render the full panel (tabs + content) once there is room for the
    // ~64px tab header; otherwise the footer strip stays visible and we avoid
    // a RenderFlex overflow during the collapse animation.
    final showPanel = h > _footerH + 64;
    final expanded = h >= _screenH * _maxFraction - 1;
    final radius = expanded ? 16.0 : (showPanel ? 12.0 : 0.0);
    return AnimatedContainer(
      duration: AppMotion.normal,
      curve: AppMotion.easeOut,
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(radius)),
        boxShadow: expanded
            ? [
                BoxShadow(
                  color: AppColors.text.withValues(alpha: 0.10),
                  blurRadius: 24,
                  offset: const Offset(0, -4),
                ),
              ]
            : const [],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          _buildHandleBar(),
          Expanded(child: showPanel ? _buildPanel() : _buildFooter()),
        ],
      ),
    );
  }

  Widget _buildHandleBar() {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragUpdate: _onSheetDragUpdate,
      onVerticalDragEnd: _onSheetDragEnd,
      onTap: _toggleSheet,
      child: Container(
        width: double.infinity,
        height: 36,
        alignment: Alignment.center,
        child: Container(
          width: 40,
          height: 4,
          decoration: BoxDecoration(
            color: AppColors.handle,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }

  Widget _buildFooter() {
    final label = ['Products', 'Stores', 'Websites'][_tab];
    final brand = (_rows.isNotEmpty
            ? (_rows.first['tags'] ?? '').toString()
            : '')
        .trim();
    final subtitle = _tab == 0 && _rows.isNotEmpty
        ? (brand.isEmpty
            ? '${_rows.length} rows'
            : '$brand · ${_rows.length} rows')
        : null;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _expandSheet,
      onVerticalDragUpdate: _onSheetDragUpdate,
      onVerticalDragEnd: _onSheetDragEnd,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(label,
              style: const TextStyle(
                  color: AppColors.text, fontSize: 12, fontWeight: FontWeight.w600)),
          if (subtitle != null) ...[
            const SizedBox(width: 8),
            Text(subtitle,
                style: const TextStyle(color: AppColors.muted, fontSize: 11)),
          ],
          const SizedBox(width: 2),
          const Icon(Icons.keyboard_arrow_up,
              size: 18, color: AppColors.muted),
        ],
      ),
    );
  }

  void _onSheetDragUpdate(DragUpdateDetails d) {
    if (_screenH <= 0) return;
    final delta = -d.delta.dy / _screenH;
    _sheetAnim.value = (_sheetAnim.value + delta).clamp(0.0, _maxFraction);
  }

  void _onSheetDragEnd(DragEndDetails d) {
    final v = d.primaryVelocity ?? 0;
    double target;
    if (v < -300) {
      target = _snapUp(_sheetAnim.value);
    } else if (v > 300) {
      target = _snapDown(_sheetAnim.value);
    } else {
      target = _nearestSnap(_sheetAnim.value);
    }
    _animateToSnap(target);
  }

  void _animateToSnap(double target) {
    HapticFeedback.mediumImpact();
    _sheetAnim.animateTo(target,
        curve: AppMotion.easeOut, duration: AppMotion.normal);
  }

  double _nearestSnap(double v) {
    double best = _snapFractions.first;
    double bestDist = double.infinity;
    for (final s in _snapFractions) {
      final dist = (s - v).abs();
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    return best;
  }

  double _snapUp(double v) {
    for (final s in _snapFractions) {
      if (s > v + 0.001) return s;
    }
    return _maxFraction;
  }

  double _snapDown(double v) {
    for (final s in _snapFractions.reversed) {
      if (s < v - 0.001) return s;
    }
    return 0.0;
  }

  void _expandSheet() => _animateToSnap(_maxFraction);
  void _collapseSheet() => _animateToSnap(0.0);
  void _toggleSheet() {
    final v = _sheetAnim.value;
    if (v >= _maxFraction - 0.001) {
      _collapseSheet();
    } else {
      _animateToSnap(_snapUp(v));
    }
  }

  Widget _buildPanel() {
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Column(
        children: [
          _buildTabs(),
          Expanded(
            child: AnimatedSwitcher(
              duration: AppMotion.normal,
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              transitionBuilder: (child, anim) {
                final offset =
                    Tween<Offset>(begin: const Offset(0, 0.04), end: Offset.zero)
                        .animate(anim);
                return FadeTransition(
                  opacity: anim,
                  child: SlideTransition(position: offset, child: child),
                );
              },
              child: KeyedSubtree(
                key: ValueKey(_tab),
                child: _tab == 0
                    ? _buildProducts()
                    : _tab == 1
                        ? _buildStores()
                        : _buildWebsites(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTabs() {
    Widget tab(String label, int i) {
      final active = _tab == i;
      return Expanded(
        child: InkWell(
          onTap: () {
            if (_tab != i) {
              setState(() => _tab = i);
              HapticFeedback.selectionClick();
            }
          },
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 16),
            alignment: Alignment.center,
            child: AnimatedDefaultTextStyle(
              duration: AppMotion.fast,
              style: TextStyle(
                color: active ? AppColors.text : AppColors.muted,
                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                fontSize: 14,
              ),
              child: Text(label),
            ),
          ),
        ),
      );
    }

    // Sliding pill indicator behind the active tab.
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Stack(
        children: [
          AnimatedAlign(
            duration: AppMotion.normal,
            curve: AppMotion.easeOut,
            alignment: Alignment(
              -1.0 + _tab, // -1, 0, +1 for 3 tabs
              0,
            ),
            child: FractionallySizedBox(
              widthFactor: 1 / 3,
              child: Container(
                height: 46,
                margin: const EdgeInsets.all(3),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(9),
                  boxShadow: [
                    BoxShadow(
                      color: AppColors.text.withValues(alpha: 0.08),
                      blurRadius: 6,
                      offset: const Offset(0, 1),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Row(children: [
            tab('Products', 0),
            tab('Stores', 1),
            tab('Websites', 2),
          ]),
        ],
      ),
    );
  }

  // ── Products panel ─────────────────────────────────────────────────────────
  Widget _buildProducts() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_rows.isEmpty && _steps.isEmpty) ...[
            const SizedBox(height: 20),
            const Text(
              'Scrape Any Ecommerce Website!',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w500),
            ),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(
                child: FilledButton(
                  onPressed: _busy ? null : _scrape,
                  child: const Text('Scrape this page'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : _addScraper,
                  child: const Text('Add new Scrapper'),
                ),
              ),
            ]),
          ] else if (_steps.isNotEmpty) ...[
            _buildSteps(),
          ],
          if (_statusMsg.isNotEmpty) _buildStatus(),
          if (_busy && !_cancelled)
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: _cancel,
                icon: const Icon(Icons.close, size: 16),
                label: const Text('Cancel'),
              ),
            ),
          if (_statusType == 'error')
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: _retryLast,
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('Retry'),
              ),
            ),
          if (_notProduct && !_busy)
            FilledButton.icon(
              onPressed: _goBack,
              icon: const Icon(Icons.arrow_back, size: 18),
              label: const Text('Go back'),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          if (_thought.isNotEmpty)
            AnimatedSwitcher(
              duration: AppMotion.fast,
              transitionBuilder: (child, anim) =>
                  FadeTransition(opacity: anim, child: child),
              child: Container(
                key: ValueKey(_thought),
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.surfaceMuted,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.border),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Padding(
                      padding: EdgeInsets.only(top: 1),
                      child: Icon(Icons.auto_awesome,
                          size: 14, color: AppColors.accent),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        _thought,
                        style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                            fontStyle: FontStyle.italic),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (_rows.isNotEmpty) _buildResults(),
          if (_showChat) _reveal(_buildChat()),
          if (_showDone) _reveal(_buildDone()),
        ],
      ),
    );
  }

  Widget _reveal(Widget child) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: AppMotion.normal,
      curve: AppMotion.easeOut,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(
          offset: Offset(0, 16 * (1 - t)),
          child: child,
        ),
      ),
      child: child,
    );
  }

  Widget _buildDone() {
    return Container(
      margin: const EdgeInsets.only(top: 12),
      child: FilledButton.icon(
        onPressed: _resetToScrape,
        icon: const Icon(Icons.arrow_back, size: 18),
        label: const Text('Back to scrape screen'),
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(vertical: 14),
        ),
      ),
    );
  }

  void _resetToScrape() {
    setState(() {
      _rows = [];
      _steps.clear();
      _thought = '';
      _statusMsg = '';
      _statusType = '';
      _showDone = false;
      _showChat = false;
      _chat.clear();
      _chatBusy = false;
      _cancelled = false;
      _notProduct = false;
      _showSuccess = false;
    });
  }

  Widget _buildSteps() {
    return AnimatedSize(
      duration: AppMotion.normal,
      curve: AppMotion.easeOut,
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          children: _stepLabels.entries.map((e) {
            final step = e.key;
            final st = _steps[step] ?? {'state': 'pending', 'detail': ''};
            final state = st['state']!;
            final detail = st['detail']!;
            final running = state == 'running';
            final mark = state == 'fail'
                ? '✕'
                : state == 'done'
                    ? '✓'
                    : state == 'skip'
                        ? '–'
                        : state == 'value'
                            ? ''
                            : '…';
            final markColor = state == 'fail'
                ? AppColors.error
                : state == 'done'
                    ? AppColors.success
                    : AppColors.accent;
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 160,
                    child: Text(e.value,
                        style: const TextStyle(
                            color: AppColors.text,
                            fontSize: 12,
                            fontWeight: FontWeight.w500)),
                  ),
                  const Spacer(),
                  AnimatedDefaultTextStyle(
                    duration: AppMotion.fast,
                    style: TextStyle(
                        color: running ? AppColors.accent : AppColors.muted,
                        fontSize: 11),
                    child: Text(detail),
                  ),
                  const SizedBox(width: 8),
                  TweenAnimationBuilder<double>(
                    key: ValueKey('$step-$state'),
                    tween: Tween(begin: 0.6, end: 1.0),
                    duration: AppMotion.fast,
                    curve: Curves.elasticOut,
                    builder: (context, scale, child) =>
                        Transform.scale(scale: scale, child: child),
                    child: running
                        ? FadeTransition(
                            opacity: Tween(begin: 0.35, end: 1.0)
                                .animate(_pulseAnim),
                            child: Text(mark,
                                style: TextStyle(
                                    color: markColor, fontSize: 13)),
                          )
                        : Text(mark,
                            style:
                                TextStyle(color: markColor, fontSize: 13)),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ),
    );
  }

  Widget _buildStatus() {
    final color = _statusType == 'success'
        ? AppColors.success
        : _statusType == 'error'
            ? AppColors.error
            : _statusType == 'warn'
                ? AppColors.warn
                : AppColors.muted;
    return TweenAnimationBuilder<double>(
      key: ValueKey(_statusMsg),
      tween: Tween(begin: 0, end: 1),
      duration: AppMotion.fast,
      curve: AppMotion.easeOut,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(
          offset: Offset(0, 8 * (1 - t)),
          child: child,
        ),
      ),
      child: Container(
        margin: const EdgeInsets.only(top: 10),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Icon(
              _statusType == 'success'
                  ? Icons.check_circle
                  : _statusType == 'error'
                      ? Icons.error
                      : _statusType == 'warn'
                          ? Icons.warning_amber
                          : Icons.info,
              size: 16,
              color: color,
            ),
            const SizedBox(width: 8),
            Expanded(
              child:
                  Text(_statusMsg, style: TextStyle(color: color, fontSize: 12)),
            ),
          ],
        ),
      ),
    );
  }

  DataCell _dataCellFor(String c, Map<String, dynamic> r) {
    final v = r[c];
    if (c == 'Images' || c == 'Rey Variations extra images') {
      final list = v is List ? v : (v == null ? [] : [v]);
      return DataCell(SizedBox(
        height: 30,
        child: Row(
          children: (list.isEmpty ? [''] : list)
              .take(2)
              .map((u) => u.toString().isEmpty
                  ? const SizedBox.shrink()
                  : Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: Image.network(u.toString(),
                          width: 28,
                          height: 28,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) =>
                              const SizedBox.shrink()),
                    ))
              .toList(),
        ),
      ));
    }
    if (c == 'Rey Swatches') {
      final t = _reySwatches(r);
      return DataCell(Text(
          t.isEmpty ? '' : (t.length > 80 ? '${t.substring(0, 80)}…' : t),
          style: const TextStyle(fontSize: 10)));
    }
    final t = _cell(v);
    return DataCell(
        Text(t.length > 60 ? '${t.substring(0, 60)}…' : t,
            style: const TextStyle(fontSize: 11)));
  }

  /// The product's scraped images (from the parent row for variable products,
  /// or the single row for simple products). Used for the gallery above the
  /// table so images are visible without scrolling the column list to the end.
  List<String> _productImages() {
    if (_rows.isEmpty) return [];
    Map<String, dynamic> parent;
    if (_type == 'variable') {
      parent = _rows.firstWhere((r) => r['Type'] == 'variable',
          orElse: () => _rows.first);
    } else {
      parent = _rows.first;
    }
    final v = parent['Images'];
    final list = v is List ? v : (v == null ? [] : [v]);
    return list.map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
  }

  Widget _buildResults() {
    final cols = _type == 'simple' ? _simpleCols : _variableCols;
    final varIds = _variationIds();
    final showSel = _type == 'variable' && varIds.isNotEmpty;
    final allSelected =
        varIds.isNotEmpty && varIds.every((id) => _selectedIds.contains(id));
    final images = _productImages();
    return TweenAnimationBuilder<double>(
      key: ValueKey('results-${_rows.length}'),
      tween: Tween(begin: 0, end: 1),
      duration: AppMotion.normal,
      curve: AppMotion.easeOut,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(
          offset: Offset(0, 16 * (1 - t)),
          child: child,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (showSel)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: AnimatedSwitcher(
                duration: AppMotion.fast,
                transitionBuilder: (child, anim) =>
                    FadeTransition(opacity: anim, child: child),
                child: Text(
                  '${_selectedIds.length} of ${varIds.length} variants selected',
                  key: ValueKey(_selectedIds.length),
                  style:
                      const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ),
            ),
          if (images.isNotEmpty) ...[
            const SizedBox(height: 8),
            SizedBox(
              height: 72,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: images.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) => ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.network(
                    images[i],
                    width: 72,
                    height: 72,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      width: 72,
                      height: 72,
                      color: AppColors.surfaceMuted,
                      child: const Icon(Icons.broken_image,
                          size: 24, color: AppColors.muted),
                    ),
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 4),
          Container(
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(8),
            ),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SingleChildScrollView(
                child: DataTable(
                  headingRowColor:
                      WidgetStateProperty.all(AppColors.surfaceMuted),
                  columns: [
                    if (showSel)
                      DataColumn(
                        label: Checkbox(
                          value: allSelected,
                          onChanged: (v) => setState(() {
                            _selectedIds
                              ..clear()
                              ..addAll(v == true ? varIds : []);
                          }),
                        ),
                      ),
                    ...cols.map((c) => DataColumn(
                        label: Text(c,
                            style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w500)))),
                  ],
                  rows: _rows.map((r) {
                    final isVar = r['Type'] == 'variation';
                    final id = r['ID'].toString();
                    final cells = <DataCell>[];
                    if (showSel) {
                      cells.add(DataCell(
                        isVar
                            ? Checkbox(
                                value: _selectedIds.contains(id),
                                onChanged: (v) => setState(() {
                                  if (v == true) {
                                    _selectedIds.add(id);
                                  } else {
                                    _selectedIds.remove(id);
                                  }
                                }),
                              )
                            : const SizedBox.shrink(),
                      ));
                    }
                    cells.addAll(cols.map((c) => _dataCellFor(c, r)));
                    return DataRow(cells: cells);
                  }).toList(),
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _showImportPicker,
            icon: const Icon(Icons.cloud_upload, size: 22),
            label: const Text('Import to website'),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 18),
              textStyle: const TextStyle(
                  fontSize: 16, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: _resetToScrape,
            icon: const Icon(Icons.add, size: 18),
            label: const Text('Scrape new one'),
          ),
        ],
      ),
    );
  }

  Widget _buildChat() {
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [AppColors.accent, Color(0xFF9D8CFF)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(Icons.auto_awesome,
                    size: 16, color: Colors.white),
              ),
              const SizedBox(width: 10),
              const Expanded(
                child: Text('Fix the scraper',
                    style:
                        TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 240),
            child: SingleChildScrollView(
              reverse: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: _chat.map((m) {
                  final isUser = m['role'] == 'user';
                  return Align(
                    alignment: isUser
                        ? Alignment.centerRight
                        : Alignment.centerLeft,
                    child: Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 9),
                      constraints: const BoxConstraints(maxWidth: 300),
                      decoration: BoxDecoration(
                        color: isUser
                            ? AppColors.accent
                            : AppColors.surfaceMuted,
                        borderRadius: BorderRadius.only(
                          topLeft: const Radius.circular(14),
                          topRight: const Radius.circular(14),
                          bottomLeft:
                              Radius.circular(isUser ? 14 : 2),
                          bottomRight:
                              Radius.circular(isUser ? 2 : 14),
                        ),
                      ),
                      child: Text(
                        m['text'] ?? '',
                        style: TextStyle(
                          color: isUser ? Colors.white : AppColors.text,
                          fontSize: 12.5,
                          height: 1.3,
                        ),
                      ),
                    ),
                  );
                }).toList(),
              ),
            ),
          ),
          if (_chatBusy)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  SizedBox(width: 8),
                  Text('Agent is working…',
                      style: TextStyle(
                          color: AppColors.muted, fontSize: 12)),
                ],
              ),
            ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _chatController,
                  enabled: !_chatBusy,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _sendChat(),
                  decoration: InputDecoration(
                    hintText: 'Describe what\'s wrong…',
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 11),
                    filled: true,
                    fillColor: AppColors.surfaceMuted,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(22),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                onPressed: _chatBusy ? null : _sendChat,
                icon: const Icon(Icons.send, size: 18),
                style: IconButton.styleFrom(
                  backgroundColor: AppColors.accent,
                  foregroundColor: Colors.white,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _chatBusy ? null : _finishScraper,
            icon: const Icon(Icons.check, size: 18),
            label: const Text('Looks good — save scraper'),
          ),
        ],
      ),
    );
  }

  // ── Stores panel ───────────────────────────────────────────────────────────
  Widget _buildStores() {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                _stores.isEmpty ? 'Stores' : 'Stores (${_stores.length})',
                style: const TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            FilledButton.icon(
              onPressed: _openAddStore,
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Add store'),
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.compact,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (_stores.isEmpty)
          Column(
            children: [
              const _EmptyState(
                icon: Icons.store,
                title: 'No stores yet',
                subtitle:
                    'Add a WooCommerce store to import scraped products into.',
              ),
              const SizedBox(height: 4),
              OutlinedButton.icon(
                onPressed: _openAddStore,
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add your first store'),
              ),
            ],
          )
        else
          ..._stores.map((s) {
            final id = s['id']?.toString() ?? '';
            final testState = _storeTestState[id];
            final testMsg = _storeTestMsg[id];
            final name = (s['name'] ?? '').toString();
            final host = _hostOf(s['url'] ?? '');
            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: const BorderSide(color: AppColors.border),
              ),
              child: Column(
                children: [
                  ListTile(
                    onTap: () => _openEditStore(s),
                    leading: CircleAvatar(
                      backgroundColor:
                          AppColors.accent.withValues(alpha: 0.14),
                      foregroundColor: AppColors.accent,
                      child: Text(
                        name.isEmpty ? '?' : name[0].toUpperCase(),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    title: Text(name,
                        style: const TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 14)),
                    subtitle: Text(host,
                        style: const TextStyle(fontSize: 11)),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: testState == 'loading'
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2))
                              : const Icon(Icons.wifi_tethering, size: 20),
                          onPressed: testState == 'loading'
                              ? null
                              : () => _testStore(s),
                          tooltip: 'Test connection',
                        ),
                        PopupMenuButton<String>(
                          tooltip: 'More',
                          onSelected: (v) {
                            if (v == 'test') {
                              _testStore(s);
                            } else if (v == 'edit') {
                              _openEditStore(s);
                            } else if (v == 'delete') {
                              _deleteStore(s);
                            }
                          },
                          itemBuilder: (_) => const [
                            PopupMenuItem(
                                value: 'test',
                                child: Text('Test connection')),
                            PopupMenuItem(value: 'edit', child: Text('Edit')),
                            PopupMenuItem(
                                value: 'delete', child: Text('Delete')),
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (testState != null)
                    AnimatedSize(
                      duration: AppMotion.fast,
                      curve: AppMotion.easeOut,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                        child: Row(
                          children: [
                            Icon(
                              testState == 'ok'
                                  ? Icons.check_circle
                                  : testState == 'error'
                                      ? Icons.cancel
                                      : Icons.info,
                              size: 14,
                              color: testState == 'ok'
                                  ? AppColors.success
                                  : testState == 'error'
                                      ? AppColors.error
                                      : AppColors.muted,
                            ),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(testMsg ?? '',
                                  style: TextStyle(
                                      fontSize: 11,
                                      color: testState == 'ok'
                                          ? AppColors.success
                                          : testState == 'error'
                                              ? AppColors.error
                                              : AppColors.muted)),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            );
          }),
      ],
    );
  }

  String _hostOf(String url) {
    final u = Uri.tryParse(url);
    if (u == null) return url;
    return u.host.isEmpty ? url : u.host.replaceFirst(RegExp(r'^www\.'), '');
  }

  Future<void> _openAddStore() async {
    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => _StoreSheet(engine: _engine),
    );
    if (result == null || !mounted) return;
    result['id'] = DateTime.now().millisecondsSinceEpoch.toString();
    setState(() => _stores.add(result));
    await _saveStores();
    _showStoreToast('Store saved.');
  }

  Future<void> _openEditStore(Map<String, dynamic> s) async {
    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => _StoreSheet(engine: _engine, initial: s),
    );
    if (result == null || !mounted) return;
    final i = _stores.indexWhere((x) => x['id'] == s['id']);
    if (i >= 0) {
      setState(() => _stores[i].addAll({'id': s['id'], ...result}));
    }
    await _saveStores();
    _showStoreToast('Store updated.');
  }

  void _showStoreToast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  Future<void> _deleteStore(Map<String, dynamic> s) async {
    final name = (s['name'] ?? '').toString();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete store?'),
        content: Text('Remove "$name" from your stores?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.error,
            ),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _stores.removeWhere((x) => x['id'] == s['id']);
      final id = s['id']?.toString() ?? '';
      _storeTestState.remove(id);
      _storeTestMsg.remove(id);
    });
    await _saveStores();
  }

  Future<void> _testStore(Map<String, dynamic> s) async {
    final id = s['id']?.toString() ?? '';
    setState(() {
      _storeTestState[id] = 'loading';
      _storeTestMsg[id] = 'Testing connection…';
    });
    final res =
        await _engine.wcTest(store: s['url'] ?? '', authKey: s['authKey'] ?? '');
    if (!mounted) return;
    setState(() {
      _storeTestState[id] = res['ok'] == true ? 'ok' : 'error';
      _storeTestMsg[id] = res['ok'] == true
          ? (res['message'] ?? 'Connected')
          : (res['error'] ?? 'Connection failed');
    });
  }

  // ── Websites panel ─────────────────────────────────────────────────────────
  Widget _buildWebsites() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _loadWebsites();
    });
    if (_websitesLoading && !_websitesLoaded) {
      return _buildSkeleton();
    }
    if (_websitesError != null && !_websitesLoaded) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off, size: 40, color: AppColors.muted),
              const SizedBox(height: 12),
              const Text('Could not load websites',
                  style: TextStyle(color: AppColors.muted)),
              const SizedBox(height: 4),
              Text(_websitesError!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                      color: AppColors.muted, fontSize: 11)),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () {
                  _websitesError = null;
                  setState(() {});
                },
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }
    if (_websites.isEmpty) {
      return const _EmptyState(
        icon: Icons.language,
        title: 'No websites yet',
        subtitle: 'Scrape a product to add its site, or add a scraper for a new one.',
      );
    }
    final query = _websiteSearch.trim().toLowerCase();
    final filtered = query.isEmpty
        ? _websites
        : _websites.where((w) {
            final brand = (w['brand'] ?? '').toString();
            final domain = (w['domain'] ?? '').toString();
            return brand.toLowerCase().contains(query) ||
                domain.toLowerCase().contains(query);
          }).toList();
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        TextField(
          onChanged: (v) => setState(() => _websiteSearch = v),
          decoration: InputDecoration(
            isDense: true,
            hintText: 'Search websites',
            prefixIcon: const Icon(Icons.search, size: 20),
            suffixIcon: _websiteSearch.isEmpty
                ? null
                : IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => setState(() => _websiteSearch = ''),
                  ),
            filled: true,
            fillColor: AppColors.surfaceMuted,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide.none,
            ),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          ),
        ),
        const SizedBox(height: 10),
        if (filtered.isEmpty)
          const _EmptyState(
            icon: Icons.search_off,
            title: 'No matches',
            subtitle: 'No websites match your search.',
          )
        else
          ...filtered.map((w) {
            final types = (w['types'] as List).cast<String>();
            final predefined = w['predefined'] == true;
            final brand = (w['brand'] ?? '').toString().isNotEmpty
                ? w['brand'].toString()
                : ScraperEngine.brandFromDomain(w['domain'] ?? '');
            return Card(
              margin: const EdgeInsets.only(bottom: 6),
              child: ListTile(
                dense: true,
                title: Text(brand, style: const TextStyle(fontSize: 13)),
                subtitle: Wrap(
                  spacing: 6,
                  children: types
                      .map((t) => Chip(
                            label: Text(t,
                                style: const TextStyle(fontSize: 10)),
                            visualDensity: VisualDensity.compact,
                          ))
                      .toList(),
                ),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if ((w['example'] ?? '').toString().isNotEmpty)
                      TextButton(
                        onPressed: () =>
                            _navigateTo(w['example'].toString()),
                        child: const Text('Example'),
                      ),
                    if (!predefined)
                      IconButton(
                        icon: const Icon(Icons.delete, size: 18),
                        onPressed: () => _deleteScraper(w['domain'] ?? ''),
                      ),
                  ],
                ),
              ),
            );
          }),
      ],
    );
  }

  Future<void> _navigateTo(String url) async {
    _urlController.text = url;
    await _browser.navigate(url);
    setState(() => _tab = 0);
  }

  Future<void> _deleteScraper(String domain) async {
    await SupabaseClient().deleteScraperByDomain(domain);
    _websitesLoaded = false;
    _loadWebsites();
  }

  Widget _buildSkeleton() {
    Widget line(double w) => Container(
          width: w,
          height: 12,
          decoration: BoxDecoration(
            color: AppColors.surfaceMuted,
            borderRadius: BorderRadius.circular(6),
          ),
        );
    return AnimatedBuilder(
      animation: _pulseAnim,
      builder: (context, _) => Opacity(
        opacity: 0.5 + 0.5 * _pulseAnim.value,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: List.generate(6, (_) {
            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    line(140),
                    const SizedBox(height: 8),
                    line(double.infinity),
                    const SizedBox(height: 6),
                    line(80),
                  ],
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}

/// Modal sheet that imports a scraped CSV into each selected store in turn,
/// showing per-store progress and a summary.
class _ImportProgressSheet extends StatefulWidget {
  const _ImportProgressSheet({
    required this.engine,
    required this.stores,
    required this.csv,
    required this.skipResize,
  });

  final ScraperEngine engine;
  final List<Map<String, dynamic>> stores;
  final String csv;
  final bool skipResize;

  @override
  State<_ImportProgressSheet> createState() => _ImportProgressSheetState();
}

class _ImportProgressSheetState extends State<_ImportProgressSheet> {
  final Map<String, String> _status = {}; // loading|created|updated|error
  final Map<String, String> _err = {};
  bool _done = false;

  @override
  void initState() {
    super.initState();
    for (final s in widget.stores) {
      _status[s['id']?.toString() ?? ''] = 'loading';
    }
    _run();
  }

  Future<void> _run() async {
    for (final s in widget.stores) {
      final id = s['id']?.toString() ?? '';
      final res = await widget.engine.wcImport(
        store: s['url'] ?? '',
        authKey: s['authKey'] ?? '',
        csv: widget.csv,
        skipResize: widget.skipResize,
      );
      if (!mounted) return;
      setState(() {
        if (res['ok'] == true) {
          final data = res['data'];
          var updated = 0;
          var created = 0;
          if (data is Map) {
            updated = (data['updated_variable'] as num?)?.toInt() ?? 0;
            created = ((data['created_variable'] as num?)?.toInt() ?? 0) +
                ((data['created_simple'] as num?)?.toInt() ?? 0);
          }
          _status[id] = (updated > 0 && created == 0) ? 'updated' : 'created';
        } else {
          _status[id] = 'error';
          _err[id] = (res['error'] ?? 'Failed').toString();
        }
      });
    }
    if (mounted) setState(() => _done = true);
  }

  Widget _trailing(String id) {
    final st = _status[id] ?? 'loading';
    switch (st) {
      case 'loading':
        return const SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2));
      case 'created':
        return const Icon(Icons.check_circle, color: AppColors.success, size: 20);
      case 'updated':
        return const Icon(Icons.sync, color: AppColors.warn, size: 20);
      case 'error':
        return const Icon(Icons.cancel, color: AppColors.error, size: 20);
    }
    return const SizedBox.shrink();
  }

  String _label(String id) {
    switch (_status[id] ?? 'loading') {
      case 'loading':
        return 'Importing…';
      case 'created':
        return 'Created';
      case 'updated':
        return 'Updated';
      case 'error':
        return 'Failed';
    }
    return '';
  }

  @override
  Widget build(BuildContext context) {
    final ok = _status.values
        .where((v) => v == 'created' || v == 'updated')
        .length;
    final err = _status.values.where((v) => v == 'error').length;
    final title = _done
        ? (err == 0 ? 'Import complete' : '$ok imported, $err failed')
        : 'Importing…';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title,
                style: const TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: widget.stores.map((s) {
                  final id = s['id']?.toString() ?? '';
                  return ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(s['name'] ?? ''),
                    subtitle: Text(
                      _err.containsKey(id) ? _err[id]! : _label(id),
                      style: TextStyle(
                        fontSize: 11,
                        color: _status[id] == 'error'
                            ? AppColors.error
                            : AppColors.muted,
                      ),
                    ),
                    trailing: _trailing(id),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 8),
            if (_done)
              FilledButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Done'),
              ),
          ],
        ),
      ),
    );
  }
}

/// Add/edit store bottom sheet. Owns its own controllers and validation,
/// optionally tests the connection, and returns the store map on save.
class _StoreSheet extends StatefulWidget {
  const _StoreSheet({required this.engine, this.initial});

  final ScraperEngine engine;
  final Map<String, dynamic>? initial;

  @override
  State<_StoreSheet> createState() => _StoreSheetState();
}

class _StoreSheetState extends State<_StoreSheet> {
  late final TextEditingController _name;
  late final TextEditingController _url;
  late final TextEditingController _authKey;
  bool _obscure = true;
  String? _nameErr;
  String? _urlErr;
  String _testState = ''; // '', 'loading', 'ok', 'error'
  String _testMsg = '';

  bool get _isEditing => widget.initial != null;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.initial?['name'] ?? '');
    _url = TextEditingController(text: widget.initial?['url'] ?? '');
    _authKey = TextEditingController(text: widget.initial?['authKey'] ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _authKey.dispose();
    super.dispose();
  }

  bool _canTest() =>
      _url.text.trim().isNotEmpty && _authKey.text.trim().isNotEmpty;

  Future<void> _test() async {
    setState(() {
      _testState = 'loading';
      _testMsg = 'Testing connection…';
    });
    final res = await widget.engine.wcTest(
        store: _url.text.trim(), authKey: _authKey.text.trim());
    if (!mounted) return;
    setState(() {
      _testState = res['ok'] == true ? 'ok' : 'error';
      _testMsg = res['ok'] == true
          ? (res['message'] ?? 'Connected')
          : (res['error'] ?? 'Connection failed');
    });
  }

  void _save() {
    final name = _name.text.trim();
    final url = _url.text.trim();
    final urlValid = RegExp(r'^https?://').hasMatch(url);
    setState(() {
      _nameErr = name.isEmpty ? 'Store name is required.' : null;
      _urlErr = url.isEmpty
          ? 'Store URL is required.'
          : (!urlValid ? 'URL must start with http:// or https://' : null);
    });
    if (_nameErr != null || _urlErr != null) return;
    Navigator.pop(context, {
      'name': name,
      'url': url,
      'authKey': _authKey.text.trim(),
    });
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 16 + bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 10),
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.handle,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [AppColors.accent, Color(0xFF9D8CFF)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Icon(
                      _isEditing ? Icons.edit : Icons.storefront,
                      color: Colors.white,
                      size: 24,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _isEditing ? 'Edit store' : 'Add store',
                          style: const TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w700,
                              color: AppColors.text),
                        ),
                        const SizedBox(height: 2),
                        const Text(
                          'Connect a WooCommerce store for imports.',
                          style: TextStyle(
                              color: AppColors.muted, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _buildField(
                controller: _name,
                label: 'Store name',
                hint: 'My store',
                icon: Icons.store,
                errorText: _nameErr,
              ),
              const SizedBox(height: 14),
              _buildField(
                controller: _url,
                label: 'Store URL',
                hint: 'https://store.com',
                icon: Icons.link,
                keyboardType: TextInputType.url,
                errorText: _urlErr,
              ),
              const SizedBox(height: 14),
              _buildField(
                controller: _authKey,
                label: 'Auth key',
                hint: 'From the plugin dashboard',
                icon: Icons.key,
                obscure: _obscure,
                suffixIcon: IconButton(
                  icon: Icon(
                    _obscure ? Icons.visibility_off : Icons.visibility,
                    size: 20,
                    color: AppColors.muted,
                  ),
                  onPressed: () => setState(() => _obscure = !_obscure),
                  tooltip: _obscure ? 'Show key' : 'Hide key',
                ),
              ),
              const SizedBox(height: 18),
              if (_testState.isNotEmpty) _buildTestResult(),
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed:
                          _canTest() && _testState != 'loading' ? _test : null,
                      icon: const Icon(Icons.wifi_tethering, size: 18),
                      label: const Text('Test connection'),
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      onPressed: _save,
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      child: Text(_isEditing ? 'Update store' : 'Save store'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildField({
    required TextEditingController controller,
    required String label,
    required String hint,
    required IconData icon,
    String? errorText,
    TextInputType? keyboardType,
    bool obscure = false,
    Widget? suffixIcon,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      obscureText: obscure,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        errorText: errorText,
        errorMaxLines: 2,
        prefixIcon: Icon(icon, size: 20, color: AppColors.muted),
        suffixIcon: suffixIcon,
        filled: true,
        fillColor: AppColors.surfaceMuted,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.accent, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.error),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.error, width: 1.5),
        ),
      ),
    );
  }

  Widget _buildTestResult() {
    final ok = _testState == 'ok';
    final loading = _testState == 'loading';
    final color = loading
        ? AppColors.muted
        : (ok ? AppColors.success : AppColors.error);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          if (loading)
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            Icon(ok ? Icons.check_circle : Icons.cancel,
                size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _testMsg,
              style: TextStyle(
                  fontSize: 12, color: color, fontWeight: FontWeight.w500),
            ),
          ),
        ],
      ),
    );
  }
}

/// Icon-based empty state used by the Stores and Websites tabs.
class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: AppColors.surfaceMuted,
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 34, color: AppColors.muted),
            ),
            const SizedBox(height: 16),
            Text(title,
                style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(subtitle,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.muted, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}
