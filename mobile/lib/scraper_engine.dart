// ScraperEngine — a Dart port of the desktop core.js. Pure orchestration:
// DeepSeek classification/generation, scraper execution (delegated to the
// WebView via [runScraper]), Supabase registry, and WooCommerce import.
// No Flutter UI dependency, so it can be unit-tested headlessly.

import 'dart:convert';

import 'supabase_client.dart';

typedef RunScraperFn = Future<Map<String, dynamic>> Function({
  required String code,
  required String url,
  required String html,
  required String productType,
});

typedef ThinkingFn = void Function(String text);
typedef ProgressFn = void Function(int step, String state, String detail);

const String _genericHelpers = r'''
function decodeEntities(s){ return String(s==null?'':s)
  .replace(/&#x([0-9a-fA-F]+);/g,(_,n)=>String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(parseInt(n,10)))
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&bull;/g,'\u2022').replace(/&hellip;/g,'\u2026')
  .replace(/&mdash;/g,'\u2014').replace(/&ndash;/g,'\u2013').replace(/&reg;/g,'\u00ae').replace(/&trade;/g,'\u2122'); }
function normalizeShopUrl(src){ if(!src) return ''; const s=String(src).trim(); if(s.indexOf('$')>=0||s.indexOf('{')>=0||s.indexOf('}')>=0) return ''; const abs=s.startsWith('//')?'https:'+s:s; return abs.split('?')[0]; }
function ldBlocks(html){ return [...String(html||'').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]); }
const fmtPrice = p => { const n = parseFloat(p); return isFinite(n) ? n.toFixed(2) : ''; };
function simpleRow(o){ return [{ SKU: o.sku||'', Name: o.name||'', Description: o.description||'', 'Short Description': o.shortDesc||'', 'Regular Price': o.regularPrice||o.price||'', Categories: o.categories||'', Images: o.images||[], 'Sale Price': o.salePrice||'' }]; }
function variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2){
  optionName2 = optionName2 || '';
  const rows=[]; let rowId=1;
  const a1=[...new Set((variants||[]).map(v=>v.name).filter(Boolean))].join(',');
  const a2=[...new Set((variants||[]).map(v=>v.name2).filter(Boolean))].join(',');
  rows.push({ ID:rowId++, Parent:'', Type:'variable', SKU:'', Name:title, Images:(parentImages||[]).slice(0,4), 'Rey Variations extra images':'', Description:description||'', 'Short Description':shortDesc||'', Categories:categories||'', 'Regular Price':'', 'Sale Price':'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':a1, 'Attribute 1 visible':'1', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':a2, 'Attribute 2 visible':optionName2?'1':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':'' });
  const parentId=rowId-1;
  for(const v of variants){ rows.push({ ID:rowId++, Parent:'id:'+parentId, Type:'variation', SKU:v.sku||'', Name:title, Images:(v.images&&v.images.length)?[v.images[0]]:[], 'Rey Variations extra images':(v.extras&&v.extras.length)?v.extras:[], Description:'', 'Short Description':'', Categories:'', 'Regular Price':v.regularPrice||'', 'Sale Price':v.salePrice||'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':v.name||'', 'Attribute 1 visible':'', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':v.name2||'', 'Attribute 2 visible':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':v.colorCode||'' }); }
  return rows;
}
''';

