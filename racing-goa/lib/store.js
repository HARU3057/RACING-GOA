// ============================================================
// RACING GOA - 저장소 모듈
// - MONGODB_URI 환경변수가 있으면 MongoDB Atlas(무료)에 영구 저장.
//   -> Render를 재배포해도 데이터가 살아있습니다. (권장)
// - 없으면 프로젝트 폴더의 data/users.json 파일에 저장.
//   -> Render 무료 플랜은 재배포 시 디스크가 초기화되므로,
//      로컬 테스트 또는 개인 서버용으로만 쓰세요.
// ============================================================

const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcryptjs");

const MONGODB_URI = process.env.MONGODB_URI || "";
const USE_MONGO = !!MONGODB_URI;

const DEFAULTS = {
  money: 0,
  haruRose: false,
  trashUpgrade: false,
  haruBat: false,
  workerCount: 0,
  isAdmin: false,
  guildName: null
};

let mongoose, UserModel, PendingBetsModel, GuildModel;

function initMongo() {
  mongoose = require("mongoose");
  const userSchema = new mongoose.Schema({
    token: { type: String, unique: true, required: true, index: true },
    nickname: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    money: { type: Number, default: DEFAULTS.money },
    haruRose: { type: Boolean, default: DEFAULTS.haruRose },
    trashUpgrade: { type: Boolean, default: DEFAULTS.trashUpgrade },
    haruBat: { type: Boolean, default: DEFAULTS.haruBat },
    workerCount: { type: Number, default: DEFAULTS.workerCount },
    isAdmin: { type: Boolean, default: DEFAULTS.isAdmin },
    guildName: { type: String, default: null }
  }, { timestamps: true });
  UserModel = mongoose.models.RacingGoaUser || mongoose.model("RacingGoaUser", userSchema);

  // 진행 중인 경기의 베팅 내역을 잠깐 저장해두는 용도.
  // 서버가 경주 도중 재시작되면, 재기동 시 이 문서를 보고 전액 환불 처리한다.
  const pendingBetsSchema = new mongoose.Schema({
    singleton: { type: String, unique: true, default: "current" },
    raceNumber: Number,
    bets: [{ token: String, nickname: String, horseId: Number, amount: Number }]
  });
  PendingBetsModel = mongoose.models.RacingGoaPendingBets || mongoose.model("RacingGoaPendingBets", pendingBetsSchema);

  // 목장(길드) — 이름 + 소유자 + 멤버 토큰 목록 + 가입 승인 대기 목록
  const guildSchema = new mongoose.Schema({
    name: { type: String, unique: true, required: true, index: true },
    ownerToken: { type: String, required: true },
    members: [{ type: String }], // token 목록
    pendingRequests: [{ type: String }] // 가입 승인 대기 중인 token 목록
  }, { timestamps: true });
  GuildModel = mongoose.models.RacingGoaGuild || mongoose.model("RacingGoaGuild", guildSchema);

  return mongoose.connect(MONGODB_URI).then(() => {
    console.log("[store] MongoDB Atlas 연결 완료 — 데이터가 영구 저장됩니다.");
  }).catch(err => {
    console.error("[store] MongoDB 연결 실패, JSON 파일 저장으로 전환합니다:", err.message);
  });
}

// ---------------- JSON 파일 폴백 ----------------
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "users.json");
const BETS_FILE = path.join(DATA_DIR, "pendingBets.json");
const GUILDS_FILE = path.join(DATA_DIR, "guilds.json");
let jsonUsers = {}; // token -> user
let jsonPendingBets = null; // { raceNumber, bets: [...] } | null
let jsonGuilds = {}; // name -> { name, ownerToken, members: [token] }

