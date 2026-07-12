<?php
/**
 * Rey Theme Swatch Handler.
 *
 * Sets Rey theme swatch meta data on imported WooCommerce products:
 *
 * 1. rey_extra_variation_images — variation-level post meta storing a
 *    comma-separated list of media attachment IDs for the extra gallery.
 *
 * 2. Swatch color / image — stored on taxonomy terms via ACF field meta
 *    keys. The exact keys (from Rey Core swatch-color.php) are:
 *      - rey_attribute_color           for hex color swatches
 *      - rey_attribute_color_secondary  for secondary color (dual-tone)
 *      - rey_attribute_image           for image swatches (attachment ID)
 *    There is NO "rey_attribute_type" term meta — the swatch type is
 *    stored on the WooCommerce attribute taxonomy itself.
 *
 * 3. A product-level meta field `_rsi_swatch_data` is also set containing the
 *    full swatch definition JSON so that custom code (or a
 *    reycore/variation_swatches/custom_attributes filter) can read it.
 */

class Rsi_Rey_Swatches {

    /**
     * Image handler instance for downloading swatch images.
     *
     * @var Rsi_Image_Handler
     */
    private Rsi_Image_Handler $image_handler;

    public function __construct(Rsi_Image_Handler $image_handler) {
        $this->image_handler = $image_handler;
    }

    /**
     * Create global attributes, terms, and swatch colours from the
     * Rey Swatches JSON column.  This is the authoritative source that
     * sets up everything the Rey theme needs before the product is saved.
     *
     * JSON format:
     *   {"color":{"name":"color","type":"rey_color","terms":{"00":{...},"01":{...}}}}
     *
     * Term data keys:
     *   rey_attribute_color  — hex colour (e.g. #E3BBA1)
     *   rey_attribute_image  — image URL for image swatches
     *
     * @param  string $json  Raw JSON from the CSV Rey Swatches column.
     * @return array         Map of attribute-key => taxonomy name (e.g. "color" => "pa_color").
     */
    public function create_from_json(string $json): array {
        if ($json === '') {
            return [];
        }

        $data = json_decode($json, true);
        if (!is_array($data) || empty($data)) {
            error_log('[RSI] create_from_json: Failed to parse JSON or empty data.');
            return [];
        }

        error_log('[RSI] create_from_json: Parsed JSON with ' . count($data) . ' attribute(s).');

        $taxonomies = [];

        foreach ($data as $key => $attr) {
            $attr_name = $attr['name'] ?? $key;
            $attr_type = $attr['type'] ?? 'rey_color';
            $terms     = $attr['terms'] ?? [];

            error_log('[RSI] create_from_json: Processing attribute "' . $attr_name . '" with type "' . $attr_type . '" and ' . count($terms) . ' term(s).');

            if (empty($terms)) {
                error_log('[RSI] create_from_json: No terms for attribute "' . $attr_name . '", skipping.');
                continue;
            }

            // Ensure the global attribute taxonomy exists with the correct type.
            $taxonomy = $this->ensure_global_swatch_attribute($attr_name, $attr_type);
            if ($taxonomy === '') {
                error_log('[RSI] create_from_json: Failed to ensure taxonomy for attribute "' . $attr_name . '".');
                continue;
            }

            error_log('[RSI] create_from_json: Taxonomy "' . $taxonomy . '" ready.');

            $taxonomies[$key] = $taxonomy;

            // Create terms and set swatch term-meta.
            foreach ($terms as $term_data) {
                $this->ensure_swatch_term($taxonomy, $term_data, $attr_name);
            }
        }

        error_log('[RSI] create_from_json: Done. Created/updated ' . count($taxonomies) . ' taxonomy(ies).');

        return $taxonomies;
    }

    /**
     * Ensure a global WooCommerce attribute taxonomy exists with a
     * specific type (rey_color, rey_image, etc.).
     *
     * @param  string $name  e.g. "Color"
     * @param  string $type  e.g. "rey_color"
     * @return string        Taxonomy name (e.g. "pa_color"), or empty on failure.
     */
    private function ensure_global_swatch_attribute(string $name, string $type): string {
        $taxonomy = wc_attribute_taxonomy_name($name);

        if (taxonomy_exists($taxonomy)) {
            // Make sure the type is correct on an existing attribute.
            $this->update_attribute_type($taxonomy, $type);
            return $taxonomy;
        }

        $slug = wc_sanitize_taxonomy_name($name);
        $id   = wc_create_attribute([
            'name'         => $name,
            'slug'         => $slug,
            'type'         => $type,
            'order_by'     => 'menu_order',
            'has_archives' => false,
        ]);

        if (is_wp_error($id)) {
            if (taxonomy_exists($taxonomy)) {
                $this->update_attribute_type($taxonomy, $type);
                return $taxonomy;
            }
            return '';
        }

        delete_transient('wc_attribute_taxonomies');
        \WC_Cache_Helper::invalidate_cache_group('woocommerce-attributes');
        \WC_Post_Types::register_taxonomies();

        return $taxonomy;
    }

