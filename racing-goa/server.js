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

// 첫 관리자가 되기 위한 비밀 키. Render 환경변수 ADMIN_SECRET으로 반드시 직접 설정하세요.
// 설정을 안 하면 서버 시작할 때마다 무작위로 새로 만들어서 콘솔(로그)에 출력합니다.
const ADMIN_SECRET = process.env.ADMIN_SECRET || (() => {
  const generated = Math.random().toString(36).slice(2, 10);
  console.log(`[admin] ADMIN_SECRET 환경변수가 없어서 임시 키를 생성했습니다: ${generated}`);
  console.log(`[admin] 채팅창에 "/admin ${generated}" 을 입력하면 관리자가 됩니다. (서버 재시작하면 이 키는 바뀝니다 — Render 환경변수에 ADMIN_SECRET을 직접 설정하는 걸 추천합니다)`);
  return generated;
})();

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 서버가 (재배포 등으로) 새로 켜질 때마다 바뀌는 값 -> 접속 중이던 클라이언트가
// 재연결됐을 때 이 값이 달라지면 "서버가 업데이트됐다"는 뜻이므로 새로고침을 안내한다.
const SERVER_BOOT_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

// token -> { socketId, nickname }
const onlineUsers = new Map();
// socket.id -> token
const socketToToken = new Map();

const chatHistory = []; // 최근 채팅 메시지 (메모리, 최대 50개)
const CHAT_MAX = 50;

function publicUser(u) {
  if (!u) return null;
  return { nickname: u.nickname, money: u.money, haruRose: u.haruRose, workerCount: u.workerCount, isAdmin: !!u.isAdmin };
}

function isNicknameValid(nickname) {
  if (typeof nickname !== "string") return false;
  const trimmed = nickname.trim();
  return trimmed.length >= 1 && trimmed.length <= 12 && !/[<>]/.test(trimmed);
}

function isPasswordValid(password) {
  return typeof password === "string" && password.length >= 4 && password.length <= 64;
}

async function handleAdminCommand(socket, token, rawText) {
  const reply = (ok, message) => socket.emit("admin:cmdResult", { ok, message });

  const parts = rawText.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const user = await store.getUserByToken(token);
  if (!user) return reply(false, "로그인 정보를 찾을 수 없습니다.");

  if (cmd === "admin") {
    const secret = parts[1] || "";
    if (!secret) return reply(false, "사용법: /admin 비밀키");
    if (user.isAdmin) return reply(false, "이미 관리자입니다.");
    if (secret !== ADMIN_SECRET) return reply(false, "비밀키가 올바르지 않습니다.");
    await store.updateUser(token, { isAdmin: true });
    console.log(`[admin] ${user.nickname}님이 관리자 권한을 획득했습니다.`);
    return reply(true, "✅ 관리자 권한을 획득했습니다. /help 를 입력해보세요.");
  }

  if (cmd === "help") {
    if (!user.isAdmin) return reply(true, "사용 가능한 명령어: /admin <비밀키>");
    return reply(true,
      "관리자 명령어:\n" +
      "/money <닉네임> <금액>  - 소지금 지급(양수)/회수(음수)\n" +
      "/op <닉네임>  - 관리자 권한 부여\n" +
      "/deop <닉네임>  - 관리자 권한 회수\n" +
      "/announce <메시지>  - 전체 공지 방송"
    );
  }

  // 아래 명령어들은 관리자만 사용 가능
  if (!user.isAdmin) return reply(false, "관리자 권한이 필요합니다. (/admin <비밀키>)");

  if (cmd === "money") {
    const targetNickname = parts[1];
    const amount = Math.trunc(Number(parts[2]));
    if (!targetNickname || !Number.isFinite(amount) || amount === 0) return reply(false, "사용법: /money <닉네임> <금액> (음수 가능)");
    const target = await store.getUserByNickname(targetNickname);
    if (!target) return reply(false, `"${targetNickname}" 닉네임의 유저를 찾을 수 없습니다.`);
    const updated = await store.incMoney(target.token, amount);
    reply(true, `💰 ${target.nickname}님의 소지금을 ${amount > 0 ? "+" : ""}${amount.toLocaleString()} 조정했습니다. (현재: $${updated.money.toLocaleString()})`);
    const targetInfo = onlineUsers.get(target.token);
    if (targetInfo) {
      io.to(targetInfo.socketId).emit("admin:moneyUpdate", {
        money: updated.money,
        message: `🛠️ 관리자가 소지금을 ${amount > 0 ? "+" : ""}${amount.toLocaleString()} 조정했습니다.`
      });
    }
    return;
  }

  if (cmd === "op" || cmd === "deop") {
    const targetNickname = parts[1];
    if (!targetNickname) return reply(false, `사용법: /${cmd} <닉네임>`);
    const target = await store.getUserByNickname(targetNickname);
    if (!target) return reply(false, `"${targetNickname}" 닉네임의 유저를 찾을 수 없습니다.`);
    const makeAdmin = cmd === "op";
    await store.updateUser(target.token, { isAdmin: makeAdmin });
    reply(true, `${target.nickname}님을 ${makeAdmin ? "관리자로 지정" : "관리자에서 해제"}했습니다.`);
    const targetInfo = onlineUsers.get(target.token);
    if (targetInfo) {
      io.to(targetInfo.socketId).emit("admin:statusChanged", {
        isAdmin: makeAdmin,
        message: makeAdmin ? "🛠️ 관리자 권한을 부여받았습니다." : "관리자 권한이 해제되었습니다."
      });
    }
    return;
  }

  if (cmd === "announce") {
    const message = rawText.slice(rawText.indexOf(" ") + 1).trim();
    if (!message || message === "/announce") return reply(false, "사용법: /announce <메시지>");
    const payload = { text: message, ts: Date.now() };
    io.emit("chat:announce", payload);
    chatHistory.push({ announce: true, text: message, ts: payload.ts });
    if (chatHistory.length > CHAT_MAX) chatHistory.shift();
    return reply(true, "📢 공지를 방송했습니다.");
  }

  return reply(false, `알 수 없는 명령어입니다: /${cmd}`);
}

