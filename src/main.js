import "./style.css";
import {
  addFriendByUid,
  ensureProfile,
  firebaseReady,
  loginWithGoogle,
  logout,
  removeFriend,
  watchAuth,
  watchFriendProfiles,
  watchProfile
} from "./firebase";
import { createPeerPositionSync } from "./peer-sync";

const app = document.querySelector("#app");
const BALL_SIZE = 84;
const MOVE_SPEED_SCALE = 0.7;
const MOVE_SPEED = 480 * MOVE_SPEED_SCALE;
const FLOOR_HEIGHT_RATIO = 0.75;
const TARGET_STOP_DISTANCE = 4;

function floorY() {
  return Math.round(innerHeight * FLOOR_HEIGHT_RATIO - BALL_SIZE);
}
const state = {
  user: null,
  profile: null,
  friendProfiles: [],
  remotePlayers: [],
  position: { x: innerWidth / 2 - BALL_SIZE / 2, y: floorY(), vx: 0, vy: 0 },
  targetX: null,
  keys: new Set(),
  globalDirection: null,
  globalDirectionUntil: 0,
  lastTime: performance.now(),
  panelOpen: true
};

let unsubscribeProfile = () => {};
let unsubscribeFriends = () => {};
let peerSync = null;

function avatar(url, name) {
  return url
    ? `<img src="${url}" alt="${name}" referrerpolicy="no-referrer">`
    : `<span>${(name || "喵").slice(0, 1)}</span>`;
}

function render() {
  const configured = firebaseReady
    ? ""
    : `<div class="notice">尚未設定 Firebase。請複製 <code>.env.example</code> 為 <code>.env</code> 並填入專案資訊。</div>`;

  app.innerHTML = `
    <main class="desktop">
      <div class="aurora aurora-a"></div>
      <div class="aurora aurora-b"></div>
      <div class="sparkles"></div>
      <header class="titlebar">
        <div class="brand"><span>●</span> 桌面遊戲喵</div>
        <div class="window-actions">
          <button data-action="toggle-panel" title="好友列表">☰</button>
          <button data-action="minimize" title="最小化">—</button>
          <button data-action="close" title="關閉">×</button>
        </div>
      </header>
      ${configured}
      ${
        state.user
          ? `
            <aside class="friend-panel ${state.panelOpen ? "open" : ""}">
              <div class="profile">
                <div class="mini-avatar">${avatar(state.user.photoURL, state.user.displayName)}</div>
                <div><strong>${state.user.displayName || "玩家"}</strong><small>已連線</small></div>
                <button data-action="logout">登出</button>
              </div>
              <p class="uid">我的 UID<br><button data-action="copy-uid">${state.user.uid}</button></p>
              <form id="friend-form">
                <input name="uid" placeholder="貼上好友 UID" autocomplete="off">
                <button>加入</button>
              </form>
              <div class="friend-list">
                <h2>好友 <span>${state.friendProfiles.length}</span></h2>
                ${
                  state.friendProfiles.length
                    ? state.friendProfiles
                        .map(
                          (friend) => `
                            <div class="friend-row">
                              <div class="mini-avatar">${avatar(friend.photoURL, friend.displayName)}</div>
                              <div><strong>${friend.displayName || "玩家"}</strong><small>${
                                state.remotePlayers.some((player) => player.id === friend.id)
                                  ? "在線桌面上"
                                  : "離線"
                              }</small></div>
                              <button data-remove-friend="${friend.id}">×</button>
                            </div>`
                        )
                        .join("")
                    : `<div class="empty">分享 UID 並加入好友，對方上線時，頭像球就會從天空掉下來。</div>`
                }
              </div>
              <div class="help">← → 滾動角色<br>點擊螢幕下半部自動滾到指定位置<br>Ctrl + Alt + M 顯示／隱藏</div>
            </aside>
          `
          : `
            <section class="login-card">
              <div class="logo">喵</div>
              <h1>讓好友降落在你的桌面</h1>
              <p>登入後，你的頭像會變成一顆有重力的球。好友上線時，也會一起出現在粉藍流光世界裡。</p>
              <button class="google-login" data-action="login" ${firebaseReady ? "" : "disabled"}>
                <span>G</span> 使用 Google 帳號登入
              </button>
            </section>
          `
      }
      <section id="world" aria-label="遊戲世界"></section>
      <div class="ground-glow"></div>
      <div id="toast" role="status"></div>
      <button class="floating-orb" data-action="floating-orb" title="開啟桌面遊戲喵設定">
        ${state.user ? avatar(state.user.photoURL, state.user.displayName) : "<span>喵</span>"}
        <i></i>
      </button>
    </main>`;

  bindEvents();
  syncBalls();
}

