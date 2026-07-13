<?php
/**
 * Image compressor — reduces file size of uploaded images using PHP GD.
 *
 * 1. Resizes images whose longest side exceeds the max dimension (1200 px)
 *    to fit within that limit while preserving aspect ratio.
 * 2. Re-encodes JPEG at 80% quality and PNG at compression level 6.
 *
 * Only processes images larger than 300 KB. GIF, WebP, and SVG pass through.
 */

class Rsi_Image_Compressor {

    /**
     * Maximum dimension (width or height) in pixels for the source image.
     * If either side exceeds this, the image is scaled down proportionally.
     */
    private const MAX_DIMENSION = 800;

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
     * If the image exceeds MAX_DIMENSION on either side, it is scaled down
     * proportionally before saving. Then JPEGs are re-encoded at reduced quality
     * and PNGs at a higher compression level.
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
        $is_png = false;

        switch ($mime) {
            case 'image/jpeg':
            case 'image/jpg':
                if (function_exists('imagecreatefromjpeg')) {
                    $img = @imagecreatefromjpeg($file_path);
                }
                break;

            case 'image/png':
                $is_png = true;
                if (function_exists('imagecreatefrompng')) {
                    $img = @imagecreatefrompng($file_path);
                }
                break;

            // GIF, WebP, SVG, and other formats — not compressed via GD.
            default:
                return false;
        }

        if (!$img) {
            return false;
        }

        // ── 1. Resize if dimensions exceed MAX_DIMENSION ────────────────
        $orig_w = imagesx($img);
        $orig_h = imagesy($img);

        if ($orig_w > self::MAX_DIMENSION || $orig_h > self::MAX_DIMENSION) {
            $ratio = min(self::MAX_DIMENSION / $orig_w, self::MAX_DIMENSION / $orig_h);
            $new_w = (int) round($orig_w * $ratio);
            $new_h = (int) round($orig_h * $ratio);

            $resized = imagecreatetruecolor($new_w, $new_h);

            if ($is_png) {
                // Preserve transparency when resizing PNGs.
                imagealphablending($resized, false);
                imagesavealpha($resized, true);
                $color = imagecolorallocatealpha($resized, 0, 0, 0, 127);
                imagefilledrectangle($resized, 0, 0, $new_w - 1, $new_h - 1, $color);
            }

            imagecopyresampled(
                $resized, $img,
                0, 0, 0, 0,
                $new_w, $new_h, $orig_w, $orig_h
            );

            // Replace the original image with the resized version.
            if ($img && PHP_VERSION_ID < 80000) {
                @imagedestroy($img);
            }
            $img = $resized;
        }

        // ── 2. Save with reduced quality / compression ─────────────────
        if ($is_png) {
            if (function_exists('imagepng')) {
                @imagealphablending($img, false);
                @imagesavealpha($img, true);
                $success = @imagepng($img, $file_path, self::PNG_COMPRESSION);
            }
        } else {
            if (function_exists('imagejpeg')) {
                $success = @imagejpeg($img, $file_path, self::JPEG_QUALITY);
            }
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
