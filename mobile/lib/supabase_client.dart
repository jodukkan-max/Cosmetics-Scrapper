// Anonymous Supabase client — a Dart port of the extension's supabase.js.
// Uses only the anon key (no auth, no login), matching the existing backend.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class SupabaseResult {
  final bool ok;
  final int status;
  final dynamic data;
  final String? error;
  SupabaseResult(this.ok, this.status, this.data, this.error);
}

class SupabaseClient {
  static const String url = 'https://hnscofvpziluahspyjqk.supabase.co';
  static const String anonKey =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhuc2NvZnZwemlsdWFoc3B5anFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0Njc5MjEsImV4cCI6MjEwMzA0MzkyMX0.tqVD8zrRo-vRF3SPLVKflWMsmfkznDra6NLU0UzQXgg';

  static const Map<String, String> _headers = {
    'apikey': anonKey,
    'Authorization': 'Bearer $anonKey',
  };

  /// Low-level request (PostgREST + Edge Functions).
  Future<SupabaseResult> _rest(
    String path, {
    String method = 'GET',
    Object? body,
    String? prefer,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final uri = Uri.parse('$url$path');
    final headers = Map<String, String>.from(_headers);
    if (body != null) headers['Content-Type'] = 'application/json';
    if (prefer != null) headers['Prefer'] = prefer;

    http.Response r;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      final streamed = await req.send().timeout(timeout);
      r = await http.Response.fromStream(streamed);
    } on TimeoutException {
      return SupabaseResult(false, 0, null, 'The request timed out — try again.');
    } catch (e) {
      throw e;
    }

    dynamic data;
    try {
      data = r.body.isNotEmpty ? jsonDecode(r.body) : null;
    } catch (_) {
      data = null;
    }
    String? error;
    if (r.statusCode < 200 || r.statusCode >= 300) {
      if (data is Map) {
        error = (data['message'] ??
                data['error_description'] ??
                data['msg'] ??
                r.body)
            .toString();
      } else {
        error = r.body;
      }
    }
    return SupabaseResult(
        r.statusCode >= 200 && r.statusCode < 300, r.statusCode, data, error);
  }

  // ── Scrapers ──────────────────────────────────────────────────────────────
  Future<List<dynamic>> listScrapers() async {
    final res = await _rest(
        '/rest/v1/scrapers?select=domain,type,brand,example,is_predefined,verified,updated_at&order=domain.asc');
    return res.ok ? (res.data as List? ?? []) : [];
  }

  Future<List<dynamic>> listScrapersForDomain(String domain) async {
    final res = await _rest(
        '/rest/v1/scrapers?domain=eq.${Uri.encodeComponent(domain)}&select=*');
    return res.ok ? (res.data as List? ?? []) : [];
  }

  Future<SupabaseResult> upsertScraper(Map<String, dynamic> entry) {
    return _rest('/rest/v1/scrapers?on_conflict=domain,type',
        method: 'POST',
        body: entry,
        prefer: 'resolution=merge-duplicates');
  }

  Future<SupabaseResult> deleteScraperByDomain(String domain) {
    return _rest('/rest/v1/scrapers?domain=eq.${Uri.encodeComponent(domain)}',
        method: 'DELETE');
  }

  Future<SupabaseResult> setVerified(
      String domain, String type, bool verified) {
    return _rest(
        '/rest/v1/scrapers?domain=eq.${Uri.encodeComponent(domain)}&type=eq.${Uri.encodeComponent(type)}',
        method: 'PATCH',
        body: {'verified': verified});
  }

  // ── Predefined module (single shared scraper module) ──────────────────────
  Future<Map<String, dynamic>?> getPredefinedModule() async {
    final res = await _rest(
        '/rest/v1/scraper_modules?name=eq.predefined&select=code,version');
    if (!res.ok || res.data is! List || (res.data as List).isEmpty) return null;
    final row = (res.data as List).first as Map;
    if (row['code'] == null) return null;
    return {'code': row['code'] as String, 'version': row['version']};
  }

  Future<int?> getPredefinedVersion() async {
    final res = await _rest(
        '/rest/v1/scraper_modules?name=eq.predefined&select=version');
    if (!res.ok || res.data is! List || (res.data as List).isEmpty) return null;
    return (res.data as List).first['version'] as int?;
  }

  /// Plain JSON POST to an arbitrary URL (WooCommerce import endpoints).
  Future<SupabaseResult> postJson(
    String url, {
    required Map<String, dynamic> body,
    Map<String, String>? extraHeaders,
  }) async {
    final uri = Uri.parse(url);
    final headers = {'Content-Type': 'application/json', ...?extraHeaders};
    http.Response r;
    try {
      final req = http.Request('POST', uri)..headers.addAll(headers);
      req.body = jsonEncode(body);
      final streamed =
          await req.send().timeout(const Duration(seconds: 60));
      r = await http.Response.fromStream(streamed);
    } on TimeoutException {
      return SupabaseResult(false, 0, null, 'Request timed out.');
    } catch (e) {
      return SupabaseResult(false, 0, null, e.toString());
    }
    dynamic data;
    try {
      data = r.body.isNotEmpty ? jsonDecode(r.body) : null;
    } catch (_) {
      data = null;
    }
    String? error;
    if (r.statusCode < 200 || r.statusCode >= 300) {
      error = data is Map
          ? (data['message'] ?? data['error'] ?? r.body).toString()
          : r.body;
    }
    return SupabaseResult(
        r.statusCode >= 200 && r.statusCode < 300, r.statusCode, data, error);
  }

  // ── DeepSeek via Edge Function ────────────────────────────────────────────
  Future<SupabaseResult> deepseek(List<Map<String, String>> messages,
      {bool json = false}) {
    return _rest('/functions/v1/deepseek',
        method: 'POST',
        body: {'messages': messages, 'json': json},
        // Under Supabase's ~150s wall-clock limit; abort a bit early so the user
        // sees a clear timeout instead of an opaque 546/504.
        timeout: const Duration(seconds: 140));
  }
}
