<?php
/**
 * CSV Parser for Cosmetics Scraper import data.
 *
 * Parses the CSV string received from the Chrome Extension into structured
 * product arrays grouped by parent product.
 *
 * CSV columns (variable products):
 *   ID, Parent, Type, SKU, Name, tags, Product URL, Images, Description,
 *   Short Description, Categories, Regular Price, Sale Price,
 *   Attribute 1 name, Attribute 1 value(s), Attribute 1 visible,
 *   Attribute 1 global, Color Code, Rey Swatches
 *
 * CSV columns (simple products):
 *   SKU, Name, tags, Product URL, Description, Short Description,
 *   Regular Price, Categories, Images, Sale Price
 */

class Rsi_Csv_Parser {

    /**
     * Parse a CSV string into an array of product groups.
     *
     * @param string $csv Raw CSV string from the extension.
     * @return array[] Each entry: { parent: array, variations: array[], is_variable: bool }
     */
    public function parse(string $csv): array {
        $rows = $this->parse_csv_rows($csv);

        if (empty($rows)) {
            return [];
        }

        // Detect: if the first row has 'ID' and 'Type' columns, it's variable.
        // Otherwise it's a simple product CSV.
        $first      = $rows[0];
        $is_variable = isset($first['ID']) && isset($first['Type']);

        if ($is_variable) {
            return $this->group_variable_products($rows);
        }

        return $this->group_simple_products($rows);
    }

    /**
     * Parse raw CSV string into an array of associative rows.
     *
     * @param string $csv
     * @return array[]
     */
    private function parse_csv_rows(string $csv): array {
        // Trim trailing whitespace and split into lines.
        $lines = preg_split('/\r\n|\r|\n/', trim($csv));
        if (empty($lines)) {
            return [];
        }

        // First line is the header.
        $header_line = array_shift($lines);

        // Detect delimiter: if header line contains tabs, use tab.
        $delimiter = (substr_count($header_line, "\t") > 0) ? "\t" : ',';

        $header = str_getcsv($header_line, $delimiter);
        $header = array_map('trim', $header);

        $rows = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }

            // Skip enclosure handling for tab-delimited data to avoid
            // issues with HTML content containing quote characters.
            if ($delimiter === "\t") {
                $fields = explode("\t", $line);
            } else {
                $fields = str_getcsv($line, $delimiter);
            }

