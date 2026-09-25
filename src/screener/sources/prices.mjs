// Yahoo Finance: 종목코드 → .KS/.KQ 심볼 판별, 시총, 1년 일봉
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/**
 * 6자리 코드 배열 → { code: { symbol, marketCap, price, name } }
 * .KS 먼저 시도, 없으면 .KQ (코넥스·비상장은 둘 다 없어서 자연 탈락)
 */
export async function resolveSymbols(codes, { onProgress } = {}) {
  const out = {};
  const tryBatch = async (symbols) => {
    for (let i = 0; i < symbols.length; i += 150) {
      const chunk = symbols.slice(i, i + 150);
      let quotes = [];
      try { quotes = await yf.quote(chunk); }
      catch (e) { console.error(`  quote 배치 실패 (${chunk[0]}…): ${e.message.slice(0, 80)}`); continue; }
      for (const q of quotes) {
        if (q.regularMarketPrice == null) continue;
        const code = q.symbol.slice(0, 6);
        out[code] = { symbol: q.symbol, marketCap: q.marketCap ?? null, price: q.regularMarketPrice, name: q.shortName || q.longName || '' };
      }
      onProgress?.(Math.min(i + 150, symbols.length), symbols.length);
    }
  };
  await tryBatch(codes.map((c) => `${c}.KS`));
  const left = codes.filter((c) => !out[c]);
  await tryBatch(left.map((c) => `${c}.KQ`));
  return out;
}

/** 1년 일봉 [{date, close, high, low, volume}] */
export async function fetchDaily(symbol, days = 370) {
  const period1 = new Date(Date.now() - days * 86400000);
  const r = await yf.chart(symbol, { period1, interval: '1d' });
  return (r.quotes || [])
    .filter((q) => q.close != null)
    .map((q) => ({ date: q.date, open: q.open, close: q.close, high: q.high, low: q.low, volume: q.volume ?? 0 }));
}

/** 동시성 제한 map */
export async function pmap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try { results[i] = { ok: true, value: await fn(items[i], i) }; }
        catch (e) { results[i] = { ok: false, error: e.message }; }
      }
    }),
  );
  return results;
}
