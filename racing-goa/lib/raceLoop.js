// ============================================================
// RACING GOA - 경마 사이클 루프 (서버가 유일한 진행자)
// PREP(베팅) -> RACING(중계) -> RESULT(정산) 을 무한 반복하며
// 모든 접속자에게 동일한 소켓 이벤트를 broadcast 한다.
// ============================================================

const engine = require("./raceEngine");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 서버 전역에서 단 하나만 존재하는 "지금 진행 중인 경마" 상태
const state = {
  cyclePhase: "PREP",       // PREP | RACING | RESULT
  raceNumber: 0,
  currentRace: null,        // {venue, trackType, distance, distanceCategory, weather, trackCondition, refScore, oddsList}
  fieldHorses: [],          // 이번 경기 출전마 6마리 (condition 포함)
  laneAssignment: {},       // horseId -> 1~6
  horsePositions: {},
  staminaMap: {},
  finishTick: {},
  bets: new Map(),          // token -> { nickname, horseId, amount }
  phaseEndsAt: 0            // 이 시각(ms epoch)에 현재 phase가 끝남 (클라이언트 카운트다운용)
};

function getCurrentRankingIds() {
  return [...state.fieldHorses].sort((a, b) => {
    const fa = state.finishTick[a.id], fb = state.finishTick[b.id];
    const aFin = fa !== undefined, bFin = fb !== undefined;
    if (aFin && bFin) return fa - fb;
    if (aFin) return -1;
    if (bFin) return 1;
    return state.horsePositions[b.id] - state.horsePositions[a.id];
  }).map(h => h.id);
}

// 이번 경기 조건(트랙/거리)에 적성이 잘 맞는 말일수록 더 자주 출전하도록
// 가중치 기반으로 6마리를 뽑는다 (완전 랜덤은 아니지만, 안 맞는 말도 가끔은 나옴)
function selectRaceField(trackType, distanceCategory) {
  const pool = engine.HORSES.map(h => {
    const trackGrade = trackType === "turf" ? h.turfGrade : h.dirtGrade;
    const distGrade = (h.distanceGrades && h.distanceGrades[distanceCategory]) || "C";
    const fit = engine.aptitudeMod(trackGrade) + engine.aptitudeMod(distGrade);
    const weight = Math.exp(fit * 7); // 적성이 잘 맞을수록 더 자주 뽑히되, 너무 쏠리지 않게 완만하게
    return { horse: h, weight };
  });

  const chosen = [];
  const remaining = [...pool];
  const pickCount = Math.min(6, remaining.length);
  for (let i = 0; i < pickCount; i++) {
    const totalWeight = remaining.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < remaining.length - 1; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    chosen.push(remaining[idx].horse);
    remaining.splice(idx, 1);
  }

  state.fieldHorses = chosen;
  state.laneAssignment = {};
  state.fieldHorses.forEach((h, i) => { state.laneAssignment[h.id] = i + 1; });
}

function publicRaceSnapshot() {
  // 새로 접속한 클라이언트에게 즉시 보내줄 현재 경마 상태 스냅샷
  return {
    cyclePhase: state.cyclePhase,
    raceNumber: state.raceNumber,
    currentRace: state.currentRace,
    fieldHorses: state.fieldHorses,
    laneAssignment: state.laneAssignment,
    horsePositions: state.horsePositions,
    finishTick: state.finishTick,
    phaseEndsAt: state.phaseEndsAt
  };
}

function betsSnapshotArray() {
  return [...state.bets.entries()].map(([token, b]) => ({ token, nickname: b.nickname, horseId: b.horseId, amount: b.amount }));
}

// ---- 베팅 처리 (PREP 단계에서만 가능, 소켓 핸들러에서 호출) ----
async function placeBet(store, token, nickname, horseId, amount) {
  if (state.cyclePhase !== "PREP") return { ok: false, error: "지금은 베팅할 수 없습니다 (마감됨)." };
  if (!state.fieldHorses.find(h => h.id === horseId)) return { ok: false, error: "잘못된 말 번호입니다." };
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount < 10) return { ok: false, error: "최소 베팅 금액은 $10입니다." };

  const user = await store.getUserByToken(token);
  if (!user) return { ok: false, error: "로그인 정보를 찾을 수 없습니다." };

  const prev = state.bets.get(token);
  const refund = prev ? prev.amount : 0;
  const available = user.money + refund;
  if (amount > available) return { ok: false, error: "소지금이 부족합니다." };

  const delta = refund - amount; // 이전 베팅 환불하고 새 베팅만큼 차감
  const updated = await store.incMoney(token, delta);
  state.bets.set(token, { nickname, horseId, amount });
  // 서버가 경주 도중 죽어도 환불할 수 있도록 매번 베팅 내역을 저장해둔다
  await store.savePendingBets(state.raceNumber, betsSnapshotArray());
  return { ok: true, money: updated.money, horseId, amount };
}

