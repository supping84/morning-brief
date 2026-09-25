// 한국수출입은행 환율 API (무료, 키 필요): 고시 매매기준율
// 발급: https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C
// 당일 환율은 오전 11시경 게시되므로 06:30 실행 시엔 "직전 영업일" 고시가 잡힘 (정상)
import { fetchJson, kstCompact, daysAgo } from '../../common/util.mjs';

const WANT = ['USD', 'JPY(100)', 'EUR', 'CNH', 'GBP'];

export async function fetchExim(apiKey) {
  if (!apiKey) throw new Error('EXIM_API_KEY 없음 (건너뜀)');

  // 주말/공휴일엔 빈 배열이 오므로 최대 7일 거슬러 올라감
  for (let back = 0; back < 7; back++) {
    const date = kstCompact(daysAgo(back));
    const url = `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${apiKey}&searchdate=${date}&data=AP01`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || rows.length === 0) continue;
    if (rows[0]?.result && rows[0].result !== 1) throw new Error(`수출입은행 result=${rows[0].result} (키/한도 확인)`);

    const byUnit = new Map(rows.map((r) => [r.cur_unit, r]));
    return {
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
      rates: WANT.filter((u) => byUnit.has(u)).map((u) => {
        const r = byUnit.get(u);
        const num = (s) => Number(String(s).replaceAll(',', ''));
        return { unit: u, name: r.cur_nm, base: num(r.deal_bas_r), ttb: num(r.ttb), tts: num(r.tts) };
      }),
    };
  }
  throw new Error('최근 7일 내 고시환율 없음');
}