    /**
     * Update the type field of an existing attribute if it differs.
     */
    private function update_attribute_type(string $taxonomy, string $type): void {
        $attr_name = substr($taxonomy, 3); // strip "pa_"
        $attrs = wc_get_attribute_taxonomies();
        foreach ($attrs as $a) {
            if ($a->attribute_name === $attr_name && ($a->attribute_type ?? 'select') !== $type) {
                global $wpdb;
                $wpdb->update(
                    $wpdb->prefix . 'woocommerce_attribute_taxonomies',
                    ['attribute_type' => $type],
                    ['attribute_id' => $a->attribute_id]
                );
                delete_transient('wc_attribute_taxonomies');
                break;
            }
        }
    }

    /**
     * Create a term in a swatch taxonomy and set its Rey-compatible
     * swatch term-meta from the JSON data.
     *
     * @param string $taxonomy     e.g. "pa_color"
     * @param array  $term_data    {"name":"00","rey_attribute_color":"#E3BBA1"}
     * @param string $parent_title Used for image attachment titles.
     */
    private function ensure_swatch_term(string $taxonomy, array $term_data, string $parent_title): void {
        $term_name = $term_data['name'] ?? '';
        if ($term_name === '') {
            error_log('[RSI] ensure_swatch_term: Empty term name, skipping.');
            return;
        }

        $slug = wc_sanitize_taxonomy_name($term_name);
        $term = get_term_by('name', $term_name, $taxonomy);

        if (!$term || is_wp_error($term)) {
            $term = get_term_by('slug', $slug, $taxonomy);
        }

        $is_new = false;
        if (!$term || is_wp_error($term)) {
            $inserted = wp_insert_term($term_name, $taxonomy, ['slug' => $slug]);
            if (is_wp_error($inserted)) {
                error_log('[RSI] ensure_swatch_term: Failed to create term "' . $term_name . '" in "' . $taxonomy . '": ' . $inserted->get_error_message());
                return;
            }
            $term_id = $inserted['term_id'];
            $term    = get_term($term_id, $taxonomy);
            $is_new  = true;
        }

        if (!$term || is_wp_error($term)) {
            error_log('[RSI] ensure_swatch_term: Could not resolve term "' . $term_name . '" in "' . $taxonomy . '".');
            return;
        }

        $term_id = $term->term_id;

        // Set swatch type and value based on the JSON keys.
        $color = $term_data['rey_attribute_color'] ?? '';
        $image = $term_data['rey_attribute_image'] ?? '';

        if ($image !== '' && strpos($image, 'http') === 0) {
            // Image swatch — download and store attachment ID.
            $swatch_img_id = $this->image_handler->download($image, $parent_title);
            if ($swatch_img_id > 0) {
                update_term_meta($term_id, 'rey_attribute_image', $swatch_img_id);
                error_log('[RSI] ensure_swatch_term: Set image swatch for term "' . $term_name . '" (' . $taxonomy . ', ID ' . $term_id . ') image_id=' . $swatch_img_id);
            }
        } elseif ($color !== '') {
            // Colour swatch — store hex color. Rey Core reads this from
            // the ACF field "rey_attribute_color" stored as term meta.
            update_term_meta($term_id, 'rey_attribute_color', $color);
            error_log('[RSI] ensure_swatch_term: Set color swatch for term "' . $term_name . '" (' . $taxonomy . ', ID ' . $term_id . ') ' . ($is_new ? '(new)' : '(existing)') . ' rey_attribute_color=' . $color);
        }
    }

