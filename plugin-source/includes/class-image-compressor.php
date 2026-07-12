<?php
/**
 * Image compressor — reduces file size of uploaded images using PHP GD
 * without changing dimensions.
 *
 * Only processes images larger than 300 KB. JPEGs are re-encoded at 80%
 * quality, PNGs at compression level 6. GIF, WebP, and SVG pass through.
 */

class Rsi_Image_Compressor {

    /**
     * JPEG re-encode quality (0-100). 80 provides good visual quality with
     * substantial size reduction.
     */
    private const JPEG_QUALITY = 80;

    /**
     * PNG compression level (0-9). 6 is the GD default and a good balance.
     */
    private const PNG_COMPRESSION = 6;

    /**
     * Minimum file size in bytes (300 KB). Images at or below this size
     * are skipped entirely.
     */
    private const MIN_SIZE = 307200;

    /**
     * Compress an image file in-place.
     *
     * Reads the file's mime type, opens it with GD, and re-saves at lower
     * quality/compression. Original dimensions are preserved.
     *
     * @param string $file_path Absolute path to the image file.
     * @return bool True if the file was compressed, false if skipped or failed.
     */
    public static function compress(string $file_path): bool {
        if (!file_exists($file_path)) {
            return false;
        }

        $size = filesize($file_path);
        if ($size <= self::MIN_SIZE) {
            return false;
        }

        $mime = wp_get_image_mime($file_path);
        if (!$mime) {
            return false;
        }

        $img = null;
        $success = false;

        switch ($mime) {
            case 'image/jpeg':
            case 'image/jpg':
                if (function_exists('imagecreatefromjpeg')) {
                    $img = @imagecreatefromjpeg($file_path);
                }
                if ($img && function_exists('imagejpeg')) {
                    $success = @imagejpeg($img, $file_path, self::JPEG_QUALITY);
                }
                break;

            case 'image/png':
                if (function_exists('imagecreatefrompng')) {
                    $img = @imagecreatefrompng($file_path);
                }
                if ($img && function_exists('imagepng')) {
                    // Preserve alpha channel for PNGs with transparency.
                    @imagealphablending($img, false);
                    @imagesavealpha($img, true);
                    $success = @imagepng($img, $file_path, self::PNG_COMPRESSION);
                }
                break;

            // GIF, WebP, SVG, and other formats — not compressed via GD.
            default:
                return false;
        }

        // imagedestroy() is a no-op since PHP 8.0 — suppress the deprecation.
        if ($img && PHP_VERSION_ID < 80000) {
            @imagedestroy($img);
        }

        // Clear the file stat cache so subsequent filesize() calls reflect the
        // compressed file, not the old size.
        clearstatcache(true, $file_path);

        return $success;
    }

    /**
     * WordPress `wp_handle_upload` filter callback.
     *
     * Compresses the uploaded file after WordPress accepts it but before
     * it is inserted as an attachment. This covers images imported through
     * WooCommerce's internal REST API (primary product/variation images).
     *
     * @param array $upload {
     *     @type string $file Absolute path to the uploaded file.
     *     @type string $url  URL of the uploaded file.
     *     @type string $type MIME type.
     * }
     * @return array Unmodified upload array.
     */
    public static function filter_upload(array $upload): array {
        if (!empty($upload['file'])) {
            self::compress($upload['file']);
        }
        return $upload;
    }
}
