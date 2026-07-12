<?php
/**
 * REST Endpoint — registers the /wp-json/scraper/v1/import-csv route.
 *
 * Receives CSV data from the Cosmetics Scraper Chrome extension, parses it,
 * and imports products via WooCommerce's internal REST API (wc/v3/products).
 *
 * Authentication: Custom X-Scraper-Key header matching the key stored in
 *                 wp_options['rsi_auth_key'].
 *
 * Request:
 *   POST /wp-json/scraper/v1/import-csv
 *   Content-Type: application/json
 *   Headers: { "X-Scraper-Key": "1234" }
 *   Body: { "csv": "ID,Parent,Type,..." }
 *
 * Response (200):
 *   {
 *     "ok": true,
 *     "created_variable": 2,
 *     "created_simple": 0,
 *     "skipped": 0,
 *     "messages": ["Created \"Product\" with 3 variations.", ...]
 *   }
 *
 * Response (error):
 *   { "ok": false, "error": "Error message" }
 */

class Rsi_Rest_Endpoint {

    /**
     * Register the REST route.
     */
    public function register(): void {
        register_rest_route(
            RSI_REST_NAMESPACE,
            RSI_REST_ROUTE,
            [
                'methods'             => \WP_REST_Server::CREATABLE,
                'callback'            => [$this, 'handle_import'],
                'permission_callback' => [$this, 'check_permission'],
                'args'                => [
                    'csv' => [
                        'required'          => true,
                        'type'              => 'string',
                        'sanitize_callback' => function ($value) {
                            return wp_unslash($value);
                        },
                        'validate_callback' => function ($value) {
                            return is_string($value) && strlen(trim($value)) > 0;
                        },
                    ],
                ],
            ]
        );

        register_rest_route(
            RSI_REST_NAMESPACE,
            '/debug-term-meta',
            [
                'methods'             => \WP_REST_Server::READABLE,
                'callback'            => [$this, 'handle_debug_term_meta'],
                'permission_callback' => [$this, 'check_permission'],
            ]
        );

        register_rest_route(
            RSI_REST_NAMESPACE,
            '/debug-files',
            [
                'methods'             => \WP_REST_Server::READABLE,
                'callback'            => [$this, 'handle_debug_files'],
                'permission_callback' => [$this, 'check_permission'],
            ]
        );

        register_rest_route(
            RSI_REST_NAMESPACE,
            '/debug-read',
            [
                'methods'             => \WP_REST_Server::READABLE,
                'callback'            => [$this, 'handle_debug_read'],
                'permission_callback' => [$this, 'check_permission'],
                'args'                => [
                    'f' => [
                        'required'          => true,
                        'type'              => 'string',
                    ],
                ],
            ]
        );
    }

    /**
     * Permission callback — validates the X-Scraper-Key header.
     *
     * @param \WP_REST_Request $request
     * @return bool|\WP_Error
     */
    public function check_permission(\WP_REST_Request $request) {
        $provided = $request->get_header('X-Scraper-Key');
        $stored   = get_option('rsi_auth_key', '');

        if (empty($stored) || empty($provided)) {
            return new \WP_Error(
                'rest_forbidden',
                __('Missing scraper key.', 'rey-swatches-import'),
                ['status' => 403]
            );
        }

        if (!hash_equals($stored, $provided)) {
            return new \WP_Error(
                'rest_forbidden',
                __('Invalid scraper key.', 'rey-swatches-import'),
                ['status' => 403]
            );
        }

        return true;
    }

