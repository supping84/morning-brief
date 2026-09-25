// FRED (세인트루이스 연준, 무료, 키 필요): 연준 기준금리·미 국채 확정치·장단기 스프레드
// 발급: https://fred.stlouisfed.org/docs/api/api_key.html
// 주의: DGS 계열은 D+1 확정치. 실시간에 가까운 10년물은 markets.mjs의 ^TNX가 담당
import { fetchJson } from '../../common/util.mjs';

const SERIES = [
  ['DFF', '연준 실효금리(EFFR)'],
  ['DGS2', '美 2년물(확정)'],
  ['DGS10', '美 10년물(확정)'],
  ['T10Y2Y', '10Y-2Y 스프레드'],
  ['T10YIE', '10Y 기대인플레(BEI)'],
];

export async function fetchFred(apiKey) {
  if (!apiKey) throw new Error('FRED_API_KEY 없음 (건너뜀)');
  return Promise.all(
    SERIES.map(async ([id, label]) => {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=140`; // 6개월치 → 그래프용
      const j = await fetchJson(url);
      const obs = (j.observations || []).filter((o) => o.value !== '.'); // '.' = 결측
      if (!obs.length) return { label, error: 'no data' };
      const v = Number(obs[0].value);
      const pv = obs[1] ? Number(obs[1].value) : null;
      const asc = obs.slice().reverse();
      return { label, value: v, delta: pv == null ? null : v - pv, date: obs[0].date, history: { d: asc.map((o) => o.date), c: asc.map((o) => Number(o.value)) } };
    }),
  );
}
