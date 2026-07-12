<?php
/**
 * Image handler — downloads images from remote URLs and creates WordPress
 * media attachments.
 *
 * Uses WordPress HTTP API (wp_remote_get) for downloading and the media
 * sideload functions for attachment creation.
 */

class Rsi_Image_Handler {

    /**
     * Maximum time (seconds) to spend downloading a single image.
     */
    private const DOWNLOAD_TIMEOUT = 30;

    /**
     * Cache of already-downloaded URLs → attachment IDs to avoid re-downloading
     * the same image within a single import session.
     *
     * @var array<string, int>
     */
    private array $cache = [];

    /**
     * Download an image from a remote URL, insert it as a WordPress attachment,
     * and return the attachment ID.
     *
     * @param string $url       Full image URL.
     * @param string $title     Optional title for the attachment (product name).
     * @return int              Attachment ID, or 0 on failure.
     */
    public function download(string $url, string $title = ''): int {
        // Strip query parameters for cache key (CDN URLs often have ?v=...).
        $cache_key = $this->cache_key($url);

        if (isset($this->cache[$cache_key])) {
            return $this->cache[$cache_key];
        }

        $id = $this->sideload($url, $title);
        $this->cache[$cache_key] = $id;
        return $id;
    }

    /**
     * Download multiple image URLs and return their attachment IDs.
     *
     * Returns only the IDs of successfully downloaded images.
     *
     * @param string[] $urls
     * @param string   $title
     * @return int[]
     */
    public function download_many(array $urls, string $title = ''): array {
        $ids = [];
        foreach ($urls as $url) {
            $id = $this->download($url, $title);
            if ($id > 0) {
                $ids[] = $id;
            }
        }
        return $ids;
    }

    /**
     * Build a cache key from a URL.
     */
    private function cache_key(string $url): string {
        $parsed = wp_parse_url($url);
        $path   = $parsed['path'] ?? '';
        // Use the filename stem as the key.
        $basename = pathinfo($path, PATHINFO_FILENAME);
        return sanitize_title($basename);
    }

    /**
     * Side-load an image using WordPress media_sideload_image + attachment lookup.
     *
     * media_sideload_image() returns HTML, not the attachment ID, so we need to
     * use download_url + wp_handle_sideload + wp_insert_attachment instead.
     *
     * @param string $url
     * @param string $title
     * @return int
     */
    private function sideload(string $url, string $title = ''): int {
        // Validate URL.
        $url = esc_url_raw($url);
        if (empty($url)) {
            return 0;
        }

        // Require media handling functions.
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';

        // Download the file to a temp location.
        $tmp = download_url($url, self::DOWNLOAD_TIMEOUT);
        if (is_wp_error($tmp)) {
            return 0;
        }

        // Determine the filename from the URL.
        $parsed_url = wp_parse_url($url);
        $path       = $parsed_url['path'] ?? '';
        $basename   = basename($path);
        // If no extension, try to detect from mime type.
        if (!preg_match('/\.(jpg|jpeg|png|gif|webp|svg)/i', $basename)) {
            $mime      = wp_check_filetype($basename);
            $ext       = $mime['ext'] ?? 'jpg';
            $basename .= '.' . $ext;
        }

        // Build a file array suitable for wp_handle_sideload.
        $file_array = [
            'name'     => $basename,
            'tmp_name' => $tmp,
        ];

        // Sideload into the uploads directory.
        $sideload = wp_handle_sideload($file_array, [
            'test_form'   => false,
            'test_size'   => true,
            'mimes'       => [
                'jpg|jpeg|jpe' => 'image/jpeg',
                'png'          => 'image/png',
                'gif'          => 'image/gif',
                'webp'         => 'image/webp',
            ],
        ]);

        if (is_wp_error($sideload) || !empty($sideload['error'])) {
            @unlink($tmp);
            return 0;
        }

        // Compress the image if it's above the threshold (300 KB).
        // This covers extra variation images and swatch images handled directly
        // by this class (primary product images are compressed via the
        // wp_handle_upload filter in the main plugin file).
        if (class_exists('Rsi_Image_Compressor')) {
            Rsi_Image_Compressor::compress($sideload['file']);
        }

        // Insert attachment into the media library.
        $attachment = [
            'guid'           => $sideload['url'],
            'post_mime_type' => $sideload['type'],
            'post_title'     => $title ?: sanitize_file_name(pathinfo($basename, PATHINFO_FILENAME)),
            'post_content'   => '',
            'post_status'    => 'inherit',
        ];

        $attach_id = wp_insert_attachment($attachment, $sideload['file']);

        if (is_wp_error($attach_id) || $attach_id === 0) {
            @unlink($tmp);
            return 0;
        }

        // Generate attachment metadata and thumbnails.
        $attach_data = wp_generate_attachment_metadata($attach_id, $sideload['file']);
        wp_update_attachment_metadata($attach_id, $attach_data);

        return $attach_id;
    }
}