    /**
     * Handle the import request.
     *
     * Parses the CSV and delegates to Rsi_Product_Creator which uses
     * WooCommerce's internal REST API (wc/v3/products) to create products.
     *
     * @param \WP_REST_Request $request
     * @return \WP_REST_Response|\WP_Error
     */
    public function handle_import(\WP_REST_Request $request) {
        $csv = $request->get_param('csv');

        if (empty($csv) || !is_string($csv)) {
            return new \WP_Error(
                'missing_csv',
                __('The "csv" field is required and must be a non-empty string.', 'rey-swatches-import'),
                ['status' => 400]
            );
        }

        $this->bump_time_limit();

        try {
            $parser       = new Rsi_Csv_Parser();
            $products     = $parser->parse($csv);

            if (empty($products)) {
                return new \WP_REST_Response([
                    'ok'               => true,
                    'created_variable' => 0,
                    'created_simple'   => 0,
                    'skipped'          => 0,
                    'messages'         => [__('No products found in CSV.', 'rey-swatches-import')],
                ], 200);
            }

            $image_handler = new Rsi_Image_Handler();
            $rey_swatches  = new Rsi_Rey_Swatches($image_handler);
            $creator       = new Rsi_Product_Creator($rey_swatches);

            $result = $creator->import_all($products);

            return new \WP_REST_Response(array_merge(
                ['ok' => true],
                $result
            ), 200);

        } catch (\Exception $e) {
            return new \WP_Error(
                'import_error',
                $e->getMessage(),
                ['status' => 500]
            );
        }
    }