String _generateSystem(String type) {
  final variableBlock = r'''This is a VARIABLE product: it has selectable options (size, colour, shade, etc.) and EACH option usually has its own price and its own photo.

Build rows with: variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2)

The variants array is the core of a variable product. Discover each option's data from THIS page's structure:
- Find the source of the option list — it may be embedded JSON (JSON-LD hasVariant/offers arrays, a "data-product_variations" attribute, inline "product.variants", "__NEXT_DATA__", etc.), or HTML elements (swatches, <option>, radio inputs) with their own data attributes. Use whichever this page actually provides.
- For EVERY option, produce one variant object with its OWN data (this is the whole point):
- INCLUDE EVERY OPTION: scrape ALL options/variants the page offers — including out-of-stock, unavailable, sold-out, or disabled ones. NEVER filter variants by stock/availability status. If an option is marked out of stock, still emit its variant (name, its own price if present, and its own photo if present).
  * name         — the option value (e.g. "Black", "Size M", "42").
  * name2        — the SECOND attribute's value for this option, ONLY when the product has more than one attribute (e.g. a product varying by colour AND size: name="Black", name2="M"; or material AND size: name="Cotton", name2="L"). If the product has a single attribute, set name2 to ''.
  * sku          — that option's own SKU/id, if the page provides one per option; else ''.
  * regularPrice — that option's OWN normal price (numeric string like "15.00", via fmtPrice).
  * salePrice    — that option's OWN sale price, ONLY if it is discounted; else ''.
  * images       — array of image URLs for THIS SPECIFIC option (its own photo). The FIRST image is the main photo. If a specific option has no distinct photo, set images to [] (never reuse another option's photo as if it were its own).
  * extras       — extra gallery images for this option (may be []).
  * colorCode    — hex colour or swatch image URL for this option, if the page provides it; else ''.
- "parentImages" = photos shown before any option is selected (the shared gallery). If the page only has per-option images, pass [].
- "optionName" = the attribute name (e.g. "Color", "Size", "Shade") — read it from the page; default to "Option" if absent.
- "optionName2" = the SECOND attribute name, ONLY when the product has more than one selectable attribute (e.g. "Size" when the first is "Color", or "Material" when the first is "Size"). This applies to ANY multi-attribute product, not just clothing. When there is only one attribute, pass '' (empty string) and leave every variant's name2 as ''.

CRITICAL: do NOT copy one price or one image across all options. If the page stores per-option data in a JSON structure whose keys differ from the examples above, read THOSE keys — the structure is whatever the page actually uses.''';

  final simpleBlock = r'''This is a SIMPLE product (single product, one price, no options). Build rows with: simpleRow({ sku, name, description, shortDesc, regularPrice, salePrice, categories, images }) and return { rows, title }. images is an array of image URL strings (normalizeShopUrl() each). regularPrice/salePrice are numeric strings like "20.76" (via fmtPrice). Use structured data if present; otherwise locate each field in the visible HTML as described above.''';

  return r'''You are an expert web-scraper engineer. Write a single JavaScript function for a Chrome extension that extracts product data from a product page's HTML.

Write ONLY the function definition (no markdown fences, no explanation):

async function run(ctx) { ... }

Inputs available on ctx:
- ctx.mainHtml (string) — the full page HTML (already downloaded for you).
- ctx.url (string) — the page URL.
- ctx.fetchText(url, opts) / ctx.fetchJson(url, opts) — optional fetch helpers (return string/object). Use only if the data is not already in mainHtml.

Helpers already defined in scope (DO NOT redefine them): decodeEntities(s), ldBlocks(html), normalizeShopUrl(src), fmtPrice(p), simpleRow(obj), variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2).

ldBlocks(html) returns an array of RAW JSON **strings** (the text inside each <script type="application/ld+json"> tag). Each must be JSON.parse()'d (try/catch) before reading fields:
const blocks = ldBlocks(ctx.mainHtml).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

──────────────────────────────────────────────────────────────
SPEED RULES (CRITICAL — you are on a strict time budget):

- Work FAST. Do not think out loud, do not plan, do not explain. Go straight from the HTML to the code.
- STRUCTURED DATA FIRST: if a JSON-LD block or embedded JSON already contains the name, price, sku, and images, read them DIRECTLY from it and STOP scanning. Do not re-derive them from raw HTML when structured data already has them.
- Write MINIMAL code: no comments, no logging, no dead branches, no defensive over-engineering. A few tight regex/parse lines are better than long loops.
- SINGLE PASS: gather every field once and return. Do not iterate, do not search exhaustively. If a field is not found on a quick look, return '' for it and move on — a missing optional field is acceptable, a slow scrape is not.
- Skip clearly irrelevant content (menus, footer, cookie banners, currency selectors). Only look near the product name, price, and add-to-cart button.

──────────────────────────────────────────────────────────────
OUTPUT CONTRACT (NON-NEGOTIABLE):

The ONLY correct return value is { rows, title }. You MUST build "rows" by calling the helper — do NOT hand-construct row objects and do NOT invent your own field names, because the downstream table columns are fixed and only these helpers produce them:

- simple product:   return { rows: simpleRow({ sku, name, description, shortDesc, regularPrice, salePrice, categories, images }), title };
- variable product: return { rows: variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2), title };

"title" is the product name (string). Never return rows as a plain object or with your own key names — always exactly simpleRow([...]) / variableRows(...) output.

──────────────────────────────────────────────────────────────
HOW TO WORK — READ THIS CAREFULLY:

Every website has a UNIQUE HTML structure. You MUST NOT assume specific class names, meta tags, attribute names, or platforms (WooCommerce, Shopify, JSON-LD, etc.). Your job is to INSPECT ctx.mainHtml for THIS specific page and discover, from its actual content, where each output field lives. There is no standard selector list to follow — derive the mapping from the page itself.

Think in this order:
1. Read ctx.mainHtml. Identify the product's main content area (near the product name/title, price, and "add to cart" button).
2. Look for structured data embedded in the page — JSON-LD blocks, inline JSON in <script> tags (e.g. "var product = {...}", "__NEXT_DATA__", "ShopifyAnalytics", "data-*" attributes). If present, read the fields DIRECTLY from it. Structured data is self-describing: use whatever keys it actually contains.
3. For every field that is NOT available as structured data, locate it in the visible HTML by looking at what is actually near the product content:
   - name/title: the page title, an <h1>, or a product-name heading.
   - price: a number with a currency symbol/code near the title or add-to-cart button. If two numbers are shown together (one struck-through or smaller), the higher is the regular price and the lower is the sale price.
   - sku/id: an identifier label ("SKU", "barcode", "product code", "MPN", "UPC", "EAN", "Code") with a value near it, or the numeric id in the URL.
   - images: the large <img> src(s) in the product gallery area.
   - description: a longer block of prose text describing the product.
   - categories: breadcrumb links or "Category" labels.
4. Do NOT hardcode anything you saw on a previous page. Match THIS page's structure.

NEVER return an empty field just because there is "no JSON-LD" — that is a failure. If a field's data exists anywhere in mainHtml, find it.

──────────────────────────────────────────────────────────────

''' +
      (type == 'variable' ? variableBlock : simpleBlock) +
      r'''

RULES:
- Never use document, window, location, self, or any DOM API. Only pure JS + regex + JSON + the provided helpers.
- For variable products, include ALL variants/options regardless of stock or availability. Never skip out-of-stock or unavailable variants.
- ALWAYS build rows via simpleRow(...) (simple) or variableRows(...) (variable) and return { rows, title }. Do NOT hand-build row objects or invent your own key names.
- Inspect ctx.mainHtml and derive the mapping from THIS page. Do not assume any specific framework, class, or meta tag.
- Use fmtPrice() to normalise every price, and strip query strings from image URLs (normalizeShopUrl()).
- Images: match ONLY real <img> src values (or srcset/data URLs) that look like actual URLs. Inline script blocks often contain JS template placeholders (a dollar sign followed by braces, e.g. "$img") that look like image markup — NEVER emit those as an image URL, and never emit any value containing "$" or "{". Strip script blocks (except JSON-LD) before matching images, or filter matches to those starting with http/https.
- Robustness: optional chaining and fall back to '' for missing fields.
- Keep the function SHORT (under ~60 lines). Prefer structured data over HTML scanning whenever possible.''';
}