async function cancelBet(store, token) {
  if (state.cyclePhase !== "PREP") return { ok: false, error: "지금은 취소할 수 없습니다." };
  const prev = state.bets.get(token);
  if (!prev) return { ok: false, error: "베팅 내역이 없습니다." };
  const updated = await store.incMoney(token, prev.amount);
  state.bets.delete(token);
  await store.savePendingBets(state.raceNumber, betsSnapshotArray());
  return { ok: true, money: updated.money };
}

// 서버 기동 시 1회 호출: 이전 세션에서 정산되지 못한 채 남은 베팅이 있으면 전액 환불한다
async function recoverOrphanedBets(store, io, onlineUsers) {
  const pending = await store.getPendingBets();
  if (!pending || !pending.bets || pending.bets.length === 0) return;
  console.log(`[raceLoop] 정산되지 않은 이전 베팅 ${pending.bets.length}건 발견, 전액 환불합니다.`);
  for (const bet of pending.bets) {
    const updated = await store.incMoney(bet.token, bet.amount);
    if (!updated) continue;
    const info = onlineUsers.get(bet.token);
    const message = `⚠️ 서버 업데이트로 진행 중이던 경기가 초기화되어, 베팅했던 $${bet.amount.toLocaleString()}를 환불해드렸습니다.`;
    if (info) io.to(info.socketId).emit("race:payout", { rank: null, refunded: true, amount: bet.amount, payout: bet.amount, message, money: updated.money });
  }
  await store.clearPendingBets();
}

