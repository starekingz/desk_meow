import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "firebase/auth";
import {
  arrayRemove,
  collection,
  doc,
  documentId,
  getDoc,
  initializeFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseReady = Object.values(firebaseConfig).every(Boolean);
const firebaseApp = firebaseReady ? initializeApp(firebaseConfig) : null;
export const auth = firebaseApp ? getAuth(firebaseApp) : null;
const db = firebaseApp
  ? initializeFirestore(firebaseApp, {
      // Electron/WebView environments can leave Firestore's streaming
      // WebChannel open forever. Long polling is slower but substantially more
      // reliable for the desktop build and still supports realtime listeners.
      experimentalForceLongPolling: true,
      experimentalLongPollingOptions: { timeoutSeconds: 15 }
    })
  : null;
const provider = new GoogleAuthProvider();

function withTimeout(promise, milliseconds, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function updateFriendsWithRest(myUid, friends) {
  const user = auth?.currentUser;
  if (!user || user.uid !== myUid) throw new Error("登入狀態已失效，請重新登入");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const token = await user.getIdToken();
    const documentUrl =
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}` +
      `/databases/(default)/documents/users/${encodeURIComponent(myUid)}` +
      "?updateMask.fieldPaths=friends";
    const response = await fetch(documentUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fields: {
          friends: {
            arrayValue: {
              values: friends.map((uid) => ({ stringValue: uid }))
            }
          }
        }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const detail = payload?.error?.message || `HTTP ${response.status}`;
      if (response.status === 403) {
        throw new Error(`Firestore 拒絕更新好友清單：${detail}`);
      }
      throw new Error(`更新好友清單失敗：${detail}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Firebase REST 寫入逾時，請檢查網路或防火牆");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function peerRoomId(firstUid, secondUid) {
  return [firstUid, secondUid].sort().join("_");
}

async function patchFirestoreDocument(collectionName, documentId, fields) {
  const user = auth?.currentUser;
  if (!user) throw new Error("登入狀態已失效");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const token = await user.getIdToken();
    const masks = Object.keys(fields)
      .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
      .join("&");
    const url =
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}` +
      `/databases/(default)/documents/${collectionName}/${encodeURIComponent(documentId)}?${masks}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields }),
      signal: controller.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || `Firestore HTTP ${response.status}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("WebRTC 連線協商逾時");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function watchPeerRoom(myUid, friendUid, callback, onError = console.error) {
  return onSnapshot(
    doc(db, "webrtcRooms", peerRoomId(myUid, friendUid)),
    (snapshot) => callback(snapshot.exists() ? snapshot.data() : null),
    onError
  );
}

export function publishPeerOffer(myUid, friendUid, sessionId, offer) {
  return patchFirestoreDocument("webrtcRooms", peerRoomId(myUid, friendUid), {
    participants: {
      arrayValue: {
        values: [myUid, friendUid].sort().map((uid) => ({ stringValue: uid }))
      }
    },
    initiator: { stringValue: myUid },
    sessionId: { stringValue: sessionId },
    offer: { stringValue: JSON.stringify(offer) },
    answer: { nullValue: null },
    answerSessionId: { nullValue: null }
  });
}

export function publishPeerAnswer(myUid, friendUid, sessionId, answer) {
  return patchFirestoreDocument("webrtcRooms", peerRoomId(myUid, friendUid), {
    answer: { stringValue: JSON.stringify(answer) },
    answerSessionId: { stringValue: sessionId }
  });
}

export function watchAuth(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export async function loginWithGoogle() {
  if (!auth) throw new Error("請先完成 .env Firebase 設定");
  return signInWithPopup(auth, provider);
}

export function logout() {
  return auth ? signOut(auth) : Promise.resolve();
}

export async function ensureProfile(user) {
  const profileRef = doc(db, "users", user.uid);
  const existingProfile = await getDoc(profileRef);
  await setDoc(
    profileRef,
    {
      displayName: user.displayName || "玩家",
      email: user.email || "",
      photoURL: user.photoURL || "",
      ...(!existingProfile.exists() ? { friends: [] } : {}),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export function watchProfile(uid, callback) {
  return onSnapshot(doc(db, "users", uid), (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() : null);
  });
}

export function watchFriendProfiles(friendIds, callback) {
  if (!friendIds.length) {
    callback([]);
    return () => {};
  }
  const unsubscribers = [];
  const chunks = [];
  for (let i = 0; i < friendIds.length; i += 30) chunks.push(friendIds.slice(i, i + 30));
  const results = new Map();
  chunks.forEach((ids) => {
    const q = query(collection(db, "users"), where(documentId(), "in", ids));
    unsubscribers.push(
      onSnapshot(q, (snapshot) => {
        snapshot.forEach((item) => results.set(item.id, { id: item.id, ...item.data() }));
        callback([...results.values()]);
      })
    );
  });
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export async function addFriendByUid(myUid, friendUid) {
  const normalizedUid = String(friendUid || "").replace(/\s+/g, "");
  if (!normalizedUid) throw new Error("請輸入好友連線代碼");
  if (normalizedUid === myUid) throw new Error("不能加入自己的連線代碼");

  let friendProfile;
  try {
    friendProfile = await withTimeout(
      getDoc(doc(db, "users", normalizedUid)),
      15000,
      "連接 Firebase 逾時，請確認網路後重試"
    );
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error("Firestore 權限不足，請部署專案內的 firestore.rules");
    }
    if (error?.code === "unavailable") {
      throw new Error("目前無法連線 Firebase，請稍後再試");
    }
    throw error;
  }
  if (!friendProfile.exists()) {
    throw new Error("找不到此連線代碼，請好友先登入一次並重新複製 UID");
  }

  try {
    const myProfile = await withTimeout(
      getDoc(doc(db, "users", myUid)),
      15000,
      "讀取目前好友清單逾時"
    );
    const currentFriends = myProfile.exists() && Array.isArray(myProfile.data()?.friends)
      ? myProfile.data().friends
      : [];
    await updateFriendsWithRest(
      myUid,
      [...new Set([...currentFriends, normalizedUid])]
    );
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error("無法更新好友清單，請確認 Firestore 安全規則已部署");
    }
    throw error;
  }
}

export function removeFriend(myUid, friendUid) {
  return updateDoc(doc(db, "users", myUid), { friends: arrayRemove(friendUid) });
}
