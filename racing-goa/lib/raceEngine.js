// ============================================================
// RACING GOA - 경마 시뮬레이션 엔진
// 원본 GAMBLE_GOA HTML의 경마 로직을 서버(Node.js)에서 그대로 실행하기 위해
// DOM에 의존하지 않는 순수 로직만 포팅했습니다.
// 서버가 유일한 "정답"을 계산하고, 모든 접속자에게 동일한 결과를 중계합니다.
// ============================================================

const PREP_SECONDS = 60;   // 베팅 준비 시간
const RESULT_SECONDS = 30; // 결과 발표 시간
const TICK_MS = 900;       // 시뮬레이션 틱 간격
const TARGET_TICKS = { sprint: 18, mile: 24, middle: 32, long: 44 };
const FINISH_PCT = 96;

const VENUES = [
  { name: "서울",   trackTypes: ["dirt", "turf"], mod: { SPEED: 0.02 },                 desc: "직선주로 강함, 코너 보통, 완만한 오르막" },
  { name: "교토",   trackTypes: ["turf", "dirt"],  mod: { CORNERING: 0.05, STAMINA: 0.03 }, desc: "기복이 있는 코스, 코너링과 지구력이 중요" },
  { name: "도쿄",   trackTypes: ["turf"],          mod: { SPRINT: 0.06 },                desc: "매우 긴 직선주로, 후반 스퍼트에 유리" },
  { name: "파리",   trackTypes: ["turf"],          mod: { STAMINA: 0.05, CORNERING: 0.04 }, desc: "잔디 적성이 중요하고 코너가 많음" },
  { name: "뉴마켓", trackTypes: ["turf"],          mod: { SPEED: 0.03 },                 desc: "평탄하고 빠른 잔디 코스" },
  { name: "두바이", trackTypes: ["dirt"],          mod: { SPEED: 0.05, POWER: 0.03 },    desc: "더트 비중이 높고 고속 주행에 유리" },
  { name: "홍콩",   trackTypes: ["turf", "dirt"],  mod: { CONSISTENCY: 0.03 },           desc: "타이트한 코너와 좁은 직선주로" }
];

const RACE_TITLES = {
  "서울": "코리아컵", "교토": "기쿠카쇼", "도쿄": "재팬컵", "파리": "개선문상",
  "뉴마켓": "2000기니", "두바이": "두바이 월드컵", "홍콩": "홍콩컵"
};

// 실제 존재하는 그레이드(등급) 경주들을 그대로 반영
const RACE_GRADES = {
  "서울": "GI", "교토": "GI", "도쿄": "GI", "파리": "GI",
  "뉴마켓": "GI", "두바이": "GI", "홍콩": "GI"
};

const VENUE_COURSE_SHAPE = {
  "서울": "oval", "교토": "technical", "도쿄": "long_straight", "파리": "technical",
  "뉴마켓": "long_straight", "두바이": "oval", "홍콩": "technical"
};

const WEATHERS = [
  { name: "맑음", emoji: "☀️", variance: 0.05, cornerRisk: 0,    frontPenalty: 0,    staminaDrain: 0 },
  { name: "흐림", emoji: "☁️", variance: 0.06, cornerRisk: 0,    frontPenalty: 0,    staminaDrain: 0 },
  { name: "비",   emoji: "🌧️", variance: 0.09, cornerRisk: 0.10, frontPenalty: 0,    staminaDrain: 0.03 },
  { name: "폭우", emoji: "⛈️", variance: 0.14, cornerRisk: 0.18, frontPenalty: 0,    staminaDrain: 0.08 },
  { name: "강풍", emoji: "🌬️", variance: 0.09, cornerRisk: 0.04, frontPenalty: 0.08, staminaDrain: 0.02 },
  { name: "안개", emoji: "🌫️", variance: 0.16, cornerRisk: 0.05, frontPenalty: 0,    staminaDrain: 0 }
];

const DISTANCES = [1200, 1400, 1600, 2000, 2400, 3000];

