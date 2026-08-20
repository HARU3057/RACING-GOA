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
  workerCount: 0
};

let mongoose, UserModel;

function initMongo() {
  mongoose = require("mongoose");
  const userSchema = new mongoose.Schema({
    token: { type: String, unique: true, required: true, index: true },
    nickname: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    money: { type: Number, default: DEFAULTS.money },
    haruRose: { type: Boolean, default: DEFAULTS.haruRose },
    workerCount: { type: Number, default: DEFAULTS.workerCount }
  }, { timestamps: true });
  UserModel = mongoose.models.RacingGoaUser || mongoose.model("RacingGoaUser", userSchema);
  return mongoose.connect(MONGODB_URI).then(() => {
    console.log("[store] MongoDB Atlas 연결 완료 — 데이터가 영구 저장됩니다.");
  }).catch(err => {
    console.error("[store] MongoDB 연결 실패, JSON 파일 저장으로 전환합니다:", err.message);
  });
}

// ---------------- JSON 파일 폴백 ----------------
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "users.json");
let jsonUsers = {}; // token -> user

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
    workerCount: u.workerCount
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

function UseMongoActive() {
  return USE_MONGO && UserModel && mongoose && mongoose.connection.readyState === 1;
}

function storageMode() {
  return UseMongoActive() ? "mongodb" : "json-file";
}

module.exports = {
  init, createUser, verifyPassword, getUserByToken, getUserByNickname, updateUser, incMoney,
  getAllUsersWithWorkers, storageMode
};