    /**
     * Debug endpoint — scans Rey theme/Core plugin PHP files for swatch-
     * related term meta calls (update_term_meta, get_term_meta, etc.) to
     * discover the EXACT meta key names used by the Rey theme.
     *
     * GET /wp-json/scraper/v1/debug-term-meta
     */
    public function handle_debug_term_meta(\WP_REST_Request $request): \WP_REST_Response {
        $result = [
            'version'         => '1.4.6-deepscan',
            'paths_checked'   => [],
            'term_meta_lines' => [],
            'db_attributes'   => [],
            'db_term_meta'    => [],
        ];

        // ── 1. Find Rey theme / plugin directories ──
        $search_dirs = [];
        $theme_dir   = get_template_directory();       // /path/to/wp-content/themes/rey
        $theme_root  = get_theme_root();               // /path/to/wp-content/themes
        $plugin_dir  = WP_PLUGIN_DIR;                  // /path/to/wp-content/plugins

        // Check Rey theme directory.
        if (is_dir($theme_dir)) {
            $search_dirs['rey-theme'] = $theme_dir;
        }
        // Check for any rey-* theme child / parent directories.
        if (is_dir($theme_root)) {
            foreach (scandir($theme_root) as $entry) {
                if ($entry === '.' || $entry === '..') continue;
                $full = $theme_root . '/' . $entry;
                if (is_dir($full) && stripos($entry, 'rey') !== false) {
                    $search_dirs['theme-' . $entry] = $full;
                }
            }
        }
        // Check plugin directories.
        if (is_dir($plugin_dir)) {
            foreach (scandir($plugin_dir) as $entry) {
                if ($entry === '.' || $entry === '..') continue;
                if (stripos($entry, 'rey') !== false) {
                    $full = $plugin_dir . '/' . $entry;
                    if (is_dir($full)) {
                        $search_dirs['plugin-' . $entry] = $full;
                    }
                }
            }
        }

        $result['paths_checked'] = $search_dirs;

        // ── 2. Deep scan for swatch mechanism ──
        $result['swatch_files']    = [];     // files with swatch/variation in name
        $result['hooks_found']     = [];     // add_action/add_filter related to attributes
        $result['term_meta_lines'] = [];     // term meta function calls
        $result['meta_key_assignments'] = []; // any $var['meta_key'] = or similar pattern

        foreach ($search_dirs as $label => $dir) {
            $all_files = $this->glob_recursive($dir . '/*.php');

            foreach ($all_files as $file) {
                $filename = basename($file);
                $rel_path = str_replace(ABSPATH, '', $file);

                // Track swatch-related file names.
                if (preg_match('/(swatch|variation)/i', $filename)) {
                    $result['swatch_files'][] = compact('rel_path', 'label');
                }

                // Skip files > 2 MB.
                $fz = filesize($file);
                if ($fz > 2000000) continue;

                $content = @file_get_contents($file);
                if ($content === false) continue;

                $lines = explode("\n", $content);

                foreach ($lines as $lineno => $line) {
                    $trimmed = trim($line);

                    // A) Catch hooks related to attribute terms.
                    if (preg_match_all('/add_(?:action|filter)\s*\(\s*[\'"]([^\'"]+)[\'"]/', $line, $hm)) {
                        foreach ($hm[1] as $hook) {
                            if (preg_match('/(swatch|pa_|edited_pa|edit_pa|created_pa|delete_pa|attribute|rey_color|variation)/i', $hook)) {
                                $result['hooks_found'][] = [
                                    'hook'    => $hook,
                                    'file'    => $rel_path,
                                    'line_no' => $lineno + 1,
                                    'source'  => $label,
                                ];
                            }
                        }
                    }

                    // B) Catch any line assigning a string key that looks like meta.
                    //    Patterns like $meta['key'] = ... or ['key' => value] or "key" =>
                    if (preg_match('/[\'"]([a-z_]*swatch[a-z_]*|rey_[a-z_]+|_[a-z_]*color[a-z_]*|pa_[a-z_]+)[\'"]\s*(?:=>|=)/i', $line, $km)) {
                        if (strlen($km[1]) > 4) {
                            $result['meta_key_assignments'][] = [
                                'key'      => $km[1],
                                'file'     => $rel_path,
                                'line_no'  => $lineno + 1,
                                'context'  => substr($trimmed, 0, 150),
                                'source'   => $label,
                            ];
                        }
                    }

                    // C) term_meta calls.
                    if (preg_match('/(update_term_meta|get_term_meta|add_term_meta|delete_term_meta)\s*\(\s*(?:\$\w+,)?\s*[\'"]([^\'"]+)[\'"]/i', $line, $tm)) {
                        $result['term_meta_lines'][] = [
                            'file'     => $rel_path,
                            'line_no'  => $lineno + 1,
                            'function' => $tm[1],
                            'meta_key' => $tm[2],
                            'full_line' => $trimmed,
                            'source'   => $label,
                        ];
                    }
                }
            }
        }

        // ── 3. Full content of top swatch files (first 3) ──
        $result['swatch_file_contents'] = [];
        $shown = 0;
        foreach ($result['swatch_files'] as $sf) {
            if ($shown >= 3) break;
            $full_path = ABSPATH . $sf['rel_path'];
            $content = @file_get_contents($full_path);
            if ($content) {
                $result['swatch_file_contents'][] = [
                    'file'    => $sf['rel_path'],
                    'content' => substr($content, 0, 8000), // first 8 KB
                ];
                $shown++;
            }
        }

        // ── 3. Also report DB state (attributes + existing term meta) ──
        $attrs = wc_get_attribute_taxonomies();
        foreach ($attrs as $attr) {
            $taxonomy = wc_attribute_taxonomy_name($attr->attribute_name);
            $result['db_attributes'][] = [
                'name'    => $attr->attribute_name,
                'slug'    => $attr->attribute_name,
                'taxonomy' => $taxonomy,
                'type'    => $attr->attribute_type ?? 'select',
            ];
        }

        // Sample term meta for pa_* taxonomies.
        foreach ($result['db_attributes'] as $a) {
            $terms = get_terms(['taxonomy' => $a['taxonomy'], 'hide_empty' => false, 'number' => 2]);
            if (empty($terms) || is_wp_error($terms)) continue;
            foreach ($terms as $t) {
                $meta = get_term_meta($t->term_id);
                $result['db_term_meta'][] = [
                    'term'     => $t->name,
                    'taxonomy' => $a['taxonomy'],
                    'meta'     => array_map(fn($v) => count($v)===1 ? $v[0] : $v, $meta),
                ];
            }
        }

        return new \WP_REST_Response($result, 200);
    }

