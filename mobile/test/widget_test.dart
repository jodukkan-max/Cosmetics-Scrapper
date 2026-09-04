import 'package:flutter_test/flutter_test.dart';

import 'package:universal_scrapper/scraper_engine.dart';
import 'package:universal_scrapper/supabase_client.dart';

void main() {
  test('stripFences removes code fences', () {
    expect(ScraperEngine.stripFences('```js\nasync function run(ctx) {}\n```'),
        'async function run(ctx) {}');
    expect(ScraperEngine.stripFences('  async function run(ctx) {}  '),
        'async function run(ctx) {}');
  });

  test('domainOf extracts host without www', () {
    expect(ScraperEngine.domainOf('https://www.glowrecipe.com/products/x'),
        'glowrecipe.com');
    expect(ScraperEngine.domainOf('https://nextdirect.com/jo/en/style/x'),
        'nextdirect.com');
  });

  test('buildScraperBody wraps run body with helpers and return', () {
    final body = ScraperEngine.buildScraperBody('async function run(ctx) {}');
    expect(body.contains('function simpleRow'), isTrue);
    expect(body.contains('function variableRows'), isTrue);
    expect(body.trimRight().endsWith('return run(ctx);'), isTrue);
  });

  test('evaluateResult validates variable output', () {
    final engine = ScraperEngine(sb: _fakeSb(), runScraper: _noop);
    final good = {
      'rows': [
        {'Type': 'variable', 'Name': 'P'},
        {
          'Type': 'variation',
          'Attribute 1 value(s)': 'Black',
          'Regular Price': '15.00',
          'Images': ['https://x/a.jpg'],
        },
      ],
    };
    expect(engine.evaluateResult(good, 'variable').ok, isTrue);

    final bad = {
      'rows': [
        {'Type': 'variation'},
      ],
    };
    expect(engine.evaluateResult(bad, 'variable').ok, isFalse);
  });
}

dynamic _fakeSb() => SupabaseClient();

Future<Map<String, dynamic>> _noop({
  required String code,
  required String url,
  required String html,
  required String productType,
}) async =>
    {'ok': false, 'error': 'noop'};