const STAT_WEIGHTS = {
  sprint: { SPEED: 0.35, START: 0.25, ACCELERATION: 0.25, STAMINA: 0.05, POWER: 0.05, CORNERING: 0.03, SPRINT: 0.02, CONSISTENCY: 0 },
  mile:   { SPEED: 0.25, ACCELERATION: 0.20, STAMINA: 0.20, START: 0.10, CORNERING: 0.10, SPRINT: 0.10, POWER: 0.03, CONSISTENCY: 0.02 },
  middle: { SPEED: 0.20, STAMINA: 0.25, POWER: 0.15, CORNERING: 0.10, SPRINT: 0.15, ACCELERATION: 0.10, START: 0.03, CONSISTENCY: 0.02 },
  long:   { STAMINA: 0.35, POWER: 0.20, CONSISTENCY: 0.15, CORNERING: 0.10, SPEED: 0.10, SPRINT: 0.05, ACCELERATION: 0.03, START: 0.02 }
};

const STYLE_PHASE = {
  "도주형": { early: 1.04, mid: 0.96, late: 0.80, staminaDrainMult: 1.20 },
  "선행형": { early: 1.08, mid: 1.04, late: 0.97, staminaDrainMult: 1.06 },
  "선입형": { early: 0.96, mid: 1.03, late: 1.08, staminaDrainMult: 0.97 },
  "추입형": { early: 0.90, mid: 0.97, late: 1.26, staminaDrainMult: 0.86 }
};