function loadJson() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      jsonUsers = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    } catch (e) {
      console.error("[store] users.json 파싱 실패, 빈 상태로 시작합니다.", e.message);
      jsonUsers = {};
    }
  }
  if (fs.existsSync(BETS_FILE)) {
    try {
      jsonPendingBets = JSON.parse(fs.readFileSync(BETS_FILE, "utf-8"));
    } catch (e) {
      jsonPendingBets = null;
    }
  }
  if (fs.existsSync(GUILDS_FILE)) {
    try {
      jsonGuilds = JSON.parse(fs.readFileSync(GUILDS_FILE, "utf-8"));
    } catch (e) {
      jsonGuilds = {};
    }
  }
}

function saveGuildsFileSync() {
  try {
    fs.writeFileSync(GUILDS_FILE, JSON.stringify(jsonGuilds, null, 2));
  } catch (e) {
    console.error("[store] guilds.json 저장 실패:", e.message);
  }
}

function saveBetsFileSync() {
  try {
    if (jsonPendingBets) fs.writeFileSync(BETS_FILE, JSON.stringify(jsonPendingBets, null, 2));
    else if (fs.existsSync(BETS_FILE)) fs.unlinkSync(BETS_FILE);
  } catch (e) {
    console.error("[store] pendingBets.json 저장 실패:", e.message);
  }
}

let saveTimer = null;
function scheduleSaveJson() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(jsonUsers, null, 2));
    } catch (e) {
      console.error("[store] users.json 저장 실패:", e.message);
    }
  }, 300);
}

async function init() {
  if (USE_MONGO) {
    await initMongo();
  }
  if (!UserModel) loadJson(); // 몽고 연결 실패했거나 애초에 URI 없으면 JSON 사용
}

function toPlain(u) {
  if (!u) return null;
  return {
    token: u.token,
    nickname: u.nickname,
    money: u.money,
    haruRose: u.haruRose,
    trashUpgrade: !!u.trashUpgrade,
    haruBat: !!u.haruBat,
    workerCount: u.workerCount,
    isAdmin: !!u.isAdmin,
    guildName: u.guildName || null
  };
}

async function createUser(nickname, password) {
  const token = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);
  if (UseMongoActive()) {
    const doc = await UserModel.create({ token, nickname, passwordHash, ...DEFAULTS });
    return toPlain(doc);
  }
  const user = { token, nickname, passwordHash, ...DEFAULTS };
  jsonUsers[token] = user;
  scheduleSaveJson();
  return { ...user };
}

// 닉네임+비밀번호로 로그인. 성공 시 유저 정보(공개 필드만) 반환, 실패 시 null
async function verifyPassword(nickname, password) {
  if (!nickname || !password) return null;
  let raw;
  if (UseMongoActive()) {
    raw = await UserModel.findOne({ nickname });
  } else {
    raw = Object.values(jsonUsers).find(u => u.nickname === nickname);
  }
  if (!raw || !raw.passwordHash) return null;
  const ok = bcrypt.compareSync(password, raw.passwordHash);
  if (!ok) return null;
  return toPlain(raw);
}

async function getUserByToken(token) {
  if (!token) return null;
  if (UseMongoActive()) {
    const doc = await UserModel.findOne({ token });
    return toPlain(doc);
  }
  return jsonUsers[token] ? { ...jsonUsers[token] } : null;
}

async function getUserByNickname(nickname) {
  if (!nickname) return null;
  if (UseMongoActive()) {
    const doc = await UserModel.findOne({ nickname });
    return toPlain(doc);
  }
  const found = Object.values(jsonUsers).find(u => u.nickname === nickname);
  return found ? { ...found } : null;
}

async function updateUser(token, fields) {
  if (UseMongoActive()) {
    const doc = await UserModel.findOneAndUpdate({ token }, { $set: fields }, { new: true });
    return toPlain(doc);
  }
  if (!jsonUsers[token]) return null;
  Object.assign(jsonUsers[token], fields);
  scheduleSaveJson();
  return { ...jsonUsers[token] };
}

