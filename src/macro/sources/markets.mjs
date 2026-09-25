// Yahoo Finance (키 불필요): 미장 지수, 미 국채금리, 달러/환율(역외), 원자재, 국내 지수, 아시아/유럽 참고
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// 섹션별 심볼: [심볼, 라벨, 배율(선택)]. 라벨은 브리핑에 그대로 찍힘
export const GROUPS = {
  us: [
    ['^GSPC', 'S&P500'],
    ['^IXIC', '나스닥'],
    ['^DJI', '다우'],
    ['^SOX', '필라델피아 반도체'],
    ['^RUT', '러셀2000'],
    ['^VIX', 'VIX'],
  ],
  usRates: [
    ['^IRX', '美 3개월물'],
    ['^FVX', '美 5년물'],
    ['^TNX', '美 10년물'],
    ['^TYX', '美 30년물'],
  ],
  fx: [
    ['DX-Y.NYB', '달러인덱스'],
    ['KRW=X', 'USD/KRW (역외)'],
    ['JPYKRW=X', 'JPY/KRW (100엔)', 100], // Yahoo 는 1엔당 원 → ×100 으로 표시
    ['JPY=X', 'USD/JPY'],
    ['EURUSD=X', 'EUR/USD'],
    ['CNY=X', 'USD/CNY'],
  ],
  commodities: [
    ['CL=F', 'WTI'],
    ['BZ=F', '브렌트'],
    ['NG=F', '천연가스'],
    ['GC=F', '금'],
    ['SI=F', '은'],
    ['HG=F', '구리'],
    ['ZC=F', '옥수수'],
    ['ZW=F', '밀'],
    ['ZS=F', '대두'],
  ],
  kr: [
    ['^KS11', '코스피'],
    ['^KQ11', '코스닥'],
  ],
  global: [
    ['^N225', '니케이225'],
    ['^HSI', '항셍'],
    ['000001.SS', '상해종합'],
    ['^STOXX50E', '유로스톡스50'],
    ['^FTSE', 'FTSE100'],
    ['BTC-USD', '비트코인'],
  ],
};

/** 전 심볼 6개월 일봉 종가 → { symbol: { d: ['YYYY-MM-DD'…], c: [close…] } } (핸드폰 페이지의 지표별 그래프용) */
const SCALE = Object.fromEntries(Object.values(GROUPS).flat().map(([s, , k]) => [s, k ?? 1]));

export async function fetchHistory(days = 190, concurrency = 4) {
  const symbols = Object.keys(SCALE);
  const period1 = new Date(Date.now() - days * 86400000);
  const out = {};
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < symbols.length) {
      const s = symbols[i++];
      try {
        const r = await yf.chart(s, { period1, interval: '1d' });
        const q = (r.quotes || []).filter((x) => x.close != null);
        out[s] = { d: q.map((x) => x.date.toISOString().slice(0, 10)), c: q.map((x) => Number((x.close * SCALE[s]).toFixed(4))) };
      } catch (e) { console.error(`  [history ${s}] ${e.message.slice(0, 60)}`); }
    }
  }));
  return out;
}

export async function fetchMarkets() {
  const symbols = Object.values(GROUPS).flat().map(([s]) => s);
  const quotes = await yf.quote(symbols);
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

  // 배치 조회에서 간혹 빠지는 심볼은 개별 재조회
  for (const s of symbols.filter((s) => !bySymbol.has(s))) {
    try { const q = await yf.quote(s); if (q) bySymbol.set(s, q); } catch { /* 그대로 missing 처리 */ }
  }

  const out = {};
  for (const [group, list] of Object.entries(GROUPS)) {
    out[group] = list.map(([symbol, label, k = 1]) => {
      const q = bySymbol.get(symbol);
      if (!q) return { symbol, label, missing: true };
      return {
        symbol,
        label,
        price: q.regularMarketPrice * k,
        change: q.regularMarketChange * k,
        changePct: q.regularMarketChangePercent,
        prevClose: q.regularMarketPreviousClose * k,
        time: q.regularMarketTime,
        state: q.marketState, // REGULAR / CLOSED / PRE / POST
      };
    });
  }
  return out;
}
