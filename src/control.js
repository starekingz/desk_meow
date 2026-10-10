import "./control.css";
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

const root = document.querySelector("#control-app");
const BALL_SIZE = 84;
const MOVE_SPEED_SCALE = 0.7;
const MOVE_SPEED = 480 * MOVE_SPEED_SCALE;
const FLOOR_HEIGHT_RATIO = 0.75;
const CLICK_MIN_HEIGHT_RATIO = 0.5;
const TARGET_STOP_DISTANCE = 4;

function floorY() {
  return Math.round(screen.height * FLOOR_HEIGHT_RATIO - BALL_SIZE);
}
const state = {
  user: null,
  profile: null,
  friends: [],
  remote: [],
  compact: false,
  wallpaperEnabled: false,
  position: { x: innerWidth / 2, y: floorY(), vx: 0, vy: 0 },
  targetX: null,
  keys: new Set(),
  globalDirection: null,
  globalDirectionUntil: 0,
  lastTime: performance.now()
};

let stopProfile = () => {};
let stopFriends = () => {};
let peerSync = null;

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function avatar(user, className = "avatar") {
  const name = escapeHtml(user?.displayName || "喵");
  return user?.photoURL
    ? `<div class="${className}"><img src="${escapeHtml(user.photoURL)}" alt="${name}" referrerpolicy="no-referrer"></div>`
    : `<div class="${className}"><span>${name.slice(0, 1)}</span></div>`;
}

function render() {
  if (state.compact) {
    root.innerHTML = `
      <button class="orb" data-action="expand" title="開啟設定">
        ${state.user ? avatar(state.user, "orb-avatar") : '<span class="cat">喵</span>'}
        <i class="${state.user ? "online" : ""}"></i>
      </button>`;
    bind();
    return;
  }

  root.innerHTML = `
    <section class="panel">
      <header class="dragbar">
        <div class="brand"><b>●</b> 桌面遊戲喵</div>
        <button data-action="collapse" title="收合">×</button>
      </header>
      ${
        !firebaseReady
          ? `<div class="warning">尚未設定 Firebase，請先完成 <code>.env</code>。</div>`
          : ""
      }
      ${
        state.user
          ? `
            <div class="account-card">
              ${avatar(state.user)}
              <div class="account-copy">
                <strong>${escapeHtml(state.user.displayName || "玩家")}</strong>
                <span><i></i> 桌面角色層已連線</span>
              </div>
              <button class="ghost" data-action="logout">登出</button>
            </div>

            <div class="section">
              <div class="section-title"><span>我的連線代碼</span><small>點擊複製</small></div>
              <button class="uid" data-action="copy-uid">${state.user.uid}</button>
            </div>

            <div class="section wallpaper-option">
              <div class="section-title"><span>粉藍動態桌布</span><small>選用功能</small></div>
              <button class="wallpaper-toggle ${state.wallpaperEnabled ? "enabled" : ""}" data-action="wallpaper">
                ${state.wallpaperEnabled ? "停用動態桌布" : "啟用動態桌布"}
              </button>
              <small>角色與地板會獨立顯示；一般程式視窗可以蓋住角色層。</small>
            </div>

            <form id="friend-form" class="add-friend">
              <input name="uid" placeholder="貼上好友 UID" autocomplete="off">
              <button>加入</button>
            </form>

            <div class="section friends">
              <div class="section-title">
                <span>好友列表</span>
                <small>${state.friends.length} 位好友</small>
              </div>
              <div class="friend-list">
                ${
                  state.friends.length
                    ? state.friends.map((friend) => {
                        const online = state.remote.some((item) => item.id === friend.id);
                        return `
                          <div class="friend">
                            ${avatar(friend, "friend-avatar")}
                            <div><strong>${escapeHtml(friend.displayName || "玩家")}</strong>
                            <span class="${online ? "is-online" : ""}">${online ? "正在桌面上" : "離線"}</span></div>
                            <button data-remove="${friend.id}" title="移除好友">×</button>
                          </div>`;
                      }).join("")
                    : `<div class="empty">分享你的 UID 並加入好友。好友上線後，頭像球會出現在桌面角色層。</div>`
                }
              </div>
            </div>

            <div class="controls">
              <span>控制角色</span>
              <div><kbd>← →</kbd><b>左右滾動，點擊下半部自動移動</b></div>
            </div>
          `
          : `
            <div class="login">
              <div class="login-mark">喵</div>
              <h1>桌面遊戲喵</h1>
              <p>登入後，頭像球會顯示在獨立桌面角色層，並與好友即時同步。動態桌布可稍後自行開啟。</p>
              <button class="google" data-action="login" ${firebaseReady ? "" : "disabled"}>
                <b>G</b> 使用 Google 帳號登入
              </button>
            </div>
          `
      }
      <div id="toast"></div>
    </section>`;
  bind();
}