// money를 델타(증감분)로 안전하게 반영 (경쟁 조건 최소화용)
async function incMoney(token, delta) {
  if (UseMongoActive()) {
    const doc = await UserModel.findOneAndUpdate({ token }, { $inc: { money: delta } }, { new: true });
    return toPlain(doc);
  }
  if (!jsonUsers[token]) return null;
  jsonUsers[token].money = Math.max(0, (jsonUsers[token].money || 0) + delta);
  scheduleSaveJson();
  return { ...jsonUsers[token] };
}

async function getAllUsersWithWorkers() {
  if (UseMongoActive()) {
    const docs = await UserModel.find({ workerCount: { $gt: 0 } });
    return docs.map(toPlain);
  }
  return Object.values(jsonUsers).filter(u => u.workerCount > 0).map(u => ({ ...u }));
}

// ---- 목장(길드) ----
function guildToPlain(g) {
  if (!g) return null;
  return { name: g.name, ownerToken: g.ownerToken, members: [...g.members], pendingRequests: [...(g.pendingRequests || [])] };
}

async function createGuild(name, ownerToken) {
  if (UseMongoActive()) {
    const doc = await GuildModel.create({ name, ownerToken, members: [ownerToken], pendingRequests: [] });
    return guildToPlain(doc);
  }
  if (jsonGuilds[name]) return null; // 이미 존재
  const guild = { name, ownerToken, members: [ownerToken], pendingRequests: [] };
  jsonGuilds[name] = guild;
  saveGuildsFileSync();
  return guildToPlain(guild);
}

async function getGuildByName(name) {
  if (!name) return null;
  if (UseMongoActive()) {
    const doc = await GuildModel.findOne({ name });
    return guildToPlain(doc);
  }
  return jsonGuilds[name] ? guildToPlain(jsonGuilds[name]) : null;
}

async function listGuilds() {
  if (UseMongoActive()) {
    const docs = await GuildModel.find({});
    return docs.map(g => ({ name: g.name, memberCount: g.members.length }));
  }
  return Object.values(jsonGuilds).map(g => ({ name: g.name, memberCount: g.members.length }));
}

async function addGuildMember(name, token) {
  if (UseMongoActive()) {
    const doc = await GuildModel.findOneAndUpdate(
      { name },
      { $addToSet: { members: token }, $pull: { pendingRequests: token } },
      { new: true }
    );
    return guildToPlain(doc);
  }
  if (!jsonGuilds[name]) return null;
  if (!jsonGuilds[name].members.includes(token)) jsonGuilds[name].members.push(token);
  jsonGuilds[name].pendingRequests = (jsonGuilds[name].pendingRequests || []).filter(t => t !== token);
  saveGuildsFileSync();
  return guildToPlain(jsonGuilds[name]);
}

// 가입 신청 추가 (이미 멤버거나 이미 신청한 상태면 그대로 반환)
async function addGuildRequest(name, token) {
  if (UseMongoActive()) {
    const doc = await GuildModel.findOneAndUpdate({ name }, { $addToSet: { pendingRequests: token } }, { new: true });
    return guildToPlain(doc);
  }
  if (!jsonGuilds[name]) return null;
  jsonGuilds[name].pendingRequests = jsonGuilds[name].pendingRequests || [];
  if (!jsonGuilds[name].pendingRequests.includes(token)) jsonGuilds[name].pendingRequests.push(token);
  saveGuildsFileSync();
  return guildToPlain(jsonGuilds[name]);
}

// 가입 신청 거절/취소 (멤버로 넣지 않고 대기목록에서만 제거)
async function removeGuildRequest(name, token) {
  if (UseMongoActive()) {
    const doc = await GuildModel.findOneAndUpdate({ name }, { $pull: { pendingRequests: token } }, { new: true });
    return guildToPlain(doc);
  }
  if (!jsonGuilds[name]) return null;
  jsonGuilds[name].pendingRequests = (jsonGuilds[name].pendingRequests || []).filter(t => t !== token);
  saveGuildsFileSync();
  return guildToPlain(jsonGuilds[name]);
}

