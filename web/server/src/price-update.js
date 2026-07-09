import { getMeta, setMeta } from './store.js';
import { pushPrice, pushPriceNow } from './shopify.js';

export const URL_SOURCES = new Set(['mbo', 'designer']);

// Cached — this was a remote DB read per pushed product; refreshed on save.
let _srcCache = { at: 0, val: null };

export async function getPriceUrlSource() {
  if (_srcCache.val && Date.now() - _srcCache.at < 30000) return _srcCache.val;
  const value = await getMeta('price_update_url_source', 'mbo');
  const val = URL_SOURCES.has(value) ? value : 'mbo';
  _srcCache = { at: Date.now(), val };
  return val;
}

export async function setPriceUrlSource(source) {
  if (!URL_SOURCES.has(source)) throw new Error('URL source must be mbo or designer');
  await setMeta('price_update_url_source', source);
  _srcCache = { at: Date.now(), val: source };
  return source;
}

export function resolvePriceUpdateUrl(row, source) {
  const mbo = String(row?.mbo_url || '').trim();
  const designer = String(row?.url || '').trim();
  const preferred = source === 'mbo' ? mbo : designer;
  const fallback = source === 'mbo' ? designer : mbo;
  return { url: preferred || fallback, used: preferred ? source :
    (fallback ? (source === 'mbo' ? 'designer' : 'mbo') : 'none') };
}

export async function pushRowPrice(row, price, { queued = true } = {}) {
  const requested = await getPriceUrlSource();
  const selected = resolvePriceUpdateUrl(row, requested);
  if (!selected.url) return {
    ok: false, status: 'no MBO or Designer URL available', requested, used: 'none',
  };
  const result = await (queued ? pushPrice : pushPriceNow)(selected.url, price);
  const label = selected.used === 'mbo' ? 'MBO URL' : 'Designer URL';
  return { ...result, status: result.status + ' · ' + label,
    requested, used: selected.used, source_url: selected.url };
}