const HORSES = [
  { id: 1, name: "토카이 테이오", gender: "수컷", age: 4, origin: "일본", style: "선행형",
    stats: { SPEED: 82, ACCELERATION: 80, STAMINA: 80, POWER: 84, CORNERING: 76, START: 78, SPRINT: 74, CONSISTENCY: 72 },
    weakness: "더트 적성이 낮아 더트 경기에서는 고전함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "D", middle: "A", long: "B" },
    title: { name: "불량 트랙 전문가" }, special: "mud_specialist",
    recentForm: [4, 3, 5, 1, 2] },
  { id: 2, name: "골드 쉽", gender: "수컷", age: 5, origin: "일본", style: "추입형",
    stats: { SPEED: 74, ACCELERATION: 70, STAMINA: 84, POWER: 82, CORNERING: 72, START: 62, SPRINT: 66, CONSISTENCY: 38 },
    weakness: "경기마다 기복이 매우 심함 — 안정성이 전 출전마 중 최하위, 더트도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "C", middle: "A", long: "A" },
    title: { name: "괴짜 명마" }, special: "erratic_genius",
    recentForm: [1, 6, 1, 5, 2] },
  { id: 3, name: "스페셜 위크", gender: "수컷", age: 4, origin: "일본", style: "선행형",
    stats: { SPEED: 80, ACCELERATION: 77, STAMINA: 82, POWER: 73, CORNERING: 75, START: 70, SPRINT: 79, CONSISTENCY: 77 },
    weakness: "더트 적성이 낮음, 단거리도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "C", middle: "A", long: "A" },
    title: { name: "정상의 지배자" }, special: "distance_versatile",
    recentForm: [1, 2, 1, 3, 2] },
  { id: 4, name: "듀란달", gender: "수컷", age: 5, origin: "일본", style: "추입형",
    stats: { SPEED: 82, ACCELERATION: 84, STAMINA: 55, POWER: 62, CORNERING: 84, START: 70, SPRINT: 85, CONSISTENCY: 78 },
    weakness: "장거리 적성이 낮음 — 스태미나가 매우 낮아 중장거리에서 급격히 무너짐",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "A", mile: "A", middle: "D", long: "D" },
    title: { name: "천마의 일격" }, special: "sprint_specialist",
    recentForm: [2, 1, 3, 1, 4] },
  { id: 5, name: "메지로 맥퀸", gender: "수컷", age: 6, origin: "일본", style: "선행형",
    stats: { SPEED: 74, ACCELERATION: 68, STAMINA: 87, POWER: 75, CORNERING: 78, START: 65, SPRINT: 60, CONSISTENCY: 73 },
    weakness: "단거리 적성이 낮음 — 단거리 스피드 경쟁에서 확실히 밀림",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "D", middle: "A", long: "A" },
    title: { name: "장거리의 귀공자" }, special: "long_distance_master",
    recentForm: [1, 1, 2, 1, 3] },
  { id: 6, name: "맨해튼 카페", gender: "수컷", age: 4, origin: "일본", style: "선입형",
    stats: { SPEED: 81, ACCELERATION: 83, STAMINA: 84, POWER: 72, CORNERING: 79, START: 65, SPRINT: 86, CONSISTENCY: 76 },
    weakness: "더트 적성이 낮음, 단거리·마일도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "D", middle: "B", long: "A" },
    title: { name: "질풍의 마무리" }, special: "long_closer",
    recentForm: [3, 1, 4, 2, 1] },
  { id: 7, name: "메이쇼 도토", gender: "수컷", age: 5, origin: "일본", style: "선행형",
    stats: { SPEED: 80, ACCELERATION: 78, STAMINA: 78, POWER: 75, CORNERING: 76, START: 80, SPRINT: 68, CONSISTENCY: 76 },
    weakness: "더트 적성이 낮음, 단거리·마일도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "D", middle: "A", long: "A" },
    title: { name: "불굴의 도전자" }, special: null,
    recentForm: [2, 4, 1, 3, 5] },
  { id: 8, name: "오구리 캡", gender: "수컷", age: 6, origin: "일본", style: "선입형",
    stats: { SPEED: 82, ACCELERATION: 81, STAMINA: 80, POWER: 78, CORNERING: 78, START: 70, SPRINT: 82, CONSISTENCY: 76 },
    weakness: "단거리에서는 다소 약한 편",
    turfGrade: "A", dirtGrade: "B",
    distanceGrades: { sprint: "D", mile: "A", middle: "A", long: "B" },
    title: { name: "회색의 전설" }, special: "legend_closer",
    recentForm: [1, 2, 1, 4, 1] },
  { id: 9, name: "아그네스 타키온", gender: "수컷", age: 3, origin: "일본", style: "선행형",
    stats: { SPEED: 90, ACCELERATION: 88, STAMINA: 68, POWER: 70, CORNERING: 76, START: 84, SPRINT: 74, CONSISTENCY: 62 },
    weakness: "마일 적성이 낮은 편, 더트도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "D", middle: "A", long: "B" },
    title: { name: "질주하는 천재" }, special: "genius_speed",
    recentForm: [1, 3, 1, 6, 2] },
  { id: 10, name: "티엠 오페라 오", gender: "수컷", age: 5, origin: "일본", style: "선입형",
    stats: { SPEED: 85, ACCELERATION: 82, STAMINA: 78, POWER: 76, CORNERING: 82, START: 66, SPRINT: 88, CONSISTENCY: 74 },
    weakness: "단거리 적성이 낮음, 마일도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "D", mile: "D", middle: "A", long: "A" },
    title: { name: "도쿄의 괴물" }, special: "tokyo_boost",
    recentForm: [1, 4, 6, 2, 3] },
  { id: 11, name: "미스터 파크", gender: "수컷", age: 4, origin: "한국", style: "선행형",
    stats: { SPEED: 82, ACCELERATION: 78, STAMINA: 80, POWER: 72, CORNERING: 77, START: 80, SPRINT: 60, CONSISTENCY: 75 },
    weakness: "결정적인 한 방(막판 스퍼트)이 약함 — SPRINT 능력치가 전 출전마 중 최하위권, 더트도 약함",
    turfGrade: "B", dirtGrade: "D",
    distanceGrades: { sprint: "C", mile: "A", middle: "S", long: "D" },
    title: { name: "무너지지 않는 철마" }, special: "condition_resist",
    recentForm: [3, 2, 1, 4, 5] },
  { id: 12, name: "하이페리", gender: "암컷", age: 4, origin: "영국", style: "선입형",
    stats: { SPEED: 78, ACCELERATION: 75, STAMINA: 85, POWER: 72, CORNERING: 80, START: 70, SPRINT: 78, CONSISTENCY: 75 },
    weakness: "맑은 날씨에는 평범한 성적, 더트와 장거리에는 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "B", mile: "S", middle: "A", long: "D" },
    title: { name: "폭풍을 가르는 자" }, special: "rain_boost",
    recentForm: [5, 6, 2, 5, 1] },
  { id: 13, name: "실버 크라운", gender: "수컷", age: 3, origin: "영국", style: "도주형",
    stats: { SPEED: 82, ACCELERATION: 78, STAMINA: 67, POWER: 68, CORNERING: 70, START: 84, SPRINT: 71, CONSISTENCY: 73 },
    weakness: "장거리에서는 후반에 급격히 무너짐, 더트도 약함",
    turfGrade: "B", dirtGrade: "D",
    distanceGrades: { sprint: "S", mile: "A", middle: "B", long: "D" },
    title: { name: "초반의 섬광" }, special: "early_burst",
    recentForm: [6, 1, 4, 3, 6] },
  { id: 14, name: "네이티브 싱 캡", gender: "암컷", age: 5, origin: "영국", style: "추입형",
    stats: { SPEED: 80, ACCELERATION: 77, STAMINA: 82, POWER: 73, CORNERING: 78, START: 65, SPRINT: 90, CONSISTENCY: 80 },
    weakness: "선두를 잡는 능력이 약함, 더트도 약함",
    turfGrade: "A", dirtGrade: "D",
    distanceGrades: { sprint: "B", mile: "A", middle: "S", long: "D" },
    title: { name: "마지막 200m의 악마" }, special: "final_sprint",
    recentForm: [2, 5, 3, 6, 4] }
];