// 멤버를 빼고, 남은 인원이 없으면 길드 자체를 삭제, 소유자가 나갔으면 다음 사람에게 소유권 위임.
// 반환값: { deleted: true } | { deleted: false, guild }
async function removeGuildMember(name, token) {
  if (UseMongoActive()) {
    const doc = await GuildModel.findOne({ name });
    if (!doc) return { deleted: true };
    doc.members = doc.members.filter(t => t !== token);
    if (doc.members.length === 0) {
      await GuildModel.deleteOne({ name });
      return { deleted: true };
    }
    if (doc.ownerToken === token) doc.ownerToken = doc.members[0];
    await doc.save();
    return { deleted: false, guild: guildToPlain(doc) };
  }
  const g = jsonGuilds[name];
  if (!g) return { deleted: true };
  g.members = g.members.filter(t => t !== token);
  if (g.members.length === 0) {
    delete jsonGuilds[name];
    saveGuildsFileSync();
    return { deleted: true };
  }
  if (g.ownerToken === token) g.ownerToken = g.members[0];
  saveGuildsFileSync();
  return { deleted: false, guild: guildToPlain(g) };
}

// ---- 진행 중인 경기의 베팅 내역 임시 저장 (서버가 경주 도중 죽어도 환불할 수 있도록) ----
async function savePendingBets(raceNumber, betsArray) {
  if (UseMongoActive()) {
    await PendingBetsModel.findOneAndUpdate(
      { singleton: "current" },
      { $set: { raceNumber, bets: betsArray } },
      { upsert: true }
    );
    return;
  }
  jsonPendingBets = { raceNumber, bets: betsArray };
  saveBetsFileSync();
}

async function getPendingBets() {
  if (UseMongoActive()) {
    const doc = await PendingBetsModel.findOne({ singleton: "current" });
    if (!doc || !doc.bets || doc.bets.length === 0) return null;
    return { raceNumber: doc.raceNumber, bets: doc.bets.map(b => ({ ...b.toObject() })) };
  }
  if (!jsonPendingBets || !jsonPendingBets.bets || jsonPendingBets.bets.length === 0) return null;
  return { ...jsonPendingBets };
}

async function clearPendingBets() {
  if (UseMongoActive()) {
    await PendingBetsModel.findOneAndUpdate({ singleton: "current" }, { $set: { raceNumber: null, bets: [] } }, { upsert: true });
    return;
  }
  jsonPendingBets = null;
  saveBetsFileSync();
}

function UseMongoActive() {
  return USE_MONGO && UserModel && mongoose && mongoose.connection.readyState === 1;
}

function storageMode() {
  return UseMongoActive() ? "mongodb" : "json-file";
}

// 프로세스가 종료 신호(SIGTERM 등, Render가 재배포 시 보내는 정상 종료 신호)를 받았을 때
// 디바운스 중이던 저장을 즉시 동기적으로 flush 한다 (SIGKILL처럼 강제 종료면 이것도 못 잡지만,
// 정상적인 재배포/재시작은 대부분 SIGTERM을 먼저 보내므로 이걸로 데이터 유실을 크게 줄일 수 있다)
function flushSync() {
  if (UseMongoActive()) return; // 몽고는 매 요청이 즉시 반영되므로 flush 불필요
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(jsonUsers, null, 2));
  } catch (e) {
    console.error("[store] flushSync 실패:", e.message);
  }
  saveBetsFileSync();
  saveGuildsFileSync();
}

module.exports = {
  init, createUser, verifyPassword, getUserByToken, getUserByNickname, updateUser, incMoney,
  getAllUsersWithWorkers, storageMode,
  savePendingBets, getPendingBets, clearPendingBets, flushSync,
  createGuild, getGuildByName, listGuilds, addGuildMember, removeGuildMember,
  addGuildRequest, removeGuildRequest
};
