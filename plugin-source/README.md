# Rey Swatches Import for Cosmetics Scraper

WordPress plugin that receives CSV data from the Cosmetics Scraper Chrome extension and imports WooCommerce variable products with full Rey theme swatch support.

## Features

- Receives CSV via REST endpoint (`POST /wp-json/scraper/v1/import-csv`)
- Creates **variable products** with variations (SKU, prices, images)
- Creates **simple products**
- Downloads product images from URLs and adds them to the Media Library
- Sets **Rey theme swatches**:
  - Color swatches (hex codes) on taxonomy terms
  - Image swatches (image URLs) on taxonomy terms
  - `rey_extra_variation_images` — extra variation gallery per variation
- Builds category hierarchy from ">" delimited category strings
- Authenticates via WordPress Application Passwords (Basic Auth)

## Requirements

- PHP 7.4+
- WordPress 5.8+
- WooCommerce 6.0+
- [Rey theme](https://reytheme.com/) (with Variation Swatches module enabled)
- WordPress Application Passwords enabled (built-in since WP 5.6)

## Installation

1. Download or clone this repository into `/wp-content/plugins/rey-swatches-import/`.
2. Activate the plugin from **Plugins > Installed Plugins** in the WordPress admin.
3. Go to **Rey Theme > Modules Manager** and ensure "Variation Swatches" and "Extra Variation Images" modules are enabled.
4. Create an Application Password for your admin user at **Users > Profile > Application Passwords**.

## Usage with Cosmetics Scraper

1. In the **Cosmetics Scraper** Chrome extension, go to the **Stores** tab.
2. Click **Add Store** and fill in:
   - **Name**: any label (e.g., "My WooCommerce Store")
   - **Store URL**: your site URL (e.g., `https://example.com`)
   - **WP User**: your WordPress username
   - **App Password**: the application password created above
3. Save. The endpoint `/wp-json/scraper/v1/import-csv` is now configured.

### Importing products

**Single product**: After scraping a product, click **Import** and select your store.

**Bulk queue**: Save multiple products to the Bulk queue, then click **Send to WooCommerce** and select your store.

The extension sends a POST request with `{ "csv": "..." }` in the body, authenticated via Basic Auth using the WP User + App Password.

## REST API Reference

### POST `/wp-json/scraper/v1/import-csv`

**Authentication**: Basic Auth (WordPress Application Password)

**Request body** (JSON):
```json
{
  "csv": "ID,Parent,Type,SKU,Name,tags,...\n1,,variable,,Lip Gloss,...\n2,id:1,variation,,Lip Gloss,..."
}
```

**Success response** (200):
```json
{
  "ok": true,
  "created_variable": 3,
  "created_simple": 1,
  "skipped": 0,
  "messages": [
    "Created \"Lip Gloss\" with 5 variations.",
    "Created simple product \"Lip Balm\"."
  ]
}
```

**Error response**:
```json
{
  "code": "rest_forbidden",
  "message": "You do not have permission to import products.",
  "data": { "status": 403 }
}
```

## CSV Format

The plugin expects the CSV columns produced by the Cosmetics Scraper extension.

**Variable products** have these columns:
```
ID, Parent, Type, SKU, Name, tags, Product URL, Images, Description,
Short Description, Categories, Regular Price, Sale Price,
Attribute 1 name, Attribute 1 value(s), Attribute 1 visible,
Attribute 1 global, Color Code, Rey Swatches
```

- Parent rows have `Type: variable`, `Parent: ''`
- Variation rows have `Type: variation`, `Parent: id:N`
- `Categories` uses `>` delimiter (e.g., `Makeup > Eyes > Eyeliner`)
- `Color Code` is a hex color (`#ff0000`) or an image URL for image swatches
- `Rey Swatches` (parent only) contains a JSON swatch definition

**Simple products** have these columns:
```
SKU, Name, tags, Product URL, Description, Short Description,
Regular Price, Categories, Images, Sale Price
```

## File Structure

```
rey-swatches-import/
  rey-swatches-import.php           — Plugin bootstrap
  includes/
    class-rest-endpoint.php         — REST route registration & auth
    class-csv-parser.php            — CSV string → structured product arrays
    class-product-creator.php       — WooCommerce product/variation creation
    class-image-handler.php         — Image download → media attachment
    class-rey-swatches.php          — Rey theme swatch meta handling
```

## Rey Theme Meta Keys

| Meta Key | Location | Value |
|---|---|---|
| `rey_extra_variation_images` | Variation post meta | Comma-separated attachment IDs |
| `_swatch_color` | Variation post meta | Hex color string |
| `_swatch_image_id` | Variation post meta | Attachment ID for swatch image |
| `_swatch_type` | Variation post meta | `color` or `image` |
| `{tax}_swatches_id_type` | Term meta | `color` or `photo` |
| `{tax}_swatches_id_color` | Term meta | Hex color string |
| `{tax}_swatches_id_photo` | Term meta | Attachment ID |
| `_rsi_swatch_data` | Product post meta | Full swatch definition JSON |

## Troubleshooting

**"You do not have permission" (403)**
- Ensure the WordPress user has `manage_woocommerce` capability (Admin or Shop Manager role).
- Verify the Application Password is correct.

**"Missing csv" (400)**
- The request body must contain a `csv` field with a non-empty string value.

**Images not appearing**
- Check that the image URLs are publicly accessible.
- Verify that the server can make outbound HTTP requests (`allow_url_fopen` or cURL).
- Check the WordPress Media Library for downloaded images.