            $row    = [];
            foreach ($header as $i => $col) {
                $row[$col] = isset($fields[$i]) ? trim($fields[$i]) : '';
            }
            $rows[] = $row;
        }

        return $rows;
    }

    /**
     * Group variable CSV rows into parent + variations.
     *
     * @param array[] $rows All parsed rows.
     * @return array[]
     */
    private function group_variable_products(array $rows): array {
        // Separate parent and variation rows.
        $parents    = [];
        $variations = [];

        foreach ($rows as $row) {
            $type = $row['Type'] ?? '';
            if ($type === 'variable') {
                $parents[$row['ID']] = $row;
            } elseif ($type === 'variation') {
                $variations[] = $row;
            }
        }

        // Build product groups.
        $products = [];
        foreach ($parents as $parent_id => $parent) {
            $children = [];
            foreach ($variations as $var) {
                $expected_parent = 'id:' . $parent_id;
                if (($var['Parent'] ?? '') === $expected_parent) {
                    $children[] = $var;
                }
            }

            $products[] = [
                'parent'       => $this->normalize_variable_row($parent),
                'variations'   => array_map([$this, 'normalize_variation_row'], $children),
                'is_variable'  => true,
            ];
        }

        return $products;
    }

    /**
     * Group simple CSV rows (one product per row, no parent/child structure).
     *
     * @param array[] $rows
     * @return array[]
     */
    private function group_simple_products(array $rows): array {
        $products = [];
        foreach ($rows as $row) {
            $products[] = [
                'parent'       => $this->normalize_simple_row($row),
                'variations'   => [],
                'is_variable'  => false,
            ];
        }
        return $products;
    }

    /**
     * Normalize a variable parent row into a clean product array.
     */
    private function normalize_variable_row(array $row): array {
        return [
            'name'                  => $row['Name'] ?? '',
            'sku'                   => $row['SKU'] ?? '',
            'type'                  => 'variable',
            'description'           => $row['Description'] ?? '',
            'short_description'     => $row['Short Description'] ?? '',
            'categories'            => $this->parse_categories($row['Categories'] ?? ''),
            'regular_price'         => $this->parse_price($row['Regular Price'] ?? ''),
            'sale_price'            => $this->parse_price($row['Sale Price'] ?? ''),
            'images'                => $this->parse_image_list($row['Images'] ?? ''),
            'tags'                  => $row['tags'] ?? '',
            'product_url'           => $row['Product URL'] ?? '',
            'attribute_name'        => $row['Attribute 1 name'] ?? 'Color',
            'attribute_values'      => $this->parse_attribute_values($row['Attribute 1 value(s)'] ?? ''),
            'attribute_visible'     => ($row['Attribute 1 visible'] ?? '') === '1',
            'attribute_global'      => ($row['Attribute 1 global'] ?? '') === '1',
            'extra_variation_images' => $this->parse_image_list($row['Rey Variations extra images'] ?? ''),
            'rey_swatches_json'     => $row['Rey Swatches'] ?? '',
        ];
    }

    /**
     * Normalize a variation row.
     */
    private function normalize_variation_row(array $row): array {
        return [
            'sku'                   => $row['SKU'] ?? '',
            'name'                  => $row['Name'] ?? '',
            'regular_price'         => $this->parse_price($row['Regular Price'] ?? ''),
            'sale_price'            => $this->parse_price($row['Sale Price'] ?? ''),
            'images'                => $this->parse_image_list($row['Images'] ?? ''),
            'attribute_name'        => $row['Attribute 1 name'] ?? '',
            'attribute_value'       => $row['Attribute 1 value(s)'] ?? '',
            'color_code'            => $row['Color Code'] ?? '',
            'extra_variation_images' => $this->parse_image_list($row['Rey Variations extra images'] ?? ''),
        ];
    }

    /**
     * Normalize a simple product row.
     */
    private function normalize_simple_row(array $row): array {
        return [
            'name'              => $row['Name'] ?? '',
            'sku'               => $row['SKU'] ?? '',
            'type'              => 'simple',
            'description'       => $row['Description'] ?? '',
            'short_description' => $row['Short Description'] ?? '',
            'categories'        => $this->parse_categories($row['Categories'] ?? ''),
            'regular_price'     => $this->parse_price($row['Regular Price'] ?? ''),
            'sale_price'        => $this->parse_price($row['Sale Price'] ?? ''),
            'images'            => $this->parse_image_list($row['Images'] ?? ''),
            'tags'              => $row['tags'] ?? '',
            'product_url'       => $row['Product URL'] ?? '',
        ];
    }

    /**
     * Parse a ">" delimited category string into an array.
     */
    private function parse_categories(string $cats): array {
        if ($cats === '') {
            return [];
        }
        $result = [];
        foreach (explode(',', $cats) as $part) {
            $part = trim($part);
            if ($part !== '') {
                $result[] = $part;
            }
        }
        return $result;
    }

    /**
     * Parse a comma-separated list of image URLs.
     */
    private function parse_image_list(string $images): array {
        if ($images === '') {
            return [];
        }
        $urls = explode(',', $images);
        return array_filter(array_map('trim', $urls));
    }

    /**
     * Parse a comma-separated list of attribute values.
     */
    private function parse_attribute_values(string $values): array {
        if ($values === '') {
            return [];
        }
        return array_filter(array_map('trim', explode(',', $values)));
    }

    /**
     * Parse a price string to float, returning 0 for empty/invalid.
     */
    private function parse_price(string $price): float {
        if ($price === '') {
            return 0.0;
        }
        return (float) str_replace(['$', ',', ' '], '', $price);
    }
}
