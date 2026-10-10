import {
  publishPeerAnswer,
  publishPeerOffer,
  watchPeerRoom
} from "./firebase";

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};
const SEND_INTERVAL = 100;
const RETRY_INTERVAL = 30000;

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 6000);
    function done() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

function parseDescription(value) {
  if (!value) return null;
  try {
    const result = JSON.parse(value);
    return result?.type && result?.sdp ? result : null;
  } catch {
    return null;
  }
}

export function createPeerPositionSync(localUser, onRemotePlayers) {
  const peers = new Map();
  const remotes = new Map();
  let latestPosition = null;
  let stopped = false;
  let lastSent = 0;

  function emitRemotes() {
    onRemotePlayers([...remotes.values()]);
  }

  function markOffline(friendId) {
    if (remotes.delete(friendId)) emitRemotes();
  }

  function bindChannel(entry, channel) {
    entry.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      entry.retryAt = 0;
      if (latestPosition) sendTo(entry, latestPosition);
    };
    channel.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (
          payload?.type !== "position" ||
          !Number.isFinite(payload.x) ||
          !Number.isFinite(payload.y)
        ) return;
        remotes.set(entry.friend.id, {
          id: entry.friend.id,
          displayName: entry.friend.displayName || "玩家",
          photoURL: entry.friend.photoURL || "",
          x: payload.x,
          y: payload.y,
          vx: Number(payload.vx) || 0,
          vy: Number(payload.vy) || 0,
          moveSpeed: Number.isFinite(payload.moveSpeed) ? payload.moveSpeed : 0.7,
          online: true
        });
        emitRemotes();
      } catch {
        // Ignore malformed or obsolete peer packets.
      }
    };
    channel.onclose = () => markOffline(entry.friend.id);
    channel.onerror = () => markOffline(entry.friend.id);
  }

  function sendTo(entry, position) {
    if (entry.channel?.readyState !== "open") return;
    entry.channel.send(JSON.stringify({ type: "position", ...position }));
  }

  function closeConnection(entry) {
    entry.channel?.close();
    entry.peer?.close();
    entry.channel = null;
    entry.peer = null;
    markOffline(entry.friend.id);
  }

  function makePeer(entry) {
    closeConnection(entry);
    const peer = new RTCPeerConnection(RTC_CONFIG);
    entry.peer = peer;
    peer.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
        markOffline(entry.friend.id);
        if (peer.connectionState === "failed") scheduleRetry(entry);
      }
    };
    return peer;
  }

  function scheduleRetry(entry) {
    if (stopped || !entry.initiator || entry.retryTimer) return;
    const delay = Math.max(0, (entry.retryAt || 0) - Date.now());
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      startOffer(entry).catch(() => scheduleRetry(entry));
    }, delay);
  }

  async function startOffer(entry) {
    if (stopped) return;
    entry.retryAt = Date.now() + RETRY_INTERVAL;
    const peer = makePeer(entry);
    const channel = peer.createDataChannel("position", {
      ordered: false,
      maxRetransmits: 0
    });
    bindChannel(entry, channel);
    const sessionId = crypto.randomUUID();
    entry.sessionId = sessionId;
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGathering(peer);
    if (entry.peer !== peer || stopped) return;
    await publishPeerOffer(
      localUser.uid,
      entry.friend.id,
      sessionId,
      peer.localDescription.toJSON()
    );
    scheduleRetry(entry);
  }

  async function acceptOffer(entry, room) {
    if (!room?.sessionId || entry.acceptedSessionId === room.sessionId) return;
    const offer = parseDescription(room.offer);
    if (!offer) return;
    entry.acceptedSessionId = room.sessionId;
    const peer = makePeer(entry);
    peer.ondatachannel = (event) => bindChannel(entry, event.channel);
    await peer.setRemoteDescription(offer);
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForIceGathering(peer);
    if (entry.peer !== peer || stopped) return;
    await publishPeerAnswer(
      localUser.uid,
      entry.friend.id,
      room.sessionId,
      peer.localDescription.toJSON()
    );
  }

  async function acceptAnswer(entry, room) {
    if (
      !entry.peer ||
      !room?.answer ||
      room.answerSessionId !== entry.sessionId ||
      entry.peer.currentRemoteDescription
    ) return;
    const answer = parseDescription(room.answer);
    if (answer) await entry.peer.setRemoteDescription(answer);
  }

  function addFriend(friend) {
    if (peers.has(friend.id) || friend.id === localUser.uid) return;
    const entry = {
      friend,
      initiator: localUser.uid.localeCompare(friend.id) < 0,
      peer: null,
      channel: null,
      sessionId: null,
      acceptedSessionId: null,
      retryAt: 0,
      retryTimer: null,
      unsubscribe: null
    };
    peers.set(friend.id, entry);
    entry.unsubscribe = watchPeerRoom(
      localUser.uid,
      friend.id,
      (room) => {
        const task = entry.initiator
          ? acceptAnswer(entry, room)
          : acceptOffer(entry, room);
        task.catch(() => {
          markOffline(friend.id);
          if (entry.initiator) scheduleRetry(entry);
        });
      },
      () => {
        markOffline(friend.id);
        if (entry.initiator) scheduleRetry(entry);
      }
    );
    if (entry.initiator) startOffer(entry).catch(() => scheduleRetry(entry));
  }

  function setFriends(friends) {
    const activeIds = new Set(friends.map((friend) => friend.id));
    peers.forEach((entry, id) => {
      if (activeIds.has(id)) {
        entry.friend = friends.find((friend) => friend.id === id) || entry.friend;
        return;
      }
      clearTimeout(entry.retryTimer);
      entry.unsubscribe?.();
      closeConnection(entry);
      peers.delete(id);
    });
    friends.forEach(addFriend);
  }

  function publish(position) {
    latestPosition = {
      x: position.x,
      y: position.y,
      vx: position.vx,
      vy: position.vy,
      moveSpeed: Number.isFinite(position.moveSpeed) ? position.moveSpeed : 0.7,
      sentAt: Date.now()
    };
    const now = performance.now();
    if (now - lastSent < SEND_INTERVAL) return;
    lastSent = now;
    peers.forEach((entry) => sendTo(entry, latestPosition));
  }

  function stop() {
    stopped = true;
    peers.forEach((entry) => {
      clearTimeout(entry.retryTimer);
      entry.unsubscribe?.();
      closeConnection(entry);
    });
    peers.clear();
    remotes.clear();
    emitRemotes();
  }

  return { setFriends, publish, stop };
}