function bind() {
  root.querySelector('[data-action="expand"]')?.addEventListener("click", () => window.desktopMeow?.toggleControl());
  root.querySelector('[data-action="collapse"]')?.addEventListener("click", () => window.desktopMeow?.collapseControl());
  root.querySelector('[data-action="login"]')?.addEventListener("click", async () => {
    const button = root.querySelector('[data-action="login"]');
    button.disabled = true;
    button.innerHTML = "<b>G</b> 正在開啟 Google 登入…";
    try {
      await loginWithGoogle();
    } catch (error) {
      const currentButton = root.querySelector('[data-action="login"]');
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.innerHTML = "<b>G</b> 使用 Google 帳號登入";
      }
      if (error?.code !== "auth/popup-closed-by-user") {
        toast(`${error.code || "登入失敗"}：${error.message}`);
      }
    }
  });
  root.querySelector('[data-action="logout"]')?.addEventListener("click", async () => {
    peerSync?.stop();
    peerSync = null;
    window.desktopMeow?.setWallpaperMode(false);
    await logout();
  });
  root.querySelector('[data-action="copy-uid"]')?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.user.uid);
    toast("UID 已複製");
  });
  root.querySelector('[data-action="wallpaper"]')?.addEventListener("click", () => {
    window.desktopMeow?.setWallpaperMode(!state.wallpaperEnabled);
  });
  root.querySelector("#friend-form")?.addEventListener("submit", async (event) => {
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
      const currentButton = root.querySelector("#friend-form button");
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = "加入";
      }
    }
  });
  root.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeFriend(state.user.uid, button.dataset.remove));
  });
}

function toast(message) {
  const element = root.querySelector("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 5000);
}

function sendWallpaperState() {
  if (!state.user) return;
  window.desktopMeow?.publishWallpaperState({
    local: {
      id: state.user.uid,
      displayName: state.user.displayName || "玩家",
      photoURL: state.user.photoURL || "",
      moveSpeed: MOVE_SPEED_SCALE,
      ...state.position
    },
    remote: state.remote.map((player) => ({
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
    const active = now < state.globalDirectionUntil;
    if (active && state.globalDirection === "left") state.position.vx = -MOVE_SPEED;
    else if (active && state.globalDirection === "right") state.position.vx = MOVE_SPEED;
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
    const floor = floorY();
    const right = screen.width - BALL_SIZE;
    state.position.y = floor;
    state.position.vy = 0;
    if (state.position.x < 0) { state.position.x = 0; state.position.vx *= -0.35; }
    if (state.position.x > right) { state.position.x = right; state.position.vx *= -0.35; }
    sendWallpaperState();
    peerSync?.publish({ ...state.position, moveSpeed: MOVE_SPEED_SCALE });
  }
  requestAnimationFrame(physics);
}

window.desktopMeow?.onGlobalMove(move);
window.desktopMeow?.onMouseMove((position) => {
  if (!state.user || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
  if (position.y < screen.height * CLICK_MIN_HEIGHT_RATIO) return;
  state.targetX = Math.max(0, Math.min(screen.width - BALL_SIZE, position.x - BALL_SIZE / 2));
});
window.desktopMeow?.onControlMode((compact) => {
  state.compact = compact;
  document.body.classList.toggle("compact", compact);
  render();
});
window.desktopMeow?.onWallpaperMode((enabled) => {
  state.wallpaperEnabled = enabled;
  render();
  toast(enabled ? "粉藍動態桌布已啟用" : "動態桌布已停用，角色層仍會運作");
});
window.desktopMeow?.onWallpaperError((message) => toast(`桌布啟動失敗：${message}`));

watchAuth(async (user) => {
  stopProfile();
  stopFriends();
  peerSync?.stop();
  peerSync = null;
  state.user = user;
  state.profile = null;
  state.friends = [];
  state.remote = [];
  state.position = { x: screen.width / 2 - BALL_SIZE / 2, y: floorY(), vx: 0, vy: 0 };
  state.targetX = null;

  if (user) {
    // Authentication and Firestore setup are separate steps. Render the signed-in
    // account immediately so a Firestore rules/network error cannot leave the
    // Google button permanently stuck in its loading state.
    render();
    window.desktopMeow?.collapseControl();
    peerSync = createPeerPositionSync(user, (players) => {
      const previousOnline = state.remote.map((player) => player.id).sort().join(",");
      const nextOnline = players.map((player) => player.id).sort().join(",");
      state.remote = players;
      sendWallpaperState();
      if (previousOnline !== nextOnline) render();
    });
    try {
      await ensureProfile(user);
    } catch (error) {
      console.error("Unable to create or update the Firebase profile", error);
      toast(`已登入，但雲端資料同步失敗：${error.code || error.message}`);
      return;
    }
    stopProfile = watchProfile(user.uid, (profile) => {
      state.profile = profile;
      const ids = profile?.friends || [];
      stopFriends();
      stopFriends = watchFriendProfiles(ids, (friends) => {
        state.friends = friends;
        peerSync?.setFriends(friends);
        render();
      });
      render();
    });
  } else {
    window.desktopMeow?.setWallpaperMode(false);
    window.desktopMeow?.publishWallpaperState({ local: null, remote: [] });
    render();
  }
});

addEventListener("beforeunload", () => {
  peerSync?.stop();
});

render();
requestAnimationFrame(physics);