function aptitudeMod(grade) {
  switch (grade) { case "S": return 0.15; case "A": return 0.08; case "B": return 0.03; case "C": return 0; case "D": return -0.10; default: return 0; }
}
function getDistanceCategory(d) {
  if (d <= 1400) return "sprint";
  if (d <= 1600) return "mile";
  if (d <= 2400) return "middle";
  return "long";
}
function distanceCategoryLabel(cat) {
  return { sprint: "단거리", mile: "마일", middle: "중거리", long: "장거리" }[cat];
}
function getTrackCondition(trackType, weather) {
  if (trackType === "turf") {
    if (weather.name === "폭우") return "매우 무거움";
    if (weather.name === "비") return "무거움";
    if (weather.name === "흐림") return "약간 무거움";
    return "양호";
  }
  if (weather.name === "폭우") return "진흙";
  if (weather.name === "비") return "젖음";
  if (weather.name === "흐림") return "보통";
  return "건조";
}
function conditionMod(cond) {
  if (cond >= 90) return 1.04;
  if (cond >= 75) return 1.0;
  if (cond >= 55) return 0.98;
  if (cond >= 35) return 0.95;
  return 0.90;
}
function conditionStars(cond) {
  if (cond >= 90) return "★★★★★";
  if (cond >= 75) return "★★★★☆";
  if (cond >= 55) return "★★★☆☆";
  if (cond >= 35) return "★★☆☆☆";
  return "★☆☆☆☆";
}

function applyTitleEffects(h, race, s, positionPct) {
  switch (h.special) {
    case "tokyo_boost":
      if (race.venue.name === "도쿄") { for (const k in s) s[k] *= 1.14; }
      break;
    case "rain_boost":
      if (race.weather.name === "비" || race.weather.name === "폭우") s.ACCELERATION *= 1.22;
      break;
    case "early_burst":
      s.START *= 1.10; s.ACCELERATION *= 1.08;
      break;
    case "final_sprint":
      if (positionPct >= 80) s.SPRINT *= 1.55;
      break;
    case "mud_specialist":
      if (["무거움", "매우 무거움", "젖음", "진흙"].includes(race.trackCondition)) s.POWER *= 1.35;
      break;
    case "distance_versatile":
      if (race.distanceCategory === "middle" || race.distanceCategory === "long") { for (const k in s) s[k] *= 1.05; }
      break;
    case "sprint_specialist":
      if (race.distanceCategory === "sprint") { s.SPRINT *= 1.18; s.ACCELERATION *= 1.08; }
      break;
    case "long_distance_master":
      if (race.distanceCategory === "long") { for (const k in s) s[k] *= 1.04; }
      break;
    case "long_closer":
      if (race.distanceCategory === "long" && positionPct >= 75) { s.SPRINT *= 1.35; }
      break;
    case "legend_closer":
      if (positionPct >= 70) { s.SPRINT *= 1.28; s.ACCELERATION *= 1.12; }
      break;
    case "genius_speed":
      if (race.distanceCategory === "middle") { s.SPEED *= 1.16; s.ACCELERATION *= 1.13; }
      break;
    default: break;
  }
}

