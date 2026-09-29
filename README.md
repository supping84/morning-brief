# morning-brief

매일 자동으로 오는 개인용 투자 브리핑. **텔레그램 봇**이 주 채널이고, 핸드폰 웹페이지는 보조.

- 📱 페이지: <개인 페이지 주소> (본인 Claude 로그인 필요)
- 💬 텔레그램: 06:30 전체 브리핑 / 09:30 · 12:30 · 15:30 지표 업데이트

```
src/
  common/     util, notify(텔레그램 전송)
  macro/      거시지표 수집 — 미장·금리·환율·원자재·국내지수·헤드라인
  screener/   종목 스크리너 — 코스피·코스닥 전종목 정량 필터 + 사업보고서·공시·뉴스 수집
  app/        build.mjs — 위 결과를 합쳐 out/app/index.html (핸드폰 페이지)
  telegram.mjs           — 텔레그램 메시지 조립·발송
run.ps1          작업 스케줄러 진입점 (full / quick)
install-task.ps1 작업 스케줄러 4개 등록
```

## 실행 구조

| 누가 | 언제 (KST) | 무엇을 | PC 꺼져도? |
|---|---|---|---|
| **GitHub Actions** | 06:15 | 지표 + 스크리너 + **텔레그램 전체 브리핑** | ✅ |
| | 09:15 · 12:15 · 15:15 | 지표 + **텔레그램 지표 업데이트** | ✅ |
| **Claude 앱 예약 작업** | 06:40 | 오늘의 요약 · 종목 정성평가 작성 → 페이지 게시 → git push | 앱 켜져 있을 때만 |

- GitHub cron 은 10~30분 밀릴 수 있어 목표 시각보다 15분 앞당겨 잡았습니다 (06:15 → 보통 06:20~06:45 도착)
- 요약·정성평가는 LLM이 필요해서 앱 쪽 담당. 앱이 꺼져 있으면 텔레그램은 **가장 최근 요약·프로필**을 날짜와 함께 쓰고 지표·종목은 그날 것으로 나갑니다
- 앱이 쓴 요약·프로필은 5단계에서 git push 되어 다음 클라우드 실행이 이어받습니다
- 사용량: full ~2.5분 + quick ~45초 × 3 = 월 약 150분 (private repo 무료 한도 2000분)

## 설치

```
npm install
copy .env.example .env      # DART 키(스크리너) + 텔레그램 봇 토큰
```

**GitHub Actions** — 저장소 Secrets 에 `.env` 와 같은 키를 넣습니다:
```bash
gh secret set DART_API_KEY        # 그 외 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, APP_URL
gh workflow run brief.yml -f mode=quick   # 수동 테스트
gh run watch                               # 진행 확인
```

**PC 작업 스케줄러** (클라우드 대신 PC 에서 돌리고 싶을 때만):
```
.\install-task.ps1          # 4개 등록 (절전 중이면 깨움)
.\install-task.ps1 -Remove  # 해제
```

**텔레그램 봇 만들기**
1. 텔레그램에서 `@BotFather` → `/newbot` → 이름 정하면 토큰을 줌 → `.env`의 `TELEGRAM_BOT_TOKEN`
2. 만든 봇과 대화 시작(아무 말이나 전송)
3. `@userinfobot` 에게 `/start` → 내 숫자 id → `.env`의 `TELEGRAM_CHAT_ID`

**수동 실행 / 테스트**
```
.\run.ps1 -Mode quick                 # 지표 + 텔레그램
.\run.ps1 -Mode full                  # 전체
npm run macro / screener / app        # 단계별
node src/telegram.mjs full            # 발송만
Start-ScheduledTask MorningBrief-0930 # 스케줄러로 테스트
```
로그: `out/run.log`

## 데이터 소스

| 섹션 | 소스 | 키 |
|---|---|---|
| 미장·국채금리·환율·원자재·국내지수·글로벌 | Yahoo Finance | 불필요 |
| 헤드라인 | RSS: 연합인포맥스·한경·연합뉴스 | 불필요 (매경은 봇 차단 403) |
| 고시환율 | 한국수출입은행 | 무료 키 |
| 국내 금리 확정치 | 한국은행 ECOS | 무료 키 |
| 미 금리 확정치 | FRED | 무료 키 |
| 헤드라인 보강 | 네이버 뉴스 검색 | 무료 키 |
| 재무·사업보고서·공시 | 금융감독원 DART | **무료 키 (스크리너 필수)** |
| 종목 뉴스 | Google News RSS | 불필요 |

소스 하나가 실패해도 나머지는 그대로 나갑니다.

## 스크리너 흐름

```
DART 상장사 전체 (~3,900)  → 주요계정 100사/콜, 주 1회 캐시(data/)
 ▼ 1차 재무   3년 연속 영업이익·순이익>0, 영업이익률≥8%, 부채비율≤150%, ROE≥5%
 ▼ 시총       300억 ~ 2조
 ▼ 2차 시세   6M 연율변동성≤40%, 고저폭≤45%, 등락 ±25% 이내, 일평균 거래대금≥1억
 ▼ 점수·정렬  52주 고점대비 하락, PBR·PER 저평가, 이익률·ROE, 저변동, 이익 유지
 ▼ 수집       사업보고서 "사업의 내용" 발췌 + 최근 공시 + 뉴스
 ▼ 정성평가   기술 해자·사업모델·강소기업 적합성·리스크 (앱 예약 작업)
```

기준값은 [src/screener/config.mjs](src/screener/config.mjs) 한 곳에서 조정. 실행 로그에 단계별 통과 수가 찍힙니다.

## 주의

- 개인 용도 기준. 배포·공개 서비스로 넓힐 땐 회사 컴플라이언스(투자권유·정보제공) 확인
- 뉴스 본문 재게시 없음 (제목·링크만), 사업보고서 발췌는 로컬 분석용