    /**
     * Apply Rey swatch data to a variation.
     *
     * @param int    $variation_id  The variation post ID.
     * @param array  $variation     Normalized variation row from CSV parser.
     * @param string $attribute_name The attribute name (e.g., "Color").
     * @param string $parent_title  Parent product title (for image naming).
     * @param bool   $is_global     Whether the attribute is a global taxonomy.
     */
    public function set_variation_swatches(
        int $variation_id,
        array $variation,
        string $attribute_name,
        string $parent_title = '',
        bool $is_global = false
    ): void {
        // 1. Extra variation images.
        $extra_image_urls = $variation['extra_variation_images'] ?? [];
        if (!empty($extra_image_urls)) {
            $extra_ids = $this->image_handler->download_many(
                $extra_image_urls,
                $parent_title
            );
            if (!empty($extra_ids)) {
                update_post_meta(
                    $variation_id,
                    'rey_extra_variation_images',
                    implode(',', $extra_ids)
                );
            }
        }

        // 2. Variation color / image swatch.
        $color_code = trim($variation['color_code'] ?? '');
        if ($color_code === '') {
            return;
        }

        $variation_value = $variation['attribute_value'] ?? '';
        if ($variation_value === '') {
            return;
        }

        // Store on the variation as post meta (fallback / custom attribute usage).
        $this->save_variation_swatch_meta(
            $variation_id,
            $color_code,
            $parent_title
        );

        // 3. If it's a global taxonomy attribute, update the term meta.
        if ($is_global) {
            $this->save_term_swatch_meta(
                $attribute_name,
                $variation_value,
                $color_code,
                $parent_title
            );
        }
    }

    /**
     * Save swatch meta on the variation post itself.
     *
     * @param int    $variation_id
     * @param string $color_code   Hex color (#rrggbb) or image URL.
     * @param string $parent_title
     */
    private function save_variation_swatch_meta(
        int $variation_id,
        string $color_code,
        string $parent_title
    ): void {
        $is_image_swatch = $this->is_image_swatch($color_code);

        if ($is_image_swatch) {
            // Download the swatch image and store its attachment ID.
            $swatch_img_id = $this->image_handler->download($color_code, $parent_title);
            if ($swatch_img_id > 0) {
                update_post_meta($variation_id, '_swatch_image_id', $swatch_img_id);
                update_post_meta($variation_id, '_swatch_type', 'image');
            }
        } else {
            // Store the hex color.
            update_post_meta($variation_id, '_swatch_color', $color_code);
            update_post_meta($variation_id, '_swatch_type', 'color');
        }
    }

    /**
     * Save swatch data on the taxonomy term so that Rey theme reads it.
     *
     * @param string $attribute_name  e.g., "Color"
     * @param string $term_value      e.g., "Black"
     * @param string $color_code      Hex color or image URL.
     * @param string $parent_title
     */
    private function save_term_swatch_meta(
        string $attribute_name,
        string $term_value,
        string $color_code,
        string $parent_title
    ): void {
        $taxonomy = wc_attribute_taxonomy_name($attribute_name);
        if (!taxonomy_exists($taxonomy)) {
            return;
        }

        $term = get_term_by('name', $term_value, $taxonomy);
        if (!$term || is_wp_error($term)) {
            // Also try by slug.
            $slug  = wc_sanitize_taxonomy_name($term_value);
            $term = get_term_by('slug', $slug, $taxonomy);
        }

        if (!$term || is_wp_error($term)) {
            return;
        }

        $is_image_swatch = $this->is_image_swatch($color_code);

        if ($is_image_swatch) {
            $swatch_img_id = $this->image_handler->download($color_code, $parent_title);
            if ($swatch_img_id > 0) {
                update_term_meta($term->term_id, 'rey_attribute_image', $swatch_img_id);
            }
        } else {
            update_term_meta($term->term_id, 'rey_attribute_color', $color_code);
        }
    }

    /**
     * Save the full swatch definition JSON on the parent product so custom code
     * (child theme functions.php filter) can read it if needed.
     *
     * @param int    $product_id     Parent variable product ID.
     * @param array  $swatch_data    Structured swatch data from CSV parser.
     */
    public function set_product_swatch_data(int $product_id, array $swatch_data): void {
        if (empty($swatch_data)) {
            return;
        }

        update_post_meta(
            $product_id,
            '_rsi_swatch_data',
            wp_slash(wp_json_encode($swatch_data))
        );
    }

    /**
     * Check whether a color_code value represents an image swatch (URL)
     * rather than a hex color.
     */
    private function is_image_swatch(string $color_code): bool {
        $color_code = trim($color_code);
        if ($color_code === '') {
            return false;
        }
        // Hex colors start with #.
        if (strpos($color_code, '#') === 0) {
            return false;
        }
        // Anything starting with http/https is an image.
        return strpos($color_code, 'http') === 0;
    }
}