function bindEvents() {
  document.querySelector("#world")?.addEventListener("pointerdown", (event) => {
    if (!state.user || event.clientY < innerHeight * .5) return;
    event.preventDefault();
    state.targetX = Math.max(0, Math.min(innerWidth - BALL_SIZE, event.clientX - BALL_SIZE / 2));
  });
  document.querySelector('[data-action="login"]')?.addEventListener("click", async () => {
    try {
      await loginWithGoogle();
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('[data-action="logout"]')?.addEventListener("click", async () => {
    peerSync?.stop();
    peerSync = null;
    window.desktopMeow?.setWallpaperMode(false);
    await logout();
  });
  document.querySelector('[data-action="toggle-panel"]')?.addEventListener("click", () => {
    state.panelOpen = !state.panelOpen;
    document.querySelector(".friend-panel")?.classList.toggle("open", state.panelOpen);
  });
  document.querySelector('[data-action="copy-uid"]')?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.user.uid);
    toast("UID 已複製");
  });
  document.querySelector('[data-action="minimize"]')?.addEventListener("click", () => window.desktopMeow?.collapseControl());
  document.querySelector('[data-action="close"]')?.addEventListener("click", () => window.desktopMeow?.collapseControl());
  document.querySelector('[data-action="floating-orb"]')?.addEventListener("click", () => {
    window.desktopMeow?.toggleControl();
  });
  document.querySelector("#friend-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector("button");
    const uid = new FormData(event.currentTarget).get("uid")?.trim();
    submitButton.disabled = true;
    submitButton.textContent = "加入中…";
    try {
      await addFriendByUid(state.user.uid, uid);
      form.reset();
      toast("好友已加入");
    } catch (error) {
      toast(error.message || `${error.code || "加入失敗"}`);
    } finally {
      const currentButton = document.querySelector("#friend-form button");
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = "加入";
      }
    }
  });
  document.querySelectorAll("[data-remove-friend]").forEach((button) => {
    button.addEventListener("click", () => removeFriend(state.user.uid, button.dataset.removeFriend));
  });
}

