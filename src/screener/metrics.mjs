// 정량 지표 계산 + 필터 + 점수
import { CONFIG as C } from './config.mjs';

const TRADING_6M = 126;

/** 재무 필터. 통과하면 지표 객체, 아니면 null */
export function financialMetrics(f) {
  if (!f?.opIncome || !f?.netIncome || !f?.equity) return null;
  const n = C.profitYears;
  const op = f.opIncome.slice(0, n);
  const ni = f.netIncome.slice(0, n);
  if (op.length < n || ni.length < n) return null;
  if (!op.every((v) => v != null && v > 0) || !ni.every((v) => v != null && v > 0)) return null;

  const revenue = f.revenue?.[0] ?? null;
  const opMargin = revenue ? f.opIncome[0] / revenue : null;
  const debtRatio = f.equity > 0 && f.liabilities != null ? f.liabilities / f.equity : null;
  const roe = f.equity > 0 ? f.netIncome[0] / f.equity : null;

  if (opMargin == null || opMargin < C.minOpMargin) return null;
  if (debtRatio == null || debtRatio > C.maxDebtRatio) return null;
  if (roe == null || roe < C.minRoe) return null;

  return { revenue, opIncome: f.opIncome, netIncome: f.netIncome, opMargin, debtRatio, roe, equity: f.equity, fy: f.fy, fsDiv: f.fsDiv };
}

/** 시세 지표. bars = 1년 일봉 (오름차순) */
export function priceMetrics(bars, marketCap) {
  if (!bars || bars.length < TRADING_6M * 0.8) return null;
  const last6m = bars.slice(-TRADING_6M);
  const closes = last6m.map((b) => b.close);

  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1));
  const annVol = sd * Math.sqrt(252);

  const hi6 = Math.max(...last6m.map((b) => b.high ?? b.close));
  const lo6 = Math.min(...last6m.map((b) => b.low ?? b.close));
  const range6m = (hi6 - lo6) / lo6;
  const ret6m = closes.at(-1) / closes[0] - 1;

  const hi52 = Math.max(...bars.map((b) => b.high ?? b.close));
  const fromHigh52w = closes.at(-1) / hi52 - 1;

  const avgTurnover = last6m.reduce((a, b) => a + b.close * b.volume, 0) / last6m.length;

  return { price: closes.at(-1), marketCap, annVol, range6m, ret6m, fromHigh52w, avgTurnover, bars: bars.length };
}

export function passPriceFilter(p) {
  if (!p) return false;
  if (p.marketCap == null || p.marketCap < C.minMarketCap || p.marketCap > C.maxMarketCap) return false;
  if (p.annVol > C.maxAnnVol) return false;
  if (p.range6m > C.maxRange6m) return false;
  if (Math.abs(p.ret6m) > C.maxAbsReturn6m) return false;
  if (p.avgTurnover < C.minAvgTurnover) return false;
  return true;
}

/** 소프트 점수 (높을수록 우선). 각 항목 0~2점 */
export function score(fm, pm) {
  const S = C.score;
  const pbr = pm.marketCap / fm.equity;
  const per = fm.netIncome[0] > 0 ? pm.marketCap / fm.netIncome[0] : null;
  let s = 0;
  const why = [];
  if (pm.fromHigh52w <= S.fromHigh52w) { s += 2; why.push(`52주고점 대비 ${(pm.fromHigh52w * 100).toFixed(0)}%`); }
  if (pbr <= S.maxPbr) { s += 2; why.push(`PBR ${pbr.toFixed(2)}`); }
  if (per != null && per <= S.maxPer) { s += 1.5; why.push(`PER ${per.toFixed(1)}`); }
  if (fm.opMargin >= S.goodOpMargin) { s += 1.5; why.push(`영업이익률 ${(fm.opMargin * 100).toFixed(0)}%`); }
  if (fm.roe >= S.goodRoe) { s += 1; why.push(`ROE ${(fm.roe * 100).toFixed(0)}%`); }
  // 변동성 낮을수록 가점 (0~1)
  s += Math.max(0, 1 - pm.annVol / C.maxAnnVol);
  // 이익 성장 일관성: 3년 순이익이 감소 추세가 아니면 가점
  if (fm.netIncome[0] >= fm.netIncome[2]) { s += 0.5; why.push('3년 순이익 유지/성장'); }
  return { score: Number(s.toFixed(2)), pbr, per, why };
}
