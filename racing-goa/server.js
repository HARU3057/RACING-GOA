// ============================================================
// RACING GOA - 메인 서버
// ============================================================

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const store = require("./lib/store");
const raceLoop = require("./lib/raceLoop");

const WORKER_PRICE = 500;
const WORKER_MAX = 5;
const WORKER_INTERVAL_MS = 8000;
const HARU_ROSE_PRICE = 30000;

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// token -> { socketId, nickname }
const onlineUsers = new Map();
// socket.id -> token
const socketToToken = new Map();

const chatHistory = []; // 최근 채팅 메시지 (메모리, 최대 50개)
const CHAT_MAX = 50;

function publicUser(u) {
  if (!u) return null;
  return { nickname: u.nickname, money: u.money, haruRose: u.haruRose, workerCount: u.workerCount };
}

function isNicknameValid(nickname) {
  if (typeof nickname !== "string") return false;
  const trimmed = nickname.trim();
  return trimmed.length >= 1 && trimmed.length <= 12 && !/[<>]/.test(trimmed);
}

io.on("connection", (socket) => {
  let currentToken = null;

  socket.emit("chat:history", chatHistory);
  socket.emit("race:snapshot", raceLoop.publicRaceSnapshot());

  socket.on("auth:nickname", async (data) => {
    try {
      const nickname = (data && data.nickname || "").trim();
      if (!isNicknameValid(nickname)) {
        socket.emit("auth:error", { message: "닉네임은 1~12자, 특수문자(<,>) 제외로 입력해주세요." });
        return;
      }
      const existing = await store.getUserByNickname(nickname);
      if (existing) {
        socket.emit("auth:error", { message: "이미 사용 중인 닉네임입니다. 계정이 있다면 복구 코드로 로그인해주세요." });
        return;
      }
      const user = await store.createUser(nickname);
      currentToken = user.token;
      socketToToken.set(socket.id, user.token);
      onlineUsers.set(user.token, { socketId: socket.id, nickname: user.nickname });
      socket.emit("auth:ok", { token: user.token, user: publicUser(user) });
      io.emit("chat:system", { text: `${user.nickname}님이 입장했습니다.` });
    } catch (e) {
      console.error(e);
      socket.emit("auth:error", { message: "서버 오류로 로그인에 실패했습니다." });
    }
  });

  socket.on("auth:token", async (data) => {
    try {
      const token = data && data.token;
      const user = await store.getUserByToken(token);
      if (!user) {
        socket.emit("auth:error", { message: "복구 코드가 올바르지 않습니다." });
        return;
      }
      currentToken = user.token;
      socketToToken.set(socket.id, user.token);
      onlineUsers.set(user.token, { socketId: socket.id, nickname: user.nickname });
      socket.emit("auth:ok", { token: user.token, user: publicUser(user) });

      // 재접속 시 현재 진행 중인 경마에 이미 베팅해둔 게 있다면 알려준다
      const myBet = raceLoop.state.bets.get(user.token);
      if (myBet) socket.emit("race:myBet", myBet);

      io.emit("chat:system", { text: `${user.nickname}님이 접속했습니다.` });
    } catch (e) {
      console.error(e);
      socket.emit("auth:error", { message: "서버 오류로 로그인에 실패했습니다." });
    }
  });

  socket.on("chat:send", (data) => {
    if (!currentToken) return;
    const info = onlineUsers.get(currentToken);
    if (!info) return;
    const text = ((data && data.text) || "").toString().slice(0, 300).trim();
    if (!text) return;
    const msg = { nickname: info.nickname, text, ts: Date.now() };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_MAX) chatHistory.shift();
    io.emit("chat:message", msg);
  });

  socket.on("race:bet", async (data, cb) => {
    if (!currentToken) return cb && cb({ ok: false, error: "로그인이 필요합니다." });
    const info = onlineUsers.get(currentToken);
    const result = await raceLoop.placeBet(store, currentToken, info.nickname, data && data.horseId, data && data.amount);
    if (result.ok) {
      io.emit("race:betPlaced", { horseId: result.horseId }); // 다른 유저들에게 베팅 현황 살짝 노출(누가인지는 비공개)
    }
    cb && cb(result);
  });

  socket.on("race:cancelBet", async (data, cb) => {
    if (!currentToken) return cb && cb({ ok: false, error: "로그인이 필요합니다." });
    const result = await raceLoop.cancelBet(store, currentToken);
    cb && cb(result);
  });

  socket.on("trash:search", async (data, cb) => {
    if (!currentToken) return cb && cb({ ok: false, error: "로그인이 필요합니다." });
    let gain = 0, message = "", type = "trash";
    const rand = Math.random() * 100;
    if (rand < 88) {
      message = "쓰레기밖에 나오지 않았습니다... (+$0)";
    } else if (rand < 98) {
      gain = 1;
      message = "찌그러진 1달러 지폐 발견! (+$1)";
      type = "money";
    } else {
      gain = 10;
      message = "럭키! 구석에서 10달러 지폐를 찾았습니다! (+$10)";
      type = "win";
    }
    let updated = await store.getUserByToken(currentToken);
    if (gain > 0) updated = await store.incMoney(currentToken, gain);
    cb && cb({ ok: true, gain, message, type, money: updated.money });
  });

  socket.on("shop:buyWorker", async (data, cb) => {
    if (!currentToken) return cb && cb({ ok: false, error: "로그인이 필요합니다." });
    const user = await store.getUserByToken(currentToken);
    if (!user) return cb && cb({ ok: false, error: "계정 정보를 찾을 수 없습니다." });
    if (user.workerCount >= WORKER_MAX) return cb && cb({ ok: false, error: "이미 정원이 가득 찼습니다." });
    if (user.money < WORKER_PRICE) return cb && cb({ ok: false, error: "돈이 부족합니다." });
    await store.incMoney(currentToken, -WORKER_PRICE);
    const updated = await store.updateUser(currentToken, { workerCount: user.workerCount + 1 });
    cb && cb({ ok: true, user: publicUser(updated) });
  });

  socket.on("shop:buyRose", async (data, cb) => {
    if (!currentToken) return cb && cb({ ok: false, error: "로그인이 필요합니다." });
    const user = await store.getUserByToken(currentToken);
    if (!user) return cb && cb({ ok: false, error: "계정 정보를 찾을 수 없습니다." });
    if (user.haruRose) return cb && cb({ ok: false, error: "이미 보유 중입니다." });
    if (user.money < HARU_ROSE_PRICE) return cb && cb({ ok: false, error: "돈이 부족합니다." });
    await store.incMoney(currentToken, -HARU_ROSE_PRICE);
    const updated = await store.updateUser(currentToken, { haruRose: true });
    cb && cb({ ok: true, user: publicUser(updated) });
  });

  socket.on("me:refresh", async (data, cb) => {
    if (!currentToken) return cb && cb({ ok: false });
    const user = await store.getUserByToken(currentToken);
    cb && cb({ ok: true, user: publicUser(user) });
  });

  socket.on("disconnect", () => {
    const token = socketToToken.get(socket.id);
    socketToToken.delete(socket.id);
    if (token) {
      const info = onlineUsers.get(token);
      if (info && info.socketId === socket.id) {
        onlineUsers.delete(token);
        if (info.nickname) io.emit("chat:system", { text: `${info.nickname}님이 퇴장했습니다.` });
      }
    }
  });
});

// ---- 알바생(인력사무소) 자동 수익: 8초마다 워커를 고용한 모든 유저에게 적용 ----
setInterval(async () => {
  try {
    const users = await store.getAllUsersWithWorkers();
    for (const u of users) {
      let total = 0;
      for (let i = 0; i < u.workerCount; i++) {
        const rand = Math.random() * 100;
        if (rand < 2) total += 10;
        else if (rand < 12) total += 1;
      }
      if (total > 0) {
        const updated = await store.incMoney(u.token, total);
        const info = onlineUsers.get(u.token);
        if (info) {
          io.to(info.socketId).emit("worker:income", { gain: total, money: updated.money });
        }
      }
    }
  } catch (e) {
    console.error("[worker loop]", e.message);
  }
}, WORKER_INTERVAL_MS);

store.init().then(() => {
  console.log(`[store] 저장 방식: ${store.storageMode()}`);
  server.listen(PORT, () => {
    console.log(`RACING GOA 서버 실행중 — http://localhost:${PORT}`);
  });
  raceLoop.run(io, store, onlineUsers).catch(err => {
    console.error("[raceLoop] 치명적 오류:", err);
  });
});