function toast(message) {
  const element = document.querySelector("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2800);
}

function syncBalls() {
  const world = document.querySelector("#world");
  if (!world) return;
  const players = state.user
    ? [
        {
          id: state.user.uid,
          displayName: state.user.displayName,
          photoURL: state.user.photoURL,
          local: true
        },
        ...state.remotePlayers
      ]
    : [];
  const ids = new Set(players.map((player) => player.id));
  world.querySelectorAll(".avatar-ball").forEach((ball) => {
    if (!ids.has(ball.dataset.id)) ball.remove();
  });
  players.forEach((player) => {
    let ball = world.querySelector(`[data-id="${CSS.escape(player.id)}"]`);
    if (!ball) {
      ball = document.createElement("div");
      ball.className = `avatar-ball ${player.local ? "local" : "remote"}`;
      ball.dataset.id = player.id;
      ball.innerHTML = `${avatar(player.photoURL, player.displayName)}<label>${player.displayName || "玩家"}</label>`;
      world.appendChild(ball);
    }
  });
}

function updateBallTransforms() {
  if (!state.user) return;
  const localBall = document.querySelector(`[data-id="${CSS.escape(state.user.uid)}"]`);
  if (localBall) {
    localBall.style.transform = `translate3d(${state.position.x}px, ${state.position.y}px, 0) rotate(${state.position.x * 0.5}deg)`;
  }
  state.remotePlayers.forEach((player) => {
    const ball = document.querySelector(`[data-id="${CSS.escape(player.id)}"]`);
    if (ball) {
      const x = Math.max(0, Math.min(innerWidth - BALL_SIZE, player.x ?? innerWidth / 2));
      const y = floorY();
      ball.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${x * 0.35}deg)`;
    }
  });

  window.desktopMeow?.publishWallpaperState({
    local: {
      id: state.user.uid,
      displayName: state.user.displayName || "玩家",
      photoURL: state.user.photoURL || "",
      moveSpeed: MOVE_SPEED_SCALE,
      ...state.position
    },
    remote: state.remotePlayers.map((player) => ({
      id: player.id,
      displayName: player.displayName || "玩家",
      photoURL: player.photoURL || "",
      moveSpeed: player.moveSpeed ?? MOVE_SPEED_SCALE,
      x: player.x,
      y: player.y
    }))
  });
}

function move(direction) {
  if (!state.user) return;
  if (direction !== "left" && direction !== "right") return;
  state.targetX = null;
  state.globalDirection = direction;
  state.globalDirectionUntil = performance.now() + 180;
  if (direction === "left") state.position.vx = -MOVE_SPEED;
  if (direction === "right") state.position.vx = MOVE_SPEED;
}

function physics(now) {
  const dt = Math.min((now - state.lastTime) / 1000, 0.033);
  state.lastTime = now;
  if (state.user) {
    const globalActive = now < state.globalDirectionUntil;
    const movingLeft = state.keys.has("ArrowLeft") || (globalActive && state.globalDirection === "left");
    const movingRight = state.keys.has("ArrowRight") || (globalActive && state.globalDirection === "right");

    if (movingLeft) state.position.vx = -MOVE_SPEED;
    else if (movingRight) state.position.vx = MOVE_SPEED;
    else if (Number.isFinite(state.targetX)) {
      const distance = state.targetX - state.position.x;
      if (Math.abs(distance) <= TARGET_STOP_DISTANCE) {
        state.position.x = state.targetX;
        state.position.vx = 0;
        state.targetX = null;
      } else {
        state.position.vx = Math.sign(distance) * Math.min(MOVE_SPEED, Math.max(140, Math.abs(distance) * 4));
      }
    } else state.position.vx *= Math.pow(0.001, dt);

    state.position.x += state.position.vx * dt;
    state.position.y = floorY();
    state.position.vy = 0;
    if (state.position.x < 0) {
      state.position.x = 0;
      state.position.vx *= -0.35;
    }
    if (state.position.x > innerWidth - BALL_SIZE) {
      state.position.x = innerWidth - BALL_SIZE;
      state.position.vx *= -0.35;
    }
    updateBallTransforms();
    peerSync?.publish({ ...state.position, moveSpeed: MOVE_SPEED_SCALE });
  }
  requestAnimationFrame(physics);
}

addEventListener("keydown", (event) => {
  if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      state.targetX = null;
      state.keys.add(event.key);
    }
  }
});
addEventListener("keyup", (event) => state.keys.delete(event.key));
addEventListener("resize", () => {
  state.position.x = Math.min(state.position.x, innerWidth - BALL_SIZE);
  state.position.y = floorY();
});
window.desktopMeow?.onGlobalMove(move);
window.desktopMeow?.onWallpaperMode((enabled) => {
  toast(enabled ? "已切換為桌布模式" : "已切換為控制視窗");
});
window.desktopMeow?.onWallpaperError((message) => {
  toast(`桌布模式失敗：${message}`);
});
window.desktopMeow?.onControlMode((compact) => {
  document.body.classList.toggle("control-compact", compact);
});

watchAuth(async (user) => {
  unsubscribeProfile();
  unsubscribeFriends();
  peerSync?.stop();
  peerSync = null;
  state.user = user;
  state.profile = null;
  state.friendProfiles = [];
  state.remotePlayers = [];
  state.position = { x: innerWidth / 2 - BALL_SIZE / 2, y: floorY(), vx: 0, vy: 0 };
  state.targetX = null;
  if (user) {
    await ensureProfile(user);
    peerSync = createPeerPositionSync(user, (players) => {
      const previousOnline = state.remotePlayers.map((player) => player.id).sort().join(",");
      const nextOnline = players.map((player) => player.id).sort().join(",");
      state.remotePlayers = players;
      syncBalls();
      if (previousOnline !== nextOnline) render();
    });
    unsubscribeProfile = watchProfile(user.uid, (profile) => {
      state.profile = profile;
      const ids = profile?.friends || [];
      unsubscribeFriends();
      unsubscribeFriends = watchFriendProfiles(ids, (friends) => {
        state.friendProfiles = friends;
        peerSync?.setFriends(friends);
        render();
      });
      render();
    });
  } else {
    window.desktopMeow?.setWallpaperMode(false);
    render();
  }
});

addEventListener("beforeunload", () => {
  peerSync?.stop();
});

render();
requestAnimationFrame(physics);
