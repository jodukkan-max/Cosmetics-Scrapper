/* Product scrapers — browser port (no Node/axios/puppeteer).
 * Each scraper receives ctx: { site, productType, url, mainHtml, fetchText, fetchJson }
 *   - mainHtml  : HTML of the product page (rendered DOM in active-tab mode, or fetched)
 *   - fetchText : async (url, opts?) => string   (same-origin in page; cross-origin in SW)
 *   - fetchJson : async (url, opts?) => object
 * Returns { rows, title }. Runs in both a content script and the SW (self.ProductScraper).
 */
(function (root) {
  'use strict';

  const UA_HEADERS = {}; // browser sets its own UA/headers

  // ── Shared helpers ────────────────────────────────────────────────────────
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&bull;/g, '•').replace(/&hellip;/g, '…')
      .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&reg;/g, '®').replace(/&trade;/g, '™');
  }
  function normalizeShopUrl(src) {
    if (!src) return '';
    const abs = src.startsWith('//') ? 'https:' + src : src;
    return abs.split('?')[0];
  }
  const UUID_SUFFIX_RE = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^./?]+)$/i;
  function imgBaseName(url) {
    const filename = url.split('/').pop().split('?')[0];
    return filename.replace(UUID_SUFFIX_RE, '$1').toLowerCase();
  }
  function toSlug(str) {
    return str.toLowerCase()
      .replace(/[àáâã]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Shopify CDN resize/cleanup (Huda)
  const SHOP_RESIZE_RE = /_(\d+x\d*|x\d+|grande|large|medium|small|compact|pico|icon|master)(\.[a-z0-9]+)$/i;
  function cleanHudaImg(raw) {
    let u = raw.replace(/&amp;/g, '&').split('?')[0];
    if (u.startsWith('//')) u = 'https:' + u;
    const slash = u.lastIndexOf('/');
    return u.slice(0, slash + 1) + u.slice(slash + 1).replace(SHOP_RESIZE_RE, '$2');
  }
  function extractHudaGalleries(html) {
    const byVid = new Map();
    const re = /data-variant-id="(\d+)"\s+class="variant-gallery"\s*>/g;
    const marks = [];
    let m;
    while ((m = re.exec(html))) marks.push({ vid: m[1], start: re.lastIndex });
    for (let i = 0; i < marks.length; i++) {
      if (byVid.has(marks[i].vid)) continue;
      const end = i + 1 < marks.length ? marks[i + 1].start : Math.min(marks[i].start + 14000, html.length);
      const block = html.slice(marks[i].start, end);
      const seen = new Set(); const imgs = [];
      for (const im of block.matchAll(/\/\/[^"'\s]+?\/files\/[A-Za-z0-9][^"'\s?]+?\.(?:webp|jpg|jpeg|png|avif)/gi)) {
        const url = cleanHudaImg(im[0]);
        const key = imgBaseName(url);
        if (!seen.has(key)) { seen.add(key); imgs.push(url); }
      }
      byVid.set(marks[i].vid, imgs);
    }
    return byVid;
  }

  function woocommercePrice(fragment) {
    if (!fragment) return '';
    const t = fragment.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
    let n = (t.match(/[\d.,]+/) || [])[0] || '';
    if (!n) return '';
    if (/,\d{1,2}$/.test(n) && !/\.\d/.test(n)) n = n.replace(/\./g, '').replace(',', '.');
    else n = n.replace(/,/g, '');
    const f = parseFloat(n);
    return isFinite(f) ? f.toFixed(2) : '';
  }
  const fmtPrice = p => { const n = parseFloat(p); return isFinite(n) ? n.toFixed(2) : ''; };

  function ldBlocks(html) {
    return [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  }

  // ── Variation row builders (shared shapes) ──────────────────────────────────
  function variableRows(title, parentImages, description, shortDesc, categories, optionName, variants) {
    // variants: [{ name, sku, regularPrice, salePrice, images:[], extras:[], colorCode }]
    const rows = [];
    let rowId = 1;
    rows.push({
      ID: rowId++, Parent: '', Type: 'variable', SKU: '', Name: title,
      Images: (parentImages || []).slice(0, 4), 'Rey Variations extra images': '',
      Description: description || '', 'Short Description': shortDesc || '', Categories: categories || '',
      'Regular Price': '', 'Sale Price': '',
      'Attribute 1 name': optionName, 'Attribute 1 value(s)': variants.map(v => v.name).join(','),
      'Attribute 1 visible': '1', 'Attribute 1 global': '1', 'Color Code': '',
    });
    const parentId = rowId - 1;
    for (const v of variants) {
      rows.push({
        ID: rowId++, Parent: `id:${parentId}`, Type: 'variation', SKU: v.sku || '', Name: title,
        Images: v.images && v.images.length ? [v.images[0]] : [],
        'Rey Variations extra images': '',
        Description: '', 'Short Description': '', Categories: '',
        'Regular Price': '15', 'Sale Price': '',
        'Attribute 1 name': optionName, 'Attribute 1 value(s)': v.name,
        'Attribute 1 visible': '', 'Attribute 1 global': '1', 'Color Code': v.colorCode || '',
      });
    }
    return rows;
  }
  function simpleRow(o) {
    return [{
      SKU: o.sku || '', Name: o.name || '', Description: o.description || '', 'Short Description': o.shortDesc || '',
      'Regular Price': '15', Categories: o.categories || '', Images: o.images || [], 'Sale Price': '',
    }];
  }

  // ── e.l.f. (Shopify Storefront) ─────────────────────────────────────────────
  const ELF_QUERY = `query Product($handle:String!){product(handle:$handle){title description options{name values} images(first:100){nodes{url altText}} variants(first:100){nodes{id sku price{amount} compareAtPrice{amount} selectedOptions{name value} image{url altText} availableForSale}} metafield(namespace:"custom",key:"short_description"){value}}}`;
  // The page's Storefront `images` are one-swatch-per-variant, not the real product
  // gallery. The gallery shown on the PDP is embedded as a `"media":{"nodes":[…]}` JSON
  // block — read its image URLs (up to the next product field) for the parent images.
  function elfGallery(html) {
    const h = String(html || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&');
    const start = h.indexOf('"media":{"nodes":[');
    if (start < 0) return [];
    const end = h.indexOf('"handle"', start);
    const seg = h.slice(start, end > start ? end : start + 16000);
    return [...new Set([...seg.matchAll(/"url":"(https:\/\/cdn\.shopify\.com\/[^"]+?\.(?:jpg|jpeg|png|webp))/gi)].map(m => m[1].split('?')[0]))];
  }
  // elf renders shade swatches in the DOM as anchors carrying the variant gid (= the
  // Storefront variant id) plus EITHER a `--swatch-color:#hex` CSS var (colour swatch)
  // OR an <img src="…"> (image swatch). Returns gid -> { hex, img }. (\\" handles the
  // streamed/escaped HTML seen in URL mode.)
  function elfSwatches(html) {
    const h = String(html || '').replace(/\\"/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const map = new Map();
    const gids = [...h.matchAll(/data-variant-id="(gid:\/\/shopify\/ProductVariant\/\d+)"/gi)];
    gids.forEach((m, i) => {
      const gid = m[1];
      if (map.has(gid)) return;
      const block = h.slice(m.index, i + 1 < gids.length ? gids[i + 1].index : m.index + 600);
      const hex = (block.match(/--swatch-color:\s*(#[0-9a-fA-F]{3,8})/i) || [])[1] || '';
      const img = (block.match(/<img[^>]*\ssrc="(https?:\/\/[^"]+?\.(?:avif|png|jpg|jpeg|webp)[^"]*)"/i) || [])[1] || '';
      map.set(gid, { hex, img: img ? img.split('?')[0] : '' });
    });
    return map;
  }

  function extractStorefrontToken(html) {
    const m = html.match(/storefrontAccessToken\\?",\s*\\?"([a-f0-9]{32,})/) ||
      html.match(/"storefrontAccessToken","([a-f0-9]{32,})"/) ||
      html.match(/storefrontAccessToken[^"]*"([a-f0-9]{32,})"/) ||
      html.match(/"accessToken":"([a-f0-9]{32,})"/);
    return m ? m[1] : '';
  }
  function breadcrumbFromHtml(html, handle) {
    const cats = [];
    const bc = html.match(/"@type":"BreadcrumbList"[\s\S]*?"itemListElement":\[([\s\S]*?)\]/);
    if (bc) for (const m of bc[1].matchAll(/"name":"([^"]+)"/g)) {
      const n = m[1];
      if (n !== 'Home' && n.toLowerCase() !== String(handle).replace(/-/g, ' ')) cats.push(n);
    }
    return cats;
  }

  async function scrapeElf(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/^\/products\//, '').replace(/.*\/products\//, '').replace(/\/$/, '');
    const domain = u.origin;
    const html = ctx.mainHtml;
    const token = extractStorefrontToken(html);
    if (!token) throw new Error('Could not find Shopify storefront token.');
    const categories = breadcrumbFromHtml(html, handle).join('>');
    const gql = await ctx.fetchJson(`${domain}/api/2024-07/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Storefront-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ELF_QUERY, variables: { handle } }),
    });
    const product = gql && gql.data && gql.data.product;
    if (!product) throw new Error('Product not found via Storefront API.');
    // elf has no hex/swatch metafield — the variant's own photo is the image swatch,
    // and per-shade images are grouped by image altText ("…Product in <shade>").
    const swByGid = elfSwatches(html);
    const anyHex = [...swByGid.values()].some(s => s.hex);
    const allImgs = product.images.nodes.map(n => ({ url: n.url.split('?')[0], alt: (n.altText || '').toLowerCase() }));
    const shadeShort = val => String(val || '').split(/\s[-–—]\s/)[0].trim();
    const matchesShade = (alt, short) => short && alt.includes(short.toLowerCase());
    const variants = product.variants.nodes.map(v => {
      const optValue = v.selectedOptions[0] ? v.selectedOptions[0].value : '';
      const short = shadeShort(optValue);
      const price = fmtPrice(v.price.amount);
      const compareAt = v.compareAtPrice ? fmtPrice(v.compareAtPrice.amount) : '';
      const own = allImgs.filter(im => matchesShade(im.alt, short)).map(im => im.url);
      const main = (v.image && v.image.url ? v.image.url.split('?')[0] : '') || own[0] || '';
      // Swatch (keyed by variant gid): hex colour, or image swatch, else the shade photo.
      const sw = swByGid.get(v.id) || {};
      const colorCode = anyHex ? (sw.hex || '') : (sw.img || main);
      return { name: optValue, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '', images: main ? [main] : [], extras: [], colorCode };
    });
    const optionName = anyHex ? 'Color' : 'Image';
    // Parent gallery = the PDP's real product media (embedded JSON), not the per-variant swatches.
    const gallery = elfGallery(html);
    const parentImages = gallery.length ? gallery : product.images.nodes.map(n => n.url.split('?')[0]);
    const rows = variableRows(product.title, parentImages, product.description || '',
      (product.metafield && product.metafield.value) || '', categories, optionName, variants);
    return { rows, title: product.title };
  }

  async function scrapeElfSimple(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '');
    const domain = u.origin;
    const requested = [...u.searchParams.values()][0] || null;
    const html = ctx.mainHtml;
    const token = extractStorefrontToken(html);
    if (!token) throw new Error('Could not find Shopify storefront token.');
    const categories = breadcrumbFromHtml(html, handle).join('>');
    const Q = `query Product($handle:String!){product(handle:$handle){title description images(first:30){nodes{url}} variants(first:50){nodes{sku price{amount} compareAtPrice{amount} image{url} selectedOptions{name value}}} metafield(namespace:"custom",key:"short_description"){value}}}`;
    const gql = await ctx.fetchJson(`${domain}/api/2024-07/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Storefront-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: Q, variables: { handle } }),
    });
    const product = gql && gql.data && gql.data.product;
    if (!product) throw new Error('Product not found via Storefront API.');
    let target = product.variants.nodes[0];
    if (requested) {
      const match = product.variants.nodes.find(v => v.selectedOptions.some(o => o.value.toLowerCase() === requested.toLowerCase()));
      if (match) target = match;
    }
    const price = target ? fmtPrice(target.price.amount) : '';
    const compareAt = target && target.compareAtPrice ? fmtPrice(target.compareAtPrice.amount) : '';
    const images = product.images.nodes.map(n => n.url.split('?')[0]);
    return {
      rows: simpleRow({ sku: target && target.sku, name: product.title, description: product.description || '',
        shortDesc: (product.metafield && product.metafield.value) || '', regularPrice: compareAt || price,
        salePrice: compareAt ? price : '', categories, images }),
      title: product.title,
    };
  }

  // ── Huda (Shopify, variant-gallery) ─────────────────────────────────────────
  async function scrapeHuda(ctx) {
    const u = new URL(ctx.url);
    const pathMatch = u.pathname.match(/^(.*)\/products\/([^/?]+)/);
    if (!pathMatch) throw new Error('Not a Huda product URL.');
    const base = `${u.origin}${pathMatch[1] || ''}`;
    const handle = pathMatch[2];
    const html = ctx.mainHtml;
    const product = (await ctx.fetchJson(`${base}/products/${handle}.json`)).product;
    if (!product || !product.variants) throw new Error('Could not load Huda product JSON.');
    const title = product.title || '';

    const swatchByVid = new Map();
    let idx = -1;
    while ((idx = html.indexOf('custom-option product-dropdown-swatch', idx + 1)) !== -1) {
      const block = html.slice(idx, idx + 1200);
      const shade = (block.match(/data-value="([^"]*)"/) || [])[1];
      const vid = (block.match(/data-id="([^"]*)"/) || [])[1];
      const hex = (block.match(/data-option-swatch-value="([^"]*)"/) || [])[1];
      const img = (block.match(/data-option-swatch-image="([^"]*)"/) || [])[1];
      if (vid && shade && !swatchByVid.has(vid)) swatchByVid.set(vid, { shade, hex: hex || '', img: img ? normalizeShopUrl(img) : '' });
    }
    const isImageSwatch = [...swatchByVid.values()].some(s => s.img && !s.hex);
    const descMatch = html.match(/class="product__description[^"]*"\s*>([\s\S]*?)<\/div>/);
    const description = descMatch ? decodeEntities(descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';

    const kept = product.variants.filter(v => swatchByVid.has(String(v.id)));
    const variantsRaw = kept.length ? kept : product.variants;
    const optionName = isImageSwatch ? 'Image' : 'Color';
    const galleryByVid = extractHudaGalleries(html);
    const sharedImages = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
    const galleryFor = v => { const g = galleryByVid.get(String(v.id)); return g && g.length ? g : sharedImages; };
    const galleries = variantsRaw.map(galleryFor);

    const variants = variantsRaw.map((v, i) => {
      const sw = swatchByVid.get(String(v.id)) || {};
      const price = fmtPrice(v.price);
      const compareAt = v.compare_at_price && parseFloat(v.compare_at_price) > 0 ? fmtPrice(v.compare_at_price) : '';
      const g = galleries[i];
      return { name: sw.shade || v.option1 || v.title, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '',
        images: g, extras: g.slice(1, 3), colorCode: isImageSwatch ? (sw.img || '') : (sw.hex || '') };
    });
    const rows = variableRows(title, galleries[0] || [], description, '', '', optionName, variants);
    return { rows, title };
  }
  async function scrapeHudaSimple(ctx) {
    const u = new URL(ctx.url);
    const pathMatch = u.pathname.match(/^(.*)\/products\/([^/?]+)/);
    const base = `${u.origin}${pathMatch[1] || ''}`;
    const handle = pathMatch[2];
    const html = ctx.mainHtml;
    const product = (await ctx.fetchJson(`${base}/products/${handle}.json`)).product;
    if (!product || !product.variants || !product.variants.length) throw new Error('Could not load Huda product JSON.');
    const variant = product.variants[0];
    const price = fmtPrice(variant.price);
    const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
    const descMatch = html.match(/class="product__description[^"]*"\s*>([\s\S]*?)<\/div>/);
    const description = descMatch ? decodeEntities(descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    const galleryByVid = extractHudaGalleries(html);
    let images = galleryByVid.get(String(variant.id)) || [];
    if (!images.length) images = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
    return { rows: simpleRow({ sku: variant.sku, name: product.title, description, regularPrice: compareAt || price, salePrice: compareAt ? price : '', images }), title: product.title || '' };
  }

  // ── Pastel (Shopify, hex swatch from page) ──────────────────────────────────
  // Pastel's PDP shows a lifestyle "section-gallery" whose photos aren't in the Shopify
  // product JSON. Pull the page's product images (matched to this product by handle
  // tokens, skipping swatches and images already in the JSON) as clean full-res URLs.
  function pastelDomGallery(html, handle, jsonFiles) {
    const h = String(html || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&');
    const tokens = String(handle).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    const stripSize = fn => fn.replace(/_\d+x(\d+)?(_crop_center)?(?=\.[a-z]+$)/i, '');
    const seen = new Set(); const out = [];
    for (const m of h.matchAll(/(?:https?:)?\/\/[a-z0-9.-]*(?:pastelarabia\.com|cdn\.shopify\.com)[^"'\s,)\\]*?\.(?:webp|jpe?g|png)/gi)) {
      const raw = m[0].replace(/^\/\//, 'https://').split('?')[0];
      const base = stripSize(raw.split('/').pop()).toLowerCase();
      if (seen.has(base) || /swatch/i.test(base) || jsonFiles.has(base)) continue;
      if (!tokens.some(t => base.includes(t))) continue;
      seen.add(base);
      out.push(stripSize(raw));
    }
    return out;
  }
  async function scrapePastel(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const html = ctx.mainHtml;
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants) throw new Error('Could not load Pastel product JSON.');
    const categories = product.product_type || '';
    const hexByValue = new Map();
    for (const m of html.matchAll(/name="Color"\s+value="([^"]+)"[\s\S]{0,260}?--option-color:\s*(#[0-9a-fA-F]{3,8})/g)) {
      const val = decodeEntities(m[1].trim());
      if (!hexByValue.has(val)) hexByValue.set(val, m[2]);
    }
    const allImages = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const imgById = new Map(allImages.map(im => [im.id, normalizeShopUrl(im.src)]));
    const isSwatchFile = src => /swatch/i.test(src.split('/').pop());
    // Parent gallery: first variant's own photo + shared JSON shots + page lifestyle
    // photos (which aren't in the JSON). Handles Pastel's two product layouts.
    const sharedJson = allImages.filter(im => !(im.variant_ids || []).length && !isSwatchFile(im.src)).map(im => normalizeShopUrl(im.src));
    const v0 = product.variants[0];
    const v0src = v0 && v0.featured_image ? v0.featured_image.src : (v0 && v0.image_id && imgById.has(v0.image_id) ? (allImages.find(im => im.id === v0.image_id) || {}).src : '');
    const v0img = v0src && !isSwatchFile(v0src) ? normalizeShopUrl(v0src) : '';
    const jsonFiles = new Set(allImages.map(im => im.src.split('/').pop().split('?')[0].toLowerCase()));
    const parentImages = [...new Set([v0img, ...sharedJson, ...pastelDomGallery(html, handle, jsonFiles)].filter(Boolean))];
    const variants = product.variants.map(v => {
      const mainImg = v.featured_image ? normalizeShopUrl(v.featured_image.src) : (v.image_id && imgById.has(v.image_id) ? imgById.get(v.image_id) : (parentImages[0] || ''));
      // Variant-specific photos (if any), then the product's shared shots — so each
      // variation still gets extra images even when it only has one tagged photo.
      const own = allImages.filter(im => (im.variant_ids || []).includes(v.id) && !isSwatchFile(im.src)).map(im => normalizeShopUrl(im.src));
      const extras = [...own, ...parentImages].filter((u, i, a) => u && u !== mainImg && a.indexOf(u) === i).slice(0, 2);
      const price = fmtPrice(v.price);
      const compareAt = v.compare_at_price && parseFloat(v.compare_at_price) > 0 ? fmtPrice(v.compare_at_price) : '';
      return { name: v.option1, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '', images: mainImg ? [mainImg] : [], extras, colorCode: hexByValue.get(v.option1) || '' };
    });
    const rows = variableRows(product.title, parentImages, '', '', categories, 'Color', variants);
    return { rows, title: product.title };
  }
  async function scrapePastelSimple(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants || !product.variants.length) throw new Error('Could not load Pastel product JSON.');
    const variant = product.variants[0];
    const price = fmtPrice(variant.price);
    const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
    const images = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).filter(im => !/swatch/i.test(im.src.split('/').pop())).map(im => normalizeShopUrl(im.src));
    return { rows: simpleRow({ sku: variant.sku, name: product.title, regularPrice: compareAt || price, salePrice: compareAt ? price : '', categories: product.product_type || '', images }), title: product.title || '' };
  }

  // ── Glow Recipe (Shopify, image swatch = variant image) ─────────────────────
  const GLOW_SWATCH_QUERY = `query($handle:String!){product(handle:$handle){variants(first:100){nodes{id metafield(namespace:"custom",key:"swatch_image"){reference{...on MediaImage{image{url}}}}}}}}`;
  // Glow Recipe's per-shade swatch is a <div data-variant-id="…" style="background-image:
  // url(&quot;…_SWATCH_….jpg&quot;)"> (HTML-escaped). Keyed by the Shopify variant id.
  function glowSwatches(html) {
    const h = String(html || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&');
    const map = new Map();
    for (const m of h.matchAll(/data-variant-id="(\d+)"[^>]*background-image:\s*url\(\s*['"]?((?:https?:)?\/\/[^)'"\s]+?\.(?:png|jpg|jpeg|webp|avif))/gi)) {
      if (!map.has(m[1])) map.set(m[1], normalizeShopUrl(m[2]));
    }
    return map;
  }
  async function scrapeGlowrecipe(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants) throw new Error('Could not load Glow Recipe product JSON.');
    const description = product.body_html ? decodeEntities(product.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    const allImages = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const imgById = new Map(allImages.map(im => [im.id, normalizeShopUrl(im.src)]));
    // The dedicated swatch is the variant metafield custom.swatch_image — only the
    // active shade renders inline in the DOM, the rest load by JS, so read it from the
    // Storefront API (canonical, future-proof). DOM swatch is a fallback for the active one.
    const domSwatch = glowSwatches(ctx.mainHtml);
    const mfSwatch = new Map();
    const token = extractStorefrontToken(ctx.mainHtml);
    if (token) {
      try {
        const gql = await ctx.fetchJson(`${u.origin}/api/2024-07/graphql.json`, {
          method: 'POST', headers: { 'X-Shopify-Storefront-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: GLOW_SWATCH_QUERY, variables: { handle } }),
        });
        const nodes = gql && gql.data && gql.data.product && gql.data.product.variants.nodes;
        for (const n of (nodes || [])) {
          const url = n.metafield && n.metafield.reference && n.metafield.reference.image ? n.metafield.reference.image.url.split('?')[0] : '';
          if (url) mfSwatch.set(String(n.id).replace(/.*\//, ''), url);
        }
      } catch (e) { /* fall back to DOM swatch */ }
    }
    // The JSON tags shades to award-seal/teaser images, so we match real shade photos by
    // the shade keyword in the filename (option1 "Fig Bingsoo (…)" → "FIG"), skipping
    // seals, infographics and swatch crops.
    const fileKey = src => src.split('/').pop().split('?')[0].toUpperCase().replace(/[\s.-]+/g, '_');
    const isExcluded = src => /ALLURE_BEAUTY_SEAL|INFOGRAPHIC|_SEAL_|AWARD|SWATCH|_GRID_/.test(fileKey(src));
    // A real shade photo (vs. ingredient/claim/grid/seal graphics): teaser, pdp, model,
    // lifestyle or before/after shots named for the shade.
    const isShadePhoto = fk => /(TEASER|_PDP|MODEL|LIFESTYLE|B_A_)/.test(fk) && !/SEAL|_GRID_|SWATCH/.test(fk);
    const shadeKeyOf = name => String(name || '').split(/\s*bingsoo/i)[0].trim().toUpperCase().replace(/[\s-]+/g, '_');
    const variants = product.variants.map(v => {
      const realSwatch = mfSwatch.get(String(v.id)) || domSwatch.get(String(v.id)) || '';
      const key = shadeKeyOf(v.option1);
      const keyRe = key ? new RegExp('(^|_)' + key + '(_|$)') : null;
      const shadePhotos = keyRe
        ? allImages.filter(im => keyRe.test(fileKey(im.src)) && isShadePhoto(fileKey(im.src))).map(im => normalizeShopUrl(im.src))
        : [];
      // Headline photo: prefer a teaser/PDP shot, else any shade photo.
      const headline = shadePhotos.find(u => /(TEASER|_PDP)/.test(fileKey(u))) || shadePhotos[0] || '';
      // Swatch = dedicated swatch image, else the shade's own photo (never an award seal).
      const swatch = realSwatch || headline;
      const main = headline || realSwatch;
      const extras = shadePhotos.filter(u => u !== main && u !== swatch);
      const price = fmtPrice(v.price);
      const compareAt = v.compare_at_price && parseFloat(v.compare_at_price) > 0 ? fmtPrice(v.compare_at_price) : '';
      return { name: v.option1, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '', images: main ? [main] : [], extras, colorCode: swatch };
    });
    // Parent gallery = the clean product shots (variant_ids tagging is unreliable here,
    // pointing at award seals, so we just take every non-excluded image).
    let parentImages = [...new Set(allImages.filter(im => !isExcluded(im.src)).map(im => normalizeShopUrl(im.src)))].slice(0, 12);
    if (!parentImages.length) parentImages = variants.map(v => v.images[0]).filter(Boolean);
    const rows = variableRows(product.title, parentImages, description, '', product.product_type || '', 'Image', variants);
    return { rows, title: product.title };
  }

  // ── Flormar (WooCommerce — each color is a sibling product page) ────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function flormarPageImages(html) {
    const re = /https:\/\/[a-z0-9.-]+\.cloudfront\.net\/PRODUCTS_EN\/(\d+)_(\d+)\.jpg/gi;
    const seen = new Set(); const list = []; let barcode = '';
    for (const m of html.matchAll(re)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      barcode = barcode || m[1];
      list.push({ url: m[0], n: parseInt(m[2], 10) });
    }
    list.sort((a, b) => a.n - b.n);
    return { images: list.map(x => x.url), barcode };
  }
  async function flormarFetch(ctx, url, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try { return await ctx.fetchText(url); }
      catch (e) { if (i < tries - 1) await sleep(1200 * (i + 1)); else throw e; }
    }
  }
  function flormarMeta(html) {
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
    const descMatch = html.match(/<div[^>]*class="[^"]*product-detail-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch ? decodeEntities(descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    return { title, description };
  }
  async function scrapeFlormar(ctx) {
    const html = ctx.mainHtml;
    const { title, description } = flormarMeta(html);
    const clStart = html.indexOf('id="color-list"');
    const clBlock = clStart !== -1 ? html.slice(clStart, html.indexOf('</ul>', clStart)) : '';
    const colorRe = /<a\s+href="([^"]+)"[^>]*class="([^"]*)"[\s\S]*?background-color:\s*(#[0-9a-fA-F]{3,8})[\s\S]*?text-sm[^>]*>([^<]+)</g;
    const colors = [];
    for (const m of clBlock.matchAll(colorRe)) colors.push({ url: m[1], hex: m[3], name: decodeEntities(m[4].trim()) });
    if (!colors.length) throw new Error('No color swatches found on Flormar page.');
    const norm = u => u.replace(/\/$/, '');
    const pages = [];
    for (const c of colors) {
      let pageHtml;
      if (norm(ctx.url) === norm(c.url)) pageHtml = html;
      else { await sleep(400); pageHtml = await flormarFetch(ctx, c.url); }
      pages.push(Object.assign({}, c, flormarPageImages(pageHtml)));
    }
    const variants = pages.map(p => ({
      name: p.name, sku: p.barcode || '', regularPrice: '', salePrice: '',
      images: p.images, extras: p.images.slice(1, 3), colorCode: p.hex,
    }));
    const rows = variableRows(title, pages[0] ? pages[0].images : [], description, '', '', 'Color', variants);
    return { rows, title };
  }
  async function scrapeFlormarSimple(ctx) {
    const { title, description } = flormarMeta(ctx.mainHtml);
    const { images, barcode } = flormarPageImages(ctx.mainHtml);
    return { rows: simpleRow({ sku: barcode, name: title, description, images }), title };
  }

  // ── Misslyn (Shopify, image swatches keyed by shade name) ───────────────────
  // Each shade is a swatch <label title="<shade>"> wrapping a <span class="swatch"
  // style="--swatch--background: url(<img>)">. We pair the swatch image to its shade
  // by the option value (label title), which equals the variant's option1 — robust
  // even when the swatch filename has nothing to do with the SKU.
  function misslynSwatches(html) {
    const map = new Map();
    const re = /title="([^"]+)"[^>]*class="[^"]*swatch-input__label[^"]*"[\s\S]{0,300}?--swatch--background:\s*url\(\s*['"]?((?:https?:)?\/\/[^)'"\s]+?\.(?:png|jpg|jpeg|webp))/gi;
    for (const m of html.matchAll(re)) {
      const name = decodeEntities(m[1].trim());
      const url = normalizeShopUrl(m[2]);
      if (name && url && !map.has(name)) map.set(name, url);
    }
    return map;
  }
  function shopifyBodyText(product) {
    return product.body_html ? decodeEntities(product.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
  }
  function misslynLdCategory(html) {
    for (const b of ldBlocks(html || '')) {
      try { const j = JSON.parse(b); if ((j['@type'] === 'ProductGroup' || j['@type'] === 'Product') && j.category) return j.category; } catch (e) { /* skip */ }
    }
    return '';
  }
  async function scrapeMisslyn(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const html = ctx.mainHtml;
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants) throw new Error('Could not load Misslyn product JSON.');
    const categories = product.product_type || breadcrumbFromHtml(html, handle).join('>') || misslynLdCategory(html) || '';
    const swatchByName = misslynSwatches(html);
    const isImageSwatch = swatchByName.size > 0;
    const allImages = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const imgById = new Map(allImages.map(im => [im.id, normalizeShopUrl(im.src)]));
    const parentImages = allImages.map(im => normalizeShopUrl(im.src));
    // Product shots not tied to any single variant — shown as extra images on every variation.
    const sharedImages = allImages.filter(im => !(im.variant_ids || []).length).map(im => normalizeShopUrl(im.src));
    const variants = product.variants.map(v => {
      const own = allImages.filter(im => (im.variant_ids || []).includes(v.id)).map(im => normalizeShopUrl(im.src));
      const main = v.featured_image ? normalizeShopUrl(v.featured_image.src)
        : (v.image_id && imgById.has(v.image_id) ? imgById.get(v.image_id) : (own[0] || ''));
      const extras = [...own, ...sharedImages].filter((u, i, a) => u && u !== main && a.indexOf(u) === i).slice(0, 2);
      const price = fmtPrice(v.price);
      const compareAt = v.compare_at_price && parseFloat(v.compare_at_price) > 0 ? fmtPrice(v.compare_at_price) : '';
      return { name: v.option1, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '',
        images: main ? [main] : own.slice(0, 1), extras, colorCode: swatchByName.get(v.option1) || '' };
    });
    const optionName = isImageSwatch ? 'Image' : (product.options[0] ? product.options[0].name : 'Color');
    const rows = variableRows(product.title, parentImages, shopifyBodyText(product), '', categories, optionName, variants);
    return { rows, title: product.title };
  }
  async function scrapeMisslynSimple(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants || !product.variants.length) throw new Error('Could not load Misslyn product JSON.');
    const variant = product.variants[0];
    const price = fmtPrice(variant.price);
    const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
    const images = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
    const categories = product.product_type || misslynLdCategory(ctx.mainHtml) || '';
    return { rows: simpleRow({ sku: variant.sku, name: product.title, description: shopifyBodyText(product), regularPrice: compareAt || price, salePrice: compareAt ? price : '', categories, images }), title: product.title || '' };
  }

  // ── essence (Shopify; hex shade swatches, per-shade galleries via image alt) ──
  // Shade picker buttons: <button class="…js-swatch-shade-item" style="background:#7a4436"
  // title="01 Deep Scroll">. The Shopify JSON tags only one image per variant, but every
  // image's `alt` equals its shade name, so the full per-shade gallery is recoverable.
  function essenceSwatches(html) {
    const map = new Map(); // shade name -> { hex, img }
    for (const m of html.matchAll(/<button[^>]*js-swatch-shade-item[^>]*>/gi)) {
      const tag = m[0];
      const name = decodeEntities((tag.match(/title="([^"]+)"/) || [])[1] || '');
      if (!name || map.has(name)) continue;
      const hex = (tag.match(/background(?:-color)?:\s*(#[0-9a-fA-F]{3,8})/i) || [])[1] || '';
      const url = (tag.match(/background(?:-image)?:\s*url\(\s*['"]?((?:https?:)?\/\/[^)'"\s]+)/i) || [])[1] || '';
      map.set(name, { hex, img: url ? normalizeShopUrl(url) : '' });
    }
    return map;
  }
  function essenceVariantData(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    return ctx.fetchJson(`${u.origin}/products/${handle}.json`).then(r => r.product);
  }
  async function scrapeEssence(ctx) {
    const html = ctx.mainHtml;
    const product = await essenceVariantData(ctx);
    if (!product || !product.variants) throw new Error('Could not load essence product JSON.');
    const swatches = essenceSwatches(html);
    const isImageSwatch = [...swatches.values()].some(s => s.img && !s.hex);
    const categories = product.product_type || misslynLdCategory(html) || '';
    const allImages = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const imgById = new Map(allImages.map(im => [im.id, normalizeShopUrl(im.src)]));
    let firstGallery = [];
    const variants = product.variants.map((v, i) => {
      const shade = v.option1;
      // Every image whose alt matches this shade belongs to it (gallery), main image first.
      let imgs = allImages.filter(im => (im.alt || '').trim() === shade).map(im => normalizeShopUrl(im.src));
      const featured = v.featured_image ? normalizeShopUrl(v.featured_image.src)
        : (v.image_id && imgById.has(v.image_id) ? imgById.get(v.image_id) : (imgs[0] || ''));
      if (featured) imgs = [featured, ...imgs.filter(x => x !== featured)];
      if (i === 0) firstGallery = imgs;
      const main = imgs[0] || '';
      const price = fmtPrice(v.price);
      const compareAt = v.compare_at_price && parseFloat(v.compare_at_price) > 0 ? fmtPrice(v.compare_at_price) : '';
      const sw = swatches.get(shade) || {};
      return { name: shade, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '',
        images: main ? [main] : [], extras: [], colorCode: isImageSwatch ? (sw.img || '') : (sw.hex || '') };
    });
    // Parent gallery = the first variant's own product photos (not one-per-shade thumbnails).
    const parentImages = firstGallery.length ? firstGallery : variants.map(v => v.images[0]).filter(Boolean);
    const optionName = isImageSwatch ? 'Image' : 'Color';
    const rows = variableRows(product.title, parentImages, shopifyBodyText(product), '', categories, optionName, variants);
    return { rows, title: product.title };
  }
  async function scrapeEssenceSimple(ctx) {
    const product = await essenceVariantData(ctx);
    if (!product || !product.variants || !product.variants.length) throw new Error('Could not load essence product JSON.');
    const variant = product.variants[0];
    const price = fmtPrice(variant.price);
    const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
    const images = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
    const categories = product.product_type || misslynLdCategory(ctx.mainHtml) || '';
    return { rows: simpleRow({ sku: variant.sku, name: product.title, description: shopifyBodyText(product), regularPrice: compareAt || price, salePrice: compareAt ? price : '', categories, images }), title: product.title || '' };
  }

  // ── Charlotte Tilbury (Next.js; data in __NEXT_DATA__) ──────────────────────
  // Each shade is its own product page; the shade list is product.appearances
  // (name = URL slug, swatchImage = image swatch). For multi-shade products we
  // fetch each shade's page (same-origin) to read its sku/price/images.
  function ctModel(html) {
    const m = (html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    let data; try { data = JSON.parse(m[1]); } catch (e) { return null; }
    const pp = data.props || {};
    return (pp.pageProps && pp.pageProps.page && pp.pageProps.page.model)
      || (pp.initialState && pp.initialState.page && pp.initialState.page.model) || null;
  }
  function ctImg(src) {
    if (!src) return '';
    const abs = src.startsWith('//') ? 'https:' + src : src;
    try { return encodeURI(abs); } catch (e) { return abs; }
  }
  function ctCategories(model) { return ((model && model.breadcrumbs) || []).map(b => (b.label || '').trim()).filter(Boolean).join('>'); }
  function ctDescription(p) {
    const d = p.description || p.longDescription || p.cardDescription || '';
    return decodeEntities(String(d).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  }
  function ctImages(p) { return (p.images || []).map(im => ctImg(im.imageSrc || im.src)).filter(Boolean); }
  function ctName(p) {
    const t = (p.title || '').replace(/\s+/g, ' ').trim();
    const s = (p.subtitle || '').replace(/\s+/g, ' ').trim();
    return s && !t.toUpperCase().includes(s.toUpperCase()) ? `${t} ${s}` : t;
  }
  function ctVariant(prod, appearance) {
    const imgs = ctImages(prod);
    const price = prod.price && prod.price.purchasePrice ? fmtPrice(prod.price.purchasePrice.value) : '';
    const swatch = appearance && appearance.swatchImage ? ctImg(appearance.swatchImage.imageSrc)
      : (prod.swatchImage ? ctImg(prod.swatchImage.imageSrc) : '');
    return {
      name: (prod.subtitle || '').replace(/\s+/g, ' ').trim() || prod.title || '',
      sku: prod.sku || '', regularPrice: price, salePrice: '',
      images: imgs.slice(0, 1), extras: imgs.slice(1, 3), colorCode: swatch,
    };
  }
  // A "sibling" (shade option) carries its own full data inline: subtitle (shade name),
  // sku, price, images[] and swatchImage. Bundles price every shade at the bundle price.
  function ctVariantFromSibling(sib, parentPrice, isBundle) {
    const imgs = ctImages(sib);
    const sibPrice = sib.price && sib.price.purchasePrice ? fmtPrice(sib.price.purchasePrice.value) : '';
    return {
      name: (sib.subtitle || '').replace(/\s+/g, ' ').trim() || sib.title || '',
      sku: sib.sku || '', regularPrice: isBundle ? parentPrice : (sibPrice || parentPrice), salePrice: '',
      images: imgs.slice(0, 1), extras: imgs.slice(1, 3),
      colorCode: sib.swatchImage ? ctImg(sib.swatchImage.imageSrc) : '',
    };
  }
  async function scrapeCharlottetilbury(ctx) {
    const model = ctModel(ctx.mainHtml);
    if (!model || !model.product) throw new Error('Could not read Charlotte Tilbury product data.');
    const base = model.product;
    const title = (base.title || '').replace(/\s+/g, ' ').trim();
    const categories = ctCategories(model);
    const description = ctDescription(base);
    const parentPrice = base.price && base.price.purchasePrice ? fmtPrice(base.price.purchasePrice.value) : '';
    const isBundle = /BUNDLE/i.test(base.type || '');
    // 1) Bundle: the varying item is the bundleItem whose siblings list is the longest (>1).
    let inlineSiblings = null;
    if (Array.isArray(base.bundleItems)) {
      const bi = base.bundleItems.filter(b => Array.isArray(b.siblings) && b.siblings.length > 1)
        .sort((a, b) => b.siblings.length - a.siblings.length)[0];
      if (bi) inlineSiblings = bi.siblings;
    }
    // 2) Normal multi-shade product carrying inline siblings.
    if (!inlineSiblings && Array.isArray(model.siblings) && model.siblings.length > 1 && model.siblings[0].sku) inlineSiblings = model.siblings;

    let variants;
    if (inlineSiblings) {
      variants = inlineSiblings.map(s => ctVariantFromSibling(s, parentPrice, isBundle));
    } else if (Array.isArray(base.appearances) && base.appearances.length > 1) {
      // Each shade is a separate product page (no inline data) — fetch each (same-origin).
      variants = [];
      const prodBase = ctx.url.slice(0, ctx.url.indexOf('/product/') + 9);
      for (const ap of base.appearances) {
        const slug = ap.name || ap.href;
        let prod = base;
        if (slug && slug !== base.href) {
          try { const sub = ctModel(await ctx.fetchText(prodBase + slug)); if (sub && sub.product) prod = sub.product; } catch (e) { /* keep base */ }
          await sleep(250);
        }
        variants.push(ctVariant(prod, ap));
      }
    } else {
      variants = [ctVariant(base, (base.appearances || [])[0])];
    }
    const parentImages = ctImages(base).length ? ctImages(base) : (variants[0] ? variants[0].images : []);
    const rows = variableRows(title, parentImages, description, '', categories, 'Image', variants);
    return { rows, title };
  }
  async function scrapeCharlottetilburySimple(ctx) {
    const model = ctModel(ctx.mainHtml);
    if (!model || !model.product) throw new Error('Could not read Charlotte Tilbury product data.');
    const p = model.product;
    const name = ctName(p);
    const price = p.price && p.price.purchasePrice ? fmtPrice(p.price.purchasePrice.value) : '';
    return { rows: simpleRow({ sku: p.sku || '', name, description: ctDescription(p), regularPrice: price, categories: ctCategories(model), images: ctImages(p) }), title: name };
  }

  // ── Dior (Salesforce Commerce Cloud; all variants in ProductGroup LD) ────────
  // 16 shades live in the ProductGroup JSON-LD (sku, color, price, packshot). The
  // shade swatch is an image (…_cs.jpg); in the live DOM each swatch <img src> is
  // the real CDN URL (keyed by data-product-id = sku). The CDN hash differs per
  // file so it can't be derived — we read the DOM src, with a hashless URL built
  // from the LD packshot path as a fallback.
  function diorLDNodes(html) {
    const flat = [];
    for (const b of ldBlocks(html)) {
      let j; try { j = JSON.parse(b); } catch (e) { continue; }
      (function dig(x) { if (Array.isArray(x)) x.forEach(dig); else if (x && typeof x === 'object') { flat.push(x); if (x['@graph']) dig(x['@graph']); } })(j);
    }
    return flat;
  }
  function diorCategories(flat) {
    const bc = flat.find(x => x['@type'] === 'BreadcrumbList');
    if (!bc) return '';
    return (bc.itemListElement || []).map(i => (i.name || (i.item && i.item.name) || '').trim())
      .filter(n => n && !/^home$/i.test(n)).join('>');
  }
  function diorSwatchesFromDom(html) {
    const map = new Map();
    for (const m of html.matchAll(/<label[^>]*r-product-swatch[^>]*>[\s\S]*?<\/label>/gi)) {
      const block = m[0];
      const sku = (block.match(/data-product-id="([^"]+)"/) || [])[1];
      const src = (block.match(/r-product-swatch__image[^>]*\ssrc="([^"]+)"/) || [])[1];
      if (sku && src && /^https?:\/\//.test(src)) map.set(sku, src.split('?')[0]);
    }
    return map;
  }
  function diorSwatchFallback(ldImageUrl, groupId, sku) {
    if (!ldImageUrl || !groupId || !sku) return '';
    const base = ldImageUrl.split('?')[0].replace(/\/dw[0-9a-f]{6,}\//, '/');
    return base.replace(/[^/]+$/, `${groupId}_${sku}_cs.jpg`);
  }
  function diorOfferPrice(v) {
    const o = Array.isArray(v.offers) ? v.offers[0] : v.offers;
    return o && o.price != null ? fmtPrice(o.price) : '';
  }
  function diorText(s) { return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()); }
  // The PDP media gallery is the active variant's RHC images (multiple angles + a shared
  // shot), embedded in the page. Take that variant's images (and un-coded shared ones) at
  // a good size, ordered E01→E0n. This is the real product gallery, not per-shade packshots.
  function diorGallery(html) {
    const h = String(html || '').replace(/&amp;/g, '&');
    const all = new Map();
    for (const m of h.matchAll(/https:\/\/www\.dior\.com\/dw\/image\/[^"'\s]+?_RHC\.jpg/gi)) {
      const base = m[0].split('/').pop();
      if (!all.has(base)) all.set(base, m[0] + '?sw=1024');
    }
    // Active variant = the shade code that appears among the page's RHC images (most common);
    // keep its angles + any shared (un-coded) shots, ordered E01→E0n.
    const counts = {};
    for (const base of all.keys()) { const c = (base.match(/_(C\d+)_/) || [])[1]; if (c) counts[c] = (counts[c] || 0) + 1; }
    const active = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
    return [...all.keys()].filter(base => { const c = (base.match(/_(C\d+)_/) || [])[1]; return !c || c === active; })
      .sort().map(k => all.get(k));
  }
  async function scrapeDior(ctx) {
    const html = ctx.mainHtml;
    const flat = diorLDNodes(html);
    const pg = flat.find(x => x['@type'] === 'ProductGroup');
    if (!pg || !Array.isArray(pg.hasVariant) || !pg.hasVariant.length) throw new Error('Could not read Dior ProductGroup data.');
    const groupId = pg.productGroupID || '';
    const title = decodeEntities(pg.name || '');
    const description = diorText(pg.description);
    const categories = diorCategories(flat);
    const swDom = diorSwatchesFromDom(html);
    const variants = pg.hasVariant.map(v => {
      const img = Array.isArray(v.image) ? v.image[0] : v.image;
      return {
        name: decodeEntities(v.color || v.name || ''), sku: v.sku || '',
        regularPrice: diorOfferPrice(v), salePrice: '',
        images: img ? [img] : [], extras: [],
        colorCode: swDom.get(v.sku) || diorSwatchFallback(img, groupId, v.sku),
      };
    });
    // Parent gallery = the active variant's RHC gallery from the page; else variant packshots.
    let parentImages = diorGallery(html);
    if (!parentImages.length) parentImages = variants.map(v => v.images[0]).filter(Boolean);
    const rows = variableRows(title, parentImages, description, '', categories, 'Image', variants);
    return { rows, title };
  }
  async function scrapeDiorSimple(ctx) {
    const flat = diorLDNodes(ctx.mainHtml);
    const src = flat.find(x => x['@type'] === 'Product') || flat.find(x => x['@type'] === 'ProductGroup');
    if (!src) throw new Error('Could not read Dior product data.');
    const images = [].concat(src.image || []).filter(Boolean);
    const sku = src.sku || (src.hasVariant && src.hasVariant[0] && src.hasVariant[0].sku) || '';
    return { rows: simpleRow({ sku, name: decodeEntities(src.name || ''), description: diorText(src.description), regularPrice: diorOfferPrice(src), categories: diorCategories(flat), images }), title: decodeEntities(src.name || '') };
  }

  // ── Summer Fridays (Shopify; each shade is a separate product) ──────────────
  // The shade picker is a list of <li class="product__swatch"><a href="{sibling}"
  // title="{shade}"><img src="swatch-{shade}.png">. Each shade is its own Shopify
  // product, so we read the swatch image (image swatch) from the page and fetch
  // every shade's product JSON for its sku/price/photos.
  function summerfridaysSwatches(html) {
    const list = []; const seen = new Set();
    for (const m of html.matchAll(/<li class="product__swatch[^"]*">[\s\S]*?<\/li>/gi)) {
      const li = m[0];
      const href = (li.match(/href="([^"]*\/products\/[^"#?]+)/i) || [])[1];
      const shade = decodeEntities((li.match(/title="([^"]+)"/) || [])[1] || '');
      const img = (li.match(/<img[^>]*\ssrc="([^"]+)"/i) || [])[1] || '';
      if (!href || !shade) continue;
      const handle = href.split('/products/')[1].split(/[?#]/)[0];
      if (seen.has(handle)) continue; seen.add(handle);
      list.push({ handle, shade, swatch: /^(https?:)?\/\//.test(img) ? normalizeShopUrl(img) : '' });
    }
    return list;
  }
  async function scrapeSummerfridays(ctx) {
    const html = ctx.mainHtml;
    const origin = new URL(ctx.url).origin;
    const shades = summerfridaysSwatches(html);
    if (!shades.length) throw new Error('No Summer Fridays shades found on the page.');
    let baseTitle = '', description = '', categories = '';
    const variants = [];
    for (const s of shades) {
      let prod = null;
      try { prod = (await ctx.fetchJson(`${origin}/products/${s.handle}.json`)).product; } catch (e) { /* skip */ }
      if (!prod || !prod.variants || !prod.variants.length) continue;
      const variant = prod.variants[0];
      const imgs = (prod.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
      const main = variant.featured_image ? normalizeShopUrl(variant.featured_image.src) : (imgs[0] || '');
      const price = fmtPrice(variant.price);
      const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
      if (!baseTitle) {
        baseTitle = prod.title.replace(new RegExp('\\s*' + s.shade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '').trim() || prod.title;
        description = shopifyBodyText(prod);
        categories = prod.product_type || '';
      }
      variants.push({ name: s.shade, sku: variant.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '',
        images: main ? [main] : [], extras: imgs.filter(x => x !== main).slice(0, 2), colorCode: s.swatch });
      await sleep(200);
    }
    if (!variants.length) throw new Error('Could not load Summer Fridays shade data.');
    const parentImages = variants.map(v => v.images[0]).filter(Boolean);
    const rows = variableRows(baseTitle, parentImages, description, '', categories, 'Image', variants);
    return { rows, title: baseTitle };
  }
  async function scrapeSummerfridaysSimple(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants || !product.variants.length) throw new Error('Could not load Summer Fridays product JSON.');
    const variant = product.variants[0];
    const price = fmtPrice(variant.price);
    const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
    const images = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
    return { rows: simpleRow({ sku: variant.sku, name: product.title, description: shopifyBodyText(product), regularPrice: compareAt || price, salePrice: compareAt ? price : '', categories: product.product_type || '', images }), title: product.title || '' };
  }

  // ── Character Cosmetics (Shopify; hex OR image shade swatches) ──────────────
  // Shade buttons: <button class="product__color-swatch" data-option-value="CTO301"
  // style="background-color:#c51043;background-image:url(…crm001.png)">. Some products
  // use a hex (background-color), others a swatch image (background-image) — keyed by
  // the option value (= variant.option1). Per-shade images come from image alt.
  function characterSwatches(html) {
    const map = new Map(); // option value -> { hex, img }
    for (const m of html.matchAll(/<button[^>]*product__color-swatch[^>]*>/gi)) {
      const tag = m[0];
      const val = decodeEntities((tag.match(/data-option-value="([^"]*)"/) || [])[1] || '');
      if (!val || map.has(val)) continue;
      const hex = (tag.match(/background-color:\s*(#[0-9a-fA-F]{3,8})/i) || [])[1] || '';
      const url = (tag.match(/background-image:\s*url\(\s*['"]?((?:https?:)?\/\/[^)'"\s]+)/i) || [])[1] || '';
      map.set(val, { hex, img: url ? normalizeShopUrl(url) : '' });
    }
    return map;
  }
  async function scrapeCharacter(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const html = ctx.mainHtml;
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants) throw new Error('Could not load Character product JSON.');
    const swatches = characterSwatches(html);
    const isImageSwatch = [...swatches.values()].some(s => s.img && !s.hex);
    const categories = product.product_type || '';
    const allImages = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const imgById = new Map(allImages.map(im => [im.id, normalizeShopUrl(im.src)]));
    // The colour axis isn't always option1 — some products add a "Shade" group option
    // first, with the real colour (= swatch data-option-value, = image alt) in a later
    // option. Pick the option named like a colour, else fall back to option1.
    const colorIdx = Math.max(0, (product.options || []).findIndex(o => /colou?r/i.test(o.name || '')));
    const colorVal = v => v['option' + (colorIdx + 1)] || v.option1;
    // Only the images explicitly tagged alt="common" are shared across shades (other
    // untagged images still belong to a specific shade via their alt text).
    const sharedImages = allImages.filter(im => /^common$/i.test((im.alt || '').trim())).map(im => normalizeShopUrl(im.src));
    let firstGallery = [];
    const variants = product.variants.map((v, i) => {
      const shade = colorVal(v);
      let own = allImages.filter(im => (im.alt || '').trim() === shade).map(im => normalizeShopUrl(im.src));
      const featured = v.featured_image ? normalizeShopUrl(v.featured_image.src)
        : (v.image_id && imgById.has(v.image_id) ? imgById.get(v.image_id) : (own[0] || ''));
      if (featured) own = [featured, ...own.filter(x => x !== featured)];
      const main = own[0] || '';
      // Parent gallery = first shade's main photo + the shared "common" product shots.
      if (i === 0) firstGallery = [main, ...sharedImages].filter((x, idx, a) => x && a.indexOf(x) === idx);
      const price = fmtPrice(v.price);
      const compareAt = v.compare_at_price && parseFloat(v.compare_at_price) > 0 ? fmtPrice(v.compare_at_price) : '';
      const sw = swatches.get(shade) || {};
      return { name: shade, sku: v.sku || '', regularPrice: compareAt || price, salePrice: compareAt ? price : '',
        images: main ? [main] : [], extras: [], colorCode: isImageSwatch ? (sw.img || '') : (sw.hex || '') };
    });
    // Parent gallery = the first variant's own product photos (not one-per-shade thumbnails).
    const parentImages = firstGallery.length ? firstGallery : variants.map(v => v.images[0]).filter(Boolean);
    const rows = variableRows(product.title, parentImages, shopifyBodyText(product), '', categories, isImageSwatch ? 'Image' : 'Color', variants);
    return { rows, title: product.title };
  }
  async function scrapeCharacterSimple(ctx) {
    const u = new URL(ctx.url);
    const handle = u.pathname.replace(/.*\/products\//, '').replace(/\/$/, '').split('?')[0];
    const product = (await ctx.fetchJson(`${u.origin}/products/${handle}.json`)).product;
    if (!product || !product.variants || !product.variants.length) throw new Error('Could not load Character product JSON.');
    const variant = product.variants[0];
    const price = fmtPrice(variant.price);
    const compareAt = variant.compare_at_price && parseFloat(variant.compare_at_price) > 0 ? fmtPrice(variant.compare_at_price) : '';
    const images = (product.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => normalizeShopUrl(im.src));
    return { rows: simpleRow({ sku: variant.sku, name: product.title, description: shopifyBodyText(product), regularPrice: compareAt || price, salePrice: compareAt ? price : '', categories: product.product_type || '', images }), title: product.title || '' };
  }

  // ── Inglot (PrestaShop, Cloudflare — active-tab only) ───────────────────────
  // Image swatches (/img/co/{value}.jpg). The REAL product photos and the per-shade
  // SKU (product-reference, e.g. 01/0240/001) live on each shade's own page, so we
  // fetch each shade's combination page (same-origin → passes Cloudflare). The page
  // URL pattern comes from og:url: …/{idProduct}-{combo}-{slug}.
  function inglotGallery(pageHtml) {
    return [...new Set(
      [...pageHtml.matchAll(/class="thumb js-thumb[^"]*"[^>]*data-image-large-src="(https:\/\/[^"]+?-large_default\/[^"]+\.(?:jpg|jpeg|png))"/gi)]
        .map(m => m[1].split('?')[0])
    )];
  }
  function inglotReference(pageHtml) {
    const m = pageHtml.match(/class="product-reference"[^>]*>\s*([^<]+?)\s*</i);
    return m ? decodeEntities(m[1].trim()) : '';
  }
  async function scrapeInglot(ctx) {
    const html = ctx.mainHtml;
    const origin = new URL(ctx.url).origin;
    let baseProduct = null, breadcrumb = null, anyProduct = null;
    for (const raw of ldBlocks(html)) {
      try {
        const j = JSON.parse(raw);
        for (const x of (j['@graph'] || [j])) {
          if (/Product/.test(x['@type'] || '')) { anyProduct = anyProduct || x; if (!baseProduct && !/\(.*\)/.test(x.name || '')) baseProduct = x; }
          if (/BreadcrumbList/.test(x['@type'] || '')) breadcrumb = x;
        }
      } catch (e) {}
    }
    baseProduct = baseProduct || anyProduct;
    const title = decodeEntities(baseProduct && baseProduct.name
      || ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const baseSku = (baseProduct && baseProduct.sku) || '';
    const price = baseProduct && baseProduct.offers && baseProduct.offers.price ? fmtPrice(baseProduct.offers.price) : '';
    const description = decodeEntities(((baseProduct && baseProduct.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const categories = bcCategories(breadcrumb, title);

    // Per-shade page URL pattern from og:url: …/{idProduct}-{combo}-{slug}
    const ogUrl = (html.match(/property="og:url"\s+content="([^"]+)"/) || [])[1] || ctx.url;
    const um = ogUrl.replace(/^\/\//, 'https://').match(/^(.*\/)(\d+)-(\d+)-([^#?]+)/);
    const variantUrlFor = um ? (combo => `${um[1]}${um[2]}-${combo}-${um[4]}`) : null;
    const currentCombo = um ? um[3] : '';

    // Shades from the swatch inputs (dedup by combination id).
    const seen = new Set(); const shades = [];
    for (const m of html.matchAll(/<input class="input-color"[^>]*>/gi)) {
      const inp = m[0];
      const combo = (inp.match(/data-id-product-attribute="(\d+)"/) || [])[1];
      const value = (inp.match(/value="(\d+)"/) || [])[1];
      if (!combo || !value || seen.has(combo)) continue;
      seen.add(combo);
      const after = html.slice(m.index, m.index + 500);
      const name = decodeEntities(((after.match(/attribute-name[^>]*>([^<]*)</) || [])[1] || '').trim());
      shades.push({ combo, value, name });
    }
    if (!shades.length) throw new Error('No Inglot shades found on the page.');

    const variants = [];
    for (const s of shades) {
      let pageHtml = html;
      if (s.combo !== currentCombo && variantUrlFor) {
        try { pageHtml = await ctx.fetchText(variantUrlFor(s.combo)); } catch (e) { pageHtml = html; }
      }
      const gallery = inglotGallery(pageHtml);
      const swatch = `${origin}/img/co/${s.value}.jpg`;
      const ref = inglotReference(pageHtml);
      variants.push({
        name: s.name,
        sku: ref || (baseSku ? `${baseSku}/${s.name}` : ''),
        regularPrice: price, salePrice: '',
        images: gallery.length ? gallery : [swatch],
        extras: gallery.slice(1, 3),
        colorCode: swatch,
      });
    }
    const parentImages = variants[0] ? variants[0].images : [];
    return { rows: variableRows(title, parentImages, description, '', categories, 'Image', variants), title };
  }
  async function scrapeInglotSimple(ctx) {
    const html = ctx.mainHtml;
    let baseProduct = null, breadcrumb = null;
    for (const raw of ldBlocks(html)) {
      try { const j = JSON.parse(raw); for (const x of (j['@graph'] || [j])) {
        if (/Product/.test(x['@type'] || '') && !baseProduct) baseProduct = x;
        if (/BreadcrumbList/.test(x['@type'] || '')) breadcrumb = x;
      } } catch (e) {}
    }
    const title = decodeEntities((baseProduct && baseProduct.name)
      || ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const sku = inglotReference(html) || (baseProduct && baseProduct.sku) || '';
    const price = baseProduct && baseProduct.offers && baseProduct.offers.price ? fmtPrice(baseProduct.offers.price) : '';
    const description = decodeEntities(((baseProduct && baseProduct.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const categories = bcCategories(breadcrumb, title);
    return { rows: simpleRow({ sku, name: title, description, regularPrice: price, categories, images: inglotGallery(html) }), title };
  }

  // ── Shared helpers for ported sites ─────────────────────────────────────────
  const LOREAL_ORIGIN = 'https://www.lorealparisusa.com';
  function woocommercePrice(fragment) {
    if (!fragment) return '';
    const t = fragment.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
    let n = (t.match(/[\d.,]+/) || [])[0] || '';
    if (!n) return '';
    if (/,\d{1,2}$/.test(n) && !/\.\d/.test(n)) n = n.replace(/\./g, '').replace(',', '.');
    else n = n.replace(/,/g, '');
    const f = parseFloat(n);
    return isFinite(f) ? f.toFixed(2) : '';
  }
  function narsLD(html) {
    let product = null, breadcrumb = null;
    for (const raw of ldBlocks(html)) {
      try { const j = JSON.parse(raw); for (const x of (j['@graph'] || [j])) {
        if (/Product/.test(x['@type'] || '') && !product) product = x;
        if (/BreadcrumbList/.test(x['@type'] || '')) breadcrumb = x;
      } } catch (e) {}
    }
    return { product, breadcrumb };
  }
  const bcCategories = (breadcrumb, title) => breadcrumb
    ? (breadcrumb.itemListElement || []).map(i => i.name || (i.item && i.item.name))
        .filter(c => c && !/^home$/i.test(c) && c.toLowerCase() !== (title || '').toLowerCase()).join('>')
    : '';

  // ── NYX Cosmetics (Salesforce Commerce Cloud / JSON-LD ProductGroup) ────────
  async function scrapeNyx(ctx) {
    const html = ctx.mainHtml;
    // Parse ProductGroup JSON-LD.
    const pgBlock = ldBlocks(html).find(b => b.includes('"@type":"ProductGroup"'));
    if (!pgBlock) throw new Error('No ProductGroup JSON-LD on NYX page');
    const pg = JSON.parse(pgBlock);
    const title = pg.name || ((pg.hasVariant && pg.hasVariant[0] && pg.hasVariant[0].name) || '');
    const description = (pg.description || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
    const productGroupID = pg.productGroupID || '';

    // Extract swatch data from c-swatch elements (hex + variant image + SKU).
    const swatches = [];
    const swatchRe = /<a\s[^>]*class="[^"]*c-swatch[^"]*"[^>]*>/g;
    for (const m of html.matchAll(swatchRe)) {
      const tag = m[0];
      const get = a => { const mm = tag.match(new RegExp(a + '=["\']([^"\']*)')); return mm ? mm[1] : ''; };
      const pid = get('data-js-pid');
      const titleSW = get('data-js-title');
      const img = get('data-js-productimgsrc');
      const hex = (tag.match(/background-color:\s*(#[0-9a-fA-F]{3,8})/) || [])[1] || '';
      if (pid && titleSW) swatches.push({ pid, title: titleSW, img: img ? img.split('?')[0] : '', hex });
    }

    // Build variant objects from JSON-LD hasVariant. Merge swatch data by SKU.
    const ldVariants = pg.hasVariant || [];
    const variants = ldVariants.map(v => {
      const sw = swatches.find(s => s.pid === v.sku) || {};
      const vImg = (v.image || '').split('?')[0];
      const swImg = (sw.img || '').split('?')[0];
      const mainImg = swImg || vImg || '';
      const price = v.offers && v.offers.price ? String(v.offers.price) : '';
      return {
        name: sw.title || v.color || '',
        sku: v.sku || '',
        regularPrice: price,
        salePrice: '',
        images: mainImg ? [mainImg] : [],
        extras: [],
        colorCode: sw.hex || '',
      };
    });

    // Breadcrumb categories from BreadcrumbList JSON-LD.
    let categories = '';
    for (const b of ldBlocks(html)) {
      if (!b.includes('BreadcrumbList')) continue;
      try {
        const bc = JSON.parse(b);
        categories = (bc.itemListElement || []).map(i => typeof i.item === 'string' ? i.name : (i.item && i.item.name) || i.name || '').filter(n => n && n.toLowerCase() !== 'home').join('>');
      } catch (e) {}
    }

    // Gallery = carousel item images (the main product display images).
    const seenImg = new Set();
    const gallery = [];
    const carouselImgRe = /<div class="c-carousel__item\s[^"]*"[^>]*>[\s\S]*?<img\s[^>]*\ssrc="(https?:\/\/[^"]+?\.(?:jpg|jpeg|png|webp))/gi;
    for (const m of html.matchAll(carouselImgRe)) {
      const raw = m[1].split('?')[0];
      const base = imgBaseName(raw);
      if (!seenImg.has(base)) { seenImg.add(base); gallery.push(raw); }
    }

    // Short description from subtitle.
    const shortMatch = html.match(/c-product-main__subtitle[^>]*>\s*(.*?)\s*<\/span>/);
    const shortDesc = shortMatch ? decodeEntities(shortMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    const parentImages = gallery.length ? gallery : variants.map(v => v.images[0]).filter(Boolean);
    return { rows: variableRows(title, parentImages, description, shortDesc, categories, 'Color', variants), title };
  }

  async function scrapeNyxSimple(ctx) {
    const html = ctx.mainHtml;
    const ld = ldBlocks(html).map(b => { try { return JSON.parse(b); } catch (e) { return null; } }).filter(Boolean);

    // NYX "simple" products still use ProductGroup with a single variant.
    const pg = ld.find(j => j['@type'] === 'ProductGroup');
    let product, title, sku, price, productImage;
    if (pg && pg.hasVariant && pg.hasVariant[0]) {
      const v = pg.hasVariant[0];
      product = v;
      title = pg.name || v.name || '';
      sku = v.sku || '';
      price = v.offers && v.offers.price ? String(v.offers.price) : '';
      productImage = v.image || '';
    } else {
      product = ld.find(j => j['@type'] === 'Product' && j.sku) || ld.find(j => j['@type'] === 'Product') || {};
      title = product.name || '';
      sku = product.sku || '';
      price = product.offers && product.offers.price ? String(product.offers.price) : '';
      productImage = (typeof product.image === 'string' ? product.image : (Array.isArray(product.image) ? product.image[0] : '')) || '';
    }

    // Fallback title from <title>, stripping the "| NYX Professional Makeup" suffix.
    if (!title) {
      title = decodeEntities((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
      title = title.replace(/\|.*$/, '').trim();
    }
    // Clean up any trailing non-breaking spaces.
    title = title.replace(/[\u202F\u00A0]+/g, ' ').trim();

    const bc = ld.find(j => j['@type'] === 'BreadcrumbList');
    let categories = '';
    if (bc) categories = (bc.itemListElement || [])
      .map(i => typeof i.item === 'string' ? i.name : (i.item && i.item.name) || i.name || '')
      .filter(n => n && n.toLowerCase() !== 'home')
      .join('>');

    const description = (product.description || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

    // Gallery images from carousel.
    const seenImg = new Set(); const images = [];
    const carouselImgRe = /<div class="c-carousel__item\s[^"]*"[^>]*>[\s\S]*?<img\s[^>]*\ssrc="(https?:\/\/[^"]+?\.(?:jpg|jpeg|png|webp))/gi;
    for (const m of html.matchAll(carouselImgRe)) {
      const raw = m[1].split('?')[0];
      const base = imgBaseName(raw);
      if (!seenImg.has(base)) { seenImg.add(base); images.push(raw); }
    }
    // Fallbacks: product image from JSON-LD, then og:image.
    if (!images.length && productImage) images.push(productImage.split('?')[0]);
    if (!images.length) { const og = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1]; if (og) images.push(og.split('?')[0]); }

    const shortMatch = html.match(/c-product-main__subtitle[^>]*>\s*(.*?)\s*<\/span>/);
    const shortDesc = shortMatch ? decodeEntities(shortMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    return { rows: [{ SKU: sku, Name: title, Description: description, 'Short Description': shortDesc, 'Regular Price': price, Categories: categories, Images: images, 'Sale Price': '' }], title };
  }

  // ── Maybelline (L'Oréal/Sitecore) ───────────────────────────────────────────
  async function scrapeMaybelline(ctx) {
    const html = ctx.mainHtml; const domain = new URL(ctx.url).origin;
    // The name is split across two spans: product__header-name + product__header-type.
    const nameM = html.match(/<span class="product__header-name">([^<]+)<\/span>/);
    const typeM = html.match(/<span class="product__header-type">([^<]+)<\/span>/);
    let title = [nameM && nameM[1], typeM && typeM[1]].filter(Boolean).map(s => decodeEntities(s).trim()).join(' ').replace(/\s+/g, ' ').trim();
    if (!title) title = decodeEntities(((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const price = (html.match(/class="product__header-price"[^>]*>\s*<span>\$<\/span>\s*([\d.]+)/) || [])[1] || '';
    // Description: legacy "About" accordion if present, otherwise the meta description.
    const aboutMatch = html.match(/showtext="About"[^>]*>([\s\S]*?)<\/accordion-item>/);
    let description = aboutMatch ? decodeEntities(aboutMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    if (!description) description = decodeEntities((html.match(/name="description"\s+content="([^"]+)"/) || [])[1] || '');
    const categories = [...html.matchAll(/<span itemprop="name">\s*([^<]+)\s*<\/span>/g)]
      .map(m => m[1].trim()).filter(c => c !== 'Home' && c !== 'Shop All').slice(0, -1).join(', ');

    // Each shade is an <input> carrying data-variant-id/-display-name/-color/-variant-ean
    // (attribute order varies, and the class now follows the data attrs — so match the
    // input tag itself rather than anchoring on a class position).
    const variants = []; const seenV = new Set();
    for (const m of html.matchAll(/<input\b[^>]*\bdata-variant-id="[^"]*"[^>]*>/g)) {
      const tag = m[0];
      const get = a => { const mm = tag.match(new RegExp(a + '="([^"]*)"')); return mm ? mm[1] : ''; };
      const variantId = get('data-variant-id'), displayName = get('data-display-name'), color = get('data-color'), ean = get('data-variant-ean');
      if (variantId && displayName && ean && !seenV.has(variantId)) { seenV.add(variantId); variants.push({ variantId, displayName, color, isMultiColor: color.includes(','), ean, refName: get('data-product-reference-name') }); }
    }
    if (!variants.length) throw new Error('No variants found on Maybelline page.');
    // Short description = this product's reference name (data-tag-product-name on the
    // page can belong to a recommended product, so it isn't reliable here).
    const shortDesc = (variants[0] && variants[0].refName) || title;
    const isImageSwatch = variants.some(v => v.isMultiColor);

    const variantImages = {};
    for (const v of variants) {
      try {
        const data = await ctx.fetchJson(`${domain}/loreal/product/variantimage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variantId: v.variantId, width: 1500, height: 1500 }),
        });
        variantImages[v.variantId] = (data.images && Array.isArray(data.images))
          ? data.images.map(img => { const r = img[0]; const a = r.startsWith('http') ? r : domain + r; return a.replace(/([?&])(cx|cy|cw|ch|hash)=[^&]+/g, '').replace(/[?&]$/, ''); })
          : [];
      } catch (e) { variantImages[v.variantId] = []; }
    }
    const baseCount = {};
    for (const imgs of Object.values(variantImages)) { const seen = new Set(); for (const u of imgs) { const base = imgBaseName(u); if (!seen.has(base)) { seen.add(base); baseCount[base] = (baseCount[base] || 0) + 1; } } }
    const shared = new Set(Object.keys(baseCount).filter(b => baseCount[b] >= 2));
    const firstImgs = variantImages[variants[0].variantId] || []; const firstMain = firstImgs[0] || null;
    const sharedImgs = []; const seenS = new Set();
    for (const imgs of Object.values(variantImages)) for (const u of imgs) { const base = imgBaseName(u); if (shared.has(base) && !seenS.has(base)) { seenS.add(base); sharedImgs.push(u); } }
    const parentImages = firstMain ? [firstMain, ...sharedImgs.filter(u => imgBaseName(u) !== imgBaseName(firstMain))] : sharedImgs;

    const variantsOut = variants.map(v => {
      const imgs = variantImages[v.variantId] || [];
      const extras = imgs.slice(1).filter(u => !shared.has(imgBaseName(u))).slice(0, 2);
      const colorCode = isImageSwatch
        ? (imgs.find(u => /-s\.(jpg|jpeg|png|webp)/i.test(u.split('?')[0])) || imgs.find(u => /-o\.(jpg|jpeg|png|webp)/i.test(u.split('?')[0])) || imgs[0] || '')
        : (v.color ? '#' + v.color : '');
      return { name: v.displayName, sku: v.ean, regularPrice: price, salePrice: '', images: imgs, extras, colorCode };
    });
    return { rows: variableRows(title, parentImages, description, shortDesc, categories, isImageSwatch ? 'Image' : 'Color', variantsOut), title };
  }

  // ── Seventeen (Django/Oscar) ────────────────────────────────────────────────
  async function scrapeSeventeen(ctx) {
    const html = ctx.mainHtml; const domain = new URL(ctx.url).origin;
    const ldMatch = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
    if (!ldMatch) throw new Error('No JSON-LD on Seventeen page');
    const ld = JSON.parse(ldMatch[1]);
    if (ld['@type'] !== 'ProductGroup') throw new Error('Not a ProductGroup page');
    const title = ld.name || '';
    const ldByVid = {};
    for (const v of (ld.hasVariant || [])) { const vm = v.offers && v.offers.url && v.offers.url.match(/[?&]vid=(\d+)/); if (vm) ldByVid[vm[1]] = { sku: v.sku || '', price: (v.offers && v.offers.price) || '', image: Array.isArray(v.image) ? v.image[0] : (v.image || '') }; }
    const swatches = [];
    for (const m of html.matchAll(/<a\s[^>]*class="color-select__option[^"]*"([\s\S]*?)(?=<\/a>)/g)) {
      const block = m[1]; const get = a => { const r = block.match(new RegExp(a + '="([^"]*)"')); return r ? r[1] : ''; };
      const hex = (block.match(/background-color:\s*(#[0-9a-fA-F]{3,8})/) || [])[1] || '';
      const tip = (block.match(/<span class="tip">([^<]+)<\/span>/) || [])[1] || '';
      const vid = get('data-pk'); const colorName = get('data-description') || tip;
      if (vid && colorName) swatches.push({ vid, colorName, hex, salePrice: get('data-sale_price').replace(/[^0-9.]/g, ''), regularPrice: get('data-regular_price').replace(/[^0-9.]/g, ''), cat1: get('data-category_1'), cat2: get('data-category_2') });
    }
    if (!swatches.length) throw new Error('No swatches on Seventeen page');
    const categories = [swatches[0].cat1, swatches[0].cat2].filter(Boolean).map(c => c.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())).join(', ');
    const first = swatches[0];
    const price = first.regularPrice || first.salePrice || (ldByVid[first.vid] || {}).price || '';
    const shortDescM = html.match(/<div class="product-description"><p>([\s\S]*?)<\/p><\/div>/);
    const shortDesc = shortDescM ? shortDescM[1].replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim() : '';
    const whatM = html.match(/What it is<\/summary>\s*<div class="product-characteristics__content">([\s\S]*?)<\/div>\s*<\/details>/);
    const description = whatM ? whatM[1].trim() : '';
    // Each shade's gallery is a swiper block keyed by data-pk. The default (active) block
    // carries extra classes before data-pk, so match any class list then read data-pk.
    const galleryByVid = {};
    for (const m of html.matchAll(/<div class="swiper-container gallery-top[^"]*"[^>]*>([\s\S]*?)<div class="swiper-container gallery-thumbs"/g)) {
      const pk = ((m[0].slice(0, m[0].indexOf('>')).match(/data-pk="(\d+)"/)) || [])[1];
      if (!pk) continue;
      galleryByVid[pk] = [...m[1].matchAll(/data-src="([^"]+)"/g)].map(i => (i[1].startsWith('http') ? i[1] : domain + i[1]).split('?')[0]);
    }
    const variants = swatches.map(s => {
      const g = galleryByVid[s.vid] || [];
      const main = (ldByVid[s.vid] && ldByVid[s.vid].image) || g[0] || '';   // variant's own featured image
      const varSale = s.salePrice && s.salePrice !== s.regularPrice ? s.salePrice : '';
      return { name: s.colorName, sku: (ldByVid[s.vid] || {}).sku || '', regularPrice: s.regularPrice || s.salePrice || price, salePrice: varSale, images: main ? [main] : [], extras: [], colorCode: s.hex };
    });
    // Parent gallery = the default (first) variant's full gallery, else the variant mains.
    let parentImages = galleryByVid[first.vid] || [];
    if (!parentImages.length) parentImages = variants.map(v => v.images[0]).filter(Boolean);
    return { rows: variableRows(title, parentImages, description, shortDesc, categories, 'Color', variants), title };
  }
  async function scrapeSeventeenSimple(ctx) {
    const html = ctx.mainHtml; const domain = new URL(ctx.url).origin;
    const ldMatch = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
    if (!ldMatch) throw new Error('No JSON-LD on Seventeen page');
    const ld = JSON.parse(ldMatch[1]);
    const title = ld.name || ''; const regularPrice = (ld.offers && ld.offers.price) || '';
    const comparePrice = ((html.match(/data-regular_price="([^"]+)"/) || [])[1] || '').replace(/[^0-9.]/g, '');
    const salePrice = comparePrice && comparePrice !== regularPrice ? regularPrice : '';
    const finalRegular = comparePrice && comparePrice !== regularPrice ? comparePrice : regularPrice;
    const sku = ld.gtin13 || ld.sku || '';
    let categories = '';
    const bcBlock = ldBlocks(html).find(b => b.includes('BreadcrumbList'));
    if (bcBlock) { try { const bc = JSON.parse(bcBlock); categories = (bc.itemListElement || []).map(i => i.name).filter(n => n !== 'Home').join(', '); } catch (e) {} }
    const shortDescM = html.match(/<div class="product-description"><p>([\s\S]*?)<\/p><\/div>/);
    const shortDesc = shortDescM ? shortDescM[1].replace(/&amp;/g, '&').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim() : '';
    const whatM = html.match(/What it is<\/summary>\s*<div class="product-characteristics__content">([\s\S]*?)<\/div>\s*<\/details>/);
    const description = whatM ? whatM[1].trim() : '';
    const galleryM = html.match(/<div class="swiper-container gallery-top"[^>]*>([\s\S]*?)<div class="swiper-container gallery-thumbs"/);
    const images = galleryM ? [...galleryM[1].matchAll(/data-src="([^"]+)"/g)].map(m => m[1].startsWith('http') ? m[1] : domain + m[1]) : (ld.image ? [ld.image] : []);
    return { rows: [{ SKU: sku, Name: title, Description: description, 'Short Description': shortDesc, 'Regular Price': finalRegular, Categories: categories, Images: images, 'Sale Price': salePrice }], title };
  }

  // ── IsaDora (Next.js headless; one URL per variant) ────────────────────────
  // Each shade is its own SSR'd page with __NEXT_DATA__ containing per-variant
  // data (EAN, color hex, swatch, images) and slugData listing ALL site pages.
  // The scraper finds variants by filtering slugData for direct children of the
  // parent product slug, then fetches each variant's page to extract its unique
  // product images and metadata — the same approach L'Oréal uses.

  const ISADORA_ORIGIN = 'https://www.isadora.com';
  const ISADORA_DAM_BASE = 'https://isadora-damassets-prod-e6hda3fpf0g6c7gk.a03.azurefd.net/img/';

  function isadoraNextData(html) {
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try {
      const data = JSON.parse(m[1]);
      const content = data.props && data.props.pageProps && data.props.pageProps.content;
      if (!content) return null;
      return {
        fullSlug: content.full_slug || '',
        data: content.content || {},
        slugData: (data.props.pageProps.slugData) || [],
      };
    } catch (e) { return null; }
  }

  function isadoraCarouselImages(html) {
    const imgSet = new Set();
    // Match individual image URLs (non-greedy: stop before ?, whitespace, or quotes)
    const re = /https:\/\/isadora-damassets[^?\s"'<>]+/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[0];
      // Keep only image files, exclude swatch thumbnails
      if (/\.(?:jpg|png|webp)$/i.test(url) && !/_swatch/i.test(url)) {
        imgSet.add(url);
      }
    }
    return [...imgSet];
  }

  async function scrapeIsadora(ctx) {
    const html = ctx.mainHtml; const url = ctx.url;

    // ── 1. Base product name (h2, no variant suffix) ──────────────────────────
    const baseNameM = html.match(/<h2[^>]*class="[^"]*variant-page_variant-header[^"]*"[^>]*>([^<]*)<\/h2>/);
    const baseName = baseNameM ? decodeEntities(baseNameM[1].trim()) : '';

    // ── 2. SKU (GTIN from JSON-LD on the current-variant page) ───────────────
    let sku = '';
    for (const raw of ldBlocks(html)) {
      try {
        const j = JSON.parse(raw);
        if (j['@type'] === 'Product') { sku = j.gtin13 || j.sku || ''; break; }
      } catch (e) {}
    }

    // ── 3. Description (accordion sections: Ingredients + How to use) ─────────
    let description = '';
    const accordionBlocks = [...html.matchAll(/class="[^"]*accordion_content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    for (const m of accordionBlocks) {
      const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
      if (text && text.length > 5) description += (description ? '\n\n' : '') + text;
    }
    // Fallback: bullet point list
    if (!description) {
      const bullets = [...html.matchAll(/<li[^>]*class="[^"]*list-item_root[^"]*"[^>]*>([\s\S]*?)<\/li>/g)];
      description = bullets.map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '').trim())).join('\n');
    }

    // ── 4. Short description (bullet points, joined) ──────────────────────────
    const bullets = [...html.matchAll(/<li[^>]*class="[^"]*list-item_root[^"]*"[^>]*>([\s\S]*?)<\/li>/g)];
    const shortDesc = bullets.map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '').trim())).join(' | ');

    // ── 5. Categories (breadcrumbs, skipping Start / Products / product name / variant) ──
    let categories = '';
    const bcMatches = [...html.matchAll(/<a[^>]*class="[^"]*breadcrumbs_link[^"]*"[^>]*href="[^"]*"[^>]*>([^<]*)<\/a>/g)];
    const bcTexts = bcMatches.map(m => m[1].trim()).filter(t => t && t !== 'Start' && t !== 'Products');
    if (bcTexts.length > 2) categories = bcTexts.slice(0, -2).join(', ');
    else if (bcTexts.length > 1) categories = bcTexts.slice(0, -1).join(', ');

    // ── 6. Parent gallery images (carousel srcset, deduplicated) ──────────────
    const parentImages = isadoraCarouselImages(html);

    // ── 7. Variant extraction: fetch each variant's own URL page ─────────────
    // Like L'Oréal: every shade has its own SSR'd page with __NEXT_DATA__
    // containing per-variant EAN, color hex, swatch, and product images.
    let variants = [];

    const nextData = isadoraNextData(html);
    if (nextData) {
      const parentSlug = nextData.fullSlug.substring(0, nextData.fullSlug.lastIndexOf('/'));
      const parentSegments = parentSlug.split('/').length;

      // Filter slugData for direct variant children of this product
      const variantMeta = nextData.slugData.filter(s =>
        s.slug.startsWith(parentSlug + '/') && s.slug.split('/').length === parentSegments + 1
      );

      if (variantMeta.length) {
        const norm = u => u.replace(/\/$/, '');
        for (const v of variantMeta) {
          try {
            const varUrl = ISADORA_ORIGIN + '/' + v.slug;
            // Reuse main HTML when URL matches the already-loaded page
            const pageHtml = norm(varUrl) === norm(ctx.url) ? html : await ctx.fetchText(varUrl);
            const varNext = isadoraNextData(pageHtml);
            const images = isadoraCarouselImages(pageHtml);

            let sku = '', colorCode = '';
            if (varNext && varNext.data) {
              sku = varNext.data.ean || '';
              const hex = varNext.data.color_hex_code || '';
              const swatchImg = (varNext.data.swatch_image && varNext.data.swatch_image[0] && varNext.data.swatch_image[0].url) || '';
              colorCode = swatchImg ? ISADORA_DAM_BASE + swatchImg.split('?')[0] : hex ? '#' + hex : '';
            }

            variants.push({
              name: v.name, sku, regularPrice: '', salePrice: '',
              images, extras: [], colorCode,
            });
          } catch (e) {
            // Push entry with name only (no images/EAN) so the variant is still listed
            variants.push({
              name: v.name, sku: '', regularPrice: '', salePrice: '',
              images: [], extras: [], colorCode: '',
            });
          }
        }
      }
    }

    // 7b. Fallback: single variant from the URL slug
    if (!variants.length) {
      const pathParts = (new URL(url)).pathname.replace(/\/+$/, '').split('/');
      const variantSlug = pathParts[pathParts.length - 1];
      const variantName = variantSlug
        .split('-')
        .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '')
        .join(' ')
        .replace(/\b(\d+)\b/g, '$1');  // preserve numbers like "60", "61"
      variants = [{ name: variantName, sku, regularPrice: '', salePrice: '', images: parentImages.slice(0), extras: [], colorCode: '' }];
    }

    // ── 8. Price discovery (active-tab DOM first, then HTML fallback) ─────────
    let regularPrice = '';
    if (typeof document !== 'undefined' && document.querySelector) {
      try {
        // Try common price elements
        for (const sel of ['[class*="price"]', '[class*="Price"]', '[class*="product-price"]', '.variant-price', '[itemprop="price"]']) {
          const el = document.querySelector(sel);
          if (el) {
            const m = (el.textContent || '').match(/[\d,.]+/);
            if (m) { regularPrice = String(parseFloat(m[0].replace(/,/g, '.'))); break; }
          }
        }
      } catch (e) {}
    }
    // HTML fallback
    if (!regularPrice) {
      const priceM = html.match(/(?:SEK|kr|€|EUR|USD)\s*([\d,.]+)/);
      if (priceM) regularPrice = String(parseFloat(priceM[1].replace(/,/g, '.')));
    }

    // Apply discovered price to variants (variableRows uses variant.regularPrice)
    if (regularPrice) {
      for (const v of variants) if (!v.regularPrice) v.regularPrice = regularPrice;
    }

    // ── 9. Build WooCommerce rows via the shared helper ────────────────────────
    const title = baseName || 'IsaDora Product';
    return {
      rows: variableRows(title, parentImages, description, shortDesc, categories, 'Image', variants),
      title,
    };
  }

  async function scrapeIsadoraSimple(ctx) {
    const html = ctx.mainHtml; const url = ctx.url;

    // Base product name with variant suffix from URL
    const baseNameM = html.match(/<h2[^>]*class="[^"]*variant-page_variant-header[^"]*"[^>]*>([^<]*)<\/h2>/);
    const baseName = baseNameM ? decodeEntities(baseNameM[1].trim()) : '';
    const pathParts = (new URL(url)).pathname.replace(/\/+$/, '').split('/');
    const variantSlug = pathParts[pathParts.length - 1];
    const variantName = variantSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').replace(/\b(\d+)\b/g, '$1');
    const title = baseName ? `${baseName} - ${variantName}` : `IsaDora ${variantName}`;

    // SKU from JSON-LD
    let sku = '';
    for (const raw of ldBlocks(html)) {
      try { const j = JSON.parse(raw); if (j['@type'] === 'Product') { sku = j.gtin13 || j.sku || ''; break; } } catch (e) {}
    }
    if (!sku) {
      // Fallback: extract article number from URL (e.g., /10000319-the-buffer-brush)
      const articleM = (new URL(url)).pathname.match(/\/(\d{4,})-/);
      if (articleM) sku = articleM[1];
    }

    // Description (accordion)
    let description = '';
    const accordionBlocks = [...html.matchAll(/class="[^"]*accordion_content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    for (const m of accordionBlocks) {
      const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
      if (text && text.length > 5) description += (description ? '\n\n' : '') + text;
    }
    if (!description) {
      const bullets = [...html.matchAll(/<li[^>]*class="[^"]*list-item_root[^"]*"[^>]*>([\s\S]*?)<\/li>/g)];
      description = bullets.map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '').trim())).join('\n');
    }

    // Short description
    const bullets = [...html.matchAll(/<li[^>]*class="[^"]*list-item_root[^"]*"[^>]*>([\s\S]*?)<\/li>/g)];
    const shortDesc = bullets.map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '').trim())).join(' | ');

    // Categories
    let categories = '';
    const bcMatches = [...html.matchAll(/<a[^>]*class="[^"]*breadcrumbs_link[^"]*"[^>]*href="[^"]*"[^>]*>([^<]*)<\/a>/g)];
    const bcTexts = bcMatches.map(m => m[1].trim()).filter(t => t && t !== 'Start' && t !== 'Products');
    if (bcTexts.length > 2) categories = bcTexts.slice(0, -2).join(', ');
    else if (bcTexts.length > 1) categories = bcTexts.slice(0, -1).join(', ');

    // Images
    let images = [];
    for (const raw of ldBlocks(html)) {
      try { const j = JSON.parse(raw); if (j['@type'] === 'Product') { images = Array.isArray(j.image) ? j.image : (j.image ? [j.image] : []); break; } } catch (e) {}
    }
    images = images.map(u => u.split('?')[0]).filter(u => u);
    if (!images.length) {
      images = isadoraCarouselImages(html);
    }

    // Price
    let regularPrice = '';
    for (const raw of ldBlocks(html)) {
      try { const j = JSON.parse(raw); if (j['@type'] === 'Product' && j.offers && j.offers.price) { regularPrice = String(j.offers.price); break; } } catch (e) {}
    }
    if (!regularPrice) {
      const priceM = html.match(/(?:SEK|kr|€|EUR|USD)\s*([\d,.]+)/);
      if (priceM) regularPrice = String(parseFloat(priceM[1].replace(/,/g, '.')));
    }

    return {
      rows: simpleRow({ sku, name: title, description, shortDesc, categories, images, regularPrice }),
      title,
    };
  }

  // ── MakeOver (ASP classic; image swatches via kuang divs + select dropdown) ──
  // makeoverparis.com uses an old ASP-based catalogue. Each variable product
  // has a <select id="yslist"> for choosing shade, with variant data embedded
  // in hidden <div class="yskuang" id="kuang<num>"> blocks. Swatches are image
  // type — the kuang div contains the full variant image.

  function makeoverAbsUrl(src, pageUrl) {
    if (!src) return '';
    // Saved HTML uses ./MAKEOVER_files/ prefix; live site uses uploadfile/
    src = src.replace(/^\.\/MAKEOVER_files\//, 'uploadfile/');
    if (/^https?:\/\//.test(src)) return src;
    try {
      return new URL(src, pageUrl).href;
    } catch (e) {
      // Fallback: append to directory of page URL
      return pageUrl.replace(/\/[^\/]*$/, '/' + src.replace(/^\/+/, ''));
    }
  }

  function makeoverImages(html, pageUrl, excludeSet) {
    // Collect unique uploadfile images from the page
    const seen = new Set();
    const out = [];
    const re = /src=["']([^"']*(?:uploadfile\/[^"']*\.(?:jpg|jpeg|png|gif)))["']/gi;
    let m;
    while ((m = re.exec(html))) {
      const raw = makeoverAbsUrl(m[1], pageUrl);
      if (!raw || seen.has(raw)) continue;
      if (excludeSet && excludeSet.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
    return out;
  }

  async function scrapeMakeover(ctx) {
    const html = ctx.mainHtml;
    const pageUrl = ctx.url;  // full page URL for resolving relative image paths

    // Find the variant select
    const selectIdx = html.indexOf('<select id="yslist"');
    if (selectIdx === -1) throw new Error('Not a MakeOver variable product page');

    // ── Product name & SKU from text before the select ──
    // The HTML has <script> blocks that can span beyond our window. Find the
    // last </script> before the select, then extract text after it.
    let name = '', sku = '';
    const preChunk = html.slice(Math.max(0, selectIdx - 4000), selectIdx);
    const lastScript = preChunk.lastIndexOf('</script>');
    const textSrc = lastScript !== -1
      ? preChunk.slice(lastScript + 9)
      : preChunk.replace(/<script[\s\S]*?<\/script>/gi, '');
    const preText = textSrc.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();

    // The layout is: "Product Name  SKU  PRICE  Choose a color"
    // Split by double spaces or scan tokens for the SKU (short alphanumeric)
    const chooseIdx = preText.search(/choose\s+a?\s*color/i);
    const before = (chooseIdx !== -1 ? preText.slice(0, chooseIdx) : preText).trim();
    if (before) {
      const tokens = before.split(/\s+/);
      // SKU is a short code (e.g. "F37", "PT215") near the end, before price
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i].replace(/[£$€¥¤]/g, '').replace(/[^A-Za-z0-9]/g, '');
        if (/^[A-Za-z0-9]{2,6}$/.test(t)) {
          sku = t;
          name = decodeEntities(tokens.slice(0, i).join(' '));
          break;
        }
      }
      if (!name) {
        // Strip the last "Choose a color" token
        name = decodeEntities(before.replace(/\s*choose\s+a?\s*color\s*$/i, '').trim()) || before;
      }
    }
    // Fallback: <title>
    if (!name) {
      const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
      name = decodeEntities(titleTag.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (!name) name = 'MakeOver Product';

    // ── Category — look for a section header above this product ──
    let categories = '';
    // Try to find category from the URL query params
    try {
      const u = new URL(ctx.url);
      if (u.searchParams.get('id1')) categories = 'MakeOver';
    } catch (e) {}

    // ── Variants from select options ──
    // MakeOver products use the SAME main product image for all variants.
    // The kuang div images are used only as swatches (colorCode), not variant images.
    const optRe = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g;
    const kuangImages = new Set();
    const variants = [];
    let opt;
    while ((opt = optRe.exec(html))) {
      const optId = opt[1];
      const optName = decodeEntities(opt[2].trim());

      // Find the kuang div for this variant (used as the image swatch)
      const kuangRe = new RegExp(`id="kuang${optId}"[\\s\\S]*?<img[^>]*src="([^"]+)"`, '');
      const kuangImgMatch = html.match(kuangRe);
      let swatchImg = kuangImgMatch ? makeoverAbsUrl(kuangImgMatch[1], pageUrl) : '';

      // Fallback: use imgid background-image (the small clickable swatch)
      if (!swatchImg) {
        const bgRe = new RegExp(`id="imgid${optId}"[^>]*background-image:url\\(([^)]+)\\)`);
        const bgMatch = html.match(bgRe);
        swatchImg = bgMatch ? makeoverAbsUrl(bgMatch[1], pageUrl) : '';
      }

      if (swatchImg) kuangImages.add(swatchImg);

      variants.push({
        name: optName,
        sku: '',
        regularPrice: '',
        salePrice: '',
        images: [],  // filled below with the main product image
        extras: [],
        colorCode: swatchImg,  // image swatch from kuang div
      });
    }

    if (!variants.length) throw new Error('No variants found');

    // ── Product image — the mainpic is the only image, shared by all variants ──
    let mainpic = (html.match(/id="mainpic"[^>]*src="([^"]+)"/) || [])[1] || '';
    mainpic = makeoverAbsUrl(mainpic, pageUrl);
    const parentImages = mainpic ? [mainpic] : [];

    // All variants share the same main product image
    for (const v of variants) {
      if (mainpic) v.images = [mainpic];
    }

    // ── Description ──
    let description = '';
    const descIdx = html.toLowerCase().indexOf('product detail');
    if (descIdx !== -1) {
      const descBlock = html.slice(descIdx, descIdx + 2000);
      description = decodeEntities(descBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }

    return {
      rows: variableRows(name, parentImages, description, '', categories, 'Image', variants),
      title: name,
    };
  }

  async function scrapeMakeoverSimple(ctx) {
    const html = ctx.mainHtml;
    const pageUrl = ctx.url;

    // Product name — from <title> or meta og:title
    let name = '';
    const ogTitle = (html.match(/property="og:title"\s+content="([^"]+)"/) || [])[1];
    if (ogTitle) name = decodeEntities(ogTitle.trim());
    if (!name) {
      const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
      name = decodeEntities(titleTag.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (!name) name = 'MakeOver Product';

    // SKU
    let sku = '';
    const skuMatch = html.match(/<span[^>]*id="sku"[^>]*>([^<]+)</);
    if (skuMatch) sku = skuMatch[1].trim();
    if (!sku) {
      const m = html.match(/\b([A-Z]{1,3}\d{2,4})\b/);
      if (m) sku = m[1];
    }

    // Images — mainpic + any gallery images
    const parentSet = new Set();
    let mainpic = (html.match(/id="mainpic"[^>]*src="([^"]+)"/) || [])[1] || '';
    mainpic = makeoverAbsUrl(mainpic, pageUrl);
    if (mainpic) parentSet.add(mainpic);

    const allImgs = makeoverImages(html, pageUrl, null);
    for (const img of allImgs) parentSet.add(img);

    // Description
    let description = '';
    const descIdx = html.toLowerCase().indexOf('product detail');
    if (descIdx !== -1) {
      const descBlock = html.slice(descIdx, descIdx + 2000);
      description = decodeEntities(descBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }

    return { rows: simpleRow({ sku, name, description, images: [...parentSet].slice(0, 10) }), title: name };
  }

  // ── Topface (Shopify; GloboSwatchConfig.product for full product data) ─────
  // GloboSwatchConfig.product carries the complete Shopify product JSON
  // (images, media, variants with featured_image). Swatch hex codes are
  // found in <div class="swatch"> elements. Option name from product.options.

  async function scrapeTopface(ctx) {
    const html = ctx.mainHtml;

    // ── 1. Parse GloboSwatchConfig.product JSON (complete product data) ────────
    let product = null;
    const gscM = html.match(/product:\s*(\{"id":\d+)/);
    if (gscM) {
      const i = html.indexOf(gscM[1], gscM.index);
      let brace = 0, end = i;
      for (let j = i; j < html.length; j++) {
        if (html[j] === '{') brace++;
        else if (html[j] === '}') { brace--; if (brace === 0) { end = j + 1; break; } }
      }
      try { product = JSON.parse(html.slice(i, end)); } catch (e) {}
    }
    if (!product) throw new Error('No Topface product data found.');

    const productName = product.title || '';
    const description = (product.description || '').trim();

    // ── 2. Categories (product type from Shopify) ─────────────────────────────
    const categories = (product.type && product.type !== 'object') ? product.type : '';

    // ── 3. Short description (meta) ───────────────────────────────────────────
    const metaDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/);
    let shortDesc = metaDesc ? decodeEntities(metaDesc[1].trim()) : '';
    if (shortDesc === productName || shortDesc.length < 10) shortDesc = '';

    // ── 4. Swatch extraction: auto-detect colour vs image per variant ─────────
    // Globo swatches have <li class="select-option"> elements inside
    //   <ul class="value g-variant-color-detail">. Each <li> has:
    //   - data-value="Cherry Jam - PT215.001"  (maps to variant option1)
    //   - data-variantid="42813608951910"       (Shopify variant ID)
    //   - <label class="... globo-border-color-swatch ..." style="background-color:#c60500">
    //     OR
    //   - <label class="... globo-border-image-swatch ..."><img src="...">
    const swatchMap = new Map(); // shortName -> { type:'color', color }|{ type:'image', src }
    const colorSwatchUl = html.match(/class="value g-variant-color-detail"[^>]*>([\s\S]*?)<\/ul>/);
    if (colorSwatchUl) {
      for (const li of colorSwatchUl[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
        const block = li[0];
        const dataValue = (block.match(/data-value="([^"]*)"/) || [])[1] || '';
        // Strip SKU suffix to get the short variant name
        const shortName = dataValue.replace(/\s*-\s*[A-Z]{2,}\d+.*$/, '').trim();
        if (!shortName) continue;
        // Detect swatch type from the label's class
        if (/globo-border-color-swatch/.test(block)) {
          const hex = (block.match(/background-color\s*:\s*(#[0-9a-fA-F]{3,8})/i) || [])[1] || '';
          if (hex) swatchMap.set(shortName, { type: 'color', color: hex });
        } else if (/globo-border-image-swatch/.test(block) || /<img\s[^>]*src=/.test(block)) {
          const imgMatch = block.match(/<img[^>]*src="([^"]+)"/);
          if (imgMatch) {
            let src = imgMatch[1];
            if (src.startsWith('//')) src = 'https:' + src;
            swatchMap.set(shortName, { type: 'image', src: src.split('?')[0] });
          }
        }
      }
    }
    // Determine the dominant swatch type (for attribute naming)
    let swatchIsColor = true, swatchIsImage = false;
    for (const s of swatchMap.values()) {
      if (s.type === 'image') { swatchIsImage = true; swatchIsColor = false; break; }
    }

    // ── 5. Group media images by variant via alt text ──────────────────────────
    const variantImagesMap = new Map();
    (product.media || []).forEach(m => {
      if (!m || !m.alt || !m.src) return;
      // alt is e.g. "Cherry Jam - PT215.001" — extract just the shade name
      const name = m.alt.replace(/\s*-\s*[A-Z]{2,}\d+.*$/, '').trim();
      let src = m.src;
      if (src.startsWith('//')) src = 'https:' + src;
      src = src.split('?')[0];
      if (!variantImagesMap.has(name)) variantImagesMap.set(name, []);
      variantImagesMap.get(name).push(src);
    });

    // ── 6. Build variant rows ────────────────────────────────────────────────
    const variants = (product.variants || []).map(v => {
      const name = (v.option1 || v.public_title || '').replace(/\s*-\s*[A-Z]{2,}\d+.*$/, '').trim();
      const price = v.price ? String(v.price / 100) : '';
      const compareAt = v.compare_at_price ? String(v.compare_at_price / 100) : '';
      const salePrice = (compareAt && compareAt !== price) ? price : '';
      const regularPrice = (compareAt && compareAt !== price) ? compareAt : price;
      const images = variantImagesMap.get(name) || [];
      // Colour code or swatch image from the swatch map (keyed by short variant name)
      const sw = swatchMap.get(name);
      const colorCode = (sw && sw.type === 'color') ? sw.color
        : (sw && sw.type === 'image') ? sw.src
        : '';

      return {
        name, sku: v.sku || '',
        regularPrice, salePrice,
        images, extras: [], colorCode,
      };
    });

    // ── 7. Parent images (first variant's images) ─────────────────────────────
    const parentImages = variants.length ? variants[0].images : [];

    return {
      rows: variableRows(productName, parentImages, description, shortDesc, categories, swatchIsImage ? 'Image' : 'Color', variants),
      title: productName,
    };
  }

  async function scrapeTopfaceSimple(ctx) {
    const html = ctx.mainHtml;

    // ── 1. Parse GloboSwatchConfig.product JSON ────────────────────────────────
    let product = null;
    const gscM = html.match(/product:\s*(\{"id":\d+)/);
    if (gscM) {
      const i = html.indexOf(gscM[1], gscM.index);
      let brace = 0, end = i;
      for (let j = i; j < html.length; j++) {
        if (html[j] === '{') brace++;
        else if (html[j] === '}') { brace--; if (brace === 0) { end = j + 1; break; } }
      }
      try { product = JSON.parse(html.slice(i, end)); } catch (e) {}
    }
    if (!product) throw new Error('No Topface product data found.');

    const productName = product.title || '';
    const categories = (product.type && product.type !== 'object') ? product.type : '';

    // ── 2. Images (product.media or product.images) ────────────────────────────
    const images = [];
    const mediaSources = product.media || product.images || [];
    for (const m of mediaSources) {
      let src = typeof m === 'string' ? m : (m && m.src) || '';
      if (!src) continue;
      if (src.startsWith('//')) src = 'https:' + src;
      images.push(src.split('?')[0]);
    }
    // Fallback: JSON-LD image
    if (!images.length) {
      for (const raw of ldBlocks(html)) {
        try {
          const ld = JSON.parse(raw);
          if (ld['@type'] === 'Product' && ld.image) {
            const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
            images.push(...imgs.map(u => (typeof u === 'string' ? u : '').split('?')[0]).filter(Boolean));
            break;
          }
        } catch (e) {}
      }
    }

    // ── 3. SKU & Price ────────────────────────────────────────────────────────
    let sku = '', regularPrice = '';
    const variant = (product.variants && product.variants[0]) || {};

    // Prefer variant JSON (cents → decimal) over JSON-LD
    sku = variant.sku || '';
    regularPrice = variant.price ? String(variant.price / 100) : '';

    // Fallback to JSON-LD
    if (!sku || !regularPrice) {
      for (const raw of ldBlocks(html)) {
        try {
          const ld = JSON.parse(raw);
          if (ld['@type'] === 'Product') {
            if (!sku) sku = ld.sku || ld.gtin13 || '';
            if (!regularPrice) {
              const offers = ld.offers;
              if (Array.isArray(offers) && offers[0]) regularPrice = String(offers[0].price || '');
              else if (offers && offers.price) regularPrice = String(offers.price);
            }
            break;
          }
        } catch (e) {}
      }
    }

    // ── 4. Short description ──────────────────────────────────────────────────
    const metaDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/);
    let shortDesc = metaDesc ? decodeEntities(metaDesc[1].trim()) : '';
    if (shortDesc === productName || shortDesc.length < 10) shortDesc = '';

    return {
      rows: simpleRow({ sku, name: productName, description: '', shortDesc, categories, images, regularPrice }),
      title: productName,
    };
  }

  // ── L'Oréal Paris (Sitecore, color = sibling pages) ─────────────────────────
  function lorealParsePage(html) {
    let product = null, breadcrumb = null;
    for (const raw of ldBlocks(html)) { try { const j = JSON.parse(raw); if (j['@type'] === 'Product' && !product) product = j; if (j['@type'] === 'BreadcrumbList') breadcrumb = j; } catch (e) {} }
    const sku = (product && (product.sku || product.gtin13)) || '';
    const description = decodeEntities(((product && product.description) || '').trim());
    const price = product && product.offers && product.offers.price || '';
    let mainImg = ''; const im = product && product.image;
    if (typeof im === 'string') { const u = im.match(/https?:\/\/[^"\s,]+/); mainImg = u ? u[0].split('?')[0] : ''; }
    else if (Array.isArray(im)) { const f = im[0]; mainImg = (typeof f === 'string' ? f : (f && f.url) || '').split('?')[0]; }
    const seen = new Set(); const gallery = [];
    if (mainImg) { seen.add(mainImg); gallery.push(mainImg); }
    const g = html.indexOf('oap-media-gallery-fullscreen__list');
    const block = g !== -1 ? html.slice(g, html.indexOf('</ul>', g)) : '';
    for (const m of block.matchAll(/\/-\/media\/project\/loreal[^"\s,]*?\.(?:png|jpg|jpeg|webp)/gi)) { const abs = LOREAL_ORIGIN + m[0].split('?')[0]; if (!seen.has(abs)) { seen.add(abs); gallery.push(abs); } }
    let categories = '';
    if (breadcrumb) { const names = (breadcrumb.itemListElement || []).map(i => i.name || (i.item && i.item.name)).filter(Boolean).filter(n => n.toLowerCase() !== 'home'); categories = names.slice(0, -1).join('>'); }
    const name = decodeEntities(((product && product.name) || '').trim());
    return { sku, name, description, price, gallery, categories };
  }
  async function scrapeLorealParis(ctx) {
    const html = ctx.mainHtml;
    const parsed = lorealParsePage(html);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    // Prefer the JSON-LD product name; the h1 repeats the range ("Colour Riche Colour Riche …"),
    // so collapse a duplicated leading phrase when falling back to it.
    const title = parsed.name || (h1 ? decodeEntities(h1[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).replace(/^(.+?)\s+\1\b/, '$1').trim() : '');
    const { description, categories } = parsed;
    // Each shade is a colorItem <li> with an <a href> to its own page, an aria-label
    // ("see <handle> in <shade>") and the hex on the swatch SVG (fill="#…").
    const variantsMeta = []; const seenUrl = new Set();
    for (const m of html.matchAll(/<li class="[^"]*colorItem[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
      const block = m[1];
      const href = (block.match(/href="([^"]+)"/) || [])[1] || '';
      const aria = decodeEntities((block.match(/aria-label="([^"]*)"/) || [])[1] || '');
      const name = ((aria.match(/\bin\s+(.+)$/i) || [])[1] || aria).trim();
      const hex = (block.match(/fill="(#[0-9A-Fa-f]{3,6})"/i) || [])[1] || '';
      if (!href || !name || seenUrl.has(href)) continue;
      seenUrl.add(href);
      variantsMeta.push({ name, hex, url: href.startsWith('http') ? href : LOREAL_ORIGIN + href });
    }
    if (!variantsMeta.length) throw new Error('No color variants on L\'Oréal page.');
    const norm = u => u.replace(/\/$/, '');
    const pages = [];
    for (const v of variantsMeta) {
      const pageHtml = norm(v.url) === norm(ctx.url) ? html : await ctx.fetchText(v.url);
      // page fields first, then v so the shade name/hex/url win over the page's product name.
      pages.push(Object.assign({}, lorealParsePage(pageHtml), v));
    }
    const variants = pages.map(p => ({ name: p.name, sku: p.sku || '', regularPrice: '', salePrice: '', images: p.gallery, extras: p.gallery.slice(1, 3), colorCode: p.hex }));
    return { rows: variableRows(title, pages[0] ? pages[0].gallery : [], description, '', categories, 'Color', variants), title };
  }
  async function scrapeLorealParisSimple(ctx) {
    const html = ctx.mainHtml;
    const { sku, name, description, gallery, categories } = lorealParsePage(html);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = name || (h1 ? decodeEntities(h1[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).replace(/^(.+?)\s+\1\b/, '$1').trim() : '');
    return { rows: simpleRow({ sku, name: title, description, categories, images: gallery }), title };
  }

  // ── Vichy (Sitecore, single Size variation) ─────────────────────────────────
  async function scrapeVichy(ctx) {
    const html = ctx.mainHtml; const origin = new URL(ctx.url).origin;
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = h1 ? decodeEntities(h1[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    const sku = (html.match(/"dimension48":"(\d{6,})"/) || html.match(/"id":"(\d{6,})"/) || [])[1] || '';
    let size = (html.match(/"variant":"([^"]*)"/) || html.match(/"dimension35":"([^"]*)"/) || [])[1] || '';
    if (!size) { const sz = html.match(/Selected size<\/span>\s*<span[^>]*>([^<]+)</); size = sz ? sz[1].trim().replace(/\s*ML\b/i, 'ml') : ''; }
    const dm = html.match(/Description&quot;:&quot;([\s\S]*?)&quot;/);
    const description = dm ? decodeEntities(dm[1]).trim() : '';
    const categories = [...html.matchAll(/itemprop="name">([^<]+)</g)].map(m => m[1].trim()).filter(c => !/^home$/i.test(c) && !/^all[-\s]?products$/i.test(c)).join('>');
    const images = [...new Set([...html.matchAll(/\/-\/media\/project\/loreal\/brand-sites\/vchy\/[^"\s]*?\/products\/[^"\s]*?\.(?:jpg|jpeg|png|webp)/gi)].map(m => origin + m[0].split('?')[0]))];
    const variants = [{ name: size, sku, regularPrice: '', salePrice: '', images, extras: images.slice(1, 3), colorCode: '' }];
    return { rows: variableRows(title, images, description, '', categories, 'Size', variants), title };
  }

  // ── La Roche-Posay (Demandware, Akamai — active-tab; sizes via same-origin) ──
  const LRP_ORIGIN = 'https://www.laroche-posay.us';
  function lrpExtractSize(html) {
    const ean = (html.match(/variations-size-(\d{12,13})/) || [])[1] || '';
    const priceRaw = (html.match(/data-js-saleprice[^>]*>\s*\$?\s*([\d.,]+)/i) || [])[1] || '';
    const price = priceRaw ? parseFloat(priceRaw.replace(/,/g, '')).toFixed(2) : '';
    const gallery = [];
    if (ean) {
      const seen = new Set();
      const re = new RegExp('https://[^"\\s\\\\]*?/dw/image/[^"\\s\\\\]*?' + ean + '[^"\\s\\\\]*?\\.(?:jpg|jpeg|png|webp)', 'gi');
      for (const m of html.matchAll(re)) { const url = m[0].split('?')[0]; const fn = decodeURIComponent(url.split('/').pop()); if (!seen.has(fn)) { seen.add(fn); gallery.push(url); } }
    }
    return { ean, price, gallery };
  }
  async function scrapeLarocheposay(ctx) {
    const html = ctx.mainHtml;
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = decodeEntities((h1 ? h1[1] : '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const sdM = html.match(/class="[^"]*short-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const description = decodeEntities((sdM ? sdM[1] : '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s*Read more.*$/i, ''));
    const bcM = html.match(/breadcrumb[\s\S]{0,800}?<\/(?:nav|ol|ul)>/i);
    const categories = bcM ? [...bcM[0].matchAll(/>([^<>]{2,40})<\/a>/g)].map(m => m[1].trim()).filter(c => c && !/^home$/i.test(c) && !/^our products$/i.test(c)).join('>') : '';
    const sizes = []; const seenSz = new Set();
    for (const m of html.matchAll(/href="([^"]*dwvar_[^"=]+_size=([^"&]+)[^"]*)"/gi)) {
      const sz = decodeURIComponent(m[2]).replace(/\s+/g, '').toUpperCase();
      const url = m[1].replace(/&amp;/g, '&');
      if (sz && !seenSz.has(sz)) { seenSz.add(sz); sizes.push({ size: sz, url: url.startsWith('http') ? url : LRP_ORIGIN + url }); }
    }
    if (!sizes.length) throw new Error('No size variations on La Roche-Posay page.');
    const activeSize = ((html.match(/data-js-selected-value[^>]*>\s*(\d+\s*ML)/i) || [])[1] || '').replace(/\s+/g, '').toUpperCase();
    const variants = [];
    for (const sz of sizes) {
      const pageHtml = sz.size === activeSize ? html : await ctx.fetchText(sz.url);
      const v = lrpExtractSize(pageHtml);
      variants.push({ name: sz.size, sku: v.ean || '', regularPrice: v.price || '', salePrice: '', images: v.gallery, extras: v.gallery.slice(1, 3), colorCode: '' });
    }
    return { rows: variableRows(title, variants[0] ? variants[0].images : [], description, '', categories, 'Size', variants), title };
  }

  // ── Urban Care (WooCommerce) ────────────────────────────────────────────────
  async function scrapeUrbancareSimple(ctx) {
    const html = ctx.mainHtml;
    let product = null;
    for (const raw of ldBlocks(html)) { try { const j = JSON.parse(raw); for (const n of (j['@graph'] || [j])) if (/Product/.test(n['@type'] || '') && !product) product = n; } catch (e) {} }
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = decodeEntities((h1 ? h1[1] : (product && product.name) || '').replace(/<[^>]+>/g, '').trim());
    const description = product && product.description ? decodeEntities(product.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    const sku = (product && product.sku) || (html.match(/class="sku"[^>]*>([^<]+)</) || [])[1] || '';
    let images = [];
    if (product && product.image) { const arr = Array.isArray(product.image) ? product.image : [product.image]; images = arr.map(x => (typeof x === 'string' ? x : x.url)).filter(Boolean); }
    images = [...new Set(images.map(u => u.split('?')[0]))];
    const delM = html.match(/<del[^>]*>([\s\S]*?)<\/del>/); const insM = html.match(/<ins[^>]*>([\s\S]*?)<\/ins>/);
    let regular, sale = '';
    if (delM && insM) { regular = woocommercePrice(delM[1]); sale = woocommercePrice(insM[1]); }
    else regular = woocommercePrice((html.match(/woocommerce-Price-amount[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    let categories = '';
    const bc = html.match(/woocommerce-breadcrumb[^>]*>([\s\S]*?)<\/nav>/i);
    if (bc) categories = [...bc[1].matchAll(/>([^<>]+)</g)].map(m => decodeEntities(m[1].trim())).filter(c => c && !/^home$/i.test(c) && c.toLowerCase() !== title.toLowerCase()).join('>');
    return { rows: simpleRow({ sku, name: title, description, regularPrice: regular, salePrice: sale, categories, images }), title };
  }

  // ── Bielenda (catalog) ──────────────────────────────────────────────────────
  async function scrapeBielendaSimple(ctx) {
    const html = ctx.mainHtml;
    const title = decodeEntities(((html.match(/property="og:title"\s+content="([^"]+)"/) || [])[1] || (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '')).replace(/\s*-\s*Bielenda\s*$/i, '').trim();
    const gStart = html.indexOf('id="product-gallery"');
    const gBlock = gStart !== -1 ? html.slice(gStart, html.indexOf('</div>', gStart)) : '';
    const images = [...new Set([...gBlock.matchAll(/src="([^"]+\.(?:png|jpg|jpeg|webp))"/gi)].map(m => m[1]))];
    const sku = (gBlock.match(/(\d{13})/) || [])[1] || '';
    let description = '';
    const dStart = html.search(/Product description<\/span>/i);
    if (dStart !== -1) { const h5end = html.indexOf('</h5>', dStart); const after = html.slice(h5end + 5); const ns = after.search(/<h5[^>]*section-title/i); description = decodeEntities((ns !== -1 ? after.slice(0, ns) : after.slice(0, 2000)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
    const categories = [...html.matchAll(/itemprop="name">([^<]+)</g)].map(m => decodeEntities(m[1].trim())).filter(c => c && !/^homepage$/i.test(c) && c.toLowerCase() !== title.toLowerCase()).join('>');
    return { rows: simpleRow({ sku, name: title, description, categories, images }), title };
  }

  // ── CeraVe (Sitecore) ───────────────────────────────────────────────────────
  async function scrapeCeraveSimple(ctx) {
    const html = ctx.mainHtml; const origin = new URL(ctx.url).origin;
    const blocks = ldBlocks(html);
    const productLd = blocks.find(b => /"@type"\s*:\s*"Product"/.test(b)) || '';
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = decodeEntities((h1 ? h1[1] : (productLd.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const sku = (productLd.match(/"sku"\s*:\s*"([^"]*)"/) || [])[1] || '';
    const descM = productLd.match(/"description"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    const description = descM ? decodeEntities(descM[1].replace(/\\[rn]/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    const imgArr = (productLd.match(/"image"\s*:\s*\[([\s\S]*?)\]/) || [])[1] || '';
    const images = [...new Set([...imgArr.matchAll(/"(\/-\/media\/[^"]+?\.(?:jpg|jpeg|png|webp))[^"]*"/gi)].map(m => origin + m[1]))];
    let categories = '';
    const bcLd = blocks.find(b => /BreadcrumbList/.test(b));
    if (bcLd) { try { const bc = JSON.parse(bcLd); categories = (bc.itemListElement || []).map(i => i.name || (i.item && i.item.name)).filter(c => c && !/^home$/i.test(c) && c.toLowerCase() !== title.toLowerCase()).join('>'); } catch (e) {} }
    return { rows: simpleRow({ sku, name: title, description, categories, images }), title };
  }

  // ── NARS (Demandware, color OR size) ────────────────────────────────────────
  async function scrapeNars(ctx) {
    const html = ctx.mainHtml; const { product, breadcrumb } = narsLD(html);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = decodeEntities((h1 ? h1[1] : (product && product.name) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const description = decodeEntities(((product && product.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const ldPrice = product && product.offers && product.offers.price ? parseFloat(product.offers.price).toFixed(2) : '';
    const categories = bcCategories(breadcrumb, title);
    const attrMatch = html.match(/"attributes":\[\{"id":"(color|size)"/);
    const attrId = attrMatch ? attrMatch[1] : 'color'; const isSize = attrId === 'size';
    const valById = new Map(), hiResById = new Map();
    const ci = html.indexOf(`"attributes":[{"id":"${attrId}"`);
    if (ci !== -1) {
      const vi = html.indexOf('"vals":[', ci); let depth = 0, j = vi + 7;
      for (; j < html.length; j++) { if (html[j] === '[') depth++; else if (html[j] === ']') { depth--; if (!depth) break; } }
      try { for (const v of JSON.parse(html.slice(vi + 7, j + 1))) { valById.set(String(v.id), v.val); hiResById.set(String(v.id), [...new Set(((v.images && v.images.hiRes) || []).map(im => im.url.split('?')[0]))]); } } catch (e) {}
    }
    const hexByName = new Map();
    if (!isSize) for (const m of html.matchAll(/sr-only">([^<]+)<\/div>\s*<div class="swatch-block"[^>]*background-color:\s*(?:&#35;|#)([0-9a-fA-F]{3,8})/g)) { const n = decodeEntities(m[1].trim()); if (!hexByName.has(n)) hexByName.set(n, '#' + m[2]); }
    const activeUpc = (html.match(/data-pid="([^"]+)"/) || [])[1] || '';
    const ul = html.indexOf('pdp-swatches'); const block = ul !== -1 ? html.slice(ul, html.indexOf('</ul>', ul)) : '';
    const variants = [];
    for (const li of block.split(/<li /).slice(1)) {
      const vid = (li.match(new RegExp('dwvar_[^=]+_' + attrId + '=(\\w+)')) || [])[1];
      if (!vid) continue;
      const name = decodeEntities((li.match(/data-swatch-name=.([^'"]+)/) || [])[1] || valById.get(vid) || '');
      const upc = (li.match(/data-upc="([^"]+)"/) || [])[1] || '';
      let images = hiResById.get(vid) || []; let price = ldPrice;
      if (isSize) {
        let pageHtml = html; const href = decodeEntities((li.match(/href="([^"]+)"/) || [])[1] || '');
        if (upc && upc !== activeUpc && href) { try { pageHtml = await ctx.fetchText(href); } catch (e) {} }
        const pm = narsLD(pageHtml).product;
        price = pm && pm.offers && pm.offers.price ? parseFloat(pm.offers.price).toFixed(2) : ldPrice;
        if (upc) { const re = new RegExp('https://www\\.narscosmetics\\.com/dw/image/v2/[^"]*?/' + upc + '(?:_\\d+)?\\.(?:jpg|jpeg|png)', 'gi'); images = [...new Set([...pageHtml.matchAll(re)].map(m => m[0].split('?')[0]))]; }
      }
      variants.push({ name, sku: upc, regularPrice: price, salePrice: '', images, extras: images.slice(1, 3), colorCode: isSize ? '' : (hexByName.get(name) || '') });
    }
    if (!variants.length) throw new Error('No variants found on NARS page.');
    return { rows: variableRows(title, variants[0].images, description, '', categories, isSize ? 'Size' : 'Color', variants), title };
  }
  async function scrapeNarsSimple(ctx) {
    const html = ctx.mainHtml; const { product, breadcrumb } = narsLD(html);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = decodeEntities(((product && product.name) || (h1 ? h1[1] : '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const description = decodeEntities(((product && product.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const price = product && product.offers && product.offers.price ? parseFloat(product.offers.price).toFixed(2) : '';
    const sku = (product && product.sku) || (html.match(/data-pid="([^"]+)"/) || [])[1] || '';
    const categories = bcCategories(breadcrumb, title);
    let images = [];
    if (sku) { const re = new RegExp('https://www\\.narscosmetics\\.com/dw/image/v2/[^"]*?/' + sku + '(?:_\\d+)?\\.(?:jpg|jpeg|png)', 'gi'); images = [...new Set([...html.matchAll(re)].map(m => m[0].split('?')[0]))]; }
    return { rows: simpleRow({ sku, name: title, description, regularPrice: price, categories, images }), title };
  }

  // ── Sephora (linkStore from rendered DOM — active-tab) ───────────────────────
  function sephoraStore(html) {
    const m = html.match(/<script id="linkStore"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('Sephora product data (#linkStore) not found — use "Scrape this page".');
    const p = JSON.parse(m[1]) && JSON.parse(m[1]).page && JSON.parse(m[1]).page.product;
    if (!p) throw new Error('Sephora product not found.');
    return p;
  }
  function sephoraTitle(p) {
    const d = p.productDetails || {};
    const brand = (d.brand && d.brand.displayName) || (p.currentSku && p.currentSku.brandName) || '';
    const productName = d.displayName || (p.currentSku && p.currentSku.productName) || '';
    return decodeEntities([brand, productName].filter(Boolean).join(' ').trim());
  }
  function sephoraGallery(sku) {
    const out = []; const seen = new Set();
    const add = u => { u = u ? u.split('?')[0] : ''; if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
    add(sku && sku.skuImages && sku.skuImages.imageUrl);
    ((sku && sku.alternateImages) || []).forEach(a => add(a.imageUrl));
    return out;
  }
  async function scrapeSephora(ctx) {
    const p = sephoraStore(ctx.mainHtml);
    const d = p.productDetails || {};
    const title = sephoraTitle(p);
    const description = decodeEntities((d.longDescription || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const categories = (p.parentCategory && p.parentCategory.displayName) || '';
    const isImageSwatch = (p.skuSelectorType || '').toLowerCase() === 'image';
    const childSkus = (p.regularChildSkus && p.regularChildSkus.length) ? p.regularChildSkus : [p.currentSku];
    const variants = childSkus.map(s => ({
      name: decodeEntities(s.variationValue || s.displayName || ''), sku: s.skuId || '',
      regularPrice: (s.listPrice || '').replace(/[^\d.]/g, ''), salePrice: (s.salePrice || '').replace(/[^\d.]/g, ''),
      images: sephoraGallery(s), extras: sephoraGallery(s).slice(1, 3),
      colorCode: isImageSwatch ? (s.smallImage ? s.smallImage.split('?')[0] : '') : '',
    }));
    return { rows: variableRows(title, variants[0] ? variants[0].images : [], description, '', categories, isImageSwatch ? 'Image' : (p.variationTypeDisplayName || 'Color'), variants), title };
  }
  async function scrapeSephoraSimple(ctx) {
    const p = sephoraStore(ctx.mainHtml); const d = p.productDetails || {}; const sku = p.currentSku || {};
    return { rows: simpleRow({
      sku: sku.skuId || '', name: sephoraTitle(p),
      description: decodeEntities((d.longDescription || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
      regularPrice: (sku.listPrice || '').replace(/[^\d.]/g, ''), salePrice: (sku.salePrice || '').replace(/[^\d.]/g, ''),
      categories: (p.parentCategory && p.parentCategory.displayName) || '', images: sephoraGallery(sku),
    }), title: sephoraTitle(p) };
  }

  // ── Radiant Professional (custom; hex swatches + per-shade galleries) ───────
  // Shades are <li data-shade-hex data-shade-description data-upc data-price>;
  // each shade maps (by order) to a js-variant-gallery[data-gallery-id] whose
  // data-src images are that shade's photos.
  function radiantGallery(html, gid) {
    const a = html.indexOf(`data-gallery-id="${gid}"`);
    if (a === -1) return [];
    const next = [...html.matchAll(/data-gallery-id="\d+"/g)].map(x => x.index).filter(x => x > a).sort((p, q) => p - q)[0];
    const block = html.slice(a, next || a + 9000);
    return [...new Set([...block.matchAll(/data-src="([^"]+\.(?:jpg|jpeg|png|webp))"/gi)].map(x => x[1]))];
  }
  function radiantShades(html) {
    const seen = new Set(); const shades = [];
    for (const m of html.matchAll(/<li[^>]*data-shade-hex="[^"]*"[^>]*>/gi)) {
      const e = m[0];
      const upc = (e.match(/data-upc="([^"]*)"/) || [])[1];
      if (!upc || seen.has(upc)) continue;
      seen.add(upc);
      shades.push({
        name: decodeEntities((e.match(/data-shade-description="([^"]*)"/) || [])[1] || ''),
        hex: (e.match(/data-shade-hex="([^"]*)"/) || [])[1] || '',
        sku: upc,
        price: ((e.match(/data-price="([^"]*)"/) || [])[1] || '').replace(/[^\d.]/g, ''),
      });
    }
    return shades;
  }
  function radiantMeta(html) {
    const title = decodeEntities(((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const description = decodeEntities(((html.match(/name="description"\s+content="([^"]+)"/) || [])[1] || '').trim());
    return { title, description };
  }
  async function scrapeRadiant(ctx) {
    const html = ctx.mainHtml;
    const { title, description } = radiantMeta(html);
    const shades = radiantShades(html);
    if (!shades.length) throw new Error('No Radiant shades found on the page.');
    const galleryIds = [...new Set([...html.matchAll(/data-gallery-id="(\d+)"/g)].map(m => m[1]))];
    const variants = shades.map((s, i) => {
      const imgs = galleryIds[i] ? radiantGallery(html, galleryIds[i]) : [];
      return { name: s.name, sku: s.sku, regularPrice: s.price, salePrice: '', images: imgs, extras: imgs.slice(1, 3), colorCode: s.hex };
    });
    return { rows: variableRows(title, variants[0] ? variants[0].images : [], description, '', '', 'Color', variants), title };
  }
  async function scrapeRadiantSimple(ctx) {
    const html = ctx.mainHtml;
    const { title, description } = radiantMeta(html);
    // The add-to-basket <form> carries the canonical SKU + price for this product.
    const form = (html.match(/<form[^>]*data-item-code="[^"]*"[^>]*>/i) || [])[0] || '';
    const sku = (form.match(/data-item-code="([^"]*)"/) || [])[1] || '';
    const price = ((form.match(/data-item-price="([^"]*)"/) || [])[1] || '').replace(/[^\d.]/g, '');
    // Main product gallery, bounded so related-product thumbnails aren't pulled in.
    let images = [];
    const gi = html.indexOf('js-product-detail-gallery');
    if (gi !== -1) {
      const end = html.indexOf('js-add-to-basket-form', gi + 10);
      const block = html.slice(gi, end === -1 ? gi + 12000 : end);
      images = [...new Set([...block.matchAll(/data-src="([^" ]+?\.(?:jpg|jpeg|png|webp))/gi)].map(m => m[1]))];
    }
    if (!images.length) {
      const og = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1];
      if (og) images = [og];
    }
    return { rows: simpleRow({ sku, name: title, description, regularPrice: price, images }), title };
  }

  // ── Bulk discovery: get all products + categories via sitemap ────────────
  // ── e.l.f. Cosmetics (Shopify, sitemap-based, per‑page JSON‑LD breadcrumbs) ──
  async function discoverElf(ctx) {
    const { fetchText, onProgress } = ctx;

    // 1) Fetch sitemap index → collect product sitemap URLs
    const sitemapXml = await fetchText('https://www.elfcosmetics.com/sitemap.xml');
    const productSmUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/www\.elfcosmetics\.com\/sitemap\/products\/\d+\.xml)<\/loc>/g)].map(m => m[1]);
    if (!productSmUrls.length) throw new Error('No product sitemaps found for e.l.f.');

    // 2) Fetch all product sitemaps in parallel → collect every product URL
    const productUrls = [];
    for (const smUrl of productSmUrls) {
      const xml = await fetchText(smUrl);
      const urls = [...xml.matchAll(/<loc>(https:\/\/www\.elfcosmetics\.com\/products\/[^<]+)<\/loc>/g)].map(m => m[1]);
      productUrls.push(...urls);
    }
    if (!productUrls.length) throw new Error('No product URLs found in e.l.f. sitemaps.');

    // 3) Group by category: fetch each product page, extract BreadcrumbList from JSON‑LD
    const catMap = new Map(); // key = breadcrumb string (e.g. "Eyes > Eyeliner") → { name, url, products }
    const total = productUrls.length;

    onProgress && onProgress({ phase: 'scanning', current: 0, total, foundSoFar: 0 });

    const BATCH = 5;
    for (let i = 0; i < productUrls.length; i += BATCH) {
      const batch = productUrls.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          try {
            const html = await fetchText(url);
            // Extract all JSON‑LD blocks
            const ldBlocks = [];
            const ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
            let ldM;
            while ((ldM = ldRe.exec(html))) {
              try { ldBlocks.push(JSON.parse(ldM[1])); } catch (e) { /* skip */ }
            }

            let name = '';
            const breadcrumbs = [];
            for (const block of ldBlocks) {
              const items = Array.isArray(block) ? block : [block];
              for (const item of items) {
                if (item['@type'] === 'Product' && !name) name = item.name || '';
                if (item['@type'] === 'BreadcrumbList') {
                  const elems = item.itemListElement || [];
                  for (const e of elems) {
                    if (e.name && e.name !== 'Home') breadcrumbs.push(e.name);
                  }
                  // Last breadcrumb is the product name — remove it
                  if (breadcrumbs.length) breadcrumbs.pop();
                }
              }
            }
            // Fallback name from <title>
            if (!name) {
              const titleM = html.match(/<title>([^<]*)<\/title>/);
              if (titleM) name = titleM[1].replace(/\s*[–—|-]\s*e\.l\.f\..*/i, '').trim();
            }
            const category = breadcrumbs.length ? breadcrumbs.join(' > ') : 'All Products';
            return { name: name || 'Unknown', url, category };
          } catch (e) {
            // Derive name from URL slug
            const slug = url.replace(/.*\/products\//, '').replace(/\/$/, '');
            const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            return { name, url, category: 'Uncategorized' };
          }
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const { name, url, category } = r.value;
          if (!catMap.has(category)) {
            // Build a category URL from the first breadcrumb item
            const parts = category.split(' > ');
            const firstPart = parts[0].toLowerCase().replace(/\s+/g, '-');
            const catUrl = 'https://www.elfcosmetics.com/collections/' + firstPart;
            catMap.set(category, { name: category, url: catUrl, products: [] });
          }
          catMap.get(category).products.push({ name, url });
        }
      }

      const foundSoFar = [...catMap.values()].reduce((s, c) => s + c.products.length, 0);
      onProgress && onProgress({ phase: 'scanning', current: Math.min(i + BATCH, total), total, foundSoFar });
    }

    const categories = [...catMap.values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    const totalProducts = categories.reduce((s, c) => s + c.products.length, 0);
    onProgress && onProgress({ phase: 'done', totalCats: categories.length, totalProducts });
    return { categories, totalProducts, totalCategories: categories.length };
  }

  // ── NYX Cosmetics (Salesforce Commerce Cloud — blocks server-side access) ──
  // NYX returns 403 for all server-side requests (sitemaps, category pages).
  // Discovery requires a browser rendering session — currently unsupported.
  async function discoverNyx(ctx) {
    // Try the sitemap first — if by some chance it works, proceed.
    try {
      const xmlText = await ctx.fetchText('https://www.nyxcosmetics.com/sitemap.xml');
      if (xmlText && xmlText.includes('<loc>')) {
        // Sitemap accessible — extract URLs and group
        const locs = [...xmlText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        const productUrls = locs.filter(u => u.includes('/lip/') || u.includes('/face/') || u.includes('/eyes/') || u.includes('/brows/'));
        const catMap = new Map();
        for (const url of productUrls) {
          // Derive category from URL path
          const path = new URL(url).pathname.replace(/\/+$/, '');
          const parts = path.split('/').filter(Boolean);
          const category = parts.length >= 2 ? parts[parts.length - 2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'All';
          const name = (parts[parts.length - 1] || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          if (!catMap.has(category)) catMap.set(category, { name: category, url: 'https://www.nyxcosmetics.com/' + parts[0] + '/', products: [] });
          catMap.get(category).products.push({ name, url });
        }
        const categories = [...catMap.values()].sort((a, b) => a.name.localeCompare(b.name));
        const totalProducts = categories.reduce((s, c) => s + c.products.length, 0);
        ctx.onProgress && ctx.onProgress({ phase: 'done', totalCats: categories.length, totalProducts });
        return { categories, totalProducts, totalCategories: categories.length };
      }
    } catch (e) {
      // Sitemap blocked — this is expected
    }

    // NYX blocks server-side access completely.
    // Provide categories the user can use for manual scraping.
    const categories = [
      { name: 'Lips', url: 'https://www.nyxcosmetics.com/lip/', products: [] },
      { name: 'Face', url: 'https://www.nyxcosmetics.com/face/', products: [] },
      { name: 'Eyes', url: 'https://www.nyxcosmetics.com/eyes/', products: [] },
      { name: 'Brows', url: 'https://www.nyxcosmetics.com/brows/', products: [] },
      { name: 'Brushes & Tools', url: 'https://www.nyxcosmetics.com/brushes-and-tools/', products: [] },
    ];
    const summary = 'NYX blocks automated access (Server 403). For product discovery, browse to any NYX product page, then use "Scrape This Page" to save individual products to the Bulk queue.';
    ctx.onProgress && ctx.onProgress({ phase: 'done', totalCats: 0, totalProducts: 0, summary });
    return { categories, totalProducts: 0, totalCategories: categories.length, summary, blocked: true };
  }

  async function discoverSeventeen(ctx) {
    const { fetchText, onProgress } = ctx;
    const sitemapUrl = 'https://seventeencosmetics.com/sitemap.xml';
    const xmlText = await fetchText(sitemapUrl);
    const locs = [...xmlText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

    // Split into categories and products
    const categoryUrls = [];
    const productUrls = [];
    for (const u of locs) {
      if (u.includes('/catalogue/category/')) categoryUrls.push(u);
      else if (u.includes('/catalogue/')) productUrls.push(u);
    }

    // Normalize to /en/ (site supports both /el/ and /en/)
    const toEn = u => u.replace(/\/el\//, '/en/');
    const enCategories = categoryUrls.map(toEn);
    const enProducts = productUrls.map(toEn);

    // Find leaf categories (deepest nesting). Strip _id suffixes from each
    // path segment so /make-up_1/ is recognized as the parent of /make-up/face_5/.
    function normalizedPath(url) {
      return url.replace(/\/+$/, '').split('/').map(s => s.replace(/_\d+$/, '')).join('/');
    }
    const leafCategories = enCategories.filter(cat =>
      !enCategories.some(other => other !== cat && normalizedPath(other).startsWith(normalizedPath(cat) + '/'))
    );

    // Category name from URL: /en/catalogue/category/make-up/eyes_7/ → Make-Up > Eyes
    function catName(url) {
      const segments = url.replace(/\/+$/, '').split('/catalogue/category/')[1].split('/');
      return segments.map(s => s.replace(/_\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).join(' > ');
    }

    const categories = [];
    const totalCats = leafCategories.length;
    let processedCats = 0;
    let totalProductsFound = 0;

    // Fetch each category page, extract product names + URLs
    for (const catUrl of leafCategories) {
      onProgress && onProgress({ phase: 'scanning', current: processedCats + 1, total: totalCats, catUrl, foundSoFar: totalProductsFound });
      try {
        const html = await fetchText(catUrl);
        // Extract product names + URLs from product-card title elements
        const seen = new Set();
        const products = [];
        const titleRe = /product-card__details__title[\s\S]*?<a[\s\S]*?href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = titleRe.exec(html))) {
          const href = m[1].replace(/\?vid=\d+.*/, '').replace(/#.*/, '');
          const name = m[2].replace(/\s+/g, ' ').trim();
          const fullUrl = href.startsWith('http') ? href : 'https://seventeencosmetics.com' + href;
          if (name && !seen.has(fullUrl)) {
            seen.add(fullUrl);
            products.push({ name, url: fullUrl });
          }
        }

        // Fallback: if no product cards found, extract all catalogue hrefs
        if (!products.length) {
          const links = new Set();
          for (const l of html.matchAll(/href="(\/en\/catalogue\/[^"]+)"/g)) {
            const u = (l[1] || '').replace(/\?vid=\d+.*/, '').replace(/#.*/, '');
            if (!u.includes('/category/') && !u.includes('/ranges/'))
              links.add(u.startsWith('http') ? u : 'https://seventeencosmetics.com' + u);
          }
          for (const u of links) products.push({ name: '', url: u });
        }

        totalProductsFound += products.length;
        categories.push({ name: catName(catUrl), url: catUrl, products });
      } catch (e) {
        categories.push({ name: catName(catUrl), url: catUrl, products: [], error: e.message });
      }
      processedCats++;
    }

    onProgress && onProgress({ phase: 'done', totalCats, totalProducts: totalProductsFound });
    return { categories, totalProducts: totalProductsFound, totalCategories: categories.length };
  }

  async function discoverMaybelline(ctx) {
    const { fetchText, onProgress } = ctx;
    const xmlText = await fetchText('https://www.maybelline.com/sitemap.xml');
    const locs = [...xmlText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

    onProgress && onProgress({ phase: 'scanning', current: 0, total: 1, catUrl: '', foundSoFar: 0 });

    // Category roots for Maybelline
    const catRoots = ['eye-makeup','face-makeup','lip-makeup','nail-makeup','accessories'];
    // Human-readable category names
    const catNames = {
      'eye-makeup': 'Eye Makeup', 'face-makeup': 'Face Makeup',
      'lip-makeup': 'Lip Makeup', 'nail-makeup': 'Nail Makeup',
      'accessories': 'Accessories'
    };
    const subcatNames = {
      'eyebrow-makeup': 'Eyebrow', 'eyeliner': 'Eyeliner', 'eyeshadow': 'Eyeshadow',
      'mascara': 'Mascara', 'foundation-makeup': 'Foundation', 'concealer': 'Concealer',
      'powder': 'Powder', 'blush-and-bronzer': 'Blush & Bronzer', 'contouring': 'Contouring',
      'primer': 'Primer', 'lipstick': 'Lipstick', 'lip-gloss': 'Lip Gloss',
      'lip-balm': 'Lip Balm', 'lip-liner': 'Lip Liner', 'nail-color': 'Nail Color',
      'brushes': 'Brushes', 'makeup-tools': 'Tools', 'removers': 'Removers'
    };

    // Group products by parent category
    const catMap = new Map(); // key: parentSubcat -> { name, url, products }

    for (const url of locs) {
      const path = (new URL(url)).pathname.replace(/\/+$/,'').replace(/^\//,'');
      const parts = path.split('/');
      const rootIdx = parts.findIndex(p => catRoots.includes(p));
      if (rootIdx < 0) continue;
      const depth = parts.length - rootIdx;
      if (depth < 3) continue;

      const last = parts[parts.length - 1];
      const wordCount = last.split('-').length;
      // Product heuristic: >2 words OR (>15 chars AND >=2 words)
      if (!(wordCount > 2 || (last.length > 15 && wordCount >= 2))) continue;

      const root = parts[rootIdx];
      const subcat = parts[rootIdx + 1] || root;
      const parentKey = root + '/' + subcat;
      const parentUrl = 'https://www.maybelline.com/' + root + '/' + subcat + '/';

      if (!catMap.has(parentKey)) {
        const rootName = catNames[root] || root.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        const subName = subcatNames[subcat] || subcat.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        catMap.set(parentKey, { name: rootName + ' > ' + subName, url: parentUrl, products: [] });
      }

      // Derive product name from slug
      const name = last.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      catMap.get(parentKey).products.push({ name, url });
    }

    const categories = [...catMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    const totalProducts = categories.reduce((s, c) => s + c.products.length, 0);

    onProgress && onProgress({ phase: 'done', totalCats: categories.length, totalProducts });
    return { categories, totalProducts, totalCategories: categories.length };
  }

  const DISCOVERERS = {
    seventeen: discoverSeventeen,
    maybelline: discoverMaybelline,
    elf: discoverElf,
    nyx: discoverNyx,
  };

  async function discoverAll(ctx) {
    const site = ctx.site || detectSite(ctx.url);
    const fn = DISCOVERERS[site];
    if (!fn) throw new Error('No bulk discovery for site: ' + (site || '(unknown)'));
    return await fn(ctx);
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  const SCRAPERS = {
    nyx: { variable: scrapeNyx, simple: scrapeNyxSimple },
    elf: { variable: scrapeElf, simple: scrapeElfSimple },
    huda: { variable: scrapeHuda, simple: scrapeHudaSimple },
    pastel: { variable: scrapePastel, simple: scrapePastelSimple },
    glowrecipe: { variable: scrapeGlowrecipe, simple: scrapeGlowrecipe },
    inglot: { variable: scrapeInglot, simple: scrapeInglotSimple },
    flormar: { variable: scrapeFlormar, simple: scrapeFlormarSimple },
    maybelline: { variable: scrapeMaybelline, simple: scrapeMaybelline },
    seventeen: { variable: scrapeSeventeen, simple: scrapeSeventeenSimple },
    isadora: { variable: scrapeIsadora, simple: scrapeIsadoraSimple },
    topface: { variable: scrapeTopface, simple: scrapeTopfaceSimple },
    lorealparis: { variable: scrapeLorealParis, simple: scrapeLorealParisSimple },
    vichy: { variable: scrapeVichy, simple: scrapeVichy },
    larocheposay: { variable: scrapeLarocheposay, simple: scrapeLarocheposay },
    urbancare: { variable: scrapeUrbancareSimple, simple: scrapeUrbancareSimple },
    bielenda: { variable: scrapeBielendaSimple, simple: scrapeBielendaSimple },
    cerave: { variable: scrapeCeraveSimple, simple: scrapeCeraveSimple },
    nars: { variable: scrapeNars, simple: scrapeNarsSimple },
    sephora: { variable: scrapeSephora, simple: scrapeSephoraSimple },
    radiant: { variable: scrapeRadiant, simple: scrapeRadiantSimple },
    misslyn: { variable: scrapeMisslyn, simple: scrapeMisslynSimple },
    essence: { variable: scrapeEssence, simple: scrapeEssenceSimple },
    charlottetilbury: { variable: scrapeCharlottetilbury, simple: scrapeCharlottetilburySimple },
    dior: { variable: scrapeDior, simple: scrapeDiorSimple },
    summerfridays: { variable: scrapeSummerfridays, simple: scrapeSummerfridaysSimple },
    character: { variable: scrapeCharacter, simple: scrapeCharacterSimple },
    makeover: { variable: scrapeMakeover, simple: scrapeMakeoverSimple },
  };

  // Detect site from a URL hostname.
  function detectSite(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '');
      const map = {
        'nyxcosmetics.com': 'nyx', 'elfcosmetics.com': 'elf', 'maybelline.com': 'maybelline', 'hudabeauty.com': 'huda',
        'flormar.com': 'flormar', 'lorealparisusa.com': 'lorealparis', 'vichy-me.com': 'vichy',
        'pastelarabia.com': 'pastel', 'laroche-posay.us': 'larocheposay', 'urbancare.ro': 'urbancare',
        'bielenda.pl': 'bielenda', 'sephora.com': 'sephora', 'cerave.com': 'cerave',
        'narscosmetics.com': 'nars', 'glowrecipe.com': 'glowrecipe',         'seventeencosmetics.com': 'seventeen',
        'inglotcosmetics.com': 'inglot', 'radiant-professional.com': 'radiant', 'misslyn.com': 'misslyn',
        'isadora.com': 'isadora',
        'topfaceofficial.com': 'topface',
        'essencemakeup.com': 'essence', 'charlottetilbury.com': 'charlottetilbury', 'dior.com': 'dior',
        'summerfridays.com': 'summerfridays', 'charactercosmetics.in': 'character',
        'makeoverparis.com': 'makeover',
      };
      for (const dom in map) if (h === dom || h.endsWith('.' + dom)) return map[dom];
    } catch (e) {}
    return '';
  }

  async function scrapeProduct(ctx) {
    const site = ctx.site || detectSite(ctx.url);
    const type = ctx.productType === 'simple' ? 'simple' : 'variable';
    const entry = SCRAPERS[site];
    if (!entry) throw new Error('No scraper for site: ' + (site || '(unknown)'));
    const fn = entry[type] || entry.variable;
    return await fn(ctx);
  }

  // Catalogue of brands the tool knows. `ready` = scraper implemented in the
  // extension; others are on the roadmap (server-only for now).
  const BRANDS = [
    { name: 'NYX Professional Makeup', domain: 'nyxcosmetics.com', key: 'nyx', discover: true, example: 'https://www.nyxcosmetics.com/lip/lip-gloss-pouch/USNYX_44.html' },
    { name: 'e.l.f. Cosmetics', domain: 'elfcosmetics.com', key: 'elf', discover: true, example: 'https://www.elfcosmetics.com/products/smoky-kohl-eyeliner?Color=Black+Velvet' },
    { name: 'Huda Beauty', domain: 'hudabeauty.com', key: 'huda', example: 'https://hudabeauty.com/en-jo/products/easy-blur-natural-airbrush-foundation-with-niacinamide-hb01166m?variant=50573350273302' },
    { name: 'Pastel', domain: 'pastelarabia.com', key: 'pastel', example: 'https://pastelarabia.com/collections/foundation/products/silky-dream-foundation' },
    { name: 'Glow Recipe', domain: 'glowrecipe.com', key: 'glowrecipe' },
    { name: 'Inglot', domain: 'inglotcosmetics.com', key: 'inglot' },
    { name: 'Maybelline', domain: 'maybelline.com', key: 'maybelline', discover: true, example: 'https://www.maybelline.com/face-makeup/foundation-makeup/fit-me-matte-poreless-foundation?variant=334' },
    { name: 'Flormar', domain: 'flormar.com', key: 'flormar', example: 'https://www.flormar.com/perfect-coverage-liquid-concealer--ivory-002/' },
    { name: "L'Oréal Paris", domain: 'lorealparisusa.com', key: 'lorealparis', example: 'https://www.lorealparisusa.com/makeup/face/concealer/true-match-radiant-serum-concealer' },
    { name: 'Vichy', domain: 'vichy-me.com', key: 'vichy' },
    { name: 'La Roche-Posay', domain: 'laroche-posay.us', key: 'larocheposay' },
    { name: 'Urban Care', domain: 'urbancare.ro', key: 'urbancare' },
    { name: 'Bielenda', domain: 'bielenda.pl', key: 'bielenda' },
    { name: 'Sephora', domain: 'sephora.com', key: 'sephora', example: 'https://www.sephora.com/product/tinted-moisturizer-oil-free-blurred-matte-spf-30-P515711?skuId=2854479&icid2=products%20grid:p515711:product' },
    { name: 'CeraVe', domain: 'cerave.com', key: 'cerave' },
    { name: 'NARS', domain: 'narscosmetics.com', key: 'nars', example: 'https://www.narscosmetics.com/USA/natural-matte-longwear-foundation/999NAC0000285.html?dwvar_999NAC0000285_color=4251155135&cgid=foundation' },
    { name: 'Seventeen Cosmetics', domain: 'seventeencosmetics.com', key: 'seventeen', discover: true, example: 'https://seventeencosmetics.com/en/catalogue/skin-perfect-ultra-coverage-waterproof-foundation_23/?vid=24#All' },
    { name: 'Radiant Professional', domain: 'radiant-professional.com', key: 'radiant', example: 'https://radiant-professional.com/en/catalogue/NATURAL_FIX_CONCEALER_670/' },
    { name: 'Misslyn Cosmetics', domain: 'misslyn.com', key: 'misslyn' },
    { name: 'essence makeup', domain: 'essencemakeup.com', key: 'essence', example: 'https://essencemakeup.com/collections/face/products/correct-conceal-under-eye-brightening-concealer' },
    { name: 'Charlotte Tilbury', domain: 'charlottetilbury.com', key: 'charlottetilbury', example: 'https://www.charlottetilbury.com/uk/product/airbrush-flawless-foundation-shade-1-cool?from_multi_product_card=true' },
    { name: 'Dior Makeup', domain: 'dior.com', key: 'dior', url: 'https://www.dior.com/en_int/beauty', example: 'https://www.dior.com/en_int/beauty/products/dior-forever-skin-correct-Y0326000.html' },
    { name: 'Summer Fridays', domain: 'summerfridays.com', key: 'summerfridays' },
    { name: 'Character Cosmetics', domain: 'charactercosmetics.in', key: 'character', example: 'https://charactercosmetics.in/products/character-hyaluronic-acid-high-coverage-foundation' },
    { name: 'IsaDora', domain: 'isadora.com', key: 'isadora', example: 'https://www.isadora.com/products/face/powder/the-no-compromise-matte-longwear-powder/60-neutral-porcelain' },
    { name: 'Topface', domain: 'topfaceofficial.com', key: 'topface', example: 'https://topfaceofficial.com/products/aqua-tint-lip-cheek' },
    { name: 'MakeOver', domain: 'makeoverparis.com', key: 'makeover', example: 'http://makeoverparis.com/en/products.asp?id1=1&id2=8&id3=32' },
  ].map(b => ({ ...b, ready: !!SCRAPERS[b.key] }));

  root.ProductScraper = { scrapeProduct, discoverAll, detectSite, decodeEntities, brands: BRANDS, DISCOVERERS };
})(typeof self !== 'undefined' ? self : this);