// ---- 메인 루프 ----
async function run(io, store, onlineUsers, chatHistory, chatMax) {
  const emitToToken = (token, event, payload) => {
    const info = onlineUsers.get(token);
    if (info) io.to(info.socketId).emit(event, payload);
  };

  while (true) {
    // ================= PREP =================
    state.cyclePhase = "PREP";
    state.raceNumber++;
    state.bets = new Map();

    // 경기 조건(경기장/트랙/거리/날씨)을 먼저 정하고, 그 조건에 맞는 말이
    // 더 자주 뽑히도록 출전마를 선발한다.
    const venue = engine.VENUES[Math.floor(Math.random() * engine.VENUES.length)];
    const trackType = venue.trackTypes[Math.floor(Math.random() * venue.trackTypes.length)];
    const distance = engine.DISTANCES[Math.floor(Math.random() * engine.DISTANCES.length)];
    const distanceCategory = engine.getDistanceCategory(distance);
    const weather = engine.WEATHERS[Math.floor(Math.random() * engine.WEATHERS.length)];
    const trackCondition = engine.getTrackCondition(trackType, weather);

    selectRaceField(trackType, distanceCategory);
    state.fieldHorses.forEach(h => { h.condition = Math.max(15, Math.min(100, Math.round(70 + (Math.random() * 44 - 22)))); });

    state.currentRace = { venue, trackType, distance, distanceCategory, weather, trackCondition };
    const scores = state.fieldHorses.map(h => engine.computeBaselineScore(h, state.currentRace));
    state.currentRace.refScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    state.currentRace.oddsList = engine.computeOddsFromScores(state.fieldHorses, scores);

    state.horsePositions = {}; state.staminaMap = {}; state.finishTick = {};
    state.fieldHorses.forEach(h => { state.horsePositions[h.id] = 0; state.staminaMap[h.id] = 100; });

    state.phaseEndsAt = Date.now() + engine.PREP_SECONDS * 1000;
    io.emit("race:prep", publicRaceSnapshot());

    await sleep(engine.PREP_SECONDS * 1000);

    // ================= RACING =================
    state.cyclePhase = "RACING";
    const bettorsByHorse = {};
    state.fieldHorses.forEach(h => { bettorsByHorse[h.id] = 0; });
    for (const bet of state.bets.values()) bettorsByHorse[bet.horseId] = (bettorsByHorse[bet.horseId] || 0) + 1;

    const grade = engine.RACE_GRADES[state.currentRace.venue.name] || "GI";
    const raceTitle = engine.RACE_TITLES[state.currentRace.venue.name] || "그랑프리";
    io.emit("race:banner", {
      raceNumber: state.raceNumber,
      raceTitle,
      grade,
      venueName: state.currentRace.venue.name,
      trackType: state.currentRace.trackType,
      distance: state.currentRace.distance,
      bettorsByHorse
    });
    await sleep(3200);

    const targetTicks = engine.TARGET_TICKS[state.currentRace.distanceCategory];
    let ticks = 0;
    const raceLuck = engine.rollRaceLuck(state.fieldHorses, state.currentRace);

    while (!state.fieldHorses.every(h => state.horsePositions[h.id] >= engine.FINISH_PCT) && ticks < targetTicks * 2.2) {
      ticks++;
      const phase = ticks < targetTicks * 0.3 ? "early" : (ticks < targetTicks * 0.75 ? "mid" : "late");
      const leaderId = getCurrentRankingIds()[0];

      state.fieldHorses.forEach(h => {
        if (state.horsePositions[h.id] >= engine.FINISH_PCT) return;
        let raw = engine.computeTickIncrement(h, state.currentRace, phase, state.horsePositions[h.id], state.staminaMap[h.id], raceLuck[h.id]);
        if (state.currentRace.weather.frontPenalty > 0 && h.id === leaderId) raw *= (1 - state.currentRace.weather.frontPenalty);
        const inc = Math.max(0.3, (raw / state.currentRace.refScore) * (100 / targetTicks));
        const beforePos = state.horsePositions[h.id];
        state.horsePositions[h.id] = beforePos + inc;
        state.staminaMap[h.id] = engine.updateStamina(h, state.staminaMap[h.id], phase, state.currentRace);

        if (state.horsePositions[h.id] >= engine.FINISH_PCT && state.finishTick[h.id] === undefined) {
          const overshoot = (engine.FINISH_PCT - beforePos) / inc;
          state.finishTick[h.id] = ticks - 1 + Math.max(0, Math.min(1, overshoot));
        }
      });

      const rankingIds = getCurrentRankingIds();
      io.emit("race:tick", {
        ticks,
        horsePositions: state.horsePositions,
        leaderId: rankingIds[0],
        rankingIds
      });

      await sleep(engine.TICK_MS);
    }

    // ================= RESULT =================
    state.cyclePhase = "RESULT";
    const finalRanking = getCurrentRankingIds();
    const winnerId = finalRanking[0];
    const winnerHorse = state.fieldHorses.find(h => h.id === winnerId);

    // 마지막 틱에서 캡에 걸려 못 끝낸 말이 있어도, 결과 화면에서는 등수 순서대로
    // 전원이 결승선을 넘은 모습으로 정렬해서 보여준다 (시각적 어긋남 방지)
    finalRanking.forEach((id, idx) => {
      state.horsePositions[id] = Math.max(0, 100 - idx * 0.9);
    });
    io.emit("race:tick", {
      ticks: -1,
      horsePositions: state.horsePositions,
      leaderId: winnerId,
      rankingIds: finalRanking
    });

    finalRanking.forEach((id, idx) => {
      const h = engine.HORSES.find(x => x.id === id);
      h.recentForm = [idx + 1, ...h.recentForm].slice(0, 5);
    });

    state.phaseEndsAt = Date.now() + engine.RESULT_SECONDS * 1000;

    io.emit("race:result", {
      raceNumber: state.raceNumber,
      finalRanking,
      winnerId,
      horsePositions: state.horsePositions,
      laneAssignment: state.laneAssignment,
      oddsList: state.currentRace.oddsList,
      winReasons: engine.buildWinReasons(winnerHorse, state.currentRace),
      phaseEndsAt: state.phaseEndsAt
    });

    // 베팅한 유저별로 개별 정산 (오프라인이어도 store에는 반영됨)
    const publicResults = []; // 채팅에 공개할 적중/낙첨 결과 (등수 순으로 정렬해서 나중에 broadcast)
    for (const [token, bet] of state.bets.entries()) {
      const betHorse = state.fieldHorses.find(h => h.id === bet.horseId);
      const myRank = finalRanking.indexOf(bet.horseId) + 1;
      const oddsEntry = state.currentRace.oddsList.find(o => o.id === bet.horseId);
      const baseOdds = oddsEntry ? oddsEntry.odds : 2;
      const user = await store.getUserByToken(token);
      const haruRose = user ? user.haruRose : false;

      let payout = 0;
      let message = "";
      if (myRank === 1) {
        payout = Math.round(bet.amount * baseOdds);
        message = `🏆 적중! ${state.laneAssignment[bet.horseId]}번 ${betHorse.name} 우승! $${payout.toLocaleString()} 획득! (${baseOdds}배)`;
      } else if (myRank === 2) {
        const fullWinAmount = bet.amount * baseOdds;
        const placeMult = haruRose ? 1 : 0.3;
        payout = Math.round(fullWinAmount * placeMult);
        message = haruRose
          ? `🥈 2위 입상! ${state.laneAssignment[bet.horseId]}번 ${betHorse.name} $${payout.toLocaleString()} 획득! (🌹 누군가의 장미 효과로 페널티 없이 전액 지급)`
          : `🥈 2위 입상! ${state.laneAssignment[bet.horseId]}번 ${betHorse.name} $${payout.toLocaleString()} 획득! (배당×0.3)`;
      } else if (myRank === 3) {
        const fullWinAmount = bet.amount * baseOdds;
        payout = Math.round(fullWinAmount * 0.1);
        message = `🥉 3위 입상! ${state.laneAssignment[bet.horseId]}번 ${betHorse.name} $${payout.toLocaleString()} 획득! (배당×0.1)`;
      } else {
        message = `낙첨. ${state.laneAssignment[bet.horseId]}번 ${betHorse.name}은 ${myRank}위. 우승마는 ${state.laneAssignment[winnerId]}번 ${winnerHorse.name}.`;
      }

      let updatedUser = user;
      if (payout > 0) updatedUser = await store.incMoney(token, payout);

      emitToToken(token, "race:payout", {
        rank: myRank,
        horseId: bet.horseId,
        amount: bet.amount,
        payout,
        message,
        money: updatedUser ? updatedUser.money : null
      });

      // 채팅에 공개로 띄울 결과 (적중/낙첨 + 손익 금액)
      const net = payout - bet.amount;
      const nickname = bet.nickname || "???";
      const laneNum = state.laneAssignment[bet.horseId];
      let publicText;
      if (myRank === 1) {
        publicText = `🏆 ${nickname}님 ${laneNum}번 ${betHorse.name} 우승 적중! +$${payout.toLocaleString()} (순이익 $${net.toLocaleString()})`;
      } else if (myRank === 2 || myRank === 3) {
        publicText = `🎖️ ${nickname}님 ${laneNum}번 ${betHorse.name} ${myRank}위 입상! +$${payout.toLocaleString()} (순이익 $${net.toLocaleString()})`;
      } else {
        publicText = `💸 ${nickname}님 ${laneNum}번 ${betHorse.name} 낙첨... -$${bet.amount.toLocaleString()}`;
      }
      publicResults.push({ rank: myRank, kind: payout > 0 ? "win" : "lose", text: publicText });
    }

    // 적중자 먼저, 낙첨자 나중 순서로 채팅에 공개 (1등 맞춘 사람이 제일 먼저 보이게)
    publicResults.sort((a, b) => a.rank - b.rank);
    publicResults.forEach(r => {
      const payload = { kind: r.kind, text: r.text };
      io.emit("chat:result", payload);
      if (chatHistory) {
        chatHistory.push({ result: true, kind: r.kind, text: r.text, ts: Date.now() });
        if (chatMax && chatHistory.length > chatMax) chatHistory.shift();
      }
    });

    // 이번 경기 정산이 전부 끝났으니, 서버 재시작 시 환불 대상이 아니도록 기록을 지운다
    await store.clearPendingBets();

    await sleep(engine.RESULT_SECONDS * 1000);
  }
}

module.exports = { state, run, placeBet, cancelBet, publicRaceSnapshot, recoverOrphanedBets };
