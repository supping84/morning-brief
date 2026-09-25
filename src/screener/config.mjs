// 스크리너 조건. 숫자만 바꾸면 됨
export const CONFIG = {
  // ── 1차: 재무 (DART, 하드 필터) ──
  profitYears: 3,            // 최근 N개 사업연도 연속 영업이익·당기순이익 > 0
  minOpMargin: 0.08,         // 영업이익률 (최근년도)
  maxDebtRatio: 1.5,         // 부채비율 = 부채총계/자본총계
  minRoe: 0.05,              // ROE = 당기순이익/자본총계

  // ── 2차: 시세 (Yahoo, 하드 필터) ──
  minMarketCap: 300e8,       // 시총 300억 이상 (원)
  maxMarketCap: 2e12,        // 시총 2조 이하 → "강소기업" 범위
  maxAnnVol: 0.40,           // 6개월 연율화 변동성 40% 이하
  maxRange6m: 0.45,          // 6개월 (고-저)/저 45% 이하 → 박스권
  maxAbsReturn6m: 0.25,      // 6개월 등락 ±25% 이내 → 추세 없이 낮게 유지
  minAvgTurnover: 1e8,       // 일평균 거래대금 1억 이상 (유동성 최소치)

  // ── 3차: 가점 (소프트, 정렬용) ──
  score: {
    fromHigh52w: -0.25,      // 52주 고점 대비 -25% 이하면 가점
    maxPbr: 1.2,
    maxPer: 12,
    goodOpMargin: 0.15,
    goodRoe: 0.10,
  },

  topN: 40,                  // 정성 평가로 넘길 후보 수
  financialsTtlDays: 7,      // DART 재무 캐시 유효기간
  chartConcurrency: 3,       // Yahoo 동시 요청 수
  docChars: 9000,            // 사업보고서 발췌 길이 (LLM 입력)
};