io.on("connection", (socket) => {
  let currentToken = null;

  socket.emit("server:version", { bootId: SERVER_BOOT_ID });
  socket.emit("chat:history", chatHistory);
  socket.emit("race:snapshot", raceLoop.publicRaceSnapshot());

  // 회원가입: 닉네임+비밀번호로 새 계정 생성
  socket.on("auth:signup", async (data) => {
    try {
      const nickname = (data && data.nickname || "").trim();
      const password = (data && data.password) || "";
      if (!isNicknameValid(nickname)) {
        socket.emit("auth:error", { message: "닉네임은 1~12자, 특수문자(<,>) 제외로 입력해주세요." });
        return;
      }
      if (!isPasswordValid(password)) {
        socket.emit("auth:error", { message: "비밀번호는 4~64자로 입력해주세요." });
        return;
      }
      const existing = await store.getUserByNickname(nickname);
      if (existing) {
        socket.emit("auth:error", { message: "이미 사용 중인 닉네임입니다. 계정이 있다면 로그인해주세요." });
        return;
      }
      const user = await store.createUser(nickname, password);
      currentToken = user.token;
      socketToToken.set(socket.id, user.token);
      onlineUsers.set(user.token, { socketId: socket.id, nickname: user.nickname });
      socket.emit("auth:ok", { token: user.token, user: publicUser(user) });
      io.emit("chat:system", { text: `${user.nickname}님이 입장했습니다.` });
    } catch (e) {
      console.error(e);
      socket.emit("auth:error", { message: "서버 오류로 회원가입에 실패했습니다." });
    }
  });

  // 로그인: 닉네임+비밀번호로 기존 계정 접속
  socket.on("auth:login", async (data) => {
    try {
      const nickname = (data && data.nickname || "").trim();
      const password = (data && data.password) || "";
      const user = await store.verifyPassword(nickname, password);
      if (!user) {
        socket.emit("auth:error", { message: "닉네임 또는 비밀번호가 올바르지 않습니다." });
        return;
      }
      currentToken = user.token;
      socketToToken.set(socket.id, user.token);
      onlineUsers.set(user.token, { socketId: socket.id, nickname: user.nickname });
      socket.emit("auth:ok", { token: user.token, user: publicUser(user) });

      const myBet = raceLoop.state.bets.get(user.token);
      if (myBet) socket.emit("race:myBet", myBet);

      io.emit("chat:system", { text: `${user.nickname}님이 접속했습니다.` });
    } catch (e) {
      console.error(e);
      socket.emit("auth:error", { message: "서버 오류로 로그인에 실패했습니다." });
    }
  });

  // 같은 브라우저 자동 재접속 (localStorage에 저장된 토큰으로)
  socket.on("auth:token", async (data) => {
    try {
      const token = data && data.token;
      const user = await store.getUserByToken(token);
      if (!user) {
        socket.emit("auth:error", { message: "자동 로그인 정보가 유효하지 않습니다. 다시 로그인해주세요." });
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

  socket.on("chat:send", async (data) => {
    if (!currentToken) return;
    const info = onlineUsers.get(currentToken);
    if (!info) return;
    const text = ((data && data.text) || "").toString().slice(0, 300).trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await handleAdminCommand(socket, currentToken, text);
      return;
    }

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

store.init().then(async () => {
  console.log(`[store] 저장 방식: ${store.storageMode()}`);
  await raceLoop.recoverOrphanedBets(store, io, onlineUsers);
  server.listen(PORT, () => {
    console.log(`RACING GOA 서버 실행중 — http://localhost:${PORT}`);
  });
  raceLoop.run(io, store, onlineUsers, chatHistory, CHAT_MAX).catch(err => {
    console.error("[raceLoop] 치명적 오류:", err);
  });
});

// Render 등이 재배포/재시작 시 보내는 정상 종료 신호를 받으면, 저장 대기 중이던
// 데이터를 즉시 디스크에 flush하고 종료한다 (JSON 파일 모드에서 데이터 유실 방지)
function gracefulShutdown(signal) {
  console.log(`[server] ${signal} 수신, 저장 flush 후 종료합니다.`);
  store.flushSync();
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