const List<Map<String, String>> _productCheckPrompt = [
  {
    'role': 'system',
    'content':
        'You classify a web page. Respond with JSON only, no other text. Determine: (1) isProductPage — true if this is a product detail page (a single purchasable product with a name, price, and add-to-cart), false for a category/listing/home page. (2) productType — "simple" if it is a single product with one price and no options (size/color/etc.), or "variable" if it has selectable options/variants (size, color, etc.) that change the price; null if not a product page. (3) attributeCount — for variable products only: the number of distinct selectable attributes (1 or 2; e.g. just Color = 1, Color + Size = 2); null for simple or non-product. (4) attributes — for variable products only: an array, one object per attribute, each {"name": "...", "swatched": true|false, "swatchType": "color_code"|"image_url"|null}. name is the attribute label in lowercase (e.g. "color", "size", "weight", "flavor"). swatched is true only if selecting that attribute shows a visual swatch or thumbnail. swatchType is how the swatch is shown: "color_code" for a solid colour/hex swatch, "image_url" for a small image/thumbnail, or null if not swatched or unknown. Use [] for simple or non-product. Example: {"isProductPage": true, "productType": "variable", "attributeCount": 2, "attributes": [{"name": "color", "swatched": true, "swatchType": "image_url"}, {"name": "size", "swatched": false, "swatchType": null}]}.',
  },
];

// Human-readable hint for the scraper-generation agent, built from the
// classification: the attribute count/names + swatch info help the agent map
// optionName/optionName2 and each variant's colorCode on the first try.
String _buildAttributeHint(String pType, List<dynamic> attrs) {
  if (pType != 'variable') return '';
  final list = attrs.where((a) => a is Map && (a['name'] ?? '').toString().isNotEmpty).toList();
  if (list.isEmpty) return '';
  final parts = list.map((a) {
    final name = a['name'].toString();
    String swatch = '';
    if (a['swatched'] == true) {
      swatch = a['swatchType'] == 'image_url'
          ? ' (swatched: image thumbnails)'
          : (a['swatchType'] == 'color_code' ? ' (swatched: colour codes)' : ' (swatched)');
    }
    return name + swatch;
  }).toList();
  return 'Detected attributes: ${parts.join(', ')}. '
      'Use the first attribute as optionName and, if there is a second, the second as optionName2 '
      '(set each variant\'s name2 accordingly). If an attribute is swatched with a colour code or image thumbnail, '
      'store that value in the variant\'s colorCode field.';
}

class Verdict {
  final bool ok;
  final String problem;
  Verdict(this.ok, this.problem);
}

/// Thrown when the user cancels an in-flight AI generation.
class ScraperCancelled implements Exception {
  const ScraperCancelled();
  @override
  String toString() => 'Cancelled';
}

class ScraperEngine {
  final SupabaseClient sb;
  final RunScraperFn runScraper;
  final ThinkingFn? onThinking;
  final ProgressFn? onProgress;
  final bool Function()? isCancelled;

  String? _predefinedBody;
  int? _predefinedVersion;

  ScraperEngine({
    required this.sb,
    required this.runScraper,
    this.onThinking,
    this.onProgress,
    this.isCancelled,
  });

  void _progress(int step, String state, String detail) {
    onProgress?.call(step, state, detail);
  }

  void _thinking(String text) {
    onThinking?.call(text);
  }

  String _trimThinking(String text) {
    final t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (t.isEmpty) return '';
    return t.length > 240 ? '${t.substring(0, 240)}…' : t;
  }

