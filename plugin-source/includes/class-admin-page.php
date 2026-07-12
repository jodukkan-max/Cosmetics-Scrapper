<?php
/**
 * Admin page — displays the plugin's auth key for the Chrome extension.
 *
 * The key is auto-generated on plugin activation and stored in
 * wp_options['rsi_auth_key'].  The user copies it into the extension
 * to authorize CSV imports without WordPress credentials.
 */

class Rsi_Admin_Page {

    /**
     * Option key and key generation constants.
     */
    private const OPTION_KEY  = 'rsi_auth_key';
    private const KEY_LENGTH  = 4;
    private const KEY_GROUPS  = 1;  // single block, no dashes

    /**
     * Register the admin menu page.
     */
    public function register(): void {
        add_menu_page(
            __('Rey Swatches Import', 'rey-swatches-import'),
            __('Rey Swatches Import', 'rey-swatches-import'),
            'manage_options',
            'rey-swatches-import',
            [$this, 'render'],
            'dashicons-migrate',
            56
        );
    }

    /**
     * Render the admin page.
     */
    public function render(): void {
        $key = get_option(self::OPTION_KEY, '');

        // Handle regenerate action.
        if (isset($_POST['rsi_regenerate']) && check_admin_referer('rsi_regenerate_key')) {
            $key = Rsi_Key_Generator::generate();
            update_option(self::OPTION_KEY, $key);
            echo '<div class="notice notice-success is-dismissible"><p>'
                . esc_html__('Auth key regenerated. Update it in the Chrome extension.', 'rey-swatches-import')
                . '</p></div>';
        }

        $formatted = $this->format_key($key);
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Rey Swatches Import', 'rey-swatches-import'); ?></h1>
            <p><?php esc_html_e('This plugin receives CSV data from the Cosmetics Scraper Chrome extension and imports WooCommerce products with Rey theme swatch support.', 'rey-swatches-import'); ?></p>

            <div class="card" style="max-width:560px; margin-top:20px;">
                <h2><?php esc_html_e('Auth Key', 'rey-swatches-import'); ?></h2>
                <p><?php esc_html_e('Copy this key into the Chrome extension to authorize product imports.', 'rey-swatches-import'); ?></p>
                <div style="background:#f0f0f1; border:1px solid #c3c4c7; border-radius:4px; padding:16px; margin:12px 0; text-align:center;">
                    <code style="font-size:22px; font-weight:700; letter-spacing:2px; user-select:all;"><?php echo esc_html($formatted ?: __('Not generated', 'rey-swatches-import')); ?></code>
                </div>
                <form method="post" style="margin-top:8px;">
                    <?php wp_nonce_field('rsi_regenerate_key'); ?>
                    <button type="submit" name="rsi_regenerate" class="button button-secondary"
                            onclick="return confirm('<?php esc_attr_e('Regenerating the key will break any existing extension connections. Continue?', 'rey-swatches-import'); ?>')">
                        <?php esc_html_e('Regenerate Key', 'rey-swatches-import'); ?>
                    </button>
                </form>
            </div>

            <div class="card" style="max-width:560px; margin-top:20px;">
                <h2><?php esc_html_e('Extension Setup', 'rey-swatches-import'); ?></h2>
                <ol>
                    <li><?php esc_html_e('Copy the auth key above.', 'rey-swatches-import'); ?></li>
                    <li><?php esc_html_e('Open the Cosmetics Scraper Chrome extension.', 'rey-swatches-import'); ?></li>
                    <li><?php esc_html_e('Go to the Stores tab.', 'rey-swatches-import'); ?></li>
                    <li><?php printf(
                        /* translators: %s: site URL */
                        esc_html__('Enter %s as the store URL and paste the auth key.', 'rey-swatches-import'),
                        '<code>' . esc_html(home_url()) . '</code>'
                    ); ?></li>
                    <li><?php esc_html_e('Click Test to verify the connection, then scrape and import.', 'rey-swatches-import'); ?></li>
                </ol>
            </div>
        </div>
        <?php
    }

    /**
     * Format the raw key into readable groups: XXXX-XXXX-XXXX.
     */
    private function format_key(string $key): string {
        if (strlen($key) < self::KEY_LENGTH) {
            return $key;
        }
        $group_len = self::KEY_LENGTH / self::KEY_GROUPS;
        $groups = [];
        for ($i = 0; $i < self::KEY_LENGTH; $i += $group_len) {
            $groups[] = substr($key, $i, $group_len);
        }
        return implode('-', $groups);
    }
}

/**
 * Static helper to generate a cryptographically random alphanumeric key.
 */
class Rsi_Key_Generator {
    public static function generate(): string {
        $key = '';
        for ($i = 0; $i < 4; $i++) {
            $key .= random_int(0, 9);
        }
        return $key;
    }
}