function buildAdjustedStats(h, race, positionPct) {
  const s = { ...h.stats };
  for (const k in (race.venue.mod || {})) s[k] = (s[k] || 0) * (1 + race.venue.mod[k]);
  if (race.trackType === "turf") { const m = aptitudeMod(h.turfGrade); s.SPEED *= 1 + m; s.STAMINA *= 1 + m * 0.6; }
  else { const m = aptitudeMod(h.dirtGrade); s.POWER *= 1 + m; s.ACCELERATION *= 1 + m * 0.6; }
  // 실제 거리 적성 등급(단/마일/중/장) 기반 보정 — 적성 격차가 너무 크게 벌어지지 않도록 0.4배로 완화 적용
  const distGrade = (h.distanceGrades && h.distanceGrades[race.distanceCategory]) || "C";
  const dm = aptitudeMod(distGrade) * 0.4;
  for (const k in s) s[k] *= (1 + dm);
  applyTitleEffects(h, race, s, positionPct);
  let condMod = conditionMod(h.condition);
  if (h.special === "condition_resist" && condMod < 1) condMod = 1 - (1 - condMod) * 0.65;
  for (const k in s) s[k] *= condMod;
  return s;
}

function computeBaselineScore(h, race) {
  const s = buildAdjustedStats(h, race, 50);
  const weights = STAT_WEIGHTS[race.distanceCategory];
  let composite = 0;
  for (const stat in weights) composite += (s[stat] || 0) * weights[stat];
  return composite;
}