    /**
     * Recursive glob helper.
     */
    private function glob_recursive(string $pattern): array {
        $files = glob($pattern);
        foreach (glob(dirname($pattern) . '/*', GLOB_ONLYDIR | GLOB_NOSORT) as $dir) {
            $files = array_merge($files, $this->glob_recursive($dir . '/' . basename($pattern)));
        }
        return $files;
    }

    /**
     * Debug — reads and returns the content of specific Rey Core PHP files.
     * GET /wp-json/scraper/v1/debug-files
     */
    public function handle_debug_files(\WP_REST_Request $request): \WP_REST_Response {
        $plugin_dir = WP_PLUGIN_DIR . '/rey-core';

        $result = [
            'rey_core_exists' => is_dir($plugin_dir),
            'php_files'       => [],
            'js_files'        => [],
            'file_contents'   => [],
        ];

        if (!is_dir($plugin_dir)) {
            return new \WP_REST_Response($result, 200);
        }

        // List all PHP and JS files.
        $all_php = $this->glob_recursive($plugin_dir . '/*.php');
        $all_js  = $this->glob_recursive($plugin_dir . '/*.js');

        foreach ($all_php as $f) {
            $result['php_files'][] = str_replace($plugin_dir, '', $f);
        }
        foreach ($all_js as $f) {
            $result['js_files'][] = str_replace($plugin_dir, '', $f);
        }

        // Find swatch-related files and return their full content (up to 10 files).
        $swatch_files = [];
        foreach ($all_php as $f) {
            $name = basename($f);
            $content = @file_get_contents($f);
            if ($content && (
                stripos($name, 'swatch') !== false ||
                stripos($name, 'variation') !== false ||
                stripos($name, 'attribute') !== false ||
                stripos($content, 'update_term_meta') !== false ||
                stripos($content, 'pa_color') !== false ||
                stripos($content, 'rey_attribute') !== false
            )) {
                $swatch_files[] = $f;
            }
        }
        // Also include JS files mentioning swatch.
        foreach ($all_js as $f) {
            $content = @file_get_contents($f);
            if ($content && stripos($content, 'swatch') !== false) {
                $swatch_files[] = $f;
            }
        }

        $swatch_files = array_unique($swatch_files);
        $count = 0;
        foreach ($swatch_files as $f) {
            if ($count >= 8) break;
            $rel = str_replace($plugin_dir, '', $f);
            $content = @file_get_contents($f);
            if ($content && strlen($content) > 10) {
                $result['file_contents'][] = [
                    'file'    => $rel,
                    'content' => $content,
                ];
                $count++;
            }
        }

        // Also read the main rey-core plugin file for version/hooks.
        $main = $plugin_dir . '/rey-core.php';
        if (file_exists($main)) {
            $result['file_contents'][] = [
                'file'    => '/rey-core.php',
                'content' => substr(@file_get_contents($main), 0, 4000),
            ];
        }

        return new \WP_REST_Response($result, 200);
    }

    /**
     * Debug read — reads a specific file from the Rey Core plugin directory.
     * GET /wp-json/scraper/v1/debug-read?f=/inc/modules/variation-swatches/admin.php
     */
    public function handle_debug_read(\WP_REST_Request $request): \WP_REST_Response {
        $file = $request->get_param('f');
        $base = WP_PLUGIN_DIR . '/rey-core';
        $path = $base . '/' . ltrim($file, '/');
        $path = realpath($path);

        if (!$path || strpos($path, $base) !== 0) {
            return new \WP_REST_Response(['error' => 'Invalid path'], 404);
        }

        $content = @file_get_contents($path);
        if ($content === false) {
            return new \WP_REST_Response(['error' => 'File not found'], 404);
        }

        return new \WP_REST_Response([
            'file'    => str_replace($base, '', $path),
            'content' => $content,
        ], 200);
    }

    /**
     * Attempt to bump the PHP execution time limit for long-running imports.
     */
    private function bump_time_limit(): void {
        $current = (int) ini_get('max_execution_time');
        if ($current > 0 && $current < 300) {
            @set_time_limit(300);
        }
    }
}