  String _formatBytes(int n) {
    if (n < 1024) return '$n B';
    if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(0)} KB';
    return '${(n / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  static String stripFences(String s) {
    var t = s;
    t = t.replaceFirst(RegExp(r'^```(?:json|javascript|js)?\s*', caseSensitive: false), '');
    t = t.replaceFirst(RegExp(r'\s*```$'), '');
    return t.trim();
  }

  static String condenseHtml(String html) {
    final h = html;
    final lds = RegExp(
            r'<script[^>]*application/ld\+json[^>]*>([\s\S]*?)</script>',
            caseSensitive: false)
        .allMatches(h)
        .map((m) => m.group(1))
        .join('\n');
    final text = h
        .replaceAll(RegExp(r'<script[\s\S]*?</script>', caseSensitive: false), ' ')
        .replaceAll(RegExp(r'<style[\s\S]*?</style>', caseSensitive: false), ' ')
        .replaceAll(RegExp(r'<[^>]+>'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return 'URL JSON-LD:\n${lds.length > 6000 ? lds.substring(0, 6000) : lds}\n\nPAGE TEXT:\n${text.length > 16000 ? text.substring(0, 16000) : text}';
  }

  static String scraperHtmlSample(String html) {
    final h = html;
    final lds = RegExp(
            r'<script[^>]*application/ld\+json[^>]*>([\s\S]*?)</script>',
            caseSensitive: false)
        .allMatches(h)
        .map((m) => m.group(1))
        .join('\n---\n');
    final title = RegExp(r'<title[^>]*>([\s\S]*?)</title>', caseSensitive: false)
            .firstMatch(h)
            ?.group(1) ??
        '';
    final og = RegExp(
            r'<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>',
            caseSensitive: false)
        .allMatches(h)
        .map((m) => 'og:${m.group(1)}=${m.group(2)}')
        .join('\n');
    final ogTitle = RegExp(
            r'<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>',
            caseSensitive: false)
            .firstMatch(h)
            ?.group(1) ??
        '';
    final stripped = h
        .replaceAll(RegExp(r'<script[\s\S]*?</script>', caseSensitive: false), ' ')
        .replaceAll(RegExp(r'<style[\s\S]*?</style>', caseSensitive: false), ' ')
        .replaceAll(RegExp(r'<!--[\s\S]*?-->'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();

    var anchor = -1;
    final h1 = RegExp(r'<h1\b', caseSensitive: false).firstMatch(stripped);
    if (h1 != null) {
      anchor = h1.start;
    } else {
      final atc = RegExp(
              r'add[\s-]*to[\s-]*(cart|bag|basket)|addtocart|buy[\s-]*now',
              caseSensitive: false)
          .firstMatch(stripped);
      if (atc != null) {
        anchor = atc.start;
      } else {
        var needle = (ogTitle.isNotEmpty ? ogTitle : title)
            .replaceFirst(RegExp(r'[|–—].*$'), '')
            .trim();
        if (needle.length > 60) needle = needle.substring(0, 60);
        if (needle.isNotEmpty) {
          final ti = stripped.indexOf(needle);
          if (ti >= 0) anchor = ti;
        }
      }
    }

    final windowed = anchor >= 0
        ? stripped.substring(
            (anchor - 1200).clamp(0, stripped.length),
            (anchor + 12000).clamp(0, stripped.length))
        : (stripped.length > 10000 ? stripped.substring(0, 10000) : stripped);

    return 'TITLE: $title\n\nMETA:\n$og\n\nJSON-LD BLOCKS:\n${lds.length > 6000 ? lds.substring(0, 6000) : lds}\n\nPRODUCT HTML (around the product area):\n$windowed';
  }

  static String domainOf(String url) {
    try {
      final u = Uri.parse(url);
      final host = u.host.replaceFirst(RegExp(r'^www\.'), '');
      return host;
    } catch (_) {
      return '';
    }
  }

  static String brandFromDomain(String domain) {
    if (domain.isEmpty) return '';
    final name = domain.split('.').first.replaceAll(RegExp(r'[-_]+'), ' ');
    return name
        .split(' ')
        .map((w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1))
        .join(' ');
  }

  static String buildScraperBody(String runBody) {
    return '$_genericHelpers\n$runBody\nreturn run(ctx);';
  }

  Future<String> callDeepSeek(
    List<Map<String, String>> messages, {
    bool json = false,
    void Function(String)? onReasoning,
  }) async {
    SupabaseResult res = await sb.deepseek(messages, json: json);
    // Retry once on a transient timeout (cold start / slow turn) before giving up.
    if (!res.ok && (res.error ?? '').toLowerCase().contains('timed out')) {
      res = await sb.deepseek(messages, json: json);
    }
    if (!res.ok) throw Exception(res.error ?? 'DeepSeek HTTP ${res.status}');
    final data = res.data is Map ? res.data as Map : <String, dynamic>{};
    final content = (data['content'] ?? '').toString();
    if (content.isEmpty) throw Exception('Empty AI response.');
    if (onReasoning != null && data['reasoning'] != null) {
      onReasoning(data['reasoning'].toString());
    }
    return content;
  }

  Future<String> scraperBodyFor(String url, String type) async {
    final domain = domainOf(url);
    if (domain.isEmpty) return '';
    final rows = await sb.listScrapersForDomain(domain);
    String? simple, variable;
    for (final r in rows) {
      if (r is! Map) continue;
      if (r['type'] == 'simple' && r['code'] != null) simple = r['code'] as String;
      if (r['type'] == 'variable' && r['code'] != null) variable = r['code'] as String;
    }
    if (type == 'simple') return simple ?? '';
    if (type == 'variable') return variable ?? '';
    return variable ?? simple ?? '';
  }

  Future<Map<String, dynamic>?> getScraperEntry(String domain, String type) async {
    final rows = await sb.listScrapersForDomain(domain);
    for (final r in rows) {
      if (r is Map && r['type'] == type) return r.cast<String, dynamic>();
    }
    return null;
  }

  Future<void> saveScraperEntry(
      String domain, String type, Map<String, dynamic> fields) async {
    await sb.upsertScraper({'domain': domain, 'type': type, ...fields});
  }

  Future<String> predefinedBody() async {
    if (_predefinedBody != null) {
      final v = await sb.getPredefinedVersion();
      if (v != null && v == _predefinedVersion) return _predefinedBody!;
    }
    final mod = await sb.getPredefinedModule();
    if (mod == null || (mod['code'] as String?) == null) {
      return _predefinedBody ?? '';
    }
    final body =
        '${mod['code'] as String}\nreturn self.ProductScraper.scrapeProduct(ctx);';
    _predefinedBody = body;
    _predefinedVersion = mod['version'] as int?;
    return body;
  }

  Verdict evaluateResult(Map<String, dynamic> res, String type) {
    final rows = res['rows'];
    if (rows is! List || rows.isEmpty) {
      return Verdict(false, 'no rows were produced.');
    }
    if (type == 'variable') {
      final hasParent = rows.any((r) => r is Map && r['Type'] == 'variable');
      if (!hasParent) {
        return Verdict(false,
            'there is no "variable" parent row — you must call variableRows(...) and return its rows (a variable row followed by variation rows).');
      }
      final vars = rows.where((r) => r is Map && r['Type'] == 'variation').toList();
      if (vars.isEmpty) {
        return Verdict(false,
            'no "variation" rows were produced — this product has options, so build a variants array and pass it to variableRows(...).');
      }
      final withPrice = vars
          .where((r) => (r['Regular Price'] ?? '').toString().isNotEmpty)
          .length;
      final withImg = vars
          .where((r) => r['Images'] is List && (r['Images'] as List).isNotEmpty)
          .length;
      if (withPrice == 0 || withImg == 0) {
        final missing = <String>[];
        if (withPrice == 0) missing.add('no variant has its own price');
        if (withImg == 0) missing.add('no variant has its own photo');
        return Verdict(false,
            "${missing.join(' and ')} — locate each variant's own price and photo in the HTML and map them.");
      }
      return Verdict(true, '');
    }
    final row = rows.first is Map ? rows.first as Map : <String, dynamic>{};
    if (row['Name'] is! String) {
      return Verdict(false,
          'the row is not in the required schema (missing "Name") — call simpleRow({...}) and return { rows, title }.');
    }
    final hasPrice = (row['Regular Price'] ?? '').toString().isNotEmpty ||
        (row['Sale Price'] ?? '').toString().isNotEmpty;
    final hasImg = row['Images'] is List && (row['Images'] as List).isNotEmpty;
    if (!hasPrice || !hasImg) {
      final missing = <String>[];
      if (!hasPrice) missing.add('price');
      if (!hasImg) missing.add('image');
      return Verdict(false,
          'no ${missing.join(' or ')} was extracted — locate it in the page HTML.');
    }
    return Verdict(true, '');
  }

  String describeRows(List<dynamic> rows) {
    if (rows.isEmpty) return 'NO ROWS (empty).';
    final buf = StringBuffer();
    final n = rows.length > 30 ? 30 : rows.length;
    for (var i = 0; i < n; i++) {
      final r = rows[i];
      if (r is! Map) {
        buf.writeln('[$i] null');
        continue;
      }
      final t = (r['Type'] ?? 'row').toString();
      if (t == 'variation') {
        buf.writeln(
            '[$i] variation | name=${jsonEncode(r['Attribute 1 value(s)'])}'
            ' | sku=${jsonEncode(r['SKU'])}'
            ' | regular=${jsonEncode(r['Regular Price'])}'
            ' | sale=${jsonEncode(r['Sale Price'])}'
            ' | images=${r['Images'] is List ? (r['Images'] as List).length : 0}');
      } else {
        final desc = (r['Description'] ?? '').toString();
        buf.writeln(
            '[$i] $t'
            ' | name=${jsonEncode(r['Name'])}'
            ' | sku=${jsonEncode(r['SKU'])}'
            ' | regular=${jsonEncode(r['Regular Price'])}'
            ' | sale=${jsonEncode(r['Sale Price'])}'
            ' | categories=${jsonEncode(r['Categories'])}'
            ' | images=${r['Images'] is List ? (r['Images'] as List).length : 0}'
            ' | desc=${jsonEncode(desc.length > 80 ? desc.substring(0, 80) : desc)}');
      }
    }
    if (rows.length > 30) buf.writeln('... and ${rows.length - 30} more rows');
    return buf.toString().trimRight();
  }

  Future<Map<String, dynamic>> generateScraper(
      String html, String url, String type, {String hint = ''}) async {
    final effectiveType = type == 'variable' ? 'variable' : 'simple';
    final sample = scraperHtmlSample(html);
    const maxTurns = 6;

    final messages = <Map<String, String>>[
      {'role': 'system', 'content': _generateSystem(effectiveType)},
      {
        'role': 'user',
        'content': 'Product page URL: $url${hint.isNotEmpty ? '\n\n$hint' : ''}\n\n$sample'
      },
    ];

    for (var turn = 1; turn <= maxTurns; turn++) {
      if (isCancelled?.call() == true) throw const ScraperCancelled();
      _progress(8, 'running',
          turn == 1 ? 'Thinking…' : 'Agent turn $turn/$maxTurns');
      _thinking(turn == 1
          ? 'Reading the page and designing a scraper for this site…'
          : 'Reviewing the previous attempt and correcting it…');

      final raw = await callDeepSeek(messages,
          onReasoning: (r) => _thinking(_trimThinking(r)));
      final runBody = stripFences(raw);

      if (!RegExp(r'async\s+function\s+run\s*\(').hasMatch(runBody)) {
        _thinking('The agent replied without a run() function — asking it to retry…');
        messages.add({'role': 'assistant', 'content': raw});
        messages.add({
          'role': 'user',
          'content':
              'You did not return an "async function run(ctx) { ... }". Reply with ONLY the function definition.'
        });
        continue;
      }

      _thinking('Running the generated scraper against the page…');
      final body = buildScraperBody(runBody);
      final res = await runScraper(
          code: body, url: url, html: html, productType: effectiveType);

      if (res['ok'] != true) {
        _thinking('The scraper threw an error — the agent is fixing the code…');
        messages.add({'role': 'assistant', 'content': raw});
        messages.add({
          'role': 'user',
          'content':
              'Your code threw an error:\n${res['error'] ?? 'unknown error'}\n\nFix the code and return a corrected run() function.'
        });
        continue;
      }

      final verdict = evaluateResult(res, effectiveType);
      if (verdict.ok) {
        final rows = res['rows'] as List? ?? [];
        _thinking(
            'Scraper works — extracted ${rows.length} row${rows.length == 1 ? '' : 's'}.');
        return {'body': body, 'rows': rows.length, 'title': res['title'] ?? ''};
      }

      _thinking('Scraper ran but the mapping is off: ${verdict.problem}');
      messages.add({'role': 'assistant', 'content': raw});
      messages.add({
        'role': 'user',
        'content':
            'Your scraper ran and returned these rows:\n${describeRows(res['rows'] as List? ?? [])}\n\nProblem: ${verdict.problem}\n\nFix the mapping and return a corrected run() function.',
      });
    }

    throw Exception(
        'Could not generate a working scraper after $maxTurns agent turns.');
  }

  Future<Map<String, dynamic>> handleAddScraper(
      {required String url, required String html}) async {
    var step = 0;
    try {
      if (url.isEmpty) return {'ok': false, 'error': 'No page loaded.'};
      if (html.isEmpty) {
        return {
          'ok': false,
          'error': 'Could not read the page HTML. Make sure a page is loaded.'
        };
      }

      step = 1;
      _progress(1, 'running', '');
      _progress(1, 'done', _formatBytes(html.length));

      step = 2;
      _progress(2, 'running', '');
      final checkRaw = await callDeepSeek(
        _productCheckPrompt +
            [
              {
                'role': 'user',
                'content': condenseHtml(html),
              },
            ],
        json: true,
      );
      _progress(2, 'done', 'Ai Agent');

      Map<String, dynamic>? check;
      try {
        final parsed = jsonDecode(stripFences(checkRaw));
        if (parsed is Map) check = parsed.cast<String, dynamic>();
      } catch (_) {
        check = null;
      }
      final isProduct = check?['isProductPage'] == true;
      final pType = (check?['productType'] ?? '').toString().toLowerCase();
      final attrs = (check?['attributes'] is List)
          ? (check!['attributes'] as List)
          : <dynamic>[];
      var attrCount = check?['attributeCount'] is num
          ? (check!['attributeCount'] as num).toInt()
          : 0;
      if (attrCount != 1 && attrCount != 2) {
        attrCount = attrs.length >= 2 ? 2 : (attrs.length == 1 ? 1 : 0);
      }

      if (!isProduct) {
        _progress(3, 'fail', 'Not a product page');
        _progress(4, 'skip', '—');
        _progress(5, 'skip', '—');
        _progress(6, 'skip', '—');
        _progress(7, 'skip', '—');
        _progress(8, 'skip', '—');
        return {'notProduct': true, 'message': 'This page is not a product page.'};
      }

      _progress(3, 'done', 'Product page');
      if (pType == 'simple' || pType == 'variable') {
        _progress(4, 'value', pType);
      } else {
        _progress(4, 'value', 'unknown');
      }

      // Steps 5-7: attribute detail (variable only) — this guides the agent.
      if (pType == 'variable') {
        final n = attrCount == 2 ? 2 : 1;
        _progress(5, 'value', 'Variable · $n attribute${n == 1 ? '' : 's'}');
        final names = attrs
            .where((a) => a is Map && (a['name'] ?? '').toString().isNotEmpty)
            .map((a) => (a as Map)['name'].toString())
            .toList();
        _progress(6, 'value', names.isNotEmpty ? names.join(', ') : 'Unknown');
        Map? colorAttr;
        for (final a in attrs) {
          if (a is Map && RegExp(r'color|colour').hasMatch((a['name'] ?? '').toString())) {
            colorAttr = a;
            break;
          }
        }
        if (colorAttr != null) {
          if (colorAttr['swatched'] == true) {
            _progress(7, 'value',
                colorAttr['swatchType'] == 'image_url'
                    ? 'Color — image swatch'
                    : (colorAttr['swatchType'] == 'color_code'
                        ? 'Color — colour code'
                        : 'Color — swatched'));
          } else {
            _progress(7, 'value', 'Color — not swatched');
          }
        } else {
          _progress(7, 'value', 'No color attribute');
        }
      } else {
        _progress(5, 'skip', '—');
        _progress(6, 'skip', '—');
        _progress(7, 'skip', '—');
      }

      step = 8;
      _progress(8, 'running', '');
      final domain = domainOf(url);
      final type = pType == 'variable' ? 'variable' : 'simple';
      final existing = await getScraperEntry(domain, type);
      final alreadyExists = existing != null &&
          (existing['is_predefined'] == true ||
              ((existing['code'] as String?)?.isNotEmpty == true &&
                  existing['verified'] == true));
      var generated = false;
      if (alreadyExists) {
        _progress(8, 'done', 'Already exists');
      } else {
        final gen = await generateScraper(html, url, type,
            hint: _buildAttributeHint(pType, attrs));
        await saveScraperEntry(domain, type, {
          'brand': (existing?['brand'] as String?)?.isNotEmpty == true
              ? existing!['brand']
              : brandFromDomain(domain),
          'example': url,
          'code': gen['body'],
          'is_predefined': false,
        });
        generated = true;
        _progress(8, 'done', '${gen['rows']} rows');
      }
      return {
        'productPage': true,
        'productType': pType,
        'generated': generated,
        'alreadyExists': alreadyExists,
        'message': alreadyExists
            ? 'A $type scraper already exists for this site.'
            : (pType.isNotEmpty
                ? 'This is a $pType product page.'
                : 'This is a product page.'),
      };
    } on ScraperCancelled {
      if (step > 0) _progress(step, 'fail', 'Cancelled');
      return {'ok': false, 'cancelled': true, 'error': 'Cancelled'};
    } catch (e) {
      if (step > 0) _progress(step, 'fail', e.toString());
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> handleScrape(
      {required String url,
      required String html,
      String productType = 'auto'}) async {
    if (url.isEmpty) return {'ok': false, 'error': 'No page loaded.'};
    final customBody = await scraperBodyFor(url, productType);
    if (customBody.isNotEmpty) {
      final r = await runScraper(
          code: customBody, url: url, html: html, productType: productType);
      if (r['ok'] == true) {
        return {
          'ok': true,
          'rows': r['rows'],
          'title': r['title'],
          'site': 'custom',
          'brand': '',
        };
      }
      return r;
    }
    final body = await predefinedBody();
    if (body.isEmpty) {
      return {
        'ok': false,
        'error': 'Could not load the scraper engine. Check your connection and try again.'
      };
    }
    final r = await runScraper(
        code: body, url: url, html: html, productType: productType);
    if (r['ok'] == true) {
      return {
        'ok': true,
        'rows': r['rows'],
        'title': r['title'],
        'site': r['site'] ?? '',
        'brand': r['brand'] ?? '',
      };
    }
    final err = (r['error'] ?? '').toString();
    if (err.contains('No scraper for site')) {
      return {
        'ok': false,
        'error':
            'No scraper for this website yet. Tap "Add new Scrapper" and the AI will build one automatically.',
      };
    }
    return r;
  }

  Future<Map<String, dynamic>> fixScraper({
    required String url,
    required String html,
    required String type,
    required List<Map<String, String>> corrections,
  }) async {
    try {
      if (url.isEmpty) return {'ok': false, 'error': 'No page loaded.'};
      final domain = domainOf(url);
      final effType = type == 'variable' ? 'variable' : 'simple';
      final entry = await getScraperEntry(domain, effType);
      if (entry == null || (entry['code'] as String?)?.isEmpty != false) {
        return {'ok': false, 'error': 'No scraper found for this site.'};
      }

      final sample = scraperHtmlSample(html);
      final fixLines = corrections.map((c) {
        final cur = (c['current'] == null || c['current']!.isEmpty)
            ? '(empty)'
            : c['current']!;
        final corr = (c['correct']?.trim().isNotEmpty == true)
            ? ' -> should be "${c['correct']!.trim()}"'
            : ' (current value is wrong)';
        return '- ${c['field']}: currently "$cur"$corr';
      }).join('\n');

      var lastError = '';
      for (var attempt = 1; attempt <= 2; attempt++) {
        final messages = <Map<String, String>>[
          {'role': 'system', 'content': _generateSystem(effType)},
          {
            'role': 'user',
            'content': 'Product page URL: $url\n\n$sample\n\nThe scraper you generated extracted some fields incorrectly. Fix the scraper code so it extracts these fields correctly:\n$fixLines${lastError.isNotEmpty ? '\n\nYour previous attempt failed with: $lastError — fix it.' : ''}'
          },
        ];
        final raw = await callDeepSeek(messages);
        final runBody = stripFences(raw);
        if (!RegExp(r'async\s+function\s+run\s*\(').hasMatch(runBody)) {
          lastError = 'run() function not found';
          continue;
        }
        final body = buildScraperBody(runBody);
        final res = await runScraper(
            code: body, url: url, html: html, productType: effType);
        if (res['ok'] == true) {
          await saveScraperEntry(domain, effType, {'code': body});
          return {
            'ok': true,
            'rows': res['rows'],
            'title': res['title'],
            'site': 'custom',
          };
        }
        lastError = res['error']?.toString() ?? '';
      }
      return {'ok': false, 'error': 'Could not fix scraper: $lastError'};
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Fixes an existing scraper from free-text user feedback, conversationally.
  /// [history] is the prior chat turns (role: 'user'/'agent') so the model
  /// keeps context across multiple fixes. Returns the freshly re-scraped rows.
  Future<Map<String, dynamic>> chatFixScraper({
    required String url,
    required String html,
    required String type,
    required String feedback,
    List<Map<String, String>> history = const [],
  }) async {
    try {
      if (url.isEmpty) return {'ok': false, 'error': 'No page loaded.'};
      final domain = domainOf(url);
      final effType = type == 'variable' ? 'variable' : 'simple';
      final entry = await getScraperEntry(domain, effType);
      if (entry == null || (entry['code'] as String?)?.isEmpty != false) {
        return {'ok': false, 'error': 'No scraper found for this site.'};
      }

      final sample = scraperHtmlSample(html);

      final messages = <Map<String, String>>[
        {'role': 'system', 'content': _generateSystem(effType)},
        {
          'role': 'user',
          'content': 'Product page URL: $url\n\n$sample\n\n'
              'You previously generated a scraper for this page (current code below, for reference). '
              'The user is reviewing the scraped results and giving feedback. Update the scraper so '
              'it extracts the data correctly per the feedback, then reply with ONLY the corrected '
              'async function run(ctx) { ... } definition.\n\n'
              'Current scraper code:\n${entry['code']}'
        },
      ];

      // Replay prior turns so the agent keeps context across multiple fixes.
      for (final m in history) {
        final role = m['role'] == 'agent' ? 'assistant' : 'user';
        final text = (m['text'] ?? '').trim();
        if (text.isEmpty) continue;
        messages.add({'role': role, 'content': text});
      }

      messages.add({
        'role': 'user',
        'content': 'User feedback: $feedback\n\n'
            'Rewrite the scraper to fix this and reply with ONLY the corrected '
            'async function run(ctx) { ... } definition.'
      });

      final raw = await callDeepSeek(messages);
      final runBody = stripFences(raw);
      if (!RegExp(r'async\s+function\s+run\s*\(').hasMatch(runBody)) {
        return {
          'ok': false,
          'error': 'The agent did not return valid code. Please try again.'
        };
      }
      final body = buildScraperBody(runBody);
      final res = await runScraper(
          code: body, url: url, html: html, productType: effType);
      if (res['ok'] == true) {
        await saveScraperEntry(domain, effType, {'code': body});
        return {
          'ok': true,
          'rows': res['rows'],
          'title': res['title'],
          'site': 'custom',
        };
      }
      return {
        'ok': false,
        'error': res['error']?.toString() ?? 'Scraper failed after the fix.'
      };
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> verifyScraper(
      {required String url, required String type}) async {
    try {
      final domain = domainOf(url);
      final effType = type == 'variable' ? 'variable' : 'simple';
      await sb.setVerified(domain, effType, true);
      return {'ok': true};
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> wcTest(
      {required String store, required String authKey}) async {
    try {
      final base = '${store.replaceAll(RegExp(r'/+$'), '')}/wp-json/scraper/v1/import-csv';
      final r = await _httpPost(base, {
        'csv': 'SKU,Name,Regular Price\nTEST,Test Product,0',
      }, authKey);
      if (r['status'] == 403) {
        return {
          'ok': false,
          'error': 'Invalid auth key. Check the key from the plugin dashboard.'
        };
      }
      if (r['status'] == 404) {
        return {
          'ok': false,
          'error': 'Rey Swatches Import plugin not found. Install and activate it first.'
        };
      }
      return {'ok': true, 'message': 'Connected — import endpoint reachable.'};
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> wcImport({
    required String store,
    required String authKey,
    required String csv,
    bool skipResize = false,
  }) async {
    try {
      final url = '${store.replaceAll(RegExp(r'/+$'), '')}/wp-json/scraper/v1/import-csv';
      final r = await _httpPost(url, {
        'csv': csv,
        'skip_resize': skipResize,
      }, authKey);
      if (r['status'] == 403) {
        return {
          'ok': false,
          'error': 'Invalid auth key. Check the key from the plugin dashboard.'
        };
      }
      if (r['ok'] != true) {
        return {'ok': false, 'error': r['error'] ?? 'HTTP ${r['status']}'};
      }
      final data = (r['data'] is Map)
          ? Map<String, dynamic>.from(r['data'] as Map)
          : <String, dynamic>{};
      final created = ((data['created_variable'] as num?)?.toInt() ?? 0) +
          ((data['created_simple'] as num?)?.toInt() ?? 0);
      final updated = ((data['updated_variable'] as num?)?.toInt() ?? 0) +
          ((data['updated_simple'] as num?)?.toInt() ?? 0);
      final skipped = (data['skipped'] as num?)?.toInt() ?? 0;
      if (created + updated == 0 && skipped > 0) {
        final msgs = (data['messages'] as List?)
                ?.whereType<String>()
                .where((s) => s.isNotEmpty)
                .toList() ??
            [];
        return {
          'ok': false,
          'error': msgs.isNotEmpty ? msgs.join(' | ') : 'No products were imported.'
        };
      }
      return {'ok': true, 'data': data};
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> _httpPost(
      String url, Map<String, dynamic> body, String authKey) async {
    final res = await sb.postJson(url,
        body: body, extraHeaders: {'X-Scraper-Key': authKey});
    return {
      'status': res.status,
      'ok': res.ok,
      'error': res.error,
      'data': res.data,
    };
  }
}