function computeOddsFromScores(fieldHorses, scores) {
  const maxScore = Math.max(...scores);
  const temp = Math.max(1, maxScore * 0.22);
  const exps = scores.map(sc => Math.exp((sc - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  return fieldHorses.map((h, i) => {
    const prob = exps[i] / sumExp;
    const odds = Math.max(1.1, Math.round((0.85 / prob) * 10) / 10);
    return { id: h.id, prob, odds };
  });
}

function computeTickIncrement(h, race, phase, positionPct, staminaLeft, luck) {
  const s = buildAdjustedStats(h, race, positionPct);
  if (race.weather.cornerRisk > 0 && Math.random() < race.weather.cornerRisk * (1 - s.CORNERING / 150)) s.SPEED *= 0.85;
  const styleMult = STYLE_PHASE[h.style][phase];
  const weights = STAT_WEIGHTS[race.distanceCategory];
  let composite = 0;
  for (const stat in weights) composite += (s[stat] || 0) * weights[stat];
  composite *= styleMult;
  if (staminaLeft < 30) composite *= 0.85;
  if (staminaLeft < 15) composite *= 0.7;
  const tickVarBase = 0.03 + (race.weather.variance || 0) * 0.28;
  let tickVariance = tickVarBase * (1 - s.CONSISTENCY / 100 * 0.4);
  if (h.special === "erratic_genius") tickVariance *= 2.4; // 골드쉽: 매 구간마다 기복이 심함
  const tickJitter = 1 + (Math.random() * 2 - 1) * tickVariance;
  return composite * luck * tickJitter;
}

function rollRaceLuck(fieldHorses, race) {
  const luck = {};
  fieldHorses.forEach(h => {
    const s = buildAdjustedStats(h, race, 50);
    const varBase = 0.13 + (race.weather.variance || 0) * 0.7;
    let variance = varBase * (1 - s.CONSISTENCY / 100 * 0.45);
    let raw;
    if (h.special === "erratic_genius") {
      // 골드쉽: 변동폭 자체는 여전히 크지만, "대박"(좋은 쪽)이 나올 확률은 줄이고
      // 평타(0에 가까운 값)가 좀 더 자주 나오도록 좋은 쪽만 완만하게 압축한다.
      // 나쁜 쪽(사고)은 그대로 균등분포 유지.
      variance *= 3.6;
      if (Math.random() < 0.5) {
        raw = -Math.random(); // 나쁜 쪽: 그대로
      } else {
        raw = Math.pow(Math.random(), 1.6); // 좋은 쪽: 대박 확률 감소, 평타 쪽으로 압축
      }
    } else {
      raw = Math.random() * 2 - 1;
    }
    luck[h.id] = 1 + raw * variance;
  });
  return luck;
}

function updateStamina(h, staminaLeft, phase, race) {
  const drainMult = STYLE_PHASE[h.style].staminaDrainMult;
  let drain = (2.2 - h.stats.STAMINA / 60) * drainMult;
  drain += (race.weather.staminaDrain || 0) * 8;
  if (phase === "early") drain *= 1.15;

  // 거리 적성이 좋을수록 그 거리에서 체력을 덜 소모함(자기 거리를 잘 아는 말),
  // 적성이 나쁘면 체력이 더 빨리 떨어져서 후반에 눈에 띄게 처짐
  const distGrade = (h.distanceGrades && h.distanceGrades[race.distanceCategory]) || "C";
  const distDrainMod = { S: 0.75, A: 0.85, B: 0.95, C: 1.0, D: 1.25 }[distGrade] || 1.0;
  drain *= distDrainMod;

  return Math.max(0, staminaLeft - Math.max(0.3, drain));
}

function buildWinReasons(h, currentRace) {
  const reasons = [];
  const grade = currentRace.trackType === "turf" ? h.turfGrade : h.dirtGrade;
  if (["S", "A"].includes(grade)) reasons.push(`${currentRace.trackType === "turf" ? "잔디" : "더트"} 적성 ${grade}`);
  const distGrade = (h.distanceGrades && h.distanceGrades[currentRace.distanceCategory]) || "C";
  if (["S", "A"].includes(distGrade)) reasons.push(`${distanceCategoryLabel(currentRace.distanceCategory)} 적성 ${distGrade}`);
  if (h.condition >= 80) reasons.push(`좋은 컨디션 (${conditionStars(h.condition)})`);
  if (h.special === "tokyo_boost" && currentRace.venue.name === "도쿄") reasons.push(`「${h.title.name}」 발동 (도쿄 경기장)`);
  if (h.special === "rain_boost" && (currentRace.weather.name === "비" || currentRace.weather.name === "폭우")) reasons.push(`「${h.title.name}」 발동 (${currentRace.weather.name})`);
  if (h.special === "mud_specialist" && ["무거움", "매우 무거움", "젖음", "진흙"].includes(currentRace.trackCondition)) reasons.push(`「${h.title.name}」 발동 (트랙: ${currentRace.trackCondition})`);
  if (h.special === "final_sprint") reasons.push(`「${h.title.name}」로 막판 스퍼트 성공`);
  if (h.special === "early_burst") reasons.push(`「${h.title.name}」로 빠른 스타트`);
  if (reasons.length === 0) reasons.push("전 구간 안정적인 페이스 유지");
  return reasons.join(" · ");
}
function buildLoseReasons(h, currentRace) {
  const reasons = [];
  const grade = currentRace.trackType === "turf" ? h.turfGrade : h.dirtGrade;
  if (grade === "D") reasons.push(`${currentRace.trackType === "turf" ? "잔디" : "더트"} 적성 D로 불리`);
  const distGrade = (h.distanceGrades && h.distanceGrades[currentRace.distanceCategory]) || "C";
  if (distGrade === "D") reasons.push(`${distanceCategoryLabel(currentRace.distanceCategory)} 적성 D로 불리`);
  if (h.condition < 55) reasons.push(`컨디션 저조 (${conditionStars(h.condition)})`);
  reasons.push(h.weakness);
  return reasons.join(" · ");
}

module.exports = {
  PREP_SECONDS, RESULT_SECONDS, TICK_MS, TARGET_TICKS, FINISH_PCT,
  VENUES, RACE_TITLES, RACE_GRADES, VENUE_COURSE_SHAPE, WEATHERS, DISTANCES,
  STAT_WEIGHTS, STYLE_PHASE, HORSES,
  aptitudeMod, getDistanceCategory, distanceCategoryLabel, getTrackCondition,
  conditionMod, conditionStars, applyTitleEffects, buildAdjustedStats,
  computeBaselineScore, computeOddsFromScores, computeTickIncrement,
  rollRaceLuck, updateStamina, buildWinReasons, buildLoseReasons
};
