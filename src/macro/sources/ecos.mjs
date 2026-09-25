// 한국은행 ECOS Open API (무료, 키 필요): 기준금리 + 국내 시장금리
// 발급: https://ecos.bok.or.kr/api/#/ → 인증키 신청 (하루 1만 건)
import { fetchJson, kstCompact, daysAgo } from '../../common/util.mjs';

// [통계표코드, 항목코드, 라벨]. 코드는 ECOS "통계코드검색"에서 확인/변경 가능
const SERIES = [
  ['722Y001', '0101000', '한은 기준금리'],
  ['817Y002', '010101000', '콜금리(1일)'],
  ['817Y002', '010502000', 'CD(91일)'],
  ['817Y002', '010200000', '국고채 3년'],
  ['817Y002', '010210000', '국고채 10년'],
  ['817Y002', '010300000', '회사채 3년(AA-)'],
];

export async function fetchEcos(apiKey) {
  if (!apiKey) throw new Error('ECOS_API_KEY 없음 (건너뜀)');
  const end = kstCompact();
  const start = kstCompact(daysAgo(190)); // 6개월치 → 그래프용

  const results = await Promise.all(
    SERIES.map(async ([stat, item, label]) => {
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/200/${stat}/D/${start}/${end}/${item}`;
      const j = await fetchJson(url);
      const rows = j?.StatisticSearch?.row;
      if (!rows?.length) {
        const msg = j?.RESULT?.MESSAGE || 'no rows';
        return { label, error: msg };
      }
      const last = rows.at(-1);
      const prev = rows.at(-2);
      const v = Number(last.DATA_VALUE);
      const pv = prev ? Number(prev.DATA_VALUE) : null;
      return {
        label,
        value: v,
        delta: pv == null ? null : v - pv,
        date: `${last.TIME.slice(0, 4)}-${last.TIME.slice(4, 6)}-${last.TIME.slice(6)}`,
        history: { d: rows.map((r) => `${r.TIME.slice(0, 4)}-${r.TIME.slice(4, 6)}-${r.TIME.slice(6)}`), c: rows.map((r) => Number(r.DATA_VALUE)) },
      };
    }),
  );
  return results;
}
