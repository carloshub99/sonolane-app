import { useState, useEffect, useRef, useId } from "react";
import { supabase, isSupabaseConfigured } from "./lib/supabaseClient.js";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Keeps a component's IDENTITY stable across re-renders while always running
// its latest closure. The app's top-level page components (ProfilePanel,
// CreatePanel, etc.) are defined fresh inside SonoLane() on every render so
// they can close over all the shared state — but that means each one is a
// brand-new function every render, and React treats a new function as a
// brand-new component type, fully unmounting/remounting the whole subtree
// (destroying every <input>'s DOM node, and with it browser focus/cursor
// position) any time ANY state in SonoLane() changes — including the very
// keystroke that just landed in a text field. Wrapping a panel's render
// function in useStablePanel gives React one unchanging component reference
// to reconcile against (so it re-renders in place instead of remounting)
// while still executing the freshest closure on every call.
function useStablePanel(render) {
  const renderRef = useRef(render);
  renderRef.current = render;
  const stableRef = useRef((props) => renderRef.current(props));
  return stableRef.current;
}

// Persisted storage — backed by real browser localStorage wherever it's
// available (a real deployed app on a phone or in a normal browser tab),
// with an in-memory fallback for sandboxes that block it (e.g. the Claude
// Artifact preview iframe). This keeps things like points, achievements,
// and car customization saved across closing and reopening the app, while
// still never crashing anywhere localStorage access throws.
const memStore = (() => {
  const fallback = {};
  let hasLS = false;
  try {
    const testKey = "__sl_ls_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    hasLS = true;
  } catch { hasLS = false; }
  return {
    getItem: (k) => {
      if (hasLS) { try { return window.localStorage.getItem(k); } catch { /* fall through */ } }
      return k in fallback ? fallback[k] : null;
    },
    setItem: (k, v) => {
      const s = String(v);
      if (hasLS) { try { window.localStorage.setItem(k, s); return; } catch { /* fall through */ } }
      fallback[k] = s;
    },
    removeItem: (k) => {
      if (hasLS) { try { window.localStorage.removeItem(k); return; } catch { /* fall through */ } }
      delete fallback[k];
    },
  };
})();

// Dashcam footage storage. Recorded clips are real video Blobs — localStorage
// can only hold strings, and the URL.createObjectURL() address used to play
// a clip back dies the instant the page reloads — so the actual video data
// lives in IndexedDB (the one browser storage that can hold binary Blobs),
// and every time the app opens we regenerate a fresh playback URL from what's
// stored there. Clips older than the retention window get purged on load
// (and periodically while the app stays open) so recordings don't quietly
// fill up the device's storage forever.
const CLIP_RETENTION_MS = 72 * 60 * 60 * 1000; // 72 hours
const clipsDB = (() => {
  const DB_NAME = "sonolane_dashcam", STORE = "clips";
  let dbPromise = null;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };
  return {
    async put(record) {
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(record);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } catch { /* IndexedDB unavailable (e.g. sandboxed preview) — clip just won't survive a reload */ }
    },
    async getAll() {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => rej(req.error);
        });
      } catch { return []; }
    },
    async remove(id) {
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } catch { /* nothing to clean up if the DB never opened */ }
    },
  };
})();

// A useState that automatically saves to (and loads from) memStore under
// `key`, so profile/car customization survives closing and reopening the
// app — not just refreshing within the same open tab.
function usePersistedState(key, initial) {
  const [value, setValue] = useState(() => {
    const raw = memStore.getItem(key);
    if (raw === null) return initial;
    try { return JSON.parse(raw); } catch { return initial; }
  });
  useEffect(() => { memStore.setItem(key, JSON.stringify(value)); }, [key, value]);
  return [value, setValue];
}

// Generic key→value store in IndexedDB, for persisted state too big or too
// numerous to trust to localStorage (see usePersistedIDBState below).
const kvDB = (() => {
  const DB_NAME = "sonolane_kv", STORE = "kv";
  let dbPromise = null;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };
  return {
    async get(key) {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(key);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      } catch { return undefined; }
    },
    async set(key, value) {
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } catch { /* IndexedDB unavailable (e.g. sandboxed preview) — falls back to whatever usePersistedIDBState already had in memory */ }
    },
  };
})();

// Same shape/contract as usePersistedState (drop-in replacement) but backed
// by IndexedDB instead of localStorage — for state that can hold big base64
// photos (car exterior/interior/private galleries, avatars, banners, shared
// garages, route/event posts, the whole myCars array…). localStorage's
// total quota is only ~5-10MB PER ORIGIN, shared across every sl_* key —
// once a device's saved photos add up to that, a browser's
// localStorage.setItem() call throws QuotaExceededError. usePersistedState's
// memStore swallows that error and silently keeps the new value in an
// in-memory-only fallback object instead of on disk — so the app doesn't
// crash, but that value quietly stops surviving a real reload: it looks
// saved while the app stays open, then reverts to the last value that
// actually fit, the moment the app is closed and reopened. That's exactly
// what "my interior photo doesn't save when I close the app" was — the
// interior gallery just happened to be the item that pushed a device over
// the localStorage limit. IndexedDB has no such tiny quota (typically a
// large share of free disk space), so moving anything photo-sized here
// removes the failure mode entirely instead of papering over one symptom.
// One-time migration: the first time this runs for a given key, if
// IndexedDB doesn't have a value yet but the OLD localStorage-backed copy
// does, that gets copied over (and cleared out of localStorage, freeing up
// the quota that was the whole problem) so upgrading never looks like it
// wiped out anyone's saved cars/photos.
function usePersistedIDBState(key, initial) {
  const [value, setValue] = useState(initial);
  const loadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let v = await kvDB.get(key);
      if (v === undefined) {
        const raw = memStore.getItem(key);
        if (raw !== null) {
          try { v = JSON.parse(raw); } catch { v = undefined; }
          if (v !== undefined) {
            kvDB.set(key, v);
            memStore.removeItem(key);
          }
        }
      }
      if (cancelled) return;
      if (v !== undefined) setValue(v);
      loadedRef.current = true;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Never write before the load above finishes — otherwise this fires on
    // mount with `initial` and overwrites the real saved value with a blank
    // one a split second before the load resolves.
    if (!loadedRef.current) return;
    kvDB.set(key, value);
  }, [value]);
  return [value, setValue];
}

const OR = "#f97316";
const STAR_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAj1ElEQVR42u19aZOdx3XeOae73+3u6+wzwGAjQJAUF5HWEkeOy5XFqdhJuVz5lE/5AfkB+ZLKl/wJV8WSrcVybEdyKFGUuEuiKEoEN4BYBxgMZl/uzN3epfucfHjvQBBNU6JEDmqo6apBzeBO3bn3PKfP8pyn+6KIwNG6f4uOTHAEwBEAR+sIgCMAjtYRAEcAHK0jAI4AOFpHABwBcIiWHHYq5bADgIgIhxmDwwqAgABA3Nu8c+0nAAggRwAcMALMANtrby3f+NbO9hYAHtJYdFgBQKQkdr3thUD1F69fBAARPgLg4DIvAHZ21inbDH1aW3wHAAjpCIADTAEAu5tLpSAxJhjuXO/HGeChzASHEgAEEIH+zq1iWQFpjlc311cADmU1dDh3AFK3n9jBUhj5IqS4u7WycFQFHWQCgM31FQPb5PmScaBlc+lixoBHIejA1tbKQr3sgMhx6vlqsHNjZ7sDSIeuGD18ACBiZmXYudWohSDA4rQ2Kt3Y2LhzFIIOqAHu7OxiulaohM4hsABSQMn28k0WQDwC4BOufwBgY2PFox2KInEWRUQoCKSzfj2Ok6Md8IkvZthavVkrZaA8FAYAFvR8GOxc39na3sfoCIBPbPUGcbJ3p9EKAYRH5na+8j27ubmxIQKHKw8fPgA6u3vKrlerJWHJI76wAKpIp9sbt9I0w0OVBw4dANzZXi96fVUImRlAmBkERTAMpLd5sz9MDhchccgASBPubCyVSykoH0REJOcfmDnwTLx7c3dv9ygEfYINcH+YxrtL9YYHjPuFKQAACytllNvsbK4frlbs0ACAiADS7fUMb9UqRQZBBAECAUQBAVQUqsHO5lKa2SMAPqFNALudrYLa1UHhHuZT8gZBBIsahpu3hsMEgA/LPjhMAKSZ3dtaKZdS8DXy3cgkeS3KjNqj4d5irzcQlsOSig8TAHHi4t3lesUAeoIASAAoLABAiCLO8zxMV7e2VlngsBSjhwmAbq8L9k6pGoIgIiJgPovPbU2ISptQDTsbS6l1RzngY16OubOzWVCdoFgScbBvfQFgHsUjFigYiDt3kiSDQzKjPzQAWMf9nbVqlKEf7lf6vxzlEUQwCHXcudnr9uRoB3xoTf9R3VPSJBvuLNYqPqBCEEEGYEARYUQUAERCBOMZjNd2dzaZ5aO+pvsibKGDtDqAuCxzDhEJRtqqX9dMvX7MyXKlFoCIIODoHwEnoycXARFUOlDdnc3lzPHd9u1Xm54dIiKSs07YHWQFpQ/S8Vloe/GF3d2b4j88O/8ZP/QBgNkh0ocXLSKy29kumW5QrDPzvQogzE28X4wCUBRgv3Mrjq1vFH6oWEiYAQGRANX68nJv++3exttTZ/9jY/wEyAENdw4OAETq9eIbS3sT/qWhW379me/41c888MQfFYsFABB28M/DkFnu7qyUowz8CEQAEAEBMQ8ciAiIzIyESrRvdGd3cdjvV0r+h5geEZEIAJZv37j2s6frtU6WbC1c2aPWH9fHGA9K5nWgOYAwS9XM6lqpkPUeeKxdpR++8tX/9ur3v7a9vYWkEJGZPygQS5q5wc5SpYgg9MEQ7ccMZqeU4v5Kp7P5QeFHmB0AIBEgLlx+59mv/6/rL/3Phx9JdQA337xqWk8GUUGYP5UhCMIgmpmZem/7bHP4cu/ti9NPPX7yoeE7Lz3z0lefrkx8/uzn/nh8cnYUqwRy98yjeL/bd4PFyrEAhCHPub9M0o1EWQwCloiU62yvL2XzJ3wfRzMyERFGUkTKOrny1ssLF54J7PWHHpkaf/JPfv7ChasvvlScfrgy92i7WSGlP50AkFK1eqHcPHln49qDrc1rL/944omnzv/Jfzh1/Z1LP3vxR197Nhh78qEv/OnM8QcQR3UJEgFLd2/P8HoQ1mXk6ngvAHlTJiKCIgwibCjpbS2m1vm+zssbIoWo4iR997XvL779nSIufeb81NT5L0Ft7pV/+P7tNy+MTTX71Scm2q0wDA/SJgcKAABEQTQx2X5v69zm3otzk7XFV39oB5+ZOvPoZxpjJ5cW37vwxk++/sobzYcf/MKfHj/3JCECgHVZZ2clxCGS4RySf7bKAhYGBkXQ6yz0B4NiqJE0otrb3bn42vfuXPxOmTYeOzc7c+aL1BoTXX3+699auXx1ZqqyjbNjU2dq9arW5tMMgDFeo16uTZxcvHaxEC1PzbSW3n4jS+JjD58rKvN4rTm/vLJw+b23vvXfL7105sRn//Tkw19C43XXF8bU3i9ifU5DEIBA7vN3MwEBsggIdDeu9/d62KpvrS+/99rT65e+Wwv7nz07PXH887pehko9dYXnvvy3u3eWp2cavQTVxBNjY+1iVDhgEumgAQCAMCxMtqvvbjyyvr082UqmplorV9+9nqYnnniMja549FCjMr++tX7r1uIL/2P1jW96k09I562xuUicRRQAAcy/cDQQ+2WTCTM5wcGdK69+Zf2tYPfmyyV/78mHjzemz5laHSMfy414SM9++ZvDra32eD1L49R/ZHz6TL1aMsbcDWufTgBERGtdrZbb48c3rp6o9i+HRT09PbF8+8aVODv9xadEKTR+yfOjSmHyWHd3dWnQ+/vimbNBEAHkLZLs5wCEERS/yMoiwOKcc3PHZ49N3Bou3zr18ETUOq2jiqlWXRiqQr3XiZ/5y29If9AcrzqXJRIGY4+2m/WoUMztfpCb4KAByN9bGEStZmVr48HNvRuTZpiYYGKqubq69M5L6bkvfJ5KHmqNnkHfbxVDHHSgWY1TDcQiDkGNeJ+8usk74P0oxMLMDkidevxMW+9lxQCqVR0VVLHMQaCDxvb67vf+8m994UqzJM6BzVzpsbHJ+Xpl5P6/E2ScNqZSLrbGZzvwwKDfZ+E0tWPjLb23+e5zL1rxsVClUlVX6qZWx3JDpUNdLKQWEfX7eALmXzqpigAucdXZ2Va7kFqr2i2v2lCVhgsLFIyt31p/+i++FgBX6xEzk3As1XDsiXajdtf9fycAQMRCVGo3K6r+0Fa/7OIesyRJ0h5rBK739vefs4nBsAqFIpYqqtoQTYEHCRpxmUiuEMU84IgDEPyF+wsIqOPnTyo3NJU6VetYqnAQKn/s9tWF737lmxXPK1UCl1kETLKEKw/Vx2crlZLnmftiivtGR2ujK6VSqz22Z84P+olkKYpLk7TZrNdVduHZ7w27GQU1CIpUqmCxSjbWUSUeJES0P3FEEcnVQfttA6SDYePYVHOswCxUblJYcSYg077+1rvPfuXva4UgKmp2TgSydBhDK5p8rF0vRFHxfmka7+c8wA/Cer0UNM5vJ21I99hlwjZJk0q92gjx7e8909/poamLX6Rqg5XyI7Lkc5beEyuEWXI0RISdFcLZh05DFkOhCsUya1/p9qXXfv79r/3DWL0UFrSwAGOWZWmSUfOJdnuiVCoZo++XEe4nAMaYSqlcb9U73vlBz2KWscvAZXE8rFfL043CWz/4QWdtA1UTdBELdQWJV6oMezHQ6CyMADBwnoWRVJZkjRPHaq2qCEGxLhSSal548fnn/+7pqYl6EBAwgIjNrBv2nZmoTj5Wr5UKheJ9NMJ9AkDy4OH8IGxUi8Xx81swT3HPDWJJMxCXZlmhEsyNFd977tmtpQVUdQhKYjy/5DmKXBwD4cj/WQhRANgxoD7x0DlAx8US6Iio+pPvPPPyt5+fm65GngYBcZwlaZoMnZVg5g9a7Ua5VFKKmN390tPRQZpcmEfjjpwLJmWMqVQamjMMg+rJ+UKl4GzKw5htkiS2UCjMH29ffvnFjeuXUTXFlJHYq1aGvRRp1Afn8kQijIe9sZPzxbGqI0GvSVh64f/87avPvnTi2LivlGPrbOZsKiKe7/nlYpb0fc+UKlUiRaTysJa7hTAfGB76EzV5/pUPmxB/0bIOB/2ttcW1pSu7aze669fczs1GRe6Y4/XxWqVczXqDNBk4YWEOPHN6fvzqqz9Ms8HUA4+x3QzKNOyYtN/zyrW8JBURdkw6mH30LEOKXo1YP/NXf335jfdOzY8bzDtmdo5j67QOgtDLkmHn8tdfuf7c25Mny8355vSZidnTtXpbKXVvLTrirgEhl2F8EgXhxwj1LywOgKTufShJkp2t5a2lG0s3L3Y2rie7K3aw4WFaKahKJazWqsbXIKI9PyqXg0JoiGyaWGdZ2Pc8Qf3e5cWp8w/NPfIUyG7aG/RXFmvT43vL6xdeviDCLk3HH3jw3JeeYNCU4rf+918vXLp15sSERhaUJE2TRJTRrUapXi6QsllqrbX93rCz19vtpb0Bg4r88lixPtecPjV57FyzPVOtj91r85x0ktEFLfhxzct+OwBGJhcEfB9JaS3vbK9ur97aWLl259Y7u+uL3Nsi6BcDr1gwUTGIosj3jdHkGa08pTUpBYqIlCJAZQwqQ0Rsk3zGgqQvXVkcO3n6xJNfAJDdhatRCeLu4M3n38hsBtp89j/9+2J1zPZ2/+Evvra+tHnqRAtt2hu6xLpCZCanm2Otkm8oS9k6tjZzll3GqRNrbZa6eJj2+0m339vrJ8NMo1fyC83WzJmpY2eb4/ON9lS5Uv/lt875G/8tN8dHBEB+0fcT0vu8oLe7s758Y+3Otc7ajfWly4PuKsnQU1wMvWIxiqIoCIxRhjQQEaJoJYq0UooUKqWURiIkUqRIEaLSCCTMzI6FjdKkzaVLC/XJ6VP/8g/TuJ8sX0WACy+/2dnZO/HkE2e/8KV48/a3v/x3nfWdublqb2+QWGk2qrNzjbF2RRHEcWItC6OIOHZsmZ1Yto7ZZsAizMAs7CjNkv5g0OsNut1+HHMiBrxSq32iMXmyMTE/PnOqOT7j+8H7GECB3wSPXw3AvgZ/lDnvfWjY625vrSzfurxx+729zZu93RUbb2vlSoFfLPmFMAyC0HiKCAFBk1KIpACJlAJEIkRSRKSIckhGAKBCUkJESikkYsfOYZqmRGSMunb5ZlRvnP1X/7q3sx7fXnj3wuW9GP7Nf/0vdvvOP/71P3bWu/VG6CxPTLVOzE80WhE7l8SJdcyMwgIsufO6Ua5lZrEswuyYhQUYHLNlZhZ24iynWTYYpr1+d9BP45gz8oNSu1yfqbWPj8892J6er9VaxvM+EI98Xv0bATAy+i9ZPB4OOlurW+u3129dXL99Kemv23hLwaAQmSgMoygKo0iPfBlUblJFiICIlM/ckRFRkYL91IyISlEOABIREhKQkrtSCUWkSbNInCXxMAWAhatLpVpl5rEnthauX3/7au3M6ZOzraf/6unN3Xj2WHN6ujF/YrJSCjnL4iS1zuVelAMgLHnrJgySzxNkHwlhYQFBx8zsnMtLLBaHzJQrL5yz8SCOh8Nuv98dpGmKTAUvrBfrc1Pz5xuT842x2UqtrRT9sgfz+5Lir7sDMsudrTtbqwud9cWtlcu7Gzck3dGYRIEpFcJC0S+EBS8w+RAVUYiIiABy2wMpQkAAyP1bQAgln4nnvkEKR0AAjjBABBRApv3fQUImVKTQaECVWTvo9pdurmmQ26udxdvbZx+YSLvDrlMPPXpsZqZFnoIkc3EszKM3OPJ0kn1DowDv93IsLMz7G2PEcNyzQISFgfOHGVnEOQZhELAuG8bJYC/e6/V7gzTNyFHJK443Jueb4yfr48eak/OFQumj7YB8HNHbvrlw4Vvrty91tlbRxZ7GMDJBFEZBaDwvt/PdcIeKkPLbYnJXVzT6cVQ4ECpAAcBc1YD7xV0e1gRzVY8CEEIQREHUSuWbl4jkbvYhhUqJQNztdZbXFm9urW7unpyrVdqt9rFxbZTLnLCoXNSDDoRAkMWJ5BEHhJGZVT5Fy00rwCw5ocQsd+drd1/9SDQ30qGO/hsBwIFzDhBFwDE752yaDYd2OBzu9YaDOLUZmkK11pg59sDjj/z+f9Ym/Kdyow/cARLHyaW3X9u89gLF68I9dkNO0yzN0pQTB85xlrF1wiLs2LHjkVR25GC5M4Fg/pbzb0AEAXk/h+cEwuiX99WKIiBCiIIg+Y4RYYTRyAUBWThJXWbdeD08NVs3gbfXz0qRurW0t7S6F2ep0loRKsS8S8t1VwLAIMiC+6ksH+Hk0OamRoC8VcmpVtz3ETXq+O56zOi1gYw4WETKdzCiKCWKwGiIgsDzAhP6pEPxK8XGyc9+6c+nZ+bycc+v3gHb29tb251BbPv97rC/nQ07MNzkeFPidY53XdrJ0jTO2FqXZZJasHc3MIMwuJyl5/zJc5UNwohHFgBgl3NoIDyKEDmpKYCCtL/1AffpfkFwDEksaZY0G9FjD822arrXS9OEEaDbTzyjljf21neSnb0hM/va0xoRc3kLEhHhKCoLOMxreUJCUkrlcSiPk8AjYPIgCfsjH8p3IEie1hCFCI1CrZRSYJT4hjzjm7Cgw4qJaiac0KVxHdWDqF4oVcIwCn09NtYOguDXygHOuSzL0jRJ0jSJ0yTJBkmSxPFwOEyHuy7elOGWxBuQ7Eja4axnrbPOZpato8yJG+2MkYMLC4g4Bpbc4uJGD4hwXn3kMTgPZ8gsuT5LANhBZnkQp8wwPV7+3JMnn3xsrrO9/cNXF966uv7Fx+eM4ldeXyKt5qfKJDS06fJad31zmDrnG20MIipEUYS5rVX+R0BIERER5nUGUZ70CREJUBBBOO/heRQolVaKDIFRaAwYg0Yb8nxjquRXKWxS2FaFlglqfqEYBlEQeIHvh572PM/zfc/ztNb4T4rUD0vCI8LMWWuds9koCKVZnHI8TJI4juO9LN6zg02JtyHZ4Gybsp7Yocsy6zhjzKxYK9Y5x+yYHecVwYiKY+bcvnkF6BgAcPQDgxWJUxsPUqXg5Hzzc0+eeuTxE4VSdPnCtedfvPjqm6unjjf/7N+ev3JjeW1n8NyPb062S6dm6sUQQy/oxvHt1d7qei9OM6XIM6QVKaUVKUOoFSECKaWIBB0iECIRaoVEpJVSSo0SmkJPoSLQhNoAKVI6IBOSX8WgrYKWClp+VDNROfAjP/QC3wt843nG8zyjjTaaSCmliOiucOZ9AOgPn1sppZRSxghAeC8eWZpamyVpK03tIE7jOE7iOB52s+EuDDdVtqOSDd9uUzZwNslsZq1klq0Tx+BcXlRIZq3LWJFzjpxzmXPWOWB0LHFie8OkGOjPPjr9+S+cPXN2TpdD6Q3f/PHFH7z83ltXttPM/osnj/mhzhI71Sofm6xevrWVpdnJuXo5gFIhfPRsoT/XuLPWvbW82+1nitLAB6MFERCN1ppQiNgojQikWClttFFKaY1GoyLQSpQCrUI0AXoV8FvoNyho6KjuRxU/KPqBHwZ+6Gujted7nucplcOn9qvBD5iH/yZk3F2tABFprX1fJIpGHuxslmXW2jTNN0caJzaOk2Q4SIddm+yoeAeTTS/bhmxb0h5kqc0yx5BaSS2lmU1SyqzFTJhdYnkwtMM4LZf9pz576vOfOzt3ago8D6yNNzsX37j67EtXL97Y3OvL4w+2Ts+P7Q4GLGhInzpeW1rtr27Ecbp57niLHYTOVIth/ZR/bLq6stFfXO50dgdp6iKjAFGQEbVWmjQZo0KDno8eKaOV0gaMoaAGfg2DpvIbFLS8sBqEhcAPgsDzfRX4vmfy5Smtc4vjb8RJ/GZsKCJCDrIxxveDPJ4756y1NsuyLE2zLM1sHGdxksZJksSDLO7Z4bYMt7x4FdOdIN3JkmE67A8l7dkkie2gF/cTbrYqjz527vEnTrZnx4C0pBnEadrtvfn6le++eOnqrT3rXCnA3/vMMRMo6TIwWOaJRmVybGfh5s5u171zff3ksVYDWByUy3450pVj1dnJ0sZ2b2m5v7XZG/aTCIxWGBkohFQoFLww0n4BgwYEbQyaJmyYsOwFFd/3wjAIPON72vM8Y/K44pGiDwzoB0pH3/3bd1+HUsrzPADg/QCfZZnNsjTLkjRNExtnNknSJE7SpJ/GuzjYUr0N3Vs2ndtaLbcnGufOz507P1VslwA0ZyySEnHS6f301UvPvHDtxvKegHWpPPDg+Kn5mnUigizC4nxtTs9V76x1MyvdAV+6tnH2WMNVgJGr5chT6GuaaZcnG4XdXmV5M0n6w1o1KrePBZUJrzStoqaJqkFUMV7g+57vmcA3vvGNUZ7vaa3z2EJEHzsp/YnMAxBRaw2gPc/Pi07Hzo2iVZamaZbZJMmGSTpM0ywe9nrDmb2XHz+9F1QqAMrFQORysmi43X31hxeffv7y7bUeIYtAFKmnHp30PS+vHlgYhC278WZhaqx4Y7HjaZ2m9uLC1snZGgMwxo2SZ4xGQBBXDnXtmJfYCI79Wbl1xveCMAj8wPOM9n3je542xhijtdknSOhe7enhGMi8z01IESkyxkAQ7GdyZ61N0yRNE5vZO6ub3TtrELMNKyoKSBE4QJT+zu5Lz1/43os3Vrb6ioSAbMYPnh07PtfKGAznqhRhRBJQyjsz11hZ69nMaUXWuqs3N62rjjGjk2oZA195vm9tZtNksNcLh8nszPHAsPZ83/e0NlrrPK5+oJt/QgOZ+6CMy+sEz/PCMBTh3W68cf3p0829oH1GdARKM7Mi6W11n3/2jWdfur6xF2sFKCQipUL4xPlJ4+m7+kTOtbkoznGrGk2PVa4ubipFBGBZrt/uZpmdbiMCSsn4vhitlCpohVu3X9je/r2Hzj2ojCK6b+KE+6mKyLvRhWvXCvEb82fm2ItEGbFOIQx2dp95+ifffu7ydjf1FRIQEVlnz5yozk7Vbeby6a3wiMTP+1QAPD5bKoQmPzOACCxucaV3c2Vvpxd3u1kcu8wxIPhhoervLr79g063fx+tfz8ByEPqyvrO6pXnzp8OqNREMgJAGvfWO//373/83ReuD2PWWgCBUES4WAofOzcOOOroZMThu5FETsQxV4reZLvIwph3TwiIdGe9f31pa3Nv2O2lSWKtcwxQKhXc5utXLr2dptl9/CQOuo/un2XZ1SsXJ6LFxtwsoxJhhbK3uvl333z5mZcWUgZf50MCVEjMcPZEe6xZyq8hcPnARGT/PLCMJhgss+2yH2hCVKQUkUbwCNa34mu3dzd2+3vdNI6tdZmQaRXi9feeW13v3MeLPej+ub8sr+7Ed358+mxZTAAMRLC1uPpXX33luZ8sIqEhQESPyCdSIKWyOTffcPklBYj7ND6AYK4NzQ+qMkBY0OPNIiF5CrVCrUlp8o3e2e1fWdxa3R7u9dIkwcyyH4Zecvn6e68P4+R+Xe6h75f7x8Pk+pULx8e2Cs05Z53SsHp16Rvf+NHrl9a0p/LhmafIEIC4TOlTc41a0VgrQZBT3ziSI+bf7bP4BEgMk42o28vEpQY0krLsHIMh6veyq7c3WWr5vEhpqhXsyq1Xlo4/eHJ+ClH9rgAAwjeXVmDnZ8eeagiTInvr3Rtf/fprFxe2gsAjAEVgPBMRG0yjoo86mGoUrZUgIgRklvyze5jzS/tYZMQqakKH2jd2vO4heHYQp85m6KeWM+eU9oaxvbq47RyLsNK6VDLF3tWFS6+3W81KORid+PvUA7DXG96+euHM7NCUJyFLr79x7ctf+9HCyl4hNIAYGioFquhhqVqpTjxoWg/A3sWgex0VkML9kZXkHLZlYSFiHI23gJRhL1OTjVLh1B8Sw97Sm3ubi71hMki9QeaIME7cwu2OswBEWtdqRVxe+9GtW+cfPDevlP6U7wABEOduLNwJsnem51vg4NJr737lb35+Z71XirTWqhypVklXGmPVqQcrM5+LahOpmN3Fis6WVC4gHA0JQUiEwY1GurQ/6USlKPAFizON2S8WSyV54Eu7q2/t3nptd31hu9vr9fRAZYPU3VzdydgS4NxsvYp3Fq+/Njk11qyXD1infuCNGMhWp7u68PrjpxUFwYXvvf6Vv/np5iCtl/1iCOO1qDE2UZp+tDz9eKUxH0W+pzBJU9ubyLYbilIAYgbkXLoAwuhy9cg9Z7uQ0DNK1+aqjVqjEgnWau3x3uxTu2uXWkuvdlYub291tnu2M1B3VrvWAig8MV3ubrx288bD1dJZbcyn+ZBemqU3ri+0otutmfJP/t+P/vJvfu4cH2t5Y9ViY2KmPPN4derxcnOqVAwKYeB7PhL1u92tUi0N64Ar+dnIvP4UIuc4F48wc65pAUCFotDT5elCVKhWa9oY5+ywFFbqje70Q9XVy82ln26vvL2xvr2+A2tbg9Suk1KzLVm58erE5MTUZPNTfEhPNjZ63bVLv/+o//K3X//qN16rlMzsZLMxPleY+mx56sFGfbpaKRSjINjXXoiIczYIC91gQtI7Mhrisewr3HMtMyHnOgjKD3dTwSuMh4EJoygnaAuFYrmU9CthtVLdHj8Trt0o3Xm9ceftndWVa6u9H71x2zw+WVbv3Lz1aLNZ8r3g0wlAmmWLt2/ONldf+sHPvvWtN06dak/Png3bj5TGz9YbY/VasVQshkFoPO9erttoE4UBhJNgPUQSFkEQgVyP4QSsoAhoFkJBJCLhsOGXmr5vjNb5U2mttdZ+EJaKSbkU7JRKW/WZ0vhTtfWf15ffXLh286Wf3vq9R22j8LO1mdmZKe/Abks5UAA2t/akd+nylZde+/naU7//R5Wpx3RtttloNmvlaqUSFQp63173LqV14GsTtbhbREjzmxJFhBkds3PMzEQqbwcgn8EH40Gh7Hve+yTDRBgEoef5UaFYKRd2qqWN+rjXfrQ0fWnlys/eevfSA/Z79dnHxloV3w8O5sqggwPAOdvd211dXtnozj357/48qk6VypVWvVyt1aKoYIz55yKv0irwPS+qpVQBWQU0AsLM6PIcYIUZgPKuHgEESRUmw8D37tlJ91LKRBSGoe/7hUKhUiptVQqb1bHK+Gday++tLb65s3671z/t+8Gn7cImZjGaps78wfGHA0VYiPxatVYslYzxPvydKlK+54VRtK0bzMvKEFgRoXwkLQzMwE4EJRf8MBmv2A79QGv9IVwIEUVRFIRBsVSqVHZ294rtiZn5R76k0AnbT2EO0FqPj4/ValV2ThsdBKE3UhTLryy9tTFREGz4bTcE44EVZM4vyRIW4P17igWRyInXDgr10NeK1K8cGRFSoVAIw7BWqcVJLCzG8/6pfOrTAAAiRlF09zaej1TqGW2C0FdhO+0XjHX7snKwTqxjy6BFGNkhCDAE7TAsG0+T+nW5HSKKCoUwiuTuJOHTyobi/vpI/Dsp5fsqCOsZlMVmfFflvK9rll88t6JoLIgiz5iPOmkZyeMPlgu6n/OAX/+XlVK+50dhlOq63ZcyWmbr8irIjXS4IIKeLkyEgTnge5cOHwAfFS1jjBcGzm+nQsAoDM6KtcwOmAGAUFCLE1PzwrpnlNL6CICPcymlw8Aof8yKj2Bdfi/NaC6Wk0xIhBC0w6gS+L5S6giAjxmAKPBNVHNYYhTL7Ky17CygYxBmIAVaUzQeRIHnGaSj6+s/ZgBIGxVEUaaauYo/L/95pEsBRQ7IU9FYGGqtzdHnB3zcL5TIGC8KAzFtNxqI4b0XrCoE9CpeVPO1p7RGOALgE8jDgedR2LASoIBjZ4FzbaIAakT2W35U9n3vsCQAOFyfoKGU8QOtg4ZTVQQngLJ/iZ8iJEXgj0dh5Pne/dVafWoB0Fr5nh8Uik7XETMAFEsWAIQ0MGpfhWOh75nDkwAOGQCjKBT4zrRQdN4L5xojIhCvrAv1MPCU0YfowyQPEwD5eZAw8NBvOyooglwdiohGE3pjUVTxfKOVhqMd8IlFIRP4ng6rqSoTinPCIoRiDHEwHoaR+egU0BEAv9bKCTeltO8ZPyo53dL5YXwGAqd0qMJ24JsjAD7BBAAARGg8Lwx9Nm1UBhGFwVcEfsVEtSjw78vtt79DIQgRPeMVQh+CtpCvEADQM4KjDsAcvLTtdw4AbUwY+F5YyXTZaAcIfqAlaodBwfMOUwt2KAEAAKVU4HtBVBSvpZQhFBMUVTgehoFnvMOVAA4lAKNiNAzBG9eatEblV7ygGYVaH7YEcGgB8LxCGFDQIBX4HqigGUYV//DMAA43AABgjBeGnhc12NQ8BIgm/UIUHAFwkGkgiqJyuYlBSwVeUJ4pl4q+Hxy6BHBYASCiKAzrzWaldbzZmKqNHatVS+YQJgC4b0eUfuti1A+Ceg2Pn3syqlanp2aLxaLWh/O93K/zsb89LSEicZzESVoqhlp7iHAEwNH63cgBRwAcrSMAjgA4WkcAHAFwtI4AOALgaB0BcJjX/wdJ9YE5FkE5jgAAAABJRU5ErkJggg=="; // golden compass-star app logo (sign-up header, PWA icon match)
const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
const AI_PALS = [
  { id:"nova", name:"Nova", emoji:"🔵", color:"#6366f1", desc:"Calm & intelligent" },
  { id:"roxy", name:"Roxy", emoji:"🟠", color:"#f97316", desc:"Energetic & fun" },
  { id:"kai",  name:"Kai",  emoji:"⚪", color:"#555",    desc:"Minimal & tactical" },
  { id:"luna", name:"Luna", emoji:"🟣", color:"#a855f7", desc:"Warm & caring" },
];
// Simulated community directory — seeds the Followers / Following lists so those
// panels have someone in them out of the box (no real backend/multi-user system).
const SAMPLE_PEOPLE = [
  { id:"p1", name:"Mia Chen",       handle:"mia.drifts",    initials:"MC", color:"#6366f1" },
  { id:"p2", name:"Jordan Cole",    handle:"jcole_gt",      initials:"JC", color:"#22c55e" },
  { id:"p3", name:"SoCalDrifter",   handle:"socaldrifter",  initials:"SD", color:"#a855f7" },
  { id:"p4", name:"Freeway Fiona",  handle:"freewayfiona",  initials:"FF", color:"#ec4899" },
  { id:"p5", name:"TruckDog99",     handle:"truckdog99",    initials:"TD", color:"#14b8a6" },
];
// Simulated "transcribed & summarized" CB chatter — when someone broadcasts on a
// freeway lane, their voice note gets boiled down to one of these so anyone
// browsing lanes (before driving) can skim recent road conditions without
// joining the live call.
const TRAFFIC_REPORTS = [
  { icon:"🐌", text:"Heavy traffic backed up near the main interchange" },
  { icon:"✅", text:"Accident cleared — lanes moving again" },
  { icon:"🚧", text:"Construction closing the right lane ahead" },
  { icon:"🟢", text:"Smooth sailing, no delays right now" },
  { icon:"👮", text:"Highway patrol running radar past the north exit" },
  { icon:"🔀", text:"Merge traffic building past the split" },
  { icon:"⚠️", text:"Stalled vehicle on the shoulder, use caution" },
  { icon:"🌧️", text:"Light rain making the pavement slick" },
  { icon:"🐢", text:"Rush hour crawl through the downtown stretch" },
  { icon:"🪨", text:"Road debris reported in the fast lane" },
];
// Simulated speech-to-text caption for a voice message — every hold-to-talk
// clip in a lane gets one, shown collapsed under the waveform bubble so it's
// skimmable without pressing play (no real transcription backend).
const VOICE_TRANSCRIPTS = [
  "Hey, you around for a drive later?",
  "Just got on — traffic's moving pretty well right now.",
  "Anyone know a good spot to grab food after this?",
  "Pulling up in about ten minutes.",
  "That was a fun run, let's do it again soon.",
  "Copy that, see you at the meet.",
  "Can barely hear you, mind repeating that?",
  "Nice fit on that car, what mods you running?",
  "Heading out now, catch up with you all in a bit.",
  "Loud and clear — let's roll.",
];
const CB_HANDLES = [
  { name:"SoCalDrifter",  color:"#6366f1" },
  { name:"NightOwl_Mike", color:"#22c55e" },
  { name:"TruckDog99",    color:"#a855f7" },
  { name:"FreewayFiona",  color:"#14b8a6" },
  { name:"CruiseCtrl",    color:"#ec4899" },
  { name:"VanLife_KC",    color:"#f59e0b" },
];
// Simulated public lanes made by other community members — anybody can make
// their lane public, so this seeds the "Public Lanes" browse section with a
// few live ones (a proximity chat network, like CB freeway channels) so it
// isn't empty before you or a friend has created one. Filtered down to ones
// "near you" the same deterministic way as posts/events (see milesAwayFor).
const SEED_PUBLIC_LANES = [
  { id:"pub_meets",   name:"weekend-car-meets", desc:"Weekend car meet coordination", color:"#f97316", host:"SoCalDrifter" },
  { id:"pub_night",   name:"night-cruise-crew", desc:"Late-night cruise squad",        color:"#6366f1", host:"NightOwl_Mike" },
  { id:"pub_builds",  name:"jdm-and-euro",      desc:"JDM & Euro builds talk",         color:"#22c55e", host:"TruckDog99" },
  { id:"pub_offroad", name:"offroad-trails",    desc:"Trail conditions & meetups",     color:"#a855f7", host:"FreewayFiona" },
];
// Seeds the Route feed with 10 posts on first-ever load, one for each of San
// Diego's top drives — each with 2 stops along the way (a food stop, then a
// parking stop) before the destination itself. Posted as your own routes
// (authorId "me") so every seeded route is fully yours to edit or remove,
// same as anything you post from scratch.
const SD_ROUTE_POSTS = [
  { title:"Balboa Park Cruise",       type:"scenic",    distance:"9 mi",  body:"Easy cruise from downtown up into Balboa Park — grab lunch on the way, then wander the gardens and museums once you're parked.", stops:["Food: Liberty Public Market","Park: Inspiration Point Lot, Balboa Park"], author:"SoCalDrifter"   },
  { title:"La Jolla Cove Coastal Run", type:"scenic",   distance:"12 mi", body:"Coast-hugging drive up to La Jolla Cove — perfect for sea lion watching and a sunset stop.", stops:["Food: The Cottage La Jolla","Park: Ellen Browning Scripps Park"], author:"NightOwl_Mike"  },
  { title:"Coronado Beach Day",        type:"scenic",   distance:"7 mi",  body:"Over the bridge to Coronado — classic beach day route with a coffee stop before you park up near the sand.", stops:["Food: Clayton's Coffee Shop","Park: Coronado Beach Public Lot"], author:"TruckDog99"     },
  { title:"Gaslamp Quarter Night Out", type:"road trip",distance:"6 mi",  body:"Downtown run into the Gaslamp Quarter for a night out — quick bite first, then park and walk the whole strip.", stops:["Food: Ballast Point Brewing, Gaslamp","Park: 5th Avenue Parkade"], author:"FreewayFiona"   },
  { title:"San Diego Zoo Family Trip", type:"road trip",distance:"10 mi", body:"Family-friendly route up to the Zoo — stop for a quick lunch before the gates so nobody's hangry in line.", stops:["Food: Panera Bread, Hillcrest","Park: San Diego Zoo Main Lot"], author:"CruiseCtrl"     },
  { title:"USS Midway Museum Run",     type:"road trip",distance:"8 mi",  body:"Harbor-front drive to the USS Midway — grab seafood downtown, then park right on the waterfront.", stops:["Food: Anthony's Fish Grotto","Park: Navy Pier Parking, Downtown"], author:"VanLife_KC"     },
  { title:"Old Town Heritage Drive",   type:"scenic",   distance:"8 mi",  body:"Short hop into Old Town for the historic district — classic Mexican food stop before you park and explore on foot.", stops:["Food: Old Town Mexican Cafe","Park: Old Town State Historic Park Lot"], author:"SoCalDrifter" },
  { title:"Sunset Cliffs Golden Hour", type:"hike",     distance:"11 mi", body:"Point Loma drive out to Sunset Cliffs — timed for golden hour, with a fish stop on the way out.", stops:["Food: Point Loma Seafoods","Park: Sunset Cliffs Natural Park Lot"], author:"NightOwl_Mike" },
  { title:"Mission Beach Boardwalk",   type:"bike",     distance:"9 mi",  body:"Beach cruise to Mission Beach — churros on the way, then park near Belmont Park for the boardwalk.", stops:["Food: Mission Beach Churro Stand","Park: Belmont Park Lot"], author:"TruckDog99"        },
  { title:"Torrey Pines Reserve Hike", type:"hike",     distance:"14 mi", body:"North county drive to Torrey Pines — coffee stop before the trailhead, then park right at the reserve.", stops:["Food: Torrey Pines Café","Park: Torrey Pines State Reserve Lot"], author:"FreewayFiona"    },
].map((r,i)=>({
  id:"sd_route_"+i, title:r.title, type:r.type, body:r.body, distance:r.distance, stops:r.stops,
  highlights:"", photos:[], fromSaved:false, likes:40+i*23, authorId:"me", authorName:"You",
}));
// The same 10 San Diego routes, but shaped for the "My Routes" created-routes
// list (routes state) instead of the community feed (posts state) — so
// "My Routes" shows you as having actually created all 10, not just posted
// them. Same source data, a different id prefix to avoid colliding with the
// feed-post copies above.
const SD_ROUTES = SD_ROUTE_POSTS.map((r,i)=>({
  id:"sd_myroute_"+i, title:r.title, type:r.type, distance:r.distance, bio:r.body, stops:r.stops,
  color:[OR,"#22c55e","#6366f1","#a855f7"][i%4], public:true,
}));
// Simulated vehicle + bio an invited friend shows up with once they "accept"
// an invite into one of your Shared Garages (no real multi-user backend, so
// this mirrors the app's existing pattern of a simulated reply — same idea
// as the CB chatter auto-reply and the auto-follow-back notifications).
const SAMPLE_GARAGE_CARS = [
  { name:"'98 Supra",     bio:"Daily driven, track weekends.",         color:"#dc2626", bodyStyle:"sport"   },
  { name:"Civic Type R",  bio:"Stage 2 tune, still gets great mpg.",   color:"#2563eb", bodyStyle:"hatchback" },
  { name:"F-150 Raptor",  bio:"Weekend trail rig.",                    color:"#78716c", bodyStyle:"pickup"  },
  { name:"Model 3",       bio:"Commuter, wrapped satin black.",        color:"#111827", bodyStyle:"sedan"   },
  { name:"WRX STI",       bio:"Rally-inspired build, always loud.",    color:"#1d4ed8", bodyStyle:"sedan"   },
  { name:"Mustang GT",    bio:"Built for Sunday cruise nights.",       color:"#f97316", bodyStyle:"muscle"  },
];
// Deterministic simulated "distance from you" (mi) for a post/event, based on its id —
// stable across renders without needing real geolocation data.
function milesAwayFor(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 140) + 1; // 1–140 mi
}
// Base map center — matches all of the app's seeded/simulated content, which
// is implicitly "around San Diego" (see milesAwayFor-style simulated data).
const SD_BASE = { lat: 32.7157, lng: -117.1611 };
// Deterministic simulated lat/lng for a route stop — same hashing technique
// as milesAwayFor, since there's no real geocoding for free-text stop
// addresses. Jitters around SD_BASE so every route's stops land in a
// plausible, stable (never-random-on-rerender), walkable-looking cluster.
function stopLatLng(routeId, stop, idx) {
  const s = `${routeId}|${stop}|${idx}`;
  let h1 = 0, h2 = 0;
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 * 31 + s.charCodeAt(i)) >>> 0;
    h2 = (h2 * 17 + s.charCodeAt(i) + i) >>> 0;
  }
  const latJitter = ((h1 % 2000) / 1000 - 1) * 0.09; // ~±6 mi
  const lngJitter = ((h2 % 2000) / 1000 - 1) * 0.09;
  return [SD_BASE.lat + latJitter, SD_BASE.lng + lngJitter];
}
// Reusable Leaflet map for a route's stops — a small non-interactive preview
// on feed/list cards, or a full interactive pan/zoom map on the route's own
// page. No real geocoding API is available, so stop markers use the
// deterministic simulated coordinates from stopLatLng above; the map tiles
// and pan/zoom/markers themselves are all real (OpenStreetMap, no API key
// needed).
function RouteMap({ route, height = 140, interactive = false, color = "#f97316" }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const stopsKey = JSON.stringify(route?.stops || []);
  useEffect(() => {
    if (!containerRef.current) return;
    const stops = (route?.stops || []).filter(s => s && String(s).trim());
    const points = stops.length > 0
      ? stops.map((s, i) => stopLatLng(String(route.id), s, i))
      : [[SD_BASE.lat, SD_BASE.lng]];
    const map = L.map(containerRef.current, {
      zoomControl: interactive,
      dragging: interactive,
      scrollWheelZoom: interactive,
      doubleClickZoom: interactive,
      touchZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      attributionControl: interactive,
    });
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      subdomains: "abc",
    }).addTo(map);
    if (points.length > 1) {
      L.polyline(points, { color, weight: 4, opacity: 0.85 }).addTo(map);
    }
    points.forEach((pt, i) => {
      const icon = L.divIcon({
        html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font:800 12px sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">${i + 1}</div>`,
        className: "",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const marker = L.marker(pt, { icon, interactive }).addTo(map);
      if (interactive && stops[i]) marker.bindPopup(stops[i]);
    });
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [28, 28] });
    } else {
      map.setView(points[0], 12);
    }
    return () => { map.remove(); mapRef.current = null; };
  }, [route?.id, stopsKey, interactive, color]);
  return <div ref={containerRef} style={{ width: "100%", height, borderRadius: interactive ? 0 : 14, overflow: "hidden", background: "#e5e7eb" }} />;
}
// Downscales an uploaded photo before it's stored as a base64 data URL. A
// phone photo straight off the camera can be several MB, and ALL of this
// app's persisted state (car photos, profile photo, event/post photos, ...)
// shares one browser localStorage quota — typically only ~5-10MB total. A
// few full-size photos blow through that fast, and when a write goes over
// quota it fails silently (see memStore.setItem's catch above) and falls
// back to an in-memory copy that's gone the moment the app closes — which
// looks exactly like "my photos don't save". Capping every upload to a
// reasonable display size keeps real photo storage an order of magnitude
// smaller, so normal use stays comfortably under the limit. Resolves the
// original file as a fallback if canvas resizing isn't available for some
// reason, so an upload never just silently fails.
/* ── Username normalize/validate — shared by sign-up and Edit Profile so
   the rule is defined once and can't drift between the two places it's
   enforced. Liberal in what it accepts as you type (Postel's Law): leading
   "@", spaces, capital letters, and stray punctuation all just get quietly
   stripped/lowercased rather than rejected outright, so pasting "@Jordan
   Cole!" while it's still being typed doesn't feel like an error — but what
   actually gets stored/checked/saved is always the strict normalized form,
   which is what the database's uniqueness constraint expects. */
function normalizeUsername(raw) {
  return (raw || "").trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "").replace(/[^a-z0-9_.]/g, "");
}
function usernameError(u) {
  if (!u) return null;
  if (u.length < 3) return "At least 3 characters";
  if (u.length > 20) return "20 characters max";
  if (!/^[a-z0-9_.]+$/.test(u)) return "Letters, numbers, _ and . only";
  return null;
}
// Suggests a starting-point username from a display name (Tesler's Law —
// push the "what should I even pick" decision off the user by default,
// they can still type over it). Never auto-fills the field; only ever used
// as placeholder text so nobody's account silently gets a name they didn't
// choose (Postel's Law cuts both ways — liberal on input, but never assume).
function suggestUsername(name) {
  const base = normalizeUsername((name || "").replace(/\s+/g, "_"));
  return base || "yourname";
}

function readImageCompressed(file, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const raw = ev.target.result;
      try {
        const img = new Image();
        img.onload = () => {
          try {
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
              const scale = maxDim / Math.max(width, height);
              width = Math.max(1, Math.round(width * scale));
              height = Math.max(1, Math.round(height * scale));
            }
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(raw); return; }
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", quality));
          } catch { resolve(raw); }
        };
        img.onerror = () => resolve(raw);
        img.src = raw;
      } catch { resolve(raw); }
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
const RADIUS_MIN = 5;
const RADIUS_MAX = 105; // slider max notch = "100+ mi" (unlimited / appRadius=null)
const CAR_COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#6366f1","#a855f7","#ec4899","#1a1a1a","#e0e0e0","#78716c"];

// Body-style library — 20 distinct silhouettes, each rendered by VehicleSVG
// below from a shared parametric generator (see BODY_FAMILY) so every style
// gets a genuinely different shape instead of one fixed hatchback outline.
const CAR_BODY_STYLES = [
  {id:"micro",          label:"Micro"},
  {id:"hatchback",      label:"Hatchback"},
  {id:"crossover",      label:"Crossover"},
  {id:"sedan",          label:"Sedan"},
  {id:"coupe",          label:"Coupe"},
  {id:"coupe_suv",      label:"Coupe SUV"},
  {id:"suv",            label:"SUV"},
  {id:"offroader",      label:"Off-Roader"},
  {id:"pickup",         label:"Pick-Up"},
  {id:"mpv",            label:"MPV"},
  {id:"wagon",          label:"Wagon/Estate"},
  {id:"van",            label:"Van"},
  {id:"sport",          label:"Sport"},
  {id:"cabriolet",      label:"Cabriolet"},
  {id:"roadster",       label:"Roadster"},
  {id:"shooting_brake", label:"Shooting Brake"},
  {id:"hyper",          label:"Hyper"},
  {id:"muscle",         label:"Muscle"},
  {id:"limousine",      label:"Limousine"},
  {id:"open_wheel",     label:"Open Wheel"},
];
// Legacy flat label list kept for anything that still expects plain strings.
const CAR_MODELS = CAR_BODY_STYLES.map(s=>s.label);
// Friends don't carry their own saved car data (only you customize a car in
// this demo) — this derives a stable, deterministic body style for a
// friend's car-avatar preview from their id, paired with their existing
// avatar color, so the same friend always shows the same "their car" look.
const friendCarStyle = (fr) => {
  const key = String(fr?.id ?? fr?.name ?? "friend");
  let hash = 0;
  for (let i=0;i<key.length;i++) hash = (hash*31 + key.charCodeAt(i)) >>> 0;
  return CAR_BODY_STYLES[hash % CAR_BODY_STYLES.length].id;
};

// Manufacturer picker — shown as colored wordmark badges (not literal brand
// marks) so the library covers a wide roster of real manufacturers without
// reproducing anyone's trademarked logo artwork.
const CAR_BRANDS = [
  {id:"acura",name:"Acura",color:"#111"},{id:"alfa",name:"Alfa Romeo",color:"#a6192e"},
  {id:"audi",name:"Audi",color:"#bb0a30"},{id:"bmw",name:"BMW",color:"#1c69d4"},
  {id:"bentley",name:"Bentley",color:"#00594c"},{id:"buick",name:"Buick",color:"#c8102e"},
  {id:"cadillac",name:"Cadillac",color:"#111"},{id:"chevrolet",name:"Chevrolet",color:"#d1a136"},
  {id:"chrysler",name:"Chrysler",color:"#111"},{id:"citroen",name:"Citroën",color:"#c8102e"},
  {id:"dacia",name:"Dacia",color:"#0a5c36"},{id:"daihatsu",name:"Daihatsu",color:"#c8102e"},
  {id:"dodge",name:"Dodge",color:"#c8102e"},{id:"ds",name:"DS Automobiles",color:"#111"},
  {id:"fiat",name:"Fiat",color:"#8b0000"},{id:"ford",name:"Ford",color:"#003478"},
  {id:"gmc",name:"GMC",color:"#c8102e"},{id:"geely",name:"Geely",color:"#0057a8"},
  {id:"honda",name:"Honda",color:"#cc0000"},{id:"hyundai",name:"Hyundai",color:"#002c5f"},
  {id:"infiniti",name:"Infiniti",color:"#111"},{id:"jaguar",name:"Jaguar",color:"#0c2340"},
  {id:"jeep",name:"Jeep",color:"#1a5632"},{id:"kia",name:"Kia",color:"#bb162b"},
  {id:"lamborghini",name:"Lamborghini",color:"#eab308"},{id:"landrover",name:"Land Rover",color:"#0f5132"},
  {id:"lexus",name:"Lexus",color:"#111"},{id:"lincoln",name:"Lincoln",color:"#111"},
  {id:"maserati",name:"Maserati",color:"#00205b"},{id:"mazda",name:"Mazda",color:"#910a2d"},
  {id:"mercedes",name:"Mercedes-Benz",color:"#a3a9ac"},{id:"mini",name:"Mini",color:"#111"},
  {id:"nissan",name:"Nissan",color:"#c3002f"},{id:"porsche",name:"Porsche",color:"#c8102e"},
  {id:"ram",name:"Ram",color:"#111"},{id:"renault",name:"Renault",color:"#ffcc00"},
  {id:"rollsroyce",name:"Rolls-Royce",color:"#111"},{id:"seat",name:"Seat",color:"#c8102e"},
  {id:"skoda",name:"Skoda",color:"#0e5a37"},{id:"smart",name:"Smart",color:"#ff8200"},
  {id:"stellantis",name:"Stellantis",color:"#111"},{id:"subaru",name:"Subaru",color:"#0033a0"},
  {id:"tesla",name:"Tesla",color:"#cc0000"},{id:"toyota",name:"Toyota",color:"#eb0a1e"},
  {id:"volkswagen",name:"Volkswagen",color:"#00437a"},{id:"volvo",name:"Volvo",color:"#003057"},
];
const CAR_MODS = {
  Wheels:["Stock","Alloy","Spokes","Deep Dish","Mesh"],
  "Body Kit":["None","Widebody"],
  Spoiler:["None","Lip","Duck Tail","GT Wing"],
  Tint:["None","Light","Medium","Dark","Limo"],
  Exhaust:["Stock","Dual","Quad"],
};
// Simulated Spotify "Now Playing" queue — a real Spotify connection needs a
// developer OAuth key we don't have here, so this drives an actually-ticking
// mini player (real elapsed time, auto-advances tracks) once you tap Connect.
const SPOTIFY_TRACKS = [
  {title:"Night Drive",   artist:"Neon Highway", dur:198, color:"#1DB954"},
  {title:"Coastal Haze",  artist:"Sable Cove",   dur:214, color:"#6366f1"},
  {title:"Overpass",      artist:"Late Shift",   dur:187, color:"#f97316"},
  {title:"Static Bloom",  artist:"Radio Static", dur:231, color:"#a855f7"},
  {title:"Low Beam",      artist:"Sable Cove",   dur:205, color:"#22c55e"},
];
const EV_ICONS  = {"car meet":"🚗","party":"🎉","market":"🛍️","concert":"🎵","food":"🌮","art":"🎨"};
const EV_COLORS = {"car meet":"#f97316","party":"#a855f7","market":"#22c55e","concert":"#6366f1","food":"#ef4444","art":"#ec4899"};
// Seeds the Events feed with 10 posts on first-ever load — things to do in
// San Diego, all dated out in 2030 so they always read as upcoming. Posted
// as your own events (authorId "me") so every one of them is fully yours to
// edit or remove, same as any event you create from scratch.
const SD_EVENTS = [
  { title:"Sunset Cliffs Bonfire Night",       type:"party",    date:"2030-01-18", address:"Sunset Cliffs Natural Park, San Diego, CA", desc:"Beachfront bonfire and live acoustic sets right on the cliffs — bring a chair and watch the sunset over the Pacific." },
  { title:"Balboa Park Food Truck Festival",   type:"food",     date:"2030-02-14", address:"Balboa Park, San Diego, CA",                 desc:"Dozens of San Diego's best food trucks lined up across the Park's central mesa, with live music all afternoon." },
  { title:"La Jolla Cove Car Meet",            type:"car meet", date:"2030-03-08", address:"La Jolla Cove, San Diego, CA",                desc:"Weekend car meet along the coast — classics, imports, and everything in between, with an ocean view backdrop." },
  { title:"Gaslamp Quarter Art Walk",          type:"art",      date:"2030-04-12", address:"Gaslamp Quarter, San Diego, CA",              desc:"Galleries and pop-up studios throw open their doors for a night of live painting, local artists, and street performers." },
  { title:"Liberty Public Market Bazaar",      type:"market",   date:"2030-05-03", address:"Liberty Public Market, San Diego, CA",        desc:"A weekend bazaar of local makers, vintage finds, and small-batch goods inside and around the market hall." },
  { title:"Petco Park Summer Concert Series",  type:"concert",  date:"2030-06-21", address:"Petco Park, San Diego, CA",                   desc:"Outdoor summer concert on the Petco Park lawn — gates open early for tailgating in the lot." },
  { title:"Mission Beach Boardwalk Block Party", type:"party",  date:"2030-07-19", address:"Mission Beach Boardwalk, San Diego, CA",      desc:"A full block of the boardwalk shuts down for DJs, food stalls, and beach games all day into the evening." },
  { title:"Old Town Taco & Tequila Festival",  type:"food",     date:"2030-08-09", address:"Old Town San Diego State Historic Park, CA",  desc:"Sample tacos and tequila flights from Old Town's best kitchens and bars, with mariachi sets between rounds." },
  { title:"Coronado Classic Car Show",         type:"car meet", date:"2030-09-13", address:"Coronado Ferry Landing, Coronado, CA",        desc:"Classic and vintage cars lined up along the ferry landing with the downtown skyline across the bay." },
  { title:"North Park Vinyl & Vintage Market", type:"market",   date:"2030-10-25", address:"North Park, San Diego, CA",                   desc:"Crate-diggers' market of vinyl, vintage clothing, and local record labels spread across North Park's main strip." },
].map((e,i)=>({
  id:"sd_event_"+i, title:e.title, type:e.type, desc:e.desc, address:e.address, date:e.date,
  icon:EV_ICONS[e.type]||"📍", photos:[], authorId:"me", authorName:"You", rsvps:20+i*7,
}));
// Premade garage-banner backgrounds — users can pick one of these instead of uploading a photo.
const CAR_BANNERS = [
  {id:"midnight", label:"Midnight",      css:"linear-gradient(180deg,#1a1a1a 0%,#111 60%,#0d0d0d 100%)"},
  {id:"sunset",   label:"Sunset",        css:"linear-gradient(160deg,#ff7e5f 0%,#feb47b 55%,#3a1c71 100%)"},
  {id:"ocean",    label:"Ocean",         css:"linear-gradient(160deg,#0f2027 0%,#2c5364 55%,#2193b0 100%)"},
  {id:"forest",   label:"Forest",        css:"linear-gradient(160deg,#0b3d2e 0%,#134e5e 55%,#71b280 100%)"},
  {id:"grid",     label:"Track Grid",    css:"repeating-linear-gradient(0deg,#0d0d0d,#0d0d0d 18px,#1c1c1c 18px,#1c1c1c 20px)"},
  {id:"racing",   label:"Racing Stripe", css:"linear-gradient(90deg,#111 44%,#ef4444 44%,#ef4444 56%,#111 56%)"},
  {id:"purple",   label:"Ultraviolet",   css:"linear-gradient(160deg,#0f0c29 0%,#302b63 55%,#a855f7 100%)"},
  {id:"gold",     label:"Gold Rush",     css:"linear-gradient(160deg,#1a1a1a 0%,#5c4813 55%,#eab308 100%)"},
];

const callClaude = async (msgs, sys) => {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:300, system:sys, messages:msgs }),
    });
    const d = await r.json();
    return d.content?.[0]?.text || "No response.";
  } catch { return "Connection error."; }
};

// Startup sound synthesis — different tones per style, no audio files needed
const STARTUP_SOUNDS = {
  classic:  {label:"Classic Chime",  notes:[523,659,784]},
  engine:   {label:"Engine Rev",     notes:[110,165,220,330]},
  digital:  {label:"Digital Beep",   notes:[880,1175]},
  warm:     {label:"Warm Tone",      notes:[392,494,587,659]},
  none:     {label:"Silent",         notes:[]},
};
const playStartupSound = (key) => {
  const cfg = STARTUP_SOUNDS[key] || STARTUP_SOUNDS.classic;
  if (!cfg.notes.length) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    cfg.notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = key==="engine" ? "sawtooth" : key==="digital" ? "square" : "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i*0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.15, start+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start+0.22);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(start); osc.stop(start+0.25);
    });
  } catch {}
};

/* ── Small hex color helpers used to build the 3D-style paint gradients
   below (mix toward white for a highlight tone, toward black for a shade
   tone) — keeps every body color paintable without a fixed palette. */
const _hexToRgb = hex => {
  const h = hex.replace("#","");
  const full = h.length===3 ? h.split("").map(c=>c+c).join("") : h;
  const num = parseInt(full,16);
  return [(num>>16)&255,(num>>8)&255,num&255];
};
const _clamp255 = n => Math.max(0,Math.min(255,Math.round(n)));
const _rgbToHex = (r,g,b) => "#"+[r,g,b].map(v=>_clamp255(v).toString(16).padStart(2,"0")).join("");
const lighten = (hex, amt) => { const [r,g,b]=_hexToRgb(hex); return _rgbToHex(r+(255-r)*amt, g+(255-g)*amt, b+(255-b)*amt); };
const darken  = (hex, amt) => { const [r,g,b]=_hexToRgb(hex); return _rgbToHex(r*(1-amt), g*(1-amt), b*(1-amt)); };

/* ── CarSVG / VehicleSVG ── one parametric generator drives every body
   style in CAR_BODY_STYLES from a small shape-parameter table, so each
   style (Micro, Pickup, Van, Limousine, …) gets a genuinely different
   silhouette instead of one fixed hatchback outline. Wheel/tint/spoiler/
   widebody mods still overlay on top of whichever body shape is active.
   Paint, glass, and wheels all use gradients (not flat fills) for a more
   3D, semi-glossy look — top-lit highlight fading to a shaded underside,
   glassy window panes, and shiny alloy-style wheels. */
const BODY_FAMILY = {
  micro:          {x0:30, x1:110, bodyTop:42, roofY:10, roofX:[46,54,86,94],   wheelR:9,  wInset:15},
  hatchback:      {x0:18, x1:122, bodyTop:38, roofY:8,  roofX:[42,50,92,100],  wheelR:10, wInset:19},
  crossover:      {x0:14, x1:126, bodyTop:32, roofY:4,  roofX:[42,50,90,98],   wheelR:12, wInset:20, tall:true},
  sedan:          {x0:10, x1:130, bodyTop:38, roofY:10, roofX:[44,52,90,102],  wheelR:10, wInset:21, trunk:true},
  coupe:          {x0:14, x1:128, bodyTop:42, roofY:14, roofX:[54,60,86,94],   wheelR:10, wInset:21, low:true},
  coupe_suv:      {x0:12, x1:128, bodyTop:32, roofY:6,  roofX:[46,54,86,96],   wheelR:12, wInset:21, tall:true},
  suv:            {x0:8,  x1:132, bodyTop:28, roofY:0,  roofX:[38,46,92,102],  wheelR:13, wInset:21, tall:true, boxy:true},
  offroader:      {x0:10, x1:130, bodyTop:26, roofY:2,  roofX:[36,44,94,104],  wheelR:14, wInset:20, tall:true, boxy:true, rack:true},
  pickup:         {x0:8,  x1:134, bodyTop:30, roofY:6,  roofX:[36,44,66,66],   wheelR:12, wInset:20, bed:true},
  mpv:            {x0:10, x1:128, bodyTop:30, roofY:2,  roofX:[38,46,96,106],  wheelR:11, wInset:20, tall:true, longRoof:true},
  wagon:          {x0:10, x1:130, bodyTop:36, roofY:8,  roofX:[44,52,96,104],  wheelR:10, wInset:21, longRoof:true},
  van:            {x0:6,  x1:134, bodyTop:24, roofY:-4, roofX:[28,34,102,112], wheelR:11, wInset:18, tall:true, boxy:true},
  sport:          {x0:16, x1:128, bodyTop:46, roofY:18, roofX:[58,64,86,92],   wheelR:11, wInset:22, low:true, wide:true},
  cabriolet:      {x0:16, x1:126, bodyTop:42, roofY:22, roofX:[52,58,86,92],   wheelR:10, wInset:21, low:true, openTop:true},
  roadster:       {x0:22, x1:120, bodyTop:44, roofY:24, roofX:[56,62,80,86],   wheelR:9,  wInset:19, low:true, openTop:true},
  shooting_brake: {x0:14, x1:128, bodyTop:40, roofY:14, roofX:[54,60,90,98],   wheelR:10, wInset:21, low:true, longRoof:true},
  hyper:          {x0:14, x1:130, bodyTop:48, roofY:20, roofX:[60,66,84,92],   wheelR:11, wInset:23, low:true, wide:true},
  muscle:         {x0:8,  x1:132, bodyTop:44, roofY:16, roofX:[76,82,98,104],  wheelR:11, wInset:23, low:true, longHood:true},
  limousine:      {x0:2,  x1:138, bodyTop:38, roofY:12, roofX:[44,50,96,104],  wheelR:9,  wInset:17, trunk:true, stretch:true},
};

function OpenWheelSVG({ color="#f97316", size=80 }) {
  return (
    <svg width={size} height={size*0.65} viewBox="0 0 140 90" fill="none">
      <ellipse cx="70" cy="84" rx="58" ry="4" fill="rgba(0,0,0,0.1)"/>
      <rect x="6" y="58" width="26" height="4" rx="2" fill="#1a1a1a"/>
      <rect x="6" y="64" width="26" height="3" rx="1.5" fill={color}/>
      <path d="M28 60 L70 52 L70 66 L28 66 Z" fill={color}/>
      <path d="M62 52 L92 50 L98 62 L70 66 Z" fill={color}/>
      <ellipse cx="76" cy="50" rx="8" ry="5" fill="#222"/>
      <path d="M92 50 L120 54 L120 64 L98 62 Z" fill={color} opacity="0.9"/>
      <rect x="118" y="42" width="4" height="20" rx="1.5" fill="#1a1a1a"/>
      <rect x="112" y="40" width="16" height="4" rx="1.5" fill="#1a1a1a"/>
      {[[20,66],[46,66],[100,64],[126,60]].map(([cx,cy],i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r="11" fill="#1a1a1a"/>
          <circle cx={cx} cy={cy} r="8.5" fill="#333"/>
          <circle cx={cx} cy={cy} r="3" fill="#888"/>
        </g>
      ))}
    </svg>
  );
}

function CarSVG({ color="#f97316", mods={}, size=80, styleId="sedan" }) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g,"");
  if (styleId === "open_wheel") return <OpenWheelSVG color={color} size={size}/>;
  const p = BODY_FAMILY[styleId] || BODY_FAMILY.sedan;
  const wcMod = mods.Wheels==="Alloy"?"#c7cbd1":mods.Wheels==="Spokes"?"#f59e0b":mods.Wheels==="Deep Dish"?"#26282c":mods.Wheels==="Mesh"?"#6366f1":null;
  const tint = mods.Tint==="Light"?0.25:mods.Tint==="Medium"?0.5:mods.Tint==="Dark"?0.72:mods.Tint==="Limo"?0.92:0;
  const sh = mods.Spoiler==="GT Wing"?10:mods.Spoiler==="Duck Tail"?6:mods.Spoiler==="Lip"?3:0;
  const wideMod = mods["Body Kit"]==="Widebody"?4:0;
  const spokes = mods.Wheels==="Spokes"||mods.Wheels==="Mesh";

  const x0 = p.x0 - wideMod, x1 = p.x1 + wideMod;
  const bodyTop = p.bodyTop, bodyBot = 64;
  const [rfBase, rfTop, rbTop, rbBase] = p.roofX;
  const roofY = p.roofY;
  const wheelR = p.wheelR;
  const wCx0 = x0 + p.wInset, wCx1 = x1 - p.wInset;
  // Vertical squash applied to the wheels — foreshortens circles into
  // ellipses, the single strongest cue that reads as a 3/4 angled view
  // (looking slightly down and across the car) rather than a flat side
  // elevation. wCy is the shared wheel center, chosen so the OUTER tire
  // ellipse's bottom edge still sits on the same ground line (y=81) that
  // the old full-circle wheels used, regardless of body style.
  const WSQ = 0.62;
  const wCy = 81 - (wheelR+2.5)*WSQ;
  const bodyRX = p.boxy ? 4 : 8;

  const roofPath = p.openTop
    ? `M${rfBase} ${bodyTop} L${rfTop} ${roofY+8} L${rbTop} ${roofY+8} L${rbBase} ${bodyTop} Z`
    : p.bed
    ? `M${rfBase} ${bodyTop} L${rfTop} ${roofY} L${rbTop} ${roofY} L${rbBase+4} ${bodyTop} Z`
    : `M${rfBase} ${bodyTop} L${rfTop} ${roofY} L${rbTop} ${roofY} L${rbBase} ${bodyTop} Z`;
  const winTopY = (p.openTop ? roofY+8 : roofY) + 3;
  const winPath = `M${rfBase+3} ${bodyTop-1} L${rfTop+3} ${winTopY} L${(p.bed?rbTop:rbTop)-3} ${winTopY} L${(p.bed?rbBase+4:rbBase)-3} ${bodyTop-1} Z`;
  const pillarX = (rfTop+rbTop)/2;

  // Gradient tones — top-lit highlight fading through the true color to a
  // shaded underside, for a rounded, semi-3D painted-metal look.
  const bodyHi  = lighten(color,0.34);
  const bodyLo  = darken(color,0.30);
  const bodyId  = "bd"+gid, winId = "wn"+gid, wheelId = "wh"+gid, tireId = "tr"+gid;
  const wheelFace = wcMod || "url(#"+wheelId+")";

  return (
    <svg width={size} height={size*0.65} viewBox="0 0 140 90" fill="none">
      <defs>
        <linearGradient id={bodyId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={bodyHi}/>
          <stop offset="42%" stopColor={color}/>
          <stop offset="100%" stopColor={bodyLo}/>
        </linearGradient>
        <linearGradient id={winId} x1="0" y1="0" x2="0.15" y2="1">
          <stop offset="0%" stopColor="#eef8ff"/>
          <stop offset="55%" stopColor="#bfe0f5"/>
          <stop offset="100%" stopColor="#87b8d9"/>
        </linearGradient>
        <radialGradient id={wheelId} cx="38%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#f0f1f3"/>
          <stop offset="55%" stopColor="#c2c6cc"/>
          <stop offset="100%" stopColor="#7d8188"/>
        </radialGradient>
        <radialGradient id={tireId} cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#3a3a3d"/>
          <stop offset="70%" stopColor="#1c1c1e"/>
          <stop offset="100%" stopColor="#0a0a0b"/>
        </radialGradient>
      </defs>
      <ellipse cx="70" cy="84" rx="56" ry="4" fill="rgba(0,0,0,0.15)"/>
      {wideMod>0 && <><ellipse cx={wCx0} cy={bodyBot-4} rx="14" ry="5" fill={color} opacity="0.5"/><ellipse cx={wCx1} cy={bodyBot-4} rx="14" ry="5" fill={color} opacity="0.5"/></>}
      <rect x={x0} y={bodyTop} width={x1-x0} height={bodyBot-bodyTop} rx={bodyRX} fill={"url(#"+bodyId+")"}/>
      {/* front fascia shade — soft dark wash at the leading edge, reading as
          the bumper curving away from the light at a 3/4 angle */}
      <rect x={x0} y={bodyTop} width={Math.min(8,(x1-x0)/3)} height={bodyBot-bodyTop} rx={bodyRX} fill="rgba(0,0,0,0.14)"/>
      {p.trunk && <rect x={rbBase-3} y={bodyTop-3} width={x1-(rbBase-3)} height="5" rx="1.5" fill={"url(#"+bodyId+")"}/>}
      {p.stretch && <line x1={(x0+x1)/2-12} y1={bodyTop+5} x2={(x0+x1)/2+12} y2={bodyTop+5} stroke="rgba(0,0,0,0.2)" strokeWidth="1"/>}
      <path d={roofPath} fill={"url(#"+bodyId+")"}/>
      {/* roof top-surface sliver — a light strip just under the roofline,
          hinting we're looking slightly down onto the roof rather than
          dead-on at its edge, like a raised 3/4-angle view */}
      {!p.openTop && <path d={`M${rfTop+3} ${roofY+1.5} L${rbTop-3} ${roofY+1.5} L${rbTop-5} ${roofY+3.5} L${rfTop+5} ${roofY+3.5} Z`} fill="#fff" opacity="0.22"/>}
      {/* glossy beltline highlight — a thin light streak along the upper
          body, the main cue that reads as "curved painted metal" */}
      <rect x={x0+3} y={bodyTop+3} width={Math.max(x1-x0-6,0)} height="2" rx="1" fill="#fff" opacity="0.4"/>
      <path d={winPath} fill={"url(#"+winId+")"}/>
      {/* diagonal glass reflection */}
      <path d={`M${rfBase+6} ${bodyTop-2} L${rfTop+6} ${winTopY} L${rfTop+9} ${winTopY} L${rfBase+10} ${bodyTop-2} Z`} fill="#fff" opacity="0.3"/>
      {/* side mirror — near the base of the windshield pillar */}
      {!p.openTop && <path d={`M${rfBase-1} ${bodyTop+3} q-5 -2 -6 2 q3 2.5 6 1 Z`} fill={darken(color,0.12)}/>}
      {!p.openTop && !p.bed && <line x1={pillarX} y1={roofY+3} x2={pillarX} y2={bodyTop-1} stroke={darken(color,0.15)} strokeWidth="2"/>}
      {tint>0 && <path d={winPath} fill={"rgba(0,0,10,"+tint+")"}/>}
      {p.bed && <>
        <rect x={rbBase+4} y={bodyTop+3} width={Math.max(x1-(rbBase+4)-3,4)} height={bodyBot-bodyTop-3} rx="2" fill="rgba(0,0,0,0.35)"/>
        <line x1={rbBase+4} y1={bodyTop} x2={rbBase+4} y2={bodyBot} stroke="rgba(0,0,0,0.4)" strokeWidth="1.5"/>
        <rect x={rbBase+6} y={bodyTop+6} width={Math.max(x1-(rbBase+6)-5,2)} height="2" rx="1" fill="rgba(255,255,255,0.12)"/>
      </>}
      {p.rack && <>
        <rect x={rfTop+3} y={roofY-6} width={rbTop-rfTop-6} height="3" rx="1" fill="#333"/>
        <line x1={rfTop+5} y1={roofY-6} x2={rfTop+5} y2={roofY} stroke="#333" strokeWidth="1.5"/>
        <line x1={rbTop-5} y1={roofY-6} x2={rbTop-5} y2={roofY} stroke="#333" strokeWidth="1.5"/>
      </>}
      <rect x={x0-2} y={bodyTop+8} width="14" height="6" rx="3" fill="#fef3c7"/>
      <rect x={x1-12} y={bodyTop+8} width="14" height="6" rx="3" fill="#ef4444" opacity="0.9"/>
      {/* front grille — small slatted detail near the bumper, the other main
          cue (with the fascia shade above) that we're seeing the front face
          a little, not just the side */}
      <rect x={x0-1} y={bodyBot-16} width="9" height="5.5" rx="1.5" fill="#1c1c1e"/>
      <rect x={x0+0.5} y={bodyBot-14.6} width="6" height="0.8" rx="0.4" fill="#4a4a4a"/>
      <rect x={x0+0.5} y={bodyBot-12.8} width="6" height="0.8" rx="0.4" fill="#4a4a4a"/>
      {sh>0 && <>
        <rect x={rbTop-6} y={roofY-sh} width="3" height={sh} rx="1" fill={color} opacity="0.9"/>
        <rect x={rbTop+7} y={roofY-sh} width="3" height={sh} rx="1" fill={color} opacity="0.9"/>
        <rect x={rbTop-8} y={roofY-sh-1} width="24" height="3" rx="1.5" fill={color}/>
      </>}
      {[wCx0,wCx1].map(cx => (
        <g key={cx}>
          <ellipse cx={cx} cy={wCy} rx={wheelR+2.5} ry={(wheelR+2.5)*WSQ} fill={"url(#"+tireId+")"}/>
          <ellipse cx={cx} cy={wCy} rx={wheelR} ry={wheelR*WSQ} fill={wheelFace}/>
          {spokes && [0,60,120,180,240,300].map(a => (
            <line key={a} x1={cx} y1={wCy}
              x2={cx+Math.cos(a*Math.PI/180)*(wheelR-1.5)}
              y2={wCy+Math.sin(a*Math.PI/180)*(wheelR-1.5)*WSQ}
              stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"/>
          ))}
          <ellipse cx={cx} cy={wCy} rx={Math.max(wheelR-7,2)} ry={Math.max(wheelR-7,2)*WSQ} fill="#3a3d42"/>
          {/* chrome shine — small offset highlight arc, gives the rim a lit-from-above look */}
          <ellipse cx={cx-wheelR*0.32} cy={wCy-wheelR*WSQ*0.32} rx={Math.max(wheelR*0.28,1.5)} ry={Math.max(wheelR*0.16,1)*WSQ} fill="#fff" opacity="0.55"/>
        </g>
      ))}
    </svg>
  );
}

/* ── GarageDoorIcon — metal roll-up garage door, used for the My Garage tile ── */
function GarageDoorIcon({ size=28, color="#8a8f98" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 10.2 12 4l9 6.2V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" stroke={color} strokeWidth="1.7" strokeLinejoin="round" fill={color+"14"}/>
      <path d="M4.3 12.3h15.4M4.3 14.7h15.4M4.3 17.1h15.4" stroke={color} strokeWidth="1.3" strokeLinecap="round"/>
      <rect x="10.4" y="14" width="3.2" height="1.7" rx="0.5" fill={color}/>
    </svg>
  );
}

/* ── ListBarsIcon — 3-bar "hamburger" list glyph, used on the Top 3 Friends
   header bar to jump to the full Friends tab. ── */
function ListBarsIcon({ size=16, color="#111" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 6.5h16M4 12h16M4 17.5h16" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

/* ── DefaultAvatar — generic person-silhouette placeholder shown when no
   profile photo is set, in a solid-white circle (replaces the old "?" glyph). */
function DefaultAvatar({ size=24, color="#111" }) {
  return (
    <svg width={size*0.62} height={size*0.62} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8.2" r="4.2" fill={color}/>
      <path d="M4 20.2c0-4.4 3.58-8 8-8s8 3.6 8 8v.3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-.3Z" fill={color}/>
    </svg>
  );
}

/* ── CompassStar — 8-point nautical compass star used to mark each AI
   co-pilot's identity; shape stays constant, color changes per pal. */
function CompassStar({ size=16, color="#f5c518" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <polygon points="12,1 12.88,9.88 16.60,7.40 14.13,11.12 23,12 14.13,12.88 16.60,16.60 12.88,14.13 12,23 11.12,14.13 7.40,16.60 9.88,12.88 1,12 9.88,11.12 7.40,7.40 11.12,9.88" fill={color}/>
    </svg>
  );
}

/* ── Profile page icon set — simple line-art outlines, same visual
   language as GarageDoorIcon (thin stroke, faint tinted fill, no emoji). */
function ProfileIcon({ id, size=20, color="#8a8f98" }) {
  const sw = 1.6;
  const fillTint = color+"14";
  switch(id) {
    case "star": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8 6.8 19.5l1-5.8L3.6 9.6l5.8-.8L12 3.5z" stroke={color} strokeWidth={sw} strokeLinejoin="round" fill={fillTint}/>
      </svg>
    );
    case "road": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M7 20.5c0-3.8 10-3.8 10-7.7s-10-3.8-10-7.6" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none"/>
        <path d="M8.7 6.4c.35 1 .35 2 0 3M15.3 17.6c-.35-1-.35-2 0-3" stroke={color} strokeWidth="1.1" strokeLinecap="round" opacity="0.65"/>
      </svg>
    );
    case "people": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="9" cy="8" r="3" stroke={color} strokeWidth={sw} fill={fillTint}/>
        <path d="M3.3 19c.5-3.5 3-5.3 5.7-5.3s5.2 1.8 5.7 5.3" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none"/>
        <circle cx="17" cy="9" r="2.3" stroke={color} strokeWidth="1.3" fill="none"/>
        <path d="M15.2 19c.3-2.6 1.8-4.2 3.7-4.4" stroke={color} strokeWidth="1.3" strokeLinecap="round" fill="none"/>
      </svg>
    );
    case "person": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="8" r="3.4" stroke={color} strokeWidth={sw} fill={fillTint}/>
        <path d="M4.5 20c.7-4.2 3.7-6.4 7.5-6.4s6.8 2.2 7.5 6.4" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none"/>
      </svg>
    );
    case "camera": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" stroke={color} strokeWidth={sw} fill={fillTint}/>
        <path d="M8 7.5l1.6-2.5h4.8L16 7.5" stroke={color} strokeWidth={sw} strokeLinejoin="round" fill="none"/>
        <circle cx="12" cy="13.7" r="3.2" stroke={color} strokeWidth={sw} fill="none"/>
      </svg>
    );
    case "video": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="2.5" y="6.5" width="13" height="11" rx="2.2" stroke={color} strokeWidth={sw} fill={fillTint}/>
        <path d="M15.5 10.3l5-2.8v9l-5-2.8z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" fill={fillTint}/>
      </svg>
    );
    case "car": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M4 15.5v-2.3l1.8-3.6a2 2 0 0 1 1.8-1.1h8.8a2 2 0 0 1 1.8 1.1l1.8 3.6v2.3" stroke={color} strokeWidth={sw} strokeLinejoin="round" fill={fillTint}/>
        <path d="M2.8 15.5h18.4" stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <circle cx="7.3" cy="15.6" r="1.6" stroke={color} strokeWidth="1.4" fill="#fff"/>
        <circle cx="16.7" cy="15.6" r="1.6" stroke={color} strokeWidth="1.4" fill="#fff"/>
        <path d="M6.5 10.3h11" stroke={color} strokeWidth="1.2"/>
      </svg>
    );
    case "bolt": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M13 3 5 14h5.5L11 21l8-11h-5.5L13 3z" stroke={color} strokeWidth={sw} strokeLinejoin="round" fill={fillTint}/>
      </svg>
    );
    case "history": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M4 10a8 8 0 1 1 1.5 5.3" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none"/>
        <path d="M4 6v4h4" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        <path d="M12 8v4.3l3 2" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    );
    case "trophy": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M7 4h10v3.2a5 5 0 0 1-5 5 5 5 0 0 1-5-5V4z" stroke={color} strokeWidth={sw} strokeLinejoin="round" fill={fillTint}/>
        <path d="M7 5.2H4.2a.9.9 0 0 0-.9 1.1c.4 2 1.8 3.4 3.7 3.7M17 5.2h2.8a.9.9 0 0 1 .9 1.1c-.4 2-1.8 3.4-3.7 3.7" stroke={color} strokeWidth="1.3" strokeLinecap="round" fill="none"/>
        <path d="M12 12.2v3" stroke={color} strokeWidth={sw}/>
        <path d="M8.5 20.5h7M9.5 17.5h5l.5 3h-6z" stroke={color} strokeWidth="1.3" strokeLinejoin="round" fill={color+"0d"}/>
      </svg>
    );
    case "gear": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="2.6" stroke={color} strokeWidth={sw} fill={fillTint}/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" fill="none"/>
      </svg>
    );
    case "briefcase": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        <rect x="3" y="7" width="18" height="12" rx="2.4" stroke={color} strokeWidth={sw} fill={fillTint}/>
        <path d="M3 12.5h18" stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <rect x="10.3" y="11" width="3.4" height="3" rx="0.8" stroke={color} strokeWidth="1.3" fill="none"/>
      </svg>
    );
    default: return null;
  }
}

/* ── DPad nav icons — one per page, colored like dashboard warning lights
   (dim when off, lit in full color with a glow when that page is active):
   Feed = routes shared → winding road (yellow), Create = Lanes chat →
   message bubble (red), Profile = car (brand orange), Drive = live map →
   map icon (green), Map = Events → calendar+star (blue). ── */
const DPAD_COLORS = { road:"#f5c518", chat:"#ef4444", profile:OR, map:"#22c55e", event:"#3b82f6" };
const DPadIcon = ({ id, color, size=17 }) => {
  const p = {width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:color,strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};
  if(id==="road") return (
    <svg {...p}>
      <path d="M7 21c0-4 10-4 10-8s-10-4-10-8" strokeWidth="2.8"/>
      <path d="M7 21c0-4 10-4 10-8s-10-4-10-8" stroke="#fff" strokeWidth="0.9" strokeDasharray="1.3 1.7" opacity="0.9"/>
    </svg>
  );
  if(id==="chat") return (
    <svg {...p}><path d="M4 5h16v11H8l-4 4V5z"/></svg>
  );
  if(id==="profile") return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path fill={color} d="M4.5 9.6 6 5.9C6.6 4.6 7.8 3.8 9.1 3.8h5.8c1.3 0 2.5.8 3.1 2l1.5 3.7c1 .3 1.5 1 1.5 2v5.1c0 .6-.4 1-1 1h-1.1c-.6 0-1-.4-1-1v-.5H6v.5c0 .6-.4 1-1 1H3.9c-.6 0-1-.4-1-1v-5.1c0-1 .5-1.7 1.6-2Z"/>
      <path fill="#fff" opacity="0.92" d="M7.3 9.1 8.4 6.5c.2-.5.7-.8 1.3-.8h4.6c.6 0 1.1.3 1.3.8l1.1 2.6Z"/>
      <circle cx="7.6" cy="16.1" r="1.35" fill={color}/>
      <circle cx="16.4" cy="16.1" r="1.35" fill={color}/>
    </svg>
  );
  if(id==="map") return (
    <svg {...p}><path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>
  );
  if(id==="event") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="16" rx="2.5" stroke={color} strokeWidth="2"/>
      <path d="M3 10h18" stroke={color} strokeWidth="2"/>
      <rect x="7" y="2.3" width="2.2" height="4" rx="1" fill={color}/>
      <rect x="14.8" y="2.3" width="2.2" height="4" rx="1" fill={color}/>
      <path fill={color} d="M12 12.1l1.05 2.14 2.35.34-1.7 1.66.4 2.35L12 17.4l-2.1 1.19.4-2.35-1.7-1.66 2.35-.34z"/>
    </svg>
  );
  return null;
};

/* DPad removed — navigation is now the top page-switcher + swipe carousel (see TopNav in SonoLane()). */

/* Bold magnifying-glass icon for the top bar's search toggle button —
   a thick ring + thick diagonal handle (matching the reference glyph
   the user provided), drawn with currentColor via `color` so it tints
   the same way the emoji it replaces did. */
const SearchIcon = ({ size=24, color="currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="10" cy="10" r="7" stroke={color} strokeWidth="3.6"/>
    <line x1="15.3" y1="15.3" x2="21" y2="21" stroke={color} strokeWidth="3.6" strokeLinecap="round"/>
  </svg>
);

/* ── Achievement sound — triumphant fanfare ── */
const playAchievementSound = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [[523,0],[659,0.1],[784,0.2],[1047,0.35]].forEach(([freq,t])=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type="sine"; o.frequency.value=freq;
      g.gain.setValueAtTime(0,ctx.currentTime+t);
      g.gain.linearRampToValueAtTime(0.18,ctx.currentTime+t+0.03);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+t+0.35);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime+t); o.stop(ctx.currentTime+t+0.4);
    });
    // Add a high shimmer
    const o2=ctx.createOscillator(), g2=ctx.createGain();
    o2.type="sine"; o2.frequency.value=1568;
    g2.gain.setValueAtTime(0,ctx.currentTime+0.5);
    g2.gain.linearRampToValueAtTime(0.1,ctx.currentTime+0.53);
    g2.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.9);
    o2.connect(g2); g2.connect(ctx.destination);
    o2.start(ctx.currentTime+0.5); o2.stop(ctx.currentTime+1);
  } catch {}
};

/* ── ACHIEVEMENTS master list ── */
const ACHIEVEMENTS = [
  // Driving milestones
  {id:"first_drive",   cat:"milestone", icon:"🚗", title:"First Drive",        desc:"Complete your first recorded drive",                pts:50,  check:(s)=>s.tripHistory.length>=1},
  {id:"drives_10",     cat:"milestone", icon:"🛣️", title:"Road Warrior",       desc:"Record 10 drives",                                  pts:100, check:(s)=>s.tripHistory.length>=10},
  {id:"drives_50",     cat:"milestone", icon:"🏆", title:"Highway Star",       desc:"Record 50 drives",                                  pts:300, check:(s)=>s.tripHistory.length>=50},
  {id:"drives_100",    cat:"milestone", icon:"🌟", title:"Century Driver",     desc:"Record 100 drives",                                 pts:500, check:(s)=>s.tripHistory.length>=100},
  // Distance
  {id:"miles_10",      cat:"distance",  icon:"📍", title:"10 Miles Club",      desc:"Drive a total of 10 miles",                         pts:50,  check:(s)=>s.totalMiles>=10},
  {id:"miles_100",     cat:"distance",  icon:"🛤️", title:"100 Miles Club",     desc:"Drive a total of 100 miles",                        pts:150, check:(s)=>s.totalMiles>=100},
  {id:"miles_500",     cat:"distance",  icon:"🌍", title:"500 Miles Club",     desc:"Drive a total of 500 miles",                        pts:400, check:(s)=>s.totalMiles>=500},
  // Speed
  {id:"under_limit",   cat:"safe",      icon:"🟢", title:"Speed Demon (Safe)", desc:"Complete a drive entirely under the speed limit",    pts:75,  check:(s)=>s.lastDriveUnderLimit},
  {id:"smooth_5",      cat:"safe",      icon:"🚦", title:"Green Light Legend", desc:"Hit 5 green lights in a row",                       pts:60,  check:(s)=>s.greenLightStreak>=5},
  {id:"smooth_10",     cat:"safe",      icon:"🏅", title:"Traffic Whisperer",  desc:"Hit 10 green lights in a row",                      pts:120, check:(s)=>s.greenLightStreak>=10},
  // Social
  {id:"first_friend",  cat:"social",    icon:"👥", title:"Riding Together",    desc:"Add your first friend",                             pts:30,  check:(s)=>s.friends.length>=1},
  {id:"first_route",   cat:"social",    icon:"🗺️", title:"Route Setter",       desc:"Save your first route",                             pts:40,  check:(s)=>s.routes.length>=1},
  {id:"first_event",   cat:"social",    icon:"⚡", title:"Event Starter",      desc:"Create your first event",                           pts:60,  check:(s)=>s.events.length>=1},
  {id:"three_events",  cat:"social",    icon:"🎉", title:"Party Starter",      desc:"Create 3 events",                                   pts:100, check:(s)=>s.events.length>=3},
  // Car
  {id:"car_saved",     cat:"car",       icon:"🏎", title:"Garage Owner",       desc:"Customize and save your car",                       pts:50,  check:(s)=>s.carSaved},
  // Night owl / early bird (simulated based on trip time)
  {id:"night_owl",     cat:"bonus",     icon:"🦉", title:"Night Owl",          desc:"Complete a drive after midnight",                   pts:80,  check:(s)=>s.hadNightDrive},
];

/* ── FriendAvatar — a friend's circle: their saved profile photo when
   they have one (`fr.photo`, hydrated from Supabase in real-backend mode),
   falling back to the initials-on-color-circle every avatar used before. ── */
function FriendAvatar({ fr, size, fontSize, style }) {
  if (fr?.photo) {
    return <img src={fr.photo} alt="" style={{width:size,height:size,borderRadius:"50%",objectFit:"cover",flexShrink:0,...style}}/>;
  }
  return (
    <div style={{width:size,height:size,borderRadius:"50%",background:fr?fr.color:"#f3f3f3",display:"flex",alignItems:"center",justifyContent:"center",fontSize:fontSize||Math.round(size*0.38),fontWeight:800,color:fr?"#fff":"#ccc",flexShrink:0,fontFamily:F,...style}}>
      {fr?fr.initials:"＋"}
    </div>
  );
}

/* ── GhostCard ── */
function GhostCard() {
  return (
    <div style={{borderRadius:16,overflow:"hidden",background:"#fff",border:"1.5px solid #ebebeb"}}>
      <div style={{height:120,background:"#f0f0f0"}}/>
      <div style={{padding:"10px 12px 14px"}}>
        <div style={{height:11,borderRadius:6,background:"#ececec",marginBottom:7,width:"65%"}}/>
        <div style={{height:9,borderRadius:6,background:"#f0f0f0",width:"42%"}}/>
      </div>
    </div>
  );
}

/* ── AuthScreen — sign-up / log-in gate shown only in real-backend mode
   (isSupabaseConfigured). Local demo mode (e.g. the Claude Artifact
   preview, or before a Supabase project is wired up) never renders this —
   the app just opens straight in, exactly as it always has. ── */
function AuthScreen() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  // "idle" | "checking" | "available" | "taken" | "invalid" — drives the
  // little inline status next to the username field. Showing "checking…"
  // the instant typing pauses (before the network reply lands) is the
  // Doherty Threshold in practice: the goal is under ~400ms to *some*
  // feedback, not to the final answer, so the field never just sits there
  // looking unresponsive while the real check is in flight.
  const [usernameStatus, setUsernameStatus] = useState("idle");
  const [region, setRegion] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const [claimedHandle, setClaimedHandle] = useState("");
  const inp = {width:"100%",padding:"12px 14px",borderRadius:10,background:"#f8f8f8",border:"1px solid #ebebeb",color:"#111",fontSize:16,boxSizing:"border-box",fontFamily:F,outline:"none"};

  // Debounced availability check against the real profiles table — only
  // meaningful in signup mode, only once the format itself is valid so we
  // don't burn a network round-trip on every keystroke of an obviously
  // incomplete username.
  useEffect(() => {
    if (mode !== "signup") return;
    const u = normalizeUsername(username);
    if (!u) { setUsernameStatus("idle"); return; }
    if (usernameError(u)) { setUsernameStatus("invalid"); return; }
    setUsernameStatus("checking");
    const t = setTimeout(async () => {
      try {
        const { data } = await supabase.from("profiles").select("id").ilike("handle", u).maybeSingle();
        setUsernameStatus(data ? "taken" : "available");
      } catch { setUsernameStatus("idle"); }
    }, 450);
    return () => clearTimeout(t);
  }, [username, mode]);

  const submit = async () => {
    setError("");
    if (mode === "signup" && !name.trim()) { setError("Enter your name."); return; }
    const u = normalizeUsername(username);
    if (mode === "signup" && !u) { setError("Choose a username."); return; }
    if (mode === "signup" && usernameError(u)) { setError(usernameError(u)); return; }
    if (mode === "signup" && usernameStatus === "taken") { setError("That username is already taken."); return; }
    if (!email.trim() || !password) { setError("Enter an email and password."); return; }
    if (password.length < 6) { setError("Password needs to be at least 6 characters."); return; }
    setBusy(true);
    try {
      if (mode === "signup") {
        // name/region/username ride along as auth user metadata — the
        // profiles-table trigger (see supabase/schema.sql) picks them up
        // and pre-fills the new profile row, so Edit Profile isn't blank
        // on first log-in and the username is reserved from account #1.
        const { error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { name: name.trim(), region: region.trim(), username: u } },
        });
        if (err) throw err;
        setClaimedHandle(u);
        setCheckEmail(true);
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw err;
      }
    } catch (e) {
      // A last-instant collision (two people claiming the same username at
      // once) surfaces here as a database uniqueness error — give people a
      // plain-English reason instead of a raw Postgres message.
      const msg = e.message || "";
      setError(/unique|duplicate/i.test(msg) ? "That username was just taken — try another." : (msg || "Something went wrong — try again."));
    } finally {
      setBusy(false);
    }
  };

  if (checkEmail) {
    return (
      <div style={{width:"100%",height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#fff",fontFamily:F,padding:24,paddingTop:"calc(24px + env(safe-area-inset-top, 0px))",paddingBottom:"calc(24px + env(safe-area-inset-bottom, 0px))",textAlign:"center",boxSizing:"border-box"}}>
        <div style={{fontSize:46,marginBottom:16}}>📬</div>
        <div style={{fontSize:19,fontWeight:800,color:"#111",marginBottom:8}}>Check your email</div>
        <div style={{fontSize:15,color:"#666",maxWidth:280,lineHeight:1.6}}>We sent a confirmation link to <b>{email}</b>. Tap it, then come back and log in.</div>
        {/* Peak-end rule — the last thing shown before people leave to check
            their inbox is a small, positive confirmation of the identity
            they just picked, not just a generic "we sent an email" beat. */}
        {claimedHandle && <div style={{marginTop:14,padding:"8px 16px",borderRadius:20,background:OR+"12",color:OR,fontSize:14,fontWeight:800}}>✓ @{claimedHandle} is yours</div>}
        <button onClick={()=>{setCheckEmail(false);setMode("signin");}} style={{marginTop:20,padding:"10px 18px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F}}>Back to log in</button>
      </div>
    );
  }

  const uErr = usernameError(normalizeUsername(username));
  return (
    <div style={{width:"100%",height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#fff",fontFamily:F,padding:24,paddingTop:"calc(24px + env(safe-area-inset-top, 0px))",paddingBottom:"calc(24px + env(safe-area-inset-bottom, 0px))",boxSizing:"border-box"}}>
      <div style={{width:"100%",maxWidth:320}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <img src={STAR_LOGO} alt="" style={{width:44,height:44,marginBottom:8,borderRadius:10}}/>
          <div style={{fontSize:22,fontWeight:900,color:"#111"}}>SonoLane</div>
          <div style={{fontSize:14,color:"#888",marginTop:4}}>{mode==="signup" ? "Create your account" : "Welcome back"}</div>
        </div>
        {mode==="signup" && (
          <>
            {/* Serial Position Effect — Name comes first (it's the field
                everyone expects and gets right without thinking), Username
                right after it while attention is still highest, since it's
                the one with a validation state to get right; Region last,
                lowest-stakes field, right before the effort shifts to
                email/password. */}
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={{...inp,marginBottom:10}}/>
            <div style={{position:"relative",marginBottom:2}}>
              <input
                value={username}
                onChange={e=>setUsername(e.target.value)}
                placeholder={"Username (e.g. "+suggestUsername(name)+")"}
                autoCapitalize="none"
                style={{...inp,paddingRight:34}}
              />
              {username.trim() && (
                <span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:15}}>
                  {usernameStatus==="checking" && <span style={{color:"#bbb"}}>⋯</span>}
                  {usernameStatus==="available" && <span style={{color:"#22c55e"}}>✓</span>}
                  {(usernameStatus==="taken"||usernameStatus==="invalid") && <span style={{color:"#ef4444"}}>✕</span>}
                </span>
              )}
            </div>
            <div style={{fontSize:11,marginBottom:10,minHeight:14,color:usernameStatus==="taken"?"#ef4444":uErr?"#ef4444":usernameStatus==="available"?"#22c55e":"#999"}}>
              {usernameStatus==="taken" ? "That username is taken" : uErr ? uErr : usernameStatus==="available" ? "Available — this is how people find you" : "This is separate from your name, and can't be changed by anyone but you"}
            </div>
            <input value={region} onChange={e=>setRegion(e.target.value)} placeholder="Region (e.g. Los Angeles, CA)" style={{...inp,marginBottom:10}}/>
          </>
        )}
        <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" autoCapitalize="none" style={{...inp,marginBottom:10}}/>
        <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" type="password"
          onKeyDown={e=>{if(e.key==="Enter")submit();}}
          style={{...inp,marginBottom:12}}/>
        {error && <div style={{fontSize:14,color:"#ef4444",marginBottom:12,lineHeight:1.5}}>{error}</div>}
        <button onClick={submit} disabled={busy} style={{width:"100%",padding:"13px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:16,fontWeight:800,cursor:busy?"default":"pointer",fontFamily:F,opacity:busy?0.7:1,marginBottom:14}}>
          {busy ? "One sec…" : mode==="signup" ? "Sign Up" : "Log In"}
        </button>
        <div style={{textAlign:"center",fontSize:14,color:"#666"}}>
          {mode==="signup" ? "Already have an account? " : "New here? "}
          <button onClick={()=>{setMode(mode==="signup"?"signin":"signup");setError("");}} style={{background:"none",border:"none",color:OR,fontWeight:700,cursor:"pointer",fontFamily:F,fontSize:14,padding:0}}>
            {mode==="signup" ? "Log in" : "Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════════════════════ */
export default function SonoLane() {

  /* ── Auth (real backend mode only) ──────────────────────────────────────
     When VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY aren't set — e.g. this
     app running standalone as a Claude Artifact preview — isSupabaseConfigured
     is false and the app skips all of this, behaving exactly like before
     (local-only demo data, no login). With a real project wired up, this
     gates the whole app behind sign-up/log-in and hydrates the profile +
     friends state below from real tables instead of starting blank. */
  const [session,      setSession]      = useState(null);
  const [authChecked,  setAuthChecked]  = useState(!isSupabaseConfigured);
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);
  const currentUserId = session?.user?.id || null;

  /* state */
  const [panel,        setPanel]        = useState("profile");
  const [discoverTab,  setDiscoverTab]  = useState("routes"); // "routes" | "events" — toggle within the combined Discover page
  // Shared top bar (+ quick-create / ☰ menu) — lives at the app shell level
  // now instead of inside Profile alone, so every page (Profile, Discover,
  // Lanes) shows the same persistent bar up top, matching the persistent
  // TopNav down below.
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [showInfoDrawer,  setShowInfoDrawer]  = useState(false);
  const [infoDrawerPage,  setInfoDrawerPage]  = useState(null); // null (list) | "tos" | "privacy" | "about" | "help"
  const [voiceOn,      setVoiceOn]      = useState(false);
  const [voiceText,    setVoiceText]    = useState("");
  const [aiThinking,   setAiThinking]   = useState(false);
  const [aiPalId,      setAiPalId]      = usePersistedState("sl_aiPalId", "nova");
  // "Say Sono to Wake" — Profile > AI setting. Governs voice control
  // everywhere OUTSIDE Drive mode. When on, the voice-command listener
  // below starts automatically the moment you leave Drive mode. Off by
  // default — voice control is opt-in, not something that starts listening
  // the first time you open the app.
  const [sayWakeEnabled, setSayWakeEnabled] = usePersistedState("sl_sayWake", false);
  // Drive mode's own separate voice-control setting, in Drive mode's own
  // Settings sheet — lets you keep voice on inside Drive mode independently
  // of whatever the rest-of-app setting above is set to. Also off by default.
  const [driveSayWakeEnabled, setDriveSayWakeEnabled] = usePersistedState("sl_driveSayWake", false);
  // AI Co-Pilot as a Top 3 Friend — tapping it starts a live voice call
  // instead of opening a normal friend chat.
  const [aiInTop3,     setAiInTop3]     = usePersistedState("sl_aiInTop3", false);
  const [showTop3Chooser, setShowTop3Chooser] = useState(false);
  const [aiCallOpen,      setAiCallOpen]      = useState(false);
  const [aiCallListening, setAiCallListening] = useState(false);
  const [aiCallSpeaking,  setAiCallSpeakingState] = useState(false);
  const [aiCallInterim,   setAiCallInterim]   = useState("");
  const aiCallActiveRef   = useRef(false);
  const aiCallSpeakingRef = useRef(false);
  const aiCallRecogRef    = useRef(null);
  const setAiCallSpeaking = v => { aiCallSpeakingRef.current=v; setAiCallSpeakingState(v); };
  // Defaults to "garage" so Profile home always lands with the Garage
  // section of the icon toggle row already expanded, instead of collapsed.
  const [subPanel,     setSubPanel]     = useState("garage");
  // Car customization — persisted via usePersistedState so it survives
  // closing and reopening the app (a phone install, not just this tab),
  // instead of silently resetting to defaults every time.
  const [carName,      setCarName]      = usePersistedState("sl_carName", "");
  const [carColor,     setCarColor]     = usePersistedState("sl_carColor", "#f97316");
  const [carModel,     setCarModel]     = usePersistedState("sl_carModel", "Sedan");
  const [carBodyStyle, setCarBodyStyle] = usePersistedState("sl_carBodyStyle", "sedan");
  const [carBrand,     setCarBrand]     = usePersistedState("sl_carBrand", null); // id from CAR_BRANDS, or null = unset
  const [carMods,      setCarMods]      = usePersistedState("sl_carMods", {});
  const [carSaved,     setCarSaved]     = usePersistedState("sl_carSaved", false);
  const [activeModCat, setActiveModCat] = useState("Wheels");
  const [carEditTab,   setCarEditTab]   = useState("banner"); // which Edit Car appearance tab is showing: banner|bodystyle|color|brand|mods
  const [carAvatarMode,  setCarAvatarMode]  = usePersistedState("sl_carAvatarMode", "avatar"); // "avatar" (custom CarSVG) | "photo" (uploaded pic)
  const [carAvatarPhoto, setCarAvatarPhoto] = usePersistedIDBState("sl_carAvatarPhoto", null); // base64 data URL
  const [carBannerPhoto, setCarBannerPhoto] = usePersistedIDBState("sl_carBannerPhoto", null); // base64 data URL, overrides preset if set
  const [carBannerPreset,setCarBannerPreset]= usePersistedState("sl_carBannerPreset", "midnight");
  const [carShowInfoHome,setCarShowInfoHome]= usePersistedState("sl_carShowInfoHome", false); // show car name/model text on the home hero avatar window
  const [carBio,       setCarBio]       = usePersistedState("sl_carBio", ""); // free-text description (mods done, build notes, etc.) — shown on the car details page, above Photos
  const [carPlate,     setCarPlate]     = usePersistedState("sl_carPlate", ""); // private — license plate
  const [carRegDate,   setCarRegDate]   = usePersistedState("sl_carRegDate", ""); // private — registration date
  const [carMileage,   setCarMileage]   = usePersistedState("sl_carMileage", ""); // private — current odometer reading
  const [carPrivateNotes, setCarPrivateNotes] = usePersistedState("sl_carPrivateNotes", ""); // private — any other handy info (VIN, insurance, service reminders, etc.)
  const [carPrivatePhotos, setCarPrivatePhotos] = usePersistedIDBState("sl_carPrivatePhotos", []); // private — [{id,url}] snapshots of insurance card, registration, etc.
  const carAvatarPhotoRef = useRef(null);
  const carBannerPhotoRef = useRef(null);
  const carPrivatePhotoRef = useRef(null);
  const [userName,     setUserName]     = usePersistedState("sl_userName", "");
  const [userHandle,   setUserHandle]   = usePersistedState("sl_userHandle", ""); // the account's real, unique username — distinct from the freely-changeable display name above; this is what accounts are found/saved by
  const [userBio,      setUserBio]      = usePersistedState("sl_userBio", "");
  const [userRegion,   setUserRegion]   = usePersistedState("sl_userRegion", ""); // e.g. "Los Angeles, CA" — collected at sign-up
  const [editMode,     setEditMode]     = useState(false);
  const [editUsernameStatus, setEditUsernameStatus] = useState("idle"); // idle|checking|available|taken|invalid
  const [editSaveError, setEditSaveError] = useState("");
  // Lanes-related settings — lifted up here (out of CreatePanel) so the
  // global Settings page (rendered from ProfilePanel, a different closure)
  // can read and toggle them too, now that they live there instead of in
  // their own separate Lanes Settings sheet.
  const [showOnlineStatus, setShowOnlineStatus] = usePersistedState("sl_showOnlineStatus", true);
  const [lanesNotifications, setLanesNotifications] = usePersistedState("sl_lanesNotifications", true);
  const [profilePhoto, setProfilePhoto] = usePersistedIDBState("sl_profilePhoto", null); // base64 data URL
  const profilePhotoRef = useRef(null);
  const garagePhotoRef = useRef(null); // Shared Garage's own profile-photo upload (Edit Garage sheet)
  const [carExteriorPhotos, setCarExteriorPhotos] = usePersistedIDBState("sl_carExteriorPhotos", []); // [{id,url}] — up to 4 garage exterior shots
  const [carInteriorPhotos, setCarInteriorPhotos] = usePersistedIDBState("sl_carInteriorPhotos", []); // [{id,url}] — up to 4 garage interior shots
  const carExteriorPhotoRef = useRef(null);
  const carInteriorPhotoRef = useRef(null);

  // My Garage — up to 3 cars total. Whichever car's data currently lives in
  // the carName/carColor/... fields above is the "active" one — every other
  // screen in the app (home hero avatar, profile header, drive mode, etc.)
  // just reads those same fields, so it always shows whichever car is
  // active without needing any changes. myCars holds snapshots of the
  // OTHER (inactive) cars; switching cars just swaps which snapshot is
  // loaded into the live fields vs. parked in this array.
  const [myCars, setMyCars] = usePersistedIDBState("sl_myCars", []); // [{id,name,color,model,bodyStyle,brand,mods,saved,avatarMode,avatarPhoto,bannerPhoto,bannerPreset,showInfoHome,bio,plate,regDate,mileage,privateNotes,privatePhotos,exteriorPhotos,interiorPhotos}]
  const [activeCarId, setActiveCarId] = usePersistedState("sl_activeCarId", "car_1");
  const snapshotActiveCar = (id) => ({
    id, name:carName, color:carColor, model:carModel, bodyStyle:carBodyStyle, brand:carBrand,
    mods:carMods, saved:carSaved, avatarMode:carAvatarMode, avatarPhoto:carAvatarPhoto,
    bannerPhoto:carBannerPhoto, bannerPreset:carBannerPreset, showInfoHome:carShowInfoHome,
    bio:carBio, plate:carPlate, regDate:carRegDate, mileage:carMileage,
    privateNotes:carPrivateNotes, privatePhotos:carPrivatePhotos,
    exteriorPhotos:carExteriorPhotos, interiorPhotos:carInteriorPhotos,
  });
  const applyCarSnapshot = (car) => {
    setCarName(car.name||""); setCarColor(car.color||"#f97316"); setCarModel(car.model||"Sedan");
    setCarBodyStyle(car.bodyStyle||"sedan"); setCarBrand(car.brand??null); setCarMods(car.mods||{});
    setCarSaved(!!car.saved); setCarAvatarMode(car.avatarMode||"avatar"); setCarAvatarPhoto(car.avatarPhoto||null);
    setCarBannerPhoto(car.bannerPhoto||null); setCarBannerPreset(car.bannerPreset||"midnight");
    setCarShowInfoHome(!!car.showInfoHome); setCarBio(car.bio||""); setCarPlate(car.plate||"");
    setCarRegDate(car.regDate||""); setCarMileage(car.mileage||""); setCarPrivateNotes(car.privateNotes||"");
    setCarPrivatePhotos(car.privatePhotos||[]); setCarExteriorPhotos(car.exteriorPhotos||[]); setCarInteriorPhotos(car.interiorPhotos||[]);
  };
  // Swap another saved car into the live fields (and park the current one
  // in its place) — pure data, no navigation, so callers decide what to
  // show afterward.
  const switchToCar = (id) => {
    if(id===activeCarId) return;
    const target = myCars.find(c=>c.id===id);
    if(!target) return;
    const current = snapshotActiveCar(activeCarId);
    setMyCars(list => [...list.filter(c=>c.id!==id), current]);
    applyCarSnapshot(target);
    setActiveCarId(id);
  };
  const MAX_CARS = 3;
  // Park the current car and load a blank one into the live fields —
  // capped at MAX_CARS total between the active car + myCars.
  const addNewCar = () => {
    if(myCars.length+1 >= MAX_CARS) return;
    const current = snapshotActiveCar(activeCarId);
    const newId = "car_"+Date.now();
    setMyCars(list => [...list, current]);
    applyCarSnapshot({id:newId});
    setActiveCarId(newId);
  };
  // Delete a car from the garage — either a parked one (just drop its
  // snapshot) or the currently active one (swap in the next parked car, or
  // reset to a blank car if this was the only one left). Each car's photos
  // and details are independent, so deleting one never touches another.
  const deleteCar = (id) => {
    if(id===activeCarId){
      const next = myCars[0];
      if(next){
        setMyCars(list => list.slice(1));
        applyCarSnapshot(next);
        setActiveCarId(next.id);
      } else {
        applyCarSnapshot({id:"car_"+Date.now()});
        setActiveCarId("car_1");
      }
    } else {
      setMyCars(list => list.filter(c=>c.id!==id));
    }
  };
  // Persisted (used to be plain useState, so adding a friend never survived
  // closing the app — the same bug as "following" not saving, below).
  const [friends,      setFriends]      = usePersistedState("sl_friends", []);
  const [showAddFriend,setShowAddFriend]= useState(false);
  const [newFriend,    setNewFriend]    = useState({name:"",handle:""});
  const [selFriend,    setSelFriend]    = useState(null);

  // ── Real-backend data (Supabase) ─────────────────────────────────────
  // Hydrate your profile + friends from real tables once signed in. In
  // local demo mode (no Supabase project configured) none of this runs,
  // and userName/userBio/profilePhoto/friends just stay local state like
  // they always have.
  useEffect(() => {
    if (!isSupabaseConfigured || !currentUserId) return;
    (async () => {
      const { data: prof } = await supabase.from("profiles").select("*").eq("id", currentUserId).single();
      if (prof) {
        setUserName(prof.name || "");
        setUserHandle(prof.handle || "");
        setUserBio(prof.bio || "");
        setUserRegion(prof.region || "");
        setProfilePhoto(prof.photo_url || null);
      }
      const { data: rows } = await supabase
        .from("friends")
        .select("friend_id, created_at, profiles:friend_id(id, name, handle, initials, color, photo_url)")
        .eq("owner_id", currentUserId)
        .order("created_at", { ascending: true });
      if (rows) {
        setFriends(rows.filter(r=>r.profiles).map(r => ({
          id: r.profiles.id, name: r.profiles.name || "Unnamed", handle: r.profiles.handle || "",
          initials: r.profiles.initials || "??", color: r.profiles.color || "#f97316",
          photo: r.profiles.photo_url || null,
        })));
      }
    })();
  }, [currentUserId]);

  // Persists name/bio/photo/username to your real profile row — no-op in
  // local demo mode. Username is normalized one more time right here, right
  // before the write that actually matters (Postel's Law's other half: be
  // liberal reading input, strict about what you ever actually store/send).
  const saveProfileToSupabase = async () => {
    if (!isSupabaseConfigured || !currentUserId) return { error: null };
    const handle = normalizeUsername(userHandle);
    const { error } = await supabase.from("profiles").update({ name: userName, handle: handle || null, bio: userBio, region: userRegion, photo_url: profilePhoto }).eq("id", currentUserId);
    return { error };
  };
  // Live availability check used by Edit Profile's username field — mirrors
  // the one in AuthScreen but excludes the signed-in user's own row, since
  // "is @you available" should always say yes for you.
  const checkUsernameAvailable = async (handle) => {
    if (!isSupabaseConfigured || !currentUserId || !handle) return null;
    const { data } = await supabase.from("profiles").select("id").ilike("handle", handle).neq("id", currentUserId).maybeSingle();
    return !data;
  };
  // Debounced check as you edit your username on the Edit Profile page —
  // same Doherty-Threshold "checking…" pattern as sign-up, gated to editMode
  // so it never fires from the background hydration effect quietly
  // resetting userHandle right after login.
  useEffect(() => {
    if (!isSupabaseConfigured || !editMode) return;
    const u = normalizeUsername(userHandle);
    if (!u) { setEditUsernameStatus("idle"); return; }
    if (usernameError(u)) { setEditUsernameStatus("invalid"); return; }
    setEditUsernameStatus("checking");
    const t = setTimeout(async () => {
      const ok = await checkUsernameAvailable(u);
      setEditUsernameStatus(ok===false ? "taken" : "available");
    }, 450);
    return () => clearTimeout(t);
  }, [userHandle, editMode]);
  // Adds/removes a row in the real friends table — no-op in local demo mode
  // (each call site also updates the local `friends` array either way, so
  // the UI reacts the same in both modes).
  const addFriendSupabase = async (friendId) => {
    if (!isSupabaseConfigured || !currentUserId) return;
    await supabase.from("friends").insert({ owner_id: currentUserId, friend_id: friendId });
  };
  const removeFriendSupabase = async (friendId) => {
    if (!isSupabaseConfigured || !currentUserId) return;
    await supabase.from("friends").delete().eq("owner_id", currentUserId).eq("friend_id", friendId);
  };
  // Searches real signed-up users by name — the backend-mode replacement
  // for the local demo mode's SAMPLE_PEOPLE/followers search.
  // Matches on name OR username — usernames are the real, unique lookup key
  // (an exact/prefix match on "handle" always finds the right account, even
  // if two people share the same display name), while the name match keeps
  // the friendlier "search by what you actually remember about them"
  // behavior people expect from every other app (Jakob's Law).
  const searchProfilesSupabase = async (query) => {
    if (!isSupabaseConfigured || !query.trim() || !currentUserId) return [];
    const q = query.trim().replace(/^@+/, "");
    const { data } = await supabase.from("profiles").select("id,name,handle,initials,color,photo_url")
      .or("name.ilike.%"+q+"%,handle.ilike.%"+q+"%").neq("id", currentUserId).limit(20);
    return data || [];
  };
  // Sends a real 1:1 message row — the Lanes Direct Messages backend.
  // Returns the inserted row's real id so the caller can reconcile it with
  // the optimistic local copy (see sendChanMsg) — otherwise the next poll
  // fetches the same message back under its DB id, which doesn't match the
  // local Date.now() id, and it silently doubles up in the thread.
  const sendMessageSupabase = async (recipientId, text) => {
    if (!isSupabaseConfigured || !currentUserId || !recipientId || !text.trim()) return null;
    const { data } = await supabase.from("messages")
      .insert({ sender_id: currentUserId, recipient_id: recipientId, text: text.trim() })
      .select("id").single();
    return data ? data.id : null;
  };
  // Loads the full 1:1 history with one friend, both directions.
  const fetchMessagesSupabase = async (otherUserId) => {
    if (!isSupabaseConfigured || !currentUserId || !otherUserId) return [];
    const { data } = await supabase.from("messages").select("*")
      .or(`and(sender_id.eq.${currentUserId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${currentUserId})`)
      .order("created_at", { ascending: true }).limit(300);
    return data || [];
  };
  // Drops a notification row into someone else's feed — friend-adds and new
  // messages both use this so the OTHER person actually finds out.
  const sendNotificationSupabase = async (recipientId, icon, text) => {
    if (!isSupabaseConfigured || !currentUserId || !recipientId) return;
    await supabase.from("notifications").insert({ recipient_id: recipientId, actor_id: currentUserId, icon, text });
  };
  // Events — creating one saves a real row so it shows up on EVERY signed-in
  // user's Events feed, not just your own device. Local demo mode (no
  // Supabase project) keeps events device-local like everything else here.
  // Your own events still live in local state the instant you create them
  // (see submitEvent) — these helpers are what makes them reach everyone else.
  const createEventSupabase = async (ev) => {
    if (!isSupabaseConfigured || !currentUserId) return null;
    const { data } = await supabase.from("events").insert({
      author_id: currentUserId, author_name: userName || "You",
      // The DB column is "description", not "desc" — desc is a reserved
      // word in Postgres (as in ORDER BY ... DESC) and isn't a valid bare
      // column name. The app's own event objects keep using "desc"
      // everywhere else; this is just the wire format for this one table.
      title: ev.title, type: ev.type, description: ev.desc || "", address: ev.address || "",
      event_date: ev.date || "", icon: ev.icon || "📍", photos: ev.photos || [], rsvps: 0,
    }).select("id").single();
    return data ? data.id : null;
  };
  const updateEventSupabase = async (sbId, ev) => {
    if (!isSupabaseConfigured || !currentUserId || !sbId) return;
    await supabase.from("events").update({
      title: ev.title, type: ev.type, description: ev.desc || "", address: ev.address || "",
      event_date: ev.date || "", icon: ev.icon || "📍", photos: ev.photos || [],
    }).eq("id", sbId).eq("author_id", currentUserId);
  };
  const deleteEventSupabase = async (sbId) => {
    if (!isSupabaseConfigured || !currentUserId || !sbId) return;
    await supabase.from("events").delete().eq("id", sbId).eq("author_id", currentUserId);
  };
  // Loads every OTHER signed-in user's events for the shared community feed.
  // Your own stay purely local (already there the instant you create them,
  // no round trip needed) — this only ever fetches events you didn't author.
  useEffect(() => {
    if (!isSupabaseConfigured || !currentUserId) return;
    (async () => {
      const { data } = await supabase.from("events").select("*")
        .neq("author_id", currentUserId).order("created_at", { ascending: false }).limit(300);
      if (!data) return;
      const mapped = data.map(r => ({
        id: "sb_"+r.id, sbId: r.id, title: r.title, type: r.type, desc: r.description || "",
        address: r.address || "", date: r.event_date || "", icon: r.icon || "📍",
        photos: r.photos || [], authorId: r.author_id, authorName: r.author_name || "Driver",
        rsvps: r.rsvps || 0,
      }));
      // Replace any previously-fetched community events with this fresh
      // batch, but never touch your own local ones (everything not tagged
      // with the "sb_" id prefix).
      setEvents(prev => [...mapped, ...prev.filter(e => !String(e.id).startsWith("sb_"))]);
    })();
  }, [currentUserId]);

  // Live location sharing — a Top 3 Friend perk. Ids of friends it's on for;
  // stays on indefinitely once toggled (no auto-expiry), until turned off.
  const [locationSharing, setLocationSharing] = useState(()=>JSON.parse(memStore.getItem("sl_locSharing")||"[]"));
  const toggleLocationSharing = id => setLocationSharing(p=>{
    const next = p.includes(id) ? p.filter(x=>x!==id) : [...p, id];
    memStore.setItem("sl_locSharing", JSON.stringify(next));
    return next;
  });
  // (Collaborate-together — Routes/Radio/Garage — removed as a Top 3 Friend
  // perk; Live Location Sharing below is the only Top 3 perk now.)
  const [pts,          setPts]          = useState(() => parseInt(memStore.getItem("sl_pts")||"0"));
  const [dashOn,       setDashOn]       = useState(false);
  // camLive: the camera preview stream is open (Dashcam widget shows the
  // live feed). Independent from dashOn (actually recording a clip) — the
  // widget shows the camera the whole time you're in Drive mode once
  // consented, but a clip is only ever saved while dashOn is also true
  // (i.e. once you're actually moving over 5 mph).
  const [camLive,      setCamLive]      = useState(false);
  const [dashcamConsent, setDashcamConsent] = useState(()=>memStore.getItem("sl_dashcamConsent")==="1"); // Dashcam ToS/Privacy accepted?
  const [showDashcamSetup, setShowDashcamSetup] = useState(false); // one-time inline setup prompt, opened from the Dashcam widget
  // Separate from consent — lets you keep the dashcam permission granted
  // while turning off automatic speed-triggered recording during Drive
  // mode any time, without having to revoke access altogether.
  const [dashcamBgRecord, setDashcamBgRecord] = usePersistedState("sl_dashcamBgRecord", true);
  const [mapInteractive, setMapInteractive] = useState(false); // false = swipe-through overlay active over map iframe
  const [cbCoords,      setCbCoords]      = useState(null); // {lat,lng} — watched only while the CB Radio sheet is open
  const [recSecs,      setRecSecs]      = useState(0);
  const [gpsSpeed,     setGpsSpeed]     = useState(0);
  const [tripDist,     setTripDist]     = useState(0);
  const [tripSecs,     setTripSecs]     = useState(0);
  const [roadMsgs,     setRoadMsgs]     = useState(["Ready. Dashcam starts automatically once you're moving over 5 mph."]);
  const [chatIn,       setChatIn]       = useState("");
  const [showAgent,    setShowAgent]    = useState(false);
  const [clips,        setClips]        = useState([]);
  // Load saved dashcam footage from IndexedDB the moment the app opens —
  // purging anything past the 72-hour retention window first — and keep
  // rechecking every so often while the app stays open so a clip that
  // crosses that mark mid-session gets cleared out too, not just on the
  // next launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const records = await clipsDB.getAll();
      if (cancelled) return;
      const cutoff = Date.now() - CLIP_RETENTION_MS;
      const fresh = [], stale = [];
      records.forEach(r => (r.id < cutoff ? stale : fresh).push(r));
      stale.forEach(r => clipsDB.remove(r.id));
      fresh.sort((a, b) => b.id - a.id);
      // Keep the Blob only in IndexedDB, not in React state too — the state
      // copy just needs a playback URL derived from it.
      setClips(fresh.map(({ blob, ...meta }) => ({ ...meta, url: URL.createObjectURL(blob) })));
    })();
    const iv = setInterval(() => {
      const cutoff = Date.now() - CLIP_RETENTION_MS;
      setClips(prev => {
        const keep = [], drop = [];
        prev.forEach(c => (c.id < cutoff ? drop : keep).push(c));
        if (!drop.length) return prev;
        drop.forEach(c => { try { URL.revokeObjectURL(c.url); } catch {} clipsDB.remove(c.id); });
        return keep;
      });
    }, 60 * 60 * 1000); // recheck hourly
    return () => { cancelled = true; clearInterval(iv); };
  }, []);
  const [tripHistory,  setTripHistory]  = useState([]); // [{id,date,time,dist,dur,pts,startAddr,endAddr,path}]
  const [selTrip,      setSelTrip]      = useState(null); // selected trip in history view
  const [unlockedAch,  setUnlockedAch]  = useState(()=>JSON.parse(memStore.getItem("sl_ach")||"[]")); // [id,...]
  const [newAchQueue,  setNewAchQueue]  = useState([]); // achievements to show as popups
  const [showAchPanel, setShowAchPanel] = useState(false);
  // Drive-session tracking
  const [lastDriveUnderLimit, setLastDriveUnderLimit] = useState(false);
  const [greenLightStreak, setGreenLightStreak] = useState(0);
  const [hadNightDrive, setHadNightDrive] = useState(false);
  const [totalMiles, setTotalMiles] = useState(()=>parseFloat(memStore.getItem("sl_miles")||"0"));
  const [playingClip,  setPlayingClip]  = useState(null);
  const [selCalDate,   setSelCalDate]   = useState(null);
  const [posts,        setPosts]        = usePersistedIDBState("sl_posts", []);
  // One-time seed: drop the 10 San Diego route posts into the feed the first
  // time this runs, regardless of what's already in posts (so it still
  // happens even though "posts" already had a persisted, possibly-empty,
  // value from before this feature existed). Never repeats once seeded.
  useEffect(() => {
    if (memStore.getItem("sl_sdRoutesSeeded")) return;
    memStore.setItem("sl_sdRoutesSeeded", "1");
    setPosts(p => [...SD_ROUTE_POSTS, ...p]);
  }, []);
  const [showPost,     setShowPost]     = useState(false);
  const [newPost,      setNewPost]      = useState({title:"",body:"",type:"scenic",distance:"",stops:["",""],highlights:""});
  const [postPhotos,   setPostPhotos]   = useState([]);
  const [postRouteMode,setPostRouteMode]= useState("new"); // "new"|"existing"
  const [postSavedRoute,setPostSavedRoute]=useState(null); // selected saved route id
  const [showRoutePicker,setShowRoutePicker]=useState(false);
  // Which route post (by id) is expanded to its own full-screen info page —
  // opened by tapping any route card while browsing the feed.
  const [viewRouteId,  setViewRouteId]  = useState(null);
  // Which post is being edited via the "Create Route Post" sheet — null
  // means the sheet is in create-new mode. Every route is yours (authorId
  // "me"), so every route card can be reopened here and edited.
  const [editingPostId,setEditingPostId]= useState(null);
  const [likedPosts,   setLikedPosts]   = useState({});
  const [feedSearch,   setFeedSearch]   = useState("");
  const [evSearch,     setEvSearch]     = useState(""); // Events search — lifted up so the shared TopBar can drive it
  const [laneUserSearch, setLaneUserSearch] = useState(""); // Lanes TopBar — look up users
  // Lanes shows a centered page title in the TopBar by default, with a 🔍
  // button on the right that swaps the title out for the actual search box
  // (Minimize Target Distance / Doherty Threshold — search is one tap away
  // without permanently taking up the title's spot). Tapping the ✕ that
  // replaces 🔍 while searching clears the search text and switches back
  // to the title. Discover (Routes/Events) went back to always showing its
  // search box in the TopBar, like before.
  const [lanesSearchActive, setLanesSearchActive] = useState(false);
  // Where the car detail page was opened from — the hero avatar at the top
  // of the profile, or a car tile inside My Garage — so its back button (now
  // the shared TopBar's back button) can return you to wherever you actually
  // came from instead of always one place. Lifted up so both ProfilePanel
  // and TopBar can read/set it.
  const [carDetailFrom, setCarDetailFrom] = useState("profile");
  const [events,       setEvents]       = usePersistedIDBState("sl_events", []);
  // One-time seed: drop the 10 San Diego events into the feed the first time
  // this runs, same pattern as the route posts seed above. Never repeats.
  useEffect(() => {
    if (memStore.getItem("sl_sdEventsSeeded")) return;
    memStore.setItem("sl_sdEventsSeeded", "1");
    setEvents(p => [...SD_EVENTS, ...p]);
  }, []);
  const [showEvent,    setShowEvent]    = useState(false);
  const [newEvent,     setNewEvent]     = useState({title:"",type:"car meet",desc:"",address:"",date:""});
  const [eventPhotos,  setEventPhotos]  = useState([]);
  const [flyerEvent,   setFlyerEvent]   = useState(null);
  // Which event is being edited via the Create Event sheet — null means
  // create-new mode. Only the event's own author (always "me" today) can
  // open this in edit mode.
  const [editingEventId, setEditingEventId] = useState(null);
  // Optimistic per-viewer RSVP toggle — same pattern as likedPosts — layered
  // on top of each event's base `rsvps` count.
  const [rsvpedEvents, setRsvpedEvents] = useState({});
  const [routes,       setRoutes]       = usePersistedState("sl_routes", []);
  // One-time seed: the 10 San Diego routes also count as routes you've
  // actually created (not just posted to the feed), so "My Routes" and your
  // Stats show 10 created routes. Same never-repeats pattern as the events
  // and route-post seeds above.
  // NOTE: this used to share the "sl_sdRoutesSeeded" flag with the feed-post
  // seed above — since both effects run on mount, the posts seed always set
  // that flag first, so this one always saw it already set and never ran,
  // and "My Routes" stayed empty. Given its own flag so it actually fires.
  useEffect(() => {
    if (memStore.getItem("sl_sdMyRoutesSeeded")) return;
    memStore.setItem("sl_sdMyRoutesSeeded", "1");
    setRoutes(p => [...SD_ROUTES, ...p]);
  }, []);
  const [savedFromFeed,setSavedFromFeed]= usePersistedState("sl_savedFromFeed", []); // routes saved from feed posts
  const [savedEventIds,setSavedEventIds]= usePersistedState("sl_savedEventIds", []); // ids of other people's events you've RSVP'd to — shown in My Events as "Saved"
  const [newRoute,     setNewRoute]     = useState({title:"",type:"commute",distance:"",bio:"",stops:[""],public:false});
  // Which "My Routes" entry (by id) is being edited via the Create/Edit
  // Route sheet — null means the sheet is in create-new mode, same pattern
  // as editingEventId/editingPostId elsewhere.
  const [editingRouteId, setEditingRouteId] = useState(null);
  const openEditRoute = (r) => {
    setNewRoute({ title:r.title||"", type:r.type||"commute", distance:r.distance||"", bio:r.bio||"", stops:r.stops?.length?[...r.stops]:[""], public:!!r.public });
    setEditingRouteId(r.id);
    setSubPanel("createroute");
  };
  const [showMusic,    setShowMusic]    = useState(false);
  const [musicTab,     setMusicTab]     = useState(()=>memStore.getItem("sl_radioTab")||"lanes"); // last mode persists
  const [startupSound,  setStartupSound]  = useState(()=>memStore.getItem("sl_startupSound")||"classic");
  const [spotifyLinked,setSpotifyLinked]= useState(false);
  // Spotify "Now Playing" activity — a real Spotify connection needs their
  // own developer OAuth key, which we don't have, but once you've linked in
  // My Music this actually ticks forward in real time and advances tracks,
  // driven by the play/pause you tap on the widget or in My Music.
  const [spotifyTrackIdx, setSpotifyTrackIdx] = useState(0);
  const [spotifyPlaying,  setSpotifyPlaying]  = useState(false);
  const [spotifyElapsed,  setSpotifyElapsed]  = useState(0);
  useEffect(() => {
    if(!spotifyPlaying) return;
    const t = setInterval(() => {
      setSpotifyElapsed(e => {
        const dur = SPOTIFY_TRACKS[spotifyTrackIdx].dur;
        if(e+1 >= dur){ setSpotifyTrackIdx(i => (i+1)%SPOTIFY_TRACKS.length); return 0; }
        return e+1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [spotifyPlaying, spotifyTrackIdx]);
  const [appleOn,      setAppleOn]      = useState(false);
  const [isBroad,      setIsBroad]      = useState(false);
  const [broadName,    setBroadName]    = useState("");
  const [showReg,      setShowReg]      = useState(false);
  const [hostForm,     setHostForm]     = useState({name:"",genre:"",bio:"",handle:""});
  const [radioHosts,   setRadioHosts]   = useState([]);
  const [tLines,       setTLines]       = useState([]);
  // Lanes chat
  const [activeChan,   setActiveChan]   = useState("notes");
  // Lanes is now two separate full pages on top of the shared TopBar/TopNav
  // shell — "list" (the sidebar's chat names, full screen) and "room" (the
  // full-screen chat for whichever chan is active). Tapping any chat in the
  // list switches to "room"; the shared TopBar becomes that page's back
  // button (see BACK_PAGES-style handling in TopBar) to return to "list".
  const [lanesView,    setLanesView]    = useState("list");
  // Set only when a Lanes room is opened FROM a Shared Garage page (its
  // group chat, or a member's individual DM) — {garageId}. The room's back
  // button checks this first: when set, back returns to that Shared Garage
  // page instead of the plain Lanes chat list. Cleared the moment it's
  // consumed (see backFromLanesRoom below), and defaults back to null on
  // every other way of opening Lanes (see go()) so it never leaks into an
  // unrelated chat opened afterward.
  const [lanesRoomOrigin, setLanesRoomOrigin] = useState(null);
  const [laneMsgs,     setLaneMsgs]     = useState({}); // {laneId: [{id,text,user,initials,color,ts,isVoice,voiceSeconds}]}
  const [showCreateLane,setShowCreateLane]=useState(false);
  const [voiceChatActive, setVoiceChatActive] = useState(null); // chanId currently in voice
  const [voiceChatMembers,setVoiceChatMembers]= useState({}); // {chanId: [name,...]}
  const [vcRecording,   setVcRecording]   = useState(false);
  const [vcTimer,       setVcTimer]       = useState(0);
  const vcTimerRef = useRef(null);
  const [newLaneName,  setNewLaneName]  = useState("");
  const [newLaneVisibility, setNewLaneVisibility] = useState("friends"); // "friends" | "public" — chosen when creating a lane
  const [customLanes,  setCustomLanes]  = usePersistedState("sl_customLanes", []); // user-created lanes
  // Shared Garages — a garage co-owned with invited friends. Each has its
  // own member roster, a vehicle (with a bio) per member, and a dedicated
  // group chat lane (auto-created, id "garage_<id>") that reuses the same
  // Lanes chat plumbing as everything else in Lanes.
  const [sharedGarages, setSharedGarages] = usePersistedIDBState("sl_sharedGarages", []); // [{id,name,color,memberIds:[...friendIds],vehicles:[{id,ownerId,ownerName,ownerInitials,ownerColor,name,bio}],laneId}]
  const [showCreateSharedGarage, setShowCreateSharedGarage] = useState(false);
  const [newSharedGarageName, setNewSharedGarageName] = useState("");
  const [newGarageInvitees, setNewGarageInvitees] = useState([]); // friend ids picked to invite when creating
  const [selSharedGarage, setSelSharedGarage] = useState(null); // id of the shared garage currently open
  const [showEditGarage, setShowEditGarage] = useState(false); // Edit Shared Garage sheet — photo, name, bio, members
  const [editGarageDraft, setEditGarageDraft] = useState({name:"",bio:"",photo:null});
  const [garageMemberAction, setGarageMemberAction] = useState(null); // friend object — Call/Text action sheet opened by tapping a member's vehicle window
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [newVehicle, setNewVehicle] = useState({name:"",bio:""});
  const [shareCarId, setShareCarId] = useState(null); // which saved garage car is picked in the "Add/Change Vehicle" sheet — null = typing one manually
  const [cbRecording,  setCbRecording]  = useState(false); // recording voice msg for CB
  const [cbTimer,      setCbTimer]      = useState(0);
  const [savedStations, setSavedStations] = useState(()=>JSON.parse(memStore.getItem("sl_savedStations")||"[]")); // names of favorited radio stations, viewable in Profile's Radio Stations page
  const toggleSavedStation = name => setSavedStations(p=>{
    const next = p.includes(name) ? p.filter(x=>x!==name) : [...p, name];
    memStore.setItem("sl_savedStations", JSON.stringify(next));
    return next;
  });
  const cbTimerRef = useRef(null);
  const CB_CITY_LANES = [
    {id:"lane_5",    name:"I-5",     city:"San Diego",    desc:"The 5 · North-South corridor",   color:"#f97316", icon:"📡"},
    {id:"lane_805",  name:"I-805",   city:"San Diego",    desc:"The 805 · Eastern bypass",       color:"#6366f1", icon:"📡"},
    {id:"lane_163",  name:"SR-163",  city:"San Diego",    desc:"Cabrillo · Balboa Park",         color:"#22c55e", icon:"📡"},
    {id:"lane_94",   name:"SR-94",   city:"San Diego",    desc:"Martin Luther King Fwy",         color:"#a855f7", icon:"📡"},
    {id:"lane_15",   name:"I-15",    desc:"The 15 · Inland / Miramar",       color:"#ef4444", icon:"📡"},
    {id:"lane_8",    name:"I-8",     desc:"Mission Valley / East County",    color:"#14b8a6", icon:"📡"},
    {id:"lane_52",   name:"SR-52",   desc:"Santee · Miramar",               color:"#f59e0b", icon:"📡"},
    {id:"lane_56",   name:"SR-56",   desc:"Carmel Valley · Rancho Bernardo",color:"#ec4899", icon:"📡"},
  ];
  // Which freeway lane (if any) the device's current location falls on. There's
  // no real road-network/map-matching API wired into this app, so this is a
  // deterministic simulation from the coordinates themselves — stable while
  // stationary, changes as the device moves. Null coords or a "between
  // freeways" bucket both mean "not currently on a tracked freeway."
  const currentFreewayId = (() => {
    if(!cbCoords) return null;
    const h = Math.abs(Math.round(cbCoords.lat*10000)*31 + Math.round(cbCoords.lng*10000)*17);
    if(h % 3 === 0) return null; // simulated gap between freeway corridors
    return CB_CITY_LANES[h % CB_CITY_LANES.length].id;
  })();
  // Transcribed & summarized CB reports per freeway lane — {laneId: [{id,icon,text,handle,color,ts}]}.
  // Seeded with a recent report on most (not all — some lanes stay quiet so
  // the empty state is reachable too) lanes so the "browse before driving"
  // view isn't empty on first load.
  const [laneTrafficUpdates, setLaneTrafficUpdates] = useState(() => {
    const out = {};
    CB_CITY_LANES.forEach((lane, i) => {
      if (i % 4 === 3) return;
      const rep = TRAFFIC_REPORTS[(i * 3 + 1) % TRAFFIC_REPORTS.length];
      const h = CB_HANDLES[i % CB_HANDLES.length];
      out[lane.id] = [{ id:"seed_"+lane.id, icon:rep.icon, text:rep.text, handle:h.name, color:h.color, ts:Date.now()-(4+i*6)*60000 }];
    });
    return out;
  });
  const timeAgo = (ts) => {
    const mins = Math.max(0, Math.floor((Date.now()-ts)/60000));
    if (mins < 1) return "just now";
    if (mins < 60) return mins+"m ago";
    return Math.floor(mins/60)+"h ago";
  };
  const [friendMsgs,   setFriendMsgs]   = useState({}); // {friendId: [{id,text,mine,ts}]}
  const [chanInput,    setChanInput]     = useState("");
  // Follow system — persisted, so who you follow survives closing the app
  // (this used to be plain useState, which never saved it at all).
  const [following,    setFollowing]     = usePersistedState("sl_following", []); // [{id,name,handle,initials,color}] — people you follow
  const [followersList,setFollowersList] = useState(SAMPLE_PEOPLE.slice(0,3)); // [{id,name,handle,initials,color}] — people following you
  const [quickUser,    setQuickUser]     = useState(null); // account quick-access sheet (Following/Followers row tap)
  // Full public profile page — every account is public, so tapping a
  // person's name anywhere (Friends, Followers, Following, Add a Friend,
  // the quick-access sheet) can open this: their garage/car avatar and
  // whatever routes/events they've posted.
  const [viewedProfile, setViewedProfile] = useState(null);
  const [friendRequestsSent, setFriendRequestsSent] = usePersistedState("sl_friendRequestsSent", []); // ids of people a friend request has been sent to
  const [notifications,setNotifications]= useState([
    {id:1, icon:"⚡", text:"Welcome to SonoLane! Create your first event.", ts:"now", read:false},
    {id:2, icon:"🗺️", text:"Save a route to start tracking your drives.", ts:"1m", read:false},
    {id:3, icon:"👥", text:"Mia Chen started following you.", ts:"2h", read:false},
    {id:4, icon:"👥", text:"SoCalDrifter started following you.", ts:"1d", read:false},
  ]);
  // Real backend — pull in notifications other real users actually sent you
  // (friend-adds, messages) and keep polling for new ones. These merge in
  // alongside the local sample/self-toast notifications above by id, so
  // nothing existing breaks; real rows use their Supabase UUID as id (a
  // string), the local ones use a number, so the two never collide.
  useEffect(() => {
    if (!isSupabaseConfigured || !currentUserId) return;
    let cancelled = false;
    const fetchNotifs = async () => {
      const { data } = await supabase.from("notifications").select("*")
        .eq("recipient_id", currentUserId).order("created_at", { ascending: false }).limit(50);
      if (cancelled || !data) return;
      setNotifications(prev => {
        const known = new Set(prev.map(n=>String(n.id)));
        const fresh = data.filter(r=>!known.has(String(r.id))).map(r => ({
          id: r.id, icon: r.icon || "🔔", text: r.text,
          ts: timeAgo(new Date(r.created_at).getTime()), read: r.read,
        }));
        return fresh.length ? [...fresh, ...prev] : prev;
      });
    };
    fetchNotifs();
    const iv = setInterval(fetchNotifs, 8000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [currentUserId]);
  const [noteText,     setNoteText]     = useState("");
  const [sonoMode,     setSonoMode]     = useState("notes");
  const [aiInput,      setAiInput]      = useState("");
  const [aiChat,       setAiChat]       = useState([{role:"ai",text:"Ready. Say \"Sono\" to ask me anything."}]);
  // Drive mode's 3 stacked widget slots (top/mid/bottom of the widgets
  // column) — persisted so your picks survive closing the app, same as
  // every other saved preference.
  const [widget1,      setWidget1]      = usePersistedState("sl_driveWidget1", "weather");
  const [widget2,      setWidget2]      = usePersistedState("sl_driveWidget2", "points");
  const [widget3,      setWidget3]      = usePersistedState("sl_driveWidget3", "dashcam");
  // Per-slot "only show when turned on" — when true, that slot disappears
  // (instead of showing an idle widget) until it's actually active, and the
  // remaining slot(s) stretch to fill the freed space since they're just
  // equal flex children of the same row/column.
  const [widget1OnlyOn, setWidget1OnlyOn] = usePersistedState("sl_driveWidget1OnlyOn", false);
  const [widget2OnlyOn, setWidget2OnlyOn] = usePersistedState("sl_driveWidget2OnlyOn", false);
  const [widget3OnlyOn, setWidget3OnlyOn] = usePersistedState("sl_driveWidget3OnlyOn", false);
  const [widgetEdit,   setWidgetEdit]   = useState(null);
  // Where the widget picker was opened from, so its back button can return
  // there instead of just closing — "drive" means the small ⚙️ list inside
  // Drive mode; null means it was opened directly (e.g. from Profile).
  const [widgetEditFrom, setWidgetEditFrom] = useState(null);
  // Small "⚙️ Widgets" button at the bottom of Drive mode's apps bar — quick
  // access to the same 3-slot picker without leaving Drive mode.
  const [showWidgetSettings, setShowWidgetSettings] = useState(false);
  // Drive mode's main app area (the ~2/3-width panel) — which of the 5 apps
  // in the bottom apps bar is currently filling it. Always opens back on
  // Maps when Drive mode starts.
  const [driveApp,     setDriveApp]     = useState("map");
  // Set by "Get Directions" on a route card — carries that route's title
  // (the actual destination) and stops (intermediate food/parking stops)
  // into Drive mode's Maps app, so the live map loads straight into that
  // route instead of a plain current-location view.
  const [driveDirections, setDriveDirections] = useState(null);
  // Drive mode's layout adapts to phone orientation: portrait puts the apps
  // strip along the side and the widgets bar along the bottom; landscape
  // keeps apps along the bottom of the main area with widgets stacked on
  // the side. Tracked live via matchMedia so rotating the phone re-flows it.
  const [driveOrientation, setDriveOrientation] = useState(
    (typeof window!=="undefined" && window.matchMedia && window.matchMedia("(orientation: portrait)").matches) ? "portrait" : "landscape"
  );
  useEffect(() => {
    if (typeof window==="undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => setDriveOrientation(mq.matches ? "portrait" : "landscape");
    onChange();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);
  const [appRadius,    setAppRadius]    = usePersistedState("sl_radius", null); // global radius in miles (null = any)
  // Global Discovery — like Instagram, see every public post/event/lane
  // everywhere, ignoring the mile radius above entirely. Toggled from the
  // Discovery Radius edit page. `radiusActive` is the one thing every
  // radius-based filter in the app should check instead of `appRadius`
  // directly, so turning this on immediately overrides any mile setting.
  const [globalDiscovery, setGlobalDiscovery] = usePersistedState("sl_globalDiscovery", false);
  const radiusActive = !globalDiscovery && appRadius;
  const [radiusColor,  setRadiusColor]  = usePersistedState("sl_radiusColor", OR); // color of the Discovery Radius bar, changeable from Edit Profile
  const [startDriveStyle, setStartDriveStyle] = usePersistedState("sl_startDriveStyle", "flag"); // "flag" | "solid" | "outline" — changeable from Edit Profile
  const [startDriveColor, setStartDriveColor] = usePersistedState("sl_startDriveColor", "#000000"); // accent color for the Start Drive button
  const [widgetAction, setWidgetAction] = useState(null); // 'weather'|'music'|'points'|'friends'
  // Reset voice counter when page state changes
  useEffect(() => { voiceCounter.current = 10; voiceActions.current = {}; }, [panel, subPanel]);

  /* refs */
  const videoRef     = useRef(null);
  const streamRef    = useRef(null);
  const mediaRecRef  = useRef(null);
  const recChunks    = useRef([]);
  const recRef       = useRef(null);
  const tripRef      = useRef(null);
  const gpsRef       = useRef(null);
  const speedSamplesRef = useRef([]); // speeds sampled during the active drive — for avg/max in Drive History
  const autoStopTimerRef = useRef(null); // grace-period timer before auto-stopping the dashcam
  const recogRef     = useRef(null);
  const eventPhotoRef= useRef(null);
  const postPhotoRef  = useRef(null);
  const chatEndRef   = useRef(null);

  const pal = AI_PALS.find(p=>p.id===aiPalId)||AI_PALS[0];
  const fmt = s => Math.floor(s/60)+":"+(String(s%60).padStart(2,"0"));
  const scrollRef     = useRef(null);
  const swipeStartRef = useRef(null); // {x,y} — page-swipe gesture tracking (Lanes ↔ Home ↔ Discover)
  const swipeActiveRef = useRef(false); // true once the current drag has been confirmed as a horizontal carousel swipe (vs. a vertical scroll, tap, or a back-page swipe which stays instant/unanimated)
  // Live drag state for the sliding carousel animation. swipeDir (React
  // state — changes only twice per gesture) says which neighbor tab is
  // being revealed ("next" = the tab to the right, "prev" = to the left)
  // and controls whether that neighbor panel is mounted at all. swipeDXRef
  // (a plain ref, NOT state) is the raw live finger offset in px — it's
  // painted straight onto the DOM via swipeWrapperRef on every move, so
  // the drag tracks the finger at a full 60fps without forcing React to
  // re-render whichever heavy panel is mounted on every pixel of movement.
  const [swipeDir, setSwipeDir] = useState(null);
  const swipeDXRef = useRef(0);
  const swipeWrapperRef = useRef(null); // the 2x-wide sliding row — see the render below
  const swipeContainerRef = useRef(null); // the swipeable content area — native (non-passive) touch listeners are attached to this below
  const voiceActions  = useRef({});   // number -> fn
  const voiceCounter  = useRef(11);   // page-level counter, starts at 11
  const setScroll = el => {
    scrollRef.current=el;
    if(el) {
      el.onscroll = () => {
        voiceCounter.current = 10;
        voiceActions.current = {};
      };
    }
  };
  const addPts = n => setPts(p => { const v=p+n; memStore.setItem("sl_pts",v); return v; });

  // Auto-dismiss achievement toasts
  useEffect(()=>{
    if(newAchQueue.length===0) return;
    const t = setTimeout(()=>setNewAchQueue(q=>q.slice(1)), 3500);
    return ()=>clearTimeout(t);
  },[newAchQueue]);

  const checkAchievements = (extraState={}) => {
    const snap = {
      tripHistory, friends, routes, events, carSaved,
      totalMiles, lastDriveUnderLimit, greenLightStreak, hadNightDrive,
      ...extraState,
    };
    const newlyUnlocked = ACHIEVEMENTS.filter(a => {
      if(unlockedAch.includes(a.id)) return false;
      try { return a.check(snap); } catch { return false; }
    });
    if(newlyUnlocked.length>0){
      const ids = newlyUnlocked.map(a=>a.id);
      const next = [...unlockedAch, ...ids];
      memStore.setItem("sl_ach", JSON.stringify(next));
      setUnlockedAch(next);
      addPts(newlyUnlocked.reduce((s,a)=>s+a.pts,0));
      setNewAchQueue(q=>[...q,...newlyUnlocked]);
      playAchievementSound();
    }
  };

  // `forceDashcamConsent` lets a caller that just this instant flipped the
  // consent flag (e.g. the "I Agree" button) start recording right away —
  // setDashcamConsent(true) doesn't take effect until the next render, so
  // the `dashcamConsent` closed over here would otherwise still read false
  // for the rest of this same click handler.
  const go = (p, { forceDashcamConsent, directions, lanesRoom, lanesGarageOrigin } = {}) => {
    // Exiting Drive mode while the dashcam is recording stops & saves the
    // clip — recording runs continuously for the whole drive regardless of
    // momentary speed, and only ends when Drive mode itself ends.
    if(panel==="drive" && p!=="drive" && dashOn){
      stopDrive();
    }
    // Re-tapping the bottom-nav tab you're already on used to always reset
    // subPanel — closing whatever Profile toggle section (Garage, History,
    // etc.) was open every time. Only reset it when actually switching to a
    // different panel, so the open section survives a re-tap.
    setPanel(p);
    // Landing on Profile fresh (from another tab) always opens with Garage
    // already expanded, instead of the collapsed home grid.
    if(p!==panel) setSubPanel(p==="profile" ? "garage" : null);
    // Landing on Lanes fresh (from another tab) always opens the chat list
    // first, not whatever chat room happened to be open last time — direct
    // "message so-and-so" entry points pass lanesRoom:true to jump straight
    // into that chat's room instead.
    if(lanesRoom) setLanesView("room");
    else if(p!==panel && p==="create") setLanesView("list");
    // Landing on Lanes fresh always shows the page title first, not
    // whatever search box was left open last time you were here.
    if(p!==panel && p==="create"){ setLanesSearchActive(false); setLaneUserSearch(""); }
    // A Lanes room only remembers "came from a Shared Garage" when THIS
    // call explicitly says so — every other way of reaching Lanes (the tab
    // itself, a plain "message this friend" button) clears it, so it can
    // never leak into a later, unrelated chat.
    if(p==="create") setLanesRoomOrigin(lanesGarageOrigin || null);
    setShowAgent(false); setMapInteractive(false);
    // Entering Drive mode always opens straight to Maps — carrying the
    // just-picked route's directions along if this call came from "Get
    // Directions" on a route card, or clearing any stale ones from a
    // previous route otherwise (e.g. tapping the plain Start button).
    if(p==="drive"){ setDriveApp("map"); setDriveDirections(directions || null); }
    // Recording no longer auto-starts the instant Drive mode opens — it
    // always waits for the speed-based auto-start threshold below instead
    // (see the gpsSpeed effect), so opening Drive mode never immediately
    // starts the camera before you've actually started moving.
  };

  // ── Back-button actions for every full-screen Profile sub-page, hoisted up
  // here (instead of defined inline inside ProfilePanel) so the shared
  // TopBar can call them directly — the TopBar takes over as that page's
  // back button (and, where there is one, its main right-side action) while
  // the page is open, instead of the page drawing its own separate header
  // row underneath. Keeping one definition of each action shared between
  // TopBar and the page body avoids the two drifting out of sync. ──
  const back = () => { setSubPanel(null); setSelTrip(null); };
  const cancelCreateRoute = () => {
    setNewRoute({title:"",type:"commute",distance:"",bio:"",stops:[""],public:false});
    setEditingRouteId(null);
    setSubPanel("routes");
  };
  const saveCreateRoute = () => {
    if(!newRoute.title.trim()) return;
    const C=[OR,"#22c55e","#6366f1","#a855f7"];
    const cleanStops = newRoute.stops.map(s=>s.trim()).filter(Boolean);
    if(editingRouteId){
      setRoutes(rs=>rs.map(x=>x.id===editingRouteId?{...x,...newRoute,stops:cleanStops}:x));
    } else {
      setRoutes(rs=>{const nr=[{id:Date.now(),...newRoute,stops:cleanStops,color:C[rs.length%C.length]},...rs]; setTimeout(()=>checkAchievements({routes:nr}),200); return nr;});
      if(newRoute.public){
        setPosts(p=>[{
          id: Date.now()+1, title: newRoute.title, type: newRoute.type, body: newRoute.bio,
          distance: newRoute.distance, stops: cleanStops, highlights: "", photos: [],
          fromSaved: true, savedRouteName: newRoute.title, likes: 0,
          authorId: "me", authorName: userName||"You",
        },...p]);
        setNotifications(n=>[{id:Date.now()+2,icon:"🗺️",text:"Your route \""+newRoute.title+"\" has been posted to the feed!",ts:"now",read:false},...n]);
      }
    }
    setNewRoute({title:"",type:"commute",distance:"",bio:"",stops:[""],public:false});
    setEditingRouteId(null);
    setSubPanel("routes");
  };
  const cancelSharedGarage = () => { setSubPanel("garage"); setSelSharedGarage(null); };
  const openSharedGarageChat = () => {
    const g = sharedGarages.find(x=>x.id===selSharedGarage);
    if(g){ setActiveChan(g.laneId); go("create", {lanesRoom:true, lanesGarageOrigin:{garageId:g.id}}); }
  };
  const saveEditCar = () => { setCarSaved(true); setTimeout(()=>checkAchievements({carSaved:true}),200); setSubPanel("car"); };
  const saveEditProfile = async () => {
    if (isSupabaseConfigured) {
      const u = normalizeUsername(userHandle);
      const fmtErr = u ? usernameError(u) : null;
      if (fmtErr) { setEditSaveError(fmtErr); return; }
      if (editUsernameStatus === "taken") { setEditSaveError("That username is taken."); return; }
      if (editUsernameStatus === "checking") { setEditSaveError("Still checking that username — one more sec, then hit Save again."); return; }
    }
    setEditSaveError("");
    setEditMode(false);
    const { error } = await saveProfileToSupabase();
    if (error) {
      setEditSaveError(/unique|duplicate/i.test(error.message||"") ? "That username was just taken — try another." : "Couldn't save — try again.");
      setEditMode(true);
      return;
    }
    back();
  };
  // Returning from a Lanes room back to whichever Shared Garage it was
  // opened from (see lanesRoomOrigin) instead of the plain chat list —
  // used by both the shared TopBar's back arrow and the swipe-to-back
  // fallback (runBack, below).
  const backFromLanesRoom = () => {
    if(lanesRoomOrigin){
      const originGarageId = lanesRoomOrigin.garageId;
      setLanesRoomOrigin(null);
      setLanesView("list");
      setSelSharedGarage(originGarageId);
      go("profile"); // resets subPanel to "garage" by default — overridden right after, same pattern as the hamburger's Settings link
      setTimeout(()=>setSubPanel("sharedgarage"), 100);
    } else {
      setLanesView("list");
    }
  };

  // ── Swipe carousel — Lanes ↔ Home ↔ Discover (Drive mode is not part of it) ──
  // Order matches the TopNav's actual left-to-right tab layout (Lanes | Home
  // | Discover — see TOPNAV_ITEMS below), NOT the order pages were coded in.
  // Swipe direction is read against THIS order, so it has to match what's
  // literally on screen or "swipe left" and "swipe right" end up backwards.
  const CAROUSEL = ["create","profile","discover"];
  // subPanel is dual-purpose on Profile — these 6 values are just which
  // "My Stuff" icon-toggle section is expanded INLINE on the Profile home
  // screen (which now defaults to "garage" open), not a full-screen
  // sub-page. Only a subPanel value OUTSIDE this list (Edit Profile, Car
  // Details, Create Route, …) is an actual full-screen page with its own
  // back button — swipe-back below needs that distinction, or it would
  // treat the Profile home screen itself as "on a sub-page" simply because
  // Garage is expanded by default.
  const PROFILE_INLINE_SECTIONS = ["garage","routes","myevents","history","radiostations","settings"];
  // Whenever the current screen already has its own ← back button (a Profile
  // sub-page like Edit Car/Settings/My Routes, or a route's full-screen
  // detail view), swipe-right should trigger THAT back action instead of the
  // carousel's "previous tab" — otherwise swiping right to go back a page
  // instead jumped all the way to the Lanes chat tab.
  const backAvailable = (panel==="profile" && !!subPanel && !PROFILE_INLINE_SECTIONS.includes(subPanel)) || (panel==="discover" && !!viewRouteId) || (panel==="create" && lanesView==="room");
  const runBack = () => {
    if(panel==="discover" && viewRouteId){ setViewRouteId(null); return; }
    if(panel==="profile" && subPanel){ setSubPanel(null); setSelTrip(null); return; }
    if(panel==="create" && lanesView==="room"){ backFromLanesRoom(); return; }
  };
  const onSwipeStart = e => {
    if(!CAROUSEL.includes(panel)) { swipeStartRef.current=null; return; }
    const t = e.touches ? e.touches[0] : e;
    const tag = e.target.tagName;
    if(tag==="INPUT"||tag==="TEXTAREA"){ swipeStartRef.current=null; return; }
    // Ignore touches starting inside a horizontally-scrolling row (filter chips, photo strips, etc.)
    let el = e.target;
    while(el && el.getAttribute){
      const cs = window.getComputedStyle(el);
      if((cs.overflowX==="auto"||cs.overflowX==="scroll") && el.scrollWidth > el.clientWidth + 1){ swipeStartRef.current=null; return; }
      el = el.parentElement;
    }
    swipeStartRef.current = {x:t.clientX, y:t.clientY};
    swipeActiveRef.current = false;
    swipeDXRef.current = 0;
    // Cancel any settle animation still finishing from a previous gesture —
    // otherwise a quick second swipe right after the first could fight the
    // leftover transition and visibly stutter.
    if(swipeWrapperRef.current) swipeWrapperRef.current.style.transition = "none";
  };
  // Live-tracks the finger/mouse while a gesture is in progress, so the
  // current page and its neighbor visibly slide together in real time,
  // proportional to how far the drag has gone — instead of only reacting
  // once the finger lifts. Only kicks in for the plain tab carousel
  // (Lanes ↔ Home ↔ Discover); a page with its own back button available
  // (a Profile sub-page, a Discover route detail, the Lanes chat room)
  // keeps the simpler instant swipe-to-go-back behavior from onSwipeEnd,
  // since animating "back out of a sub-page" would mean live-rendering two
  // states of the SAME panel at once rather than two different panels.
  //
  // The live drag position is tracked in a plain ref (swipeDXRef) and
  // painted straight onto the DOM node, NOT through React state — driving
  // a setState (and the re-render of whichever heavy panel is mounted) on
  // every single pixel of finger movement is exactly what made this feel
  // sticky/laggy on an actual phone. React only gets involved twice per
  // gesture: once to mount the neighbor panel when the drag is first
  // confirmed, and once to commit or discard it when the finger lifts.
  const onSwipeMove = e => {
    const start = swipeStartRef.current;
    if(!start || backAvailable) return;
    const idx = CAROUSEL.indexOf(panel);
    if(idx===-1) return;
    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if(!swipeActiveRef.current){
      // Not yet confirmed as a horizontal carousel drag — require a small
      // deliberate horizontal movement (clearly more horizontal than
      // vertical) before committing to it, so an ordinary vertical scroll
      // never gets hijacked into a sideways page slide. Kept small/lenient
      // so the page starts following the finger almost immediately.
      if(Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)*1.1) return;
      if(dx < 0 && idx >= CAROUSEL.length-1) return; // no next tab to reveal
      if(dx > 0 && idx <= 0) return;                 // no previous tab to reveal
      swipeActiveRef.current = true;
      setSwipeDir(dx < 0 ? "next" : "prev"); // one React update — mounts the neighbor panel
    }
    const w = window.innerWidth || 390;
    const clamped = Math.max(-w, Math.min(w, dx));
    swipeDXRef.current = clamped;
    const wrapperEl = swipeWrapperRef.current;
    if(wrapperEl){
      const dir = clamped < 0 ? "next" : "prev";
      wrapperEl.style.transform = `translateX(${dir==="next" ? clamped : clamped-w}px)`;
    }
  };
  const onSwipeEnd = e => {
    const start = swipeStartRef.current;
    const wasActive = swipeActiveRef.current;
    swipeStartRef.current = null;
    swipeActiveRef.current = false;
    if(!start) return;

    if(wasActive){
      // A live carousel drag was under way — commit to the neighbor once
      // dragged far enough (under a third of the screen springs back), and
      // either way ANIMATE the rest of the way with a real CSS transition
      // (applied directly to the DOM node, same as the drag itself) so the
      // motion the finger started continues naturally instead of snapping.
      const idx = CAROUSEL.indexOf(panel);
      const w = window.innerWidth || 390;
      const dx = swipeDXRef.current;
      const commit = Math.abs(dx) > w*0.32;
      const wrapperEl = swipeWrapperRef.current;
      const dir = dx < 0 ? "next" : "prev";
      const settleTo = (target, after) => {
        if(wrapperEl){
          wrapperEl.style.transition = "transform 0.24s cubic-bezier(0.22,1,0.36,1)";
          wrapperEl.style.transform = `translateX(${dir==="next" ? target : target-w}px)`;
        }
        setTimeout(()=>{
          if(wrapperEl) wrapperEl.style.transition = "none";
          swipeDXRef.current = 0;
          setSwipeDir(null);
          after && after();
        }, 240);
      };
      if(commit && dx<0 && idx<CAROUSEL.length-1) settleTo(-w, ()=>go(CAROUSEL[idx+1]));
      else if(commit && dx>0 && idx>0) settleTo(w, ()=>go(CAROUSEL[idx-1]));
      else settleTo(0);
      return;
    }

    // Fallback — a short tap, or a swipe on a page with its own back button
    // (see backAvailable) — same instant behavior as before, no live drag.
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if(Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy)*1.4) return; // require a deliberate horizontal drag
    if(dx > 0 && backAvailable) { runBack(); return; }               // swipe right → back out of this sub-page, not to Lanes
    if(backAvailable) return;                                         // a back page is open — leave tab-carousel swipes alone
    const idx = CAROUSEL.indexOf(panel);
    if(idx===-1) return;
    if(dx < 0 && idx < CAROUSEL.length-1) go(CAROUSEL[idx+1]);      // swipe left → move right (Lanes→Home, Home→Discover)
    else if(dx > 0 && idx > 0) go(CAROUSEL[idx-1]);                  // swipe right → move left (Discover→Home, Home→Lanes)
  };
  // Native (non-passive) touch listeners on the swipe container — React
  // attaches onTouchMove as a PASSIVE listener by default, which silently
  // ignores preventDefault(). Without being able to call it, the browser's
  // own scroll/rubber-band handling kept fighting an in-progress drag on
  // real touchscreens (the reported "gets stuck / won't swipe all the way"
  // — Playwright's synthetic mouse events never hit this, which is why it
  // wasn't caught earlier). Refs mirror the latest handlers so this effect
  // can attach once, on mount, and still always call the current version.
  const onSwipeStartLatest = useRef(onSwipeStart); onSwipeStartLatest.current = onSwipeStart;
  const onSwipeMoveLatest  = useRef(onSwipeMove);  onSwipeMoveLatest.current  = onSwipeMove;
  const onSwipeEndLatest   = useRef(onSwipeEnd);   onSwipeEndLatest.current   = onSwipeEnd;
  useEffect(() => {
    const el = swipeContainerRef.current;
    if(!el) return;
    const ts = e => onSwipeStartLatest.current(e);
    const tm = e => {
      onSwipeMoveLatest.current(e);
      if(swipeActiveRef.current && e.cancelable) e.preventDefault();
    };
    const te = e => onSwipeEndLatest.current(e);
    el.addEventListener("touchstart", ts, {passive:true});
    el.addEventListener("touchmove", tm, {passive:false});
    el.addEventListener("touchend", te, {passive:true});
    el.addEventListener("touchcancel", te, {passive:true});
    return () => {
      el.removeEventListener("touchstart", ts);
      el.removeEventListener("touchmove", tm);
      el.removeEventListener("touchend", te);
      el.removeEventListener("touchcancel", te);
    };
  }, []);

  /* voice */
  useEffect(()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR)return;
    const r=new SR(); r.continuous=true; r.interimResults=true;
    r.onresult=e=>{
      const allResults = Array.from(e.results);
      const finals  = allResults.filter(r=>r.isFinal).map(r=>r[0].transcript).join(" ");
      const interim = allResults.filter(r=>!r.isFinal).map(r=>r[0].transcript).join(" ");
      const display = (finals||interim).trim();
      setVoiceText(display.toLowerCase());

      // Only fire commands on final speech
      if(!finals.trim()) return;
      const cmd = finals.trim().toLowerCase();

      // ── Number command ───────────────────────────────────────────────────────
      const numM = cmd.match(/^(\d+)\.?$/);
      if(numM){
        const n=parseInt(numM[1]);
        if(voiceActions.current[n]){ voiceActions.current[n](); return; }
      }

      // ── "Sono" — open AI agent from anywhere ────────────────────────────────
      if(cmd.includes("sono")){
        const q=finals.trim().replace(/.*sono\s*/i,"").trim();
        if(panel==="create"){
          setSonoMode("sono");
          if(q.length>2) setAiInput(q);
        } else {
          setShowAgent(true);
          if(q.length>2) setChatIn(q);
        }
        return;
      }

      // ── Swipe/scroll voice commands ──────────────────────────────────────────
      if(cmd.includes("swipe up")||cmd.includes("scroll up")){
        if(scrollRef.current) scrollRef.current.scrollBy({top:-220,behavior:"smooth"});
        return;
      }
      if(cmd.includes("swipe down")||cmd.includes("scroll down")){
        if(scrollRef.current) scrollRef.current.scrollBy({top:220,behavior:"smooth"});
        return;
      }
      // ── Page navigation ──────────────────────────────────────────────────────
      if(cmd.includes("events")||cmd.includes("map")){setDiscoverTab("events");go("discover");}
      else if(cmd.includes("feed")){setDiscoverTab("routes");go("discover");}
      else if(cmd.includes("create")||cmd.includes("notes"))go("create");
      else if(cmd.includes("drive"))go("drive");
      else if(cmd.includes("profile")||cmd.includes("home"))go("profile");

      // ── Transcribe to notes on create panel ─────────────────────────────────
      if(panel==="create"&&sonoMode==="notes"&&cmd.length>4){
        setTLines(p=>[...p.slice(-50),finals.trim()]);
      }
    };
    r.onerror=()=>{};
    recogRef.current=r;
    // Which setting governs right now depends on where you are: Drive
    // mode's own "Say Sono to Wake" toggle (Drive mode Settings) while
    // you're in Drive mode, or the rest-of-app one (Profile > AI)
    // everywhere else. No manual mic button anymore — purely settings-driven.
    const wakeActive = panel==="drive" ? driveSayWakeEnabled : sayWakeEnabled;
    if(wakeActive){ try{ r.start(); setVoiceOn(true); }catch{} }
    else { setVoiceOn(false); }
    return ()=>{ try{r.stop();}catch{} };
  },[panel,sonoMode,sayWakeEnabled,driveSayWakeEnabled]);

  // Picks a video format the CURRENT browser can actually both record AND
  // play back. Safari/iOS never supported the plain `new MediaRecorder(st)`
  // default the way Chrome does — it either throws or silently produces
  // data that doesn't match the "video/webm" label we used to hard-code on
  // the saved Blob, so the file would save fine but the <video> player
  // would refuse to decode it. Asking MediaRecorder itself which of these
  // it supports, then tagging the saved Blob with that *same* exact type,
  // is what makes playback actually work on every device.
  const pickRecorderMime = () => {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    const candidates = [
      "video/mp4;codecs=h264,aac", // Safari/iOS
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find(c => { try { return MediaRecorder.isTypeSupported(c); } catch { return false; } }) || "";
  };

  /* drive — fully automatic: no manual Start/Stop UI. See the background
     automation effects below for what triggers these. `forceConsent` lets
     go() start recording in the same click that just granted consent,
     before the dashcamConsent state update has actually re-rendered. */
  const startDrive = async (forceConsent = false) => {
    if((!dashcamConsent && !forceConsent) || dashOn) return;
    playStartupSound(startupSound);
    try{
      // Reuse the already-open preview stream (the widget shows live camera
      // the whole time Drive mode is open) instead of re-requesting the
      // camera — only fall back to a fresh getUserMedia if no preview
      // stream happens to be live yet (e.g. speed crossed 5mph before the
      // preview effect finished opening it).
      let st = streamRef.current;
      if(!st){
        st=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:true});
        streamRef.current=st;
        setCamLive(true);
      }
      if(videoRef.current){videoRef.current.srcObject=st;videoRef.current.muted=true;videoRef.current.playsInline=true;videoRef.current.play().catch(()=>{});}
      const mime = pickRecorderMime();
      const mr = mime ? new MediaRecorder(st, {mimeType:mime}) : new MediaRecorder(st);
      mediaRecRef.current=mr; recChunks.current=[];
      mr.ondataavailable=e=>recChunks.current.push(e.data);
      mr.start(5000);
    }catch{}
    speedSamplesRef.current = [];
    setDashOn(true); setRecSecs(0); setTripDist(0); setTripSecs(0);
    recRef.current=setInterval(()=>setRecSecs(s=>s+1),1000);
    tripRef.current=setInterval(()=>setTripSecs(s=>s+1),1000);
    setRoadMsgs(p=>[...p,"🎥 Dashcam recording started."]);
  };
  const stopDrive = () => {
    if(!dashOn) return;
    // Capture current values before clearing
    const dur = tripSecs;
    const dist = tripDist;
    const samples = speedSamplesRef.current;
    const avgSpeed = samples.length ? Math.round(samples.reduce((a,b)=>a+b,0)/samples.length) : 0;
    const maxSpeed = samples.length ? Math.max(...samples) : 0;
    speedSamplesRef.current = [];

    // Stop UI immediately — don't wait for recorder
    setDashOn(false);
    setTripSecs(0);
    setTripDist(0);
    setRecSecs(0);

    // Clear timers
    clearInterval(recRef.current);
    clearInterval(tripRef.current);
    recRef.current = null;
    tripRef.current = null;

    // Stop camera stream — recording has ended, and stopDrive is only ever
    // called when actually leaving Drive mode (or turning auto-record /
    // consent off), so the preview shouldn't stay open either.
    teardownStream();

    // Stop MediaRecorder and save clip
    try {
      const mr = mediaRecRef.current;
      if(mr && mr.state !== "inactive") {
        mr.onstop = () => {
          if(!recChunks.current.length) return;
          // Tag the Blob with the SAME type MediaRecorder actually used
          // (mr.mimeType), not a hard-coded "video/webm" — a mismatch here
          // is exactly what made saved footage refuse to play back on
          // Safari/iOS, which records mp4 rather than webm.
          const usedMime = mr.mimeType || "video/webm";
          const blob = new Blob(recChunks.current, {type:usedMime});
          const id = Date.now();
          const record = {
            id,
            sizeMB: (blob.size/1024/1024).toFixed(1),
            duration: dur,
            dist: dist.toFixed(1),
            date: new Date(id).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}),
            time: new Date(id).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
            ext: usedMime.includes("mp4") ? ".mp4" : ".webm",
          };
          // Persist the actual video Blob to IndexedDB so this clip is still
          // there — and gets its 72-hour retention countdown — the next
          // time the app opens; see clipsDB near the top of this file.
          clipsDB.put({ ...record, blob });
          setClips(p => [{ ...record, url: URL.createObjectURL(blob) }, ...p]);
          recChunks.current = [];
        };
        mr.stop();
      }
    } catch {}
    mediaRecRef.current = null;

    // Award points
    const bonus = Math.floor(dist * 5) + 50;
    addPts(bonus);
    setRoadMsgs(p => [...p, "✅ Drive saved! +" + bonus + " pts"]);

    // Save trip to history
    const now = new Date();
    const nightDrive = now.getHours() >= 0 && now.getHours() < 5;
    if(nightDrive) setHadNightDrive(true);

    const underLimit = dist > 0.5;
    setLastDriveUnderLimit(underLimit);

    // Simulate green light streak per drive (random 3-12 based on drive length)
    const streak = Math.min(Math.floor(dist * 3 + Math.random() * 5), 15);
    setGreenLightStreak(streak);

    // Update total miles
    const newTotal = totalMiles + parseFloat(dist.toFixed(1));
    setTotalMiles(newTotal);
    memStore.setItem("sl_miles", newTotal.toString());

    const newHistory = [{
      id: Date.now(),
      date: now.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}),
      time: now.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
      dist: dist.toFixed(1),
      dur: dur,
      pts: bonus,
      avgSpeed, maxSpeed, lights: streak,
      startAddr: "San Diego, CA",
      endAddr: "San Diego, CA",
    }, ...tripHistory].slice(0, 50);
    setTripHistory(newHistory);

    // Check achievements with fresh state
    setTimeout(()=>checkAchievements({
      tripHistory: newHistory,
      totalMiles: newTotal,
      lastDriveUnderLimit: underLimit,
      greenLightStreak: streak,
      hadNightDrive: nightDrive || hadNightDrive,
    }), 500);
  };

  // Fully releases the camera/mic stream (used both when recording stops
  // and when just closing the live preview) and clears the preview <video>.
  const teardownStream = () => {
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    streamRef.current = null;
    setCamLive(false);
    if(videoRef.current) videoRef.current.srcObject = null;
  };

  // Opens (or keeps open) the live camera preview shown by the Dashcam
  // widget — independent of whether a clip is actually being recorded.
  // Called as soon as Drive mode is opened (with consent already granted),
  // so the widget always shows the live feed, not just while moving.
  const openCamPreview = async () => {
    if (!dashcamConsent || streamRef.current) return;
    try {
      const st = await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:true});
      streamRef.current = st;
      setCamLive(true);
    } catch {}
  };
  // Closes the preview stream — but only when nothing is actively
  // recording, since a clip mid-recording must keep its stream alive even
  // if, say, the widget itself becomes hidden.
  const closeCamPreview = () => {
    if (dashOn) return;
    teardownStream();
  };

  // Keeps the Dashcam widget's live camera preview tied to Drive mode
  // itself (once consented) rather than to whether a clip happens to be
  // recording — opens the moment Drive mode is entered, closes the moment
  // it's left (unless a clip is still recording, which stopDrive/go()
  // already handle by calling stopDrive() first).
  useEffect(() => {
    if (panel === "drive" && dashcamConsent) {
      openCamPreview();
    } else {
      closeCamPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, dashcamConsent]);

  /* ── Background dashcam automation ──
     Only runs once dashcamConsent AND dashcamBgRecord are both true (consent
     accepted in the profile's Dashcam section, background recording left on
     there). Speed is watched continuously; recording starts automatically
     above 5 mph — never just from opening Drive mode — and stops after a
     20s grace period below 5 mph, so a stoplight doesn't cut a trip short.
     None of this shows up on the map page — recorded video lands in the
     Dashcam section, and speed/duration/lights land in Drive History once
     the drive ends. */
  useEffect(() => {
    if (!dashcamConsent || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      p => setGpsSpeed(Math.round((p.coords.speed || 0) * 2.237)),
      () => {},
      { enableHighAccuracy: true }
    );
    gpsRef.current = id;
    return () => { navigator.geolocation.clearWatch(id); gpsRef.current = null; };
  }, [dashcamConsent]);

  useEffect(() => {
    if (dashOn) speedSamplesRef.current.push(gpsSpeed);
  }, [gpsSpeed, dashOn]);

  /* ── CB Radio location gate ── watches position only while the CB Radio
     sheet is actually open, and only long enough to tell which freeway (if
     any) the device is currently on — see currentFreewayId above. This is
     what lets only people actually on a given freeway talk on its lane. */
  useEffect(() => {
    if (!showMusic || musicTab!=="lanes" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      p => setCbCoords({ lat:p.coords.latitude, lng:p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [showMusic, musicTab]);

  useEffect(() => {
    // dashcamBgRecord is the "record in the background during Drive mode"
    // toggle — turning it off keeps dashcam access granted but stops it
    // from auto-starting; you can still start/stop it manually.
    if (!dashcamConsent || !dashcamBgRecord) return;
    // Dashcam only ever records while Drive mode is actually open — leaving
    // Drive mode (go() already calls stopDrive() the moment the panel
    // changes) means no recording keeps running in the background on any
    // other page, even if the phone is still reading a driving speed.
    if (panel!=="drive") {
      if (autoStopTimerRef.current) { clearTimeout(autoStopTimerRef.current); autoStopTimerRef.current = null; }
      return;
    }
    if (gpsSpeed >= 5 && !dashOn) {
      startDrive();
    }
    // While actively in Drive mode, recording continues for the whole
    // session regardless of momentary speed (stop lights, traffic, etc.) —
    // it only stops by explicitly exiting Drive mode.
  }, [gpsSpeed, dashOn, dashcamConsent, dashcamBgRecord, panel]);

  // Re-attach the live camera stream to the preview <video> whenever the
  // profile's Dashcam page (re)mounts mid-recording — e.g. a drive was
  // auto-started elsewhere in the app and the user then opens Dashcam.
  useEffect(() => {
    if (subPanel === "dashcam" && dashOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.muted = true;
      videoRef.current.playsInline = true;
      videoRef.current.play().catch(() => {});
    }
  }, [subPanel, dashOn]);

  /* ai */
  const sendChat = async () => {
    if(!chatIn.trim()||aiThinking)return;
    const q=chatIn; setChatIn(""); setAiThinking(true);
    const reply=await callClaude([{role:"user",content:q}],"You are "+pal.name+", a "+pal.desc+" AI driving co-pilot. Reply in 1-2 sentences.");
    setRoadMsgs(p=>[...p,pal.emoji+" "+reply]); setAiThinking(false);
  };
  const sendSono = async () => {
    if(!aiInput.trim()||aiThinking)return;
    const q=aiInput; setAiInput(""); setAiThinking(true);
    setAiChat(c=>[...c,{role:"user",text:q}]);
    const reply=await callClaude([{role:"user",content:q}],"You are "+pal.name+", a helpful assistant. Be concise.");
    setAiChat(c=>[...c,{role:"ai",text:reply}]); setAiThinking(false);
  };

  // ── AI Co-Pilot voice call (Top 3 Friends) ──────────────────────────────
  // A live, spoken back-and-forth with your AI Co-Pilot, startable from the
  // My Profile page. Every turn — yours and the AI's — is written straight
  // into aiChat, the same store the Lanes sidebar's "Sono AI" channel reads,
  // so the whole call sits there afterward as a transcribed conversation.
  const handleAiCallTurn = async (text) => {
    if(!text.trim()) return;
    setAiChat(c=>[...c,{role:"user",text:text.trim()}]);
    setAiCallInterim("");
    // Stop listening while Sono is thinking/talking so it doesn't hear itself.
    try{ aiCallRecogRef.current?.stop(); }catch{}
    setAiCallListening(false);
    const reply = await callClaude(
      [{role:"user",content:text.trim()}],
      "You are "+pal.name+", a "+pal.desc+" AI driving co-pilot, on a live spoken phone call with the driver. Reply in 1-2 short natural sentences, the way you'd actually talk out loud."
    );
    setAiChat(c=>[...c,{role:"ai",text:reply}]);
    const resumeListening = () => {
      if(!aiCallActiveRef.current) return;
      try{ aiCallRecogRef.current?.start(); setAiCallListening(true); }catch{}
    };
    if(window.speechSynthesis){
      setAiCallSpeaking(true);
      const utt = new SpeechSynthesisUtterance(reply);
      utt.onend = utt.onerror = () => { setAiCallSpeaking(false); resumeListening(); };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utt);
    } else {
      resumeListening();
    }
  };
  const startAiCall = () => {
    setAiChat(c=>[...c,{role:"ai",text:"📞 Voice call started with "+pal.name+"."}]);
    setAiCallOpen(true);
    aiCallActiveRef.current = true;
    const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR) return; // sheet still opens — shows a "voice isn't supported" notice
    const r = new SR();
    r.continuous = true; r.interimResults = true;
    r.onresult = e => {
      const allResults = Array.from(e.results);
      const finals = allResults.filter(x=>x.isFinal).map(x=>x[0].transcript).join(" ").trim();
      const interim = allResults.filter(x=>!x.isFinal).map(x=>x[0].transcript).join(" ");
      setAiCallInterim(interim);
      if(finals) handleAiCallTurn(finals);
    };
    r.onerror = () => {};
    r.onend = () => { if(aiCallActiveRef.current && !aiCallSpeakingRef.current){ try{ r.start(); }catch{} } };
    aiCallRecogRef.current = r;
    try{ r.start(); setAiCallListening(true); }catch{}
  };
  const endAiCall = () => {
    aiCallActiveRef.current = false;
    try{ aiCallRecogRef.current?.stop(); }catch{}
    aiCallRecogRef.current = null;
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    setAiCallOpen(false);
    setAiCallListening(false);
    setAiCallSpeaking(false);
    setAiCallInterim("");
    setAiChat(c=>[...c,{role:"ai",text:"📞 Call ended."}]);
  };

  /* shared styles */
  const INP  = {width:"100%",padding:"10px 12px",borderRadius:8,background:"#f8f8f8",border:"1px solid #ebebeb",color:"#111",fontSize:15,boxSizing:"border-box",fontFamily:F,outline:"none"};
  const CARD = {background:"#fff",borderRadius:14,border:"1px solid #ebebeb",padding:"14px",marginBottom:10,boxShadow:"0 1px 3px rgba(0,0,0,0.04)"};
  const SEC  = {fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8,marginTop:4};
  const TAG  = on => ({padding:"5px 11px",borderRadius:20,fontSize:13,fontWeight:600,cursor:"pointer",background:on?OR:"#f3f3f3",color:on?"#fff":"#888",border:"none",fontFamily:F});

  const weather = {icon:"☀️",temp:72,cond:"Sunny"};
  const WW = {width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2};
  const FORECAST = [
    {day:"Mon",icon:"☀️",hi:74,lo:58},{day:"Tue",icon:"⛅",hi:68,lo:55},{day:"Wed",icon:"🌧️",hi:62,lo:52},
    {day:"Thu",icon:"☀️",hi:71,lo:56},{day:"Fri",icon:"⛅",hi:69,lo:54},{day:"Sat",icon:"☀️",hi:76,lo:59},{day:"Sun",icon:"☀️",hi:78,lo:60},
  ];
  const renderWidget = (id, side) => {
    const openAction = () => setWidgetAction(id);
    if(id==="weather") return <button onClick={openAction} style={{...WW,background:"none",border:"none",cursor:"pointer"}}><div style={{fontSize:24}}>{weather.icon}</div><div style={{fontSize:18,fontWeight:900,color:"#111"}}>{weather.temp}°</div><div style={{fontSize:9,color:"#111"}}>{weather.cond}</div></button>;
    if(id==="points")  return <button onClick={openAction} style={{...WW,background:"none",border:"none",cursor:"pointer"}}><div style={{fontSize:20}}>⭐</div><div style={{fontSize:18,fontWeight:900,color:"#f59e0b"}}>{pts}</div><div style={{fontSize:9,color:"#111"}}>pts</div></button>;
    if(id==="friends") return <button onClick={openAction} style={{...WW,background:"none",border:"none",cursor:"pointer"}}><div style={{fontSize:22}}>👥</div><div style={{fontSize:11,color:"#111"}}>{friends.length} friends</div></button>;
    if(id==="topfriends") return (
      // Same Top 3 row as My Profile (AI Co-Pilot can occupy slot 0) — tap
      // jumps straight there since that's the one place it's fully managed.
      <button onClick={()=>go("profile")} style={{...WW,background:"none",border:"none",cursor:"pointer",gap:4}}>
        <div style={{fontSize:9,fontWeight:800,letterSpacing:1,color:"#111"}}>TOP 3</div>
        <div style={{display:"flex",gap:4}}>
          {[0,1,2].map(i=>{
            if(aiInTop3 && i===0){
              return <div key="ai" style={{width:24,height:24,borderRadius:"50%",background:pal.color+"22",border:"1.5px solid "+pal.color+"44",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><CompassStar size={12} color={pal.color}/></div>;
            }
            const fr = friends[aiInTop3?i-1:i];
            return (
              <div key={i} style={{width:24,height:24,borderRadius:"50%",background:fr?.photo?"transparent":(fr?fr.color:"#eee"),border:fr?"none":"1.5px dashed #ccc",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:fr?"#fff":"#bbb",fontWeight:800,overflow:"hidden",flexShrink:0}}>
                {fr?.photo ? <img src={fr.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : (fr?fr.initials:"＋")}
              </div>
            );
          })}
        </div>
      </button>
    );
    if(id==="music")   return <button onClick={()=>{setMusicTab("music");memStore.setItem("sl_radioTab","music");setShowMusic(true);}} style={{...WW,background:"none",border:"none",cursor:"pointer"}}><div style={{fontSize:22}}>🎵</div><div style={{fontSize:11,color:"#111"}}>My Music</div></button>;
    if(id==="cbradio") return <button onClick={()=>{setMusicTab("lanes");memStore.setItem("sl_radioTab","lanes");setShowMusic(true);}} style={{...WW,background:"none",border:"none",cursor:"pointer"}}><div style={{fontSize:22}}>📡</div><div style={{fontSize:11,color:"#111"}}>CB Radio</div></button>;
    if(id==="spotify") return (
      // Real Spotify activity needs their own developer OAuth key, which we
      // don't have — once linked in My Music, this tap-to-play/pause and the
      // progress bar are real, ticking state (see the spotifyPlaying effect).
      <button onClick={()=>{ if(!spotifyLinked){ setMusicTab("music"); memStore.setItem("sl_radioTab","music"); setShowMusic(true); return; } setSpotifyPlaying(p=>!p); }} style={{...WW,background:"none",border:"none",cursor:"pointer",padding:"4px 8px"}}>
        {!spotifyLinked ? (<>
          <div style={{fontSize:22}}>🎧</div>
          <div style={{fontSize:10,color:"#111"}}>Connect Spotify</div>
        </>) : (<>
          <div style={{display:"flex",alignItems:"center",gap:6,width:"100%"}}>
            <div style={{width:26,height:26,borderRadius:6,background:SPOTIFY_TRACKS[spotifyTrackIdx].color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>🎵</div>
            <div style={{flex:1,minWidth:0,textAlign:"left"}}>
              <div style={{fontSize:11,fontWeight:800,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SPOTIFY_TRACKS[spotifyTrackIdx].title}</div>
              <div style={{fontSize:9,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SPOTIFY_TRACKS[spotifyTrackIdx].artist}</div>
            </div>
            <span style={{fontSize:15,flexShrink:0}}>{spotifyPlaying?"⏸":"▶️"}</span>
          </div>
          <div style={{width:"100%",height:3,borderRadius:2,background:"#e5e5e5",overflow:"hidden",marginTop:3}}>
            <div style={{height:"100%",background:"#1DB954",width:(spotifyElapsed/SPOTIFY_TRACKS[spotifyTrackIdx].dur*100)+"%"}}/>
          </div>
        </>)}
      </button>
    );
    if(id==="routes")  return <button onClick={openAction} style={{...WW,background:"none",border:"none",cursor:"pointer"}}><DPadIcon id="road" color={DPAD_COLORS.road} size={20}/><div style={{fontSize:18,fontWeight:900,color:"#6366f1"}}>{routes.length}</div><div style={{fontSize:9,color:"#111"}}>routes</div></button>;
    if(id==="dashcam") return (
      // Shows the LIVE camera feed the whole time Drive mode is open, once
      // consented — that's just the preview (camLive), separate from
      // whether a clip is actually being saved (dashOn, driven by the 5mph
      // auto-record effect). The red REC dot only appears while dashOn.
      <button onClick={()=>{ if(!dashcamConsent) setShowDashcamSetup(true); }} style={{...WW,background:(camLive||dashOn)?"#000":"none",border:"none",cursor:dashcamConsent?"default":"pointer",position:"relative",overflow:"hidden",padding:0}}>
        {camLive && streamRef.current ? (
          <video
            ref={el=>{ if(el && streamRef.current && el.srcObject!==streamRef.current){ el.srcObject=streamRef.current; el.muted=true; el.playsInline=true; el.play().catch(()=>{}); } }}
            autoPlay muted playsInline
            style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}
          />
        ) : (
          <div style={{fontSize:22}}>📹</div>
        )}
        {dashOn && <span style={{position:"absolute",top:4,right:6,width:6,height:6,borderRadius:"50%",background:"#ef4444",animation:"pulse 1s infinite",display:"block",zIndex:2}}/>}
        {!camLive && <div style={{fontSize:11,color:"#bbb"}}>{dashcamConsent?"Dashcam":"Tap to enable"}</div>}
      </button>
    );
    return <div style={{...WW,color:"#111"}}><div style={{fontSize:20}}>＋</div><div style={{fontSize:9}}>empty</div></div>;
  };

  const openMaps = addr => {
    if(!addr)return;
    window.open("https://www.google.com/maps/dir/?api=1&destination="+encodeURIComponent(addr)+"&travelmode=driving","_blank");
  };

  // "Get Directions" on any route card — loads that route's stops + destination
  // straight into Drive mode's Maps app so you route yourself without ever
  // leaving the app. The embedded map shows the route + stops inline; a
  // "Start Navigation" button inside Drive mode hands the same route off to
  // the phone's Maps app for real turn-by-turn once you're ready to drive.
  const startRouteDirections = (route) => {
    go("drive", { directions: { title: route.title, stops: (route.stops||[]).filter(s=>s&&s.trim()) } });
  };
  // Builds the legacy "saddr/daddr" chain the embeddable maps.google.com/maps
  // iframe understands for multi-stop directions (the modern maps/dir/?api=1
  // link isn't embeddable) — each stop chained with "+to:" ahead of the
  // route's real destination (its title).
  const buildEmbedDirectionsSrc = (dd) => {
    const points = [...(dd.stops||[]), dd.title].filter(Boolean).map(p=>encodeURIComponent(p));
    return "https://maps.google.com/maps?saddr=My+Location&daddr="+points.join("+to:")+"&output=embed";
  };
  // Hands the same route to the phone's own Maps app for real GPS-guided
  // turn-by-turn — no origin is passed, so Maps starts from wherever you
  // actually are.
  const startTurnByTurn = (dd) => {
    let url = "https://www.google.com/maps/dir/?api=1&destination="+encodeURIComponent(dd.title)+"&travelmode=driving";
    if(dd.stops?.length) url += "&waypoints="+encodeURIComponent(dd.stops.join("|"));
    window.open(url,"_blank");
  };

  // An event only takes RSVPs while it's still upcoming — a plain string
  // date compare works fine since every date here is stored "YYYY-MM-DD".
  const isFutureEvent = (dateStr) => !!dateStr && dateStr >= new Date().toISOString().slice(0,10);
  // "Live" means happening right now — since events only store a date (no
  // start/end time), the closest honest reading of that is "today". Used to
  // gate the LIVE badge so it isn't shown on every event regardless of date.
  const isLiveEvent = (dateStr) => !!dateStr && dateStr === new Date().toISOString().slice(0,10);
  // RSVPing "Going" also saves the event into My Events (so it's easy to
  // find again without hunting back through the feed); un-RSVPing un-saves
  // it. Your own events already live in My Events via authorId, so this
  // mainly matters for other people's events you've RSVP'd to.
  const toggleRsvp = (id) => setRsvpedEvents(r=>{
    const goingNow = !r[id];
    setSavedEventIds(s => goingNow ? (s.includes(id)?s:[...s,id]) : s.filter(x=>x!==id));
    return {...r,[id]:goingNow};
  });
  const resetEventForm = () => {
    setNewEvent({title:"",type:"car meet",desc:"",address:"",date:""});
    setEventPhotos([]);
    setEditingEventId(null);
  };
  const closeEventSheet = () => { setShowEvent(false); setEditingEventId(null); };
  // Every event is yours (authorId "me"), so the pencil on any event card
  // reopens this same sheet pre-filled, in edit mode instead of create mode.
  const openEditEvent = (ev) => {
    setNewEvent({ title: ev.title||"", type: ev.type||"car meet", desc: ev.desc||"", address: ev.address||"", date: ev.date||"" });
    setEventPhotos(ev.photos||[]);
    setEditingEventId(ev.id);
    setShowEvent(true);
  };
  const submitEvent = () => {
    if(!newEvent.title.trim()) return;
    const eventData = { ...newEvent, icon: EV_ICONS[newEvent.type]||"📍", photos: eventPhotos };
    if(editingEventId){
      setEvents(p=>p.map(x=>x.id===editingEventId?{...x,...eventData}:x));
      setFlyerEvent(fe=>fe&&fe.id===editingEventId?{...fe,...eventData}:fe);
      // Already reached the shared feed (has a real Supabase row)? Keep
      // that row in sync too, so everyone else's copy updates as well.
      const existing = events.find(x=>x.id===editingEventId);
      if(existing?.sbId) updateEventSupabase(existing.sbId, eventData);
    } else {
      const ev = { id: Date.now(), ...eventData, authorId:"me", authorName: userName||"You", rsvps:0 };
      setEvents(p=>{const ne=[ev,...p]; setTimeout(()=>checkAchievements({events:ne}),200); return ne;});
      setNotifications(n=>[{id:Date.now(),icon:"⚡",text:"Your event \""+newEvent.title+"\" is now live in the community feed!",ts:"now",read:false},...n]);
      setFlyerEvent(ev);
      // Save a real row too, so it shows up on EVERY signed-in user's
      // Events feed — not just this device. Reconciled onto the local copy
      // by id once the insert resolves, so a later edit/delete finds it.
      createEventSupabase(ev).then(sbId => {
        if(!sbId) return;
        setEvents(p=>p.map(x=>x.id===ev.id?{...x,sbId}:x));
      });
    }
    resetEventForm();
    setShowEvent(false);
  };

  // CB Radio broadcasting — shared by the CB Radio page (MusicModal's "lanes"
  // tab) and Drive mode's inline CB Radio app, so both places talk on lanes
  // the same way. A finished broadcast gets "transcribed & summarized" into a
  // traffic report on that lane, with a simulated reply from another CB'er
  // most of the time.
  const pushReport = (laneId, handle, color) => {
    const rep = TRAFFIC_REPORTS[Math.floor(Math.random()*TRAFFIC_REPORTS.length)];
    setLaneTrafficUpdates(m=>({...m,[laneId]:[{id:Date.now()+Math.random(),icon:rep.icon,text:rep.text,handle,color,ts:Date.now()},...(m[laneId]||[])]}));
  };
  const broadcastOnLane = (laneId) => {
    pushReport(laneId, userName||"You", OR);
    if(Math.random()<0.7){
      const h = CB_HANDLES[Math.floor(Math.random()*CB_HANDLES.length)];
      setTimeout(()=>pushReport(laneId, h.name, h.color), 1500+Math.random()*1500);
    }
  };


  // ── VN: Voice-Numbered button — increments a render-time counter ────────────
  // No hooks inside — just reads and bumps voiceCounter.current each render.
  // voiceCounter resets to 11 on panel/subPanel change (via useEffect).
  const VN = ({action, children, style={}, ...rest}) => {
    const n = voiceCounter.current++;
    voiceActions.current[n] = action;
    return (
      <div style={{position:"relative",display:"inline-flex"}}>
        {voiceOn && <div style={{
          position:"absolute",top:-7,left:-7,zIndex:30,
          width:18,height:18,borderRadius:"50%",
          background:"#6366f1",color:"#fff",
          fontSize:n>99?7.5:n>9?8.5:10,fontWeight:900,
          lineHeight:"18px",textAlign:"center",
          pointerEvents:"none",
          boxShadow:"0 1px 5px rgba(99,102,241,0.5)",
        }}>{n}</div>}
        <button onClick={action} style={style} {...rest}>{children}</button>
      </div>
    );
  };

  // Radio Stations content — shared between Profile's own Radio Stations
  // page (subPanel==="radiostations") and the Lanes chat list's SonoLane
  // Radio pill, so it only needs to be written once. Every value it closes
  // over (radioHosts, savedStations, showReg, hostForm, isBroad, broadName,
  // CARD/SEC/INP/VN) lives at this same top level, so it works unchanged
  // from either place. Pass dark:true from Lanes (dark background) so text
  // and card colors match that theme instead of Profile's light one —
  // Jakob's Law: content shouldn't look like a dropped-in white card on a
  // page that's dark everywhere else.
  const renderRadioStationsSection = (dark=false) => {
    const _saved = radioHosts.filter(h=>savedStations.includes(h.name));
    const textPrimary = dark ? "#fff" : "#111";
    const textSecondary = dark ? "#dcddde" : "#111";
    const secStyle = dark ? {...SEC,color:"#8e9297"} : SEC;
    const cardStyle = dark ? {background:"#40444b",borderRadius:14,border:"1px solid #4f545c",padding:"14px",marginBottom:10} : CARD;
    const inpStyle = dark ? {...INP,background:"#2f3136",border:"1px solid #4f545c",color:"#fff"} : INP;
    const cancelBtnStyle = dark ? {background:"#2f3136",border:"1px solid #4f545c",color:"#dcddde"} : {background:"#f3f3f3",border:"1px solid #ebebeb",color:"#555"};
    const chipInactive = dark ? {background:"#2f3136",color:"#8e9297"} : {background:"#f3f3f3",color:"#888"};
    return (
    <div>
      <div style={{padding:"0 14px 12px"}}>
        <div style={{fontSize:16,fontWeight:800,color:textPrimary}}>📻 Radio Stations</div>
      </div>
      <div style={{padding:"4px 14px 24px"}}>

        <div style={secStyle}>SAVED STATIONS</div>
        {_saved.length===0 ? (
          <div style={{...cardStyle,textAlign:"center",color:textSecondary,fontSize:13,padding:"24px 16px"}}>
            <div style={{marginBottom:12}}>Star a station from SonoLane Radio.</div>
            <VN action={()=>{setMusicTab("nearby");setShowMusic(true);}} style={{padding:"9px 18px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F}}>📻 Go to SonoLane Radio</VN>
          </div>
        ) : _saved.map((h,i)=>(
          <div key={i} style={{...cardStyle,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:44,height:44,borderRadius:11,background:OR+"15",border:"1px solid "+OR+"33",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📻</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:15,fontWeight:700,color:textPrimary}}>{h.name}</div>
              <div style={{fontSize:12,color:textSecondary}}>{h.genre}{h.handle?" · @"+h.handle:""}</div>
            </div>
            <button onClick={()=>toggleSavedStation(h.name)} title="Remove from saved" style={{background:"none",border:"none",color:OR,fontSize:18,cursor:"pointer",padding:4,flexShrink:0}}>★</button>
          </div>
        ))}

        <div style={{...secStyle,marginTop:16}}>MY STATIONS</div>
        {radioHosts.length===0 ? (
          <div style={{...cardStyle,textAlign:"center",color:textSecondary,fontSize:13,padding:"24px 16px"}}>
            {!showReg ? (
              <>
                <div style={{marginBottom:12}}>You haven't registered a station yet.</div>
                <VN action={()=>setShowReg(true)} style={{padding:"9px 18px",borderRadius:20,background:"transparent",border:"1.5px dashed "+OR,color:OR,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F}}>📻 Apply to be a Radio Host</VN>
              </>
            ) : (
              <div style={{textAlign:"left"}}>
                <div style={{fontSize:15,fontWeight:800,color:textPrimary,marginBottom:12}}>Host Registration</div>
                <input value={hostForm.name} onChange={e=>setHostForm(f=>({...f,name:e.target.value}))} placeholder="Station name *" style={{...inpStyle,marginBottom:8}}/>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                  {["Hip-Hop","Lo-Fi","Rock","R&B","Electronic","Pop","Jazz","Talk"].map(g=>(
                    <button key={g} onClick={()=>setHostForm(f=>({...f,genre:g}))} style={{padding:"5px 11px",borderRadius:20,fontSize:12,fontWeight:600,cursor:"pointer",background:hostForm.genre===g?OR:chipInactive.background,color:hostForm.genre===g?"#fff":chipInactive.color,border:"none",fontFamily:F}}>{g}</button>
                  ))}
                </div>
                <input value={hostForm.handle} onChange={e=>setHostForm(f=>({...f,handle:e.target.value}))} placeholder="@handle" style={{...inpStyle,marginBottom:8}}/>
                <textarea value={hostForm.bio} onChange={e=>setHostForm(f=>({...f,bio:e.target.value}))} placeholder="Short bio…" rows={2} style={{...inpStyle,resize:"none",marginBottom:12}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{if(!hostForm.name.trim())return;setRadioHosts(h=>[...h,{...hostForm}]);setHostForm({name:"",genre:"",bio:"",handle:""});setShowReg(false);}} style={{flex:1,padding:"11px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Register</button>
                  <button onClick={()=>setShowReg(false)} style={{padding:"11px 16px",borderRadius:10,...cancelBtnStyle,cursor:"pointer",fontFamily:F}}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ) : radioHosts.map((h,i)=>(
          <div key={i} style={{...cardStyle,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:44,height:44,borderRadius:11,background:OR+"15",border:"1px solid "+OR+"33",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📻</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:15,fontWeight:700,color:textPrimary}}>{h.name}</div>
              <div style={{fontSize:12,color:textSecondary}}>{h.genre}{h.handle?" · @"+h.handle:""}</div>
              {h.bio && <div style={{fontSize:12,color:textSecondary,marginTop:3}}>{h.bio}</div>}
            </div>
            {isBroad&&broadName===h.name && (
              <div style={{display:"flex",alignItems:"center",gap:4,background:"#ef444422",borderRadius:20,padding:"4px 10px",flexShrink:0}}>
                <div style={{width:5,height:5,borderRadius:"50%",background:"#ef4444"}}/>
                <span style={{fontSize:11,color:"#ef4444",fontWeight:700}}>LIVE</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
    );
  };

  /* ── PROFILE PANEL ── */
  const ProfilePanel = useStablePanel(() => {
    // `back` is now defined at the SonoLane() top level (near `go`) so the
    // shared TopBar can call it too — see the back-button actions block.

    // Live drag value for the discovery-radius slider, committed to the real
    // appRadius state only on release — the whole panel remounts whenever any
    // top-level state changes, so committing on every pixel of drag would
    // interrupt the gesture; this keeps dragging smooth.
    const [radiusDraft, setRadiusDraft] = useState(appRadius ?? RADIUS_MAX);
    const commitRadius = () => setAppRadius(radiusDraft>=RADIUS_MAX ? null : radiusDraft);

    // Profile Completion card — collapsed by default (top 3 next-up objectives);
    // expands to show every objective (done and not) with its point value.
    const [showAllObjectives, setShowAllObjectives] = useState(false);
    // Dismissible like a notification — once closed it stays hidden for the
    // session (persisted so it doesn't pop back up on every visit to Profile).
    const [objectivesDismissed, setObjectivesDismissed] = useState(()=>memStore.getItem("sl_objDismissed")==="1");
    const dismissObjectives = () => { setObjectivesDismissed(true); memStore.setItem("sl_objDismissed","1"); };

    // Private car info now opens from a wallet button at the bottom of the
    // car page instead of always sitting inline on the page.
    const [showPrivateCard, setShowPrivateCard] = useState(false);
    // Home screen's top bar (+ quick-create, ☰ menu) is now shared across
    // every page — its state (showQuickCreate/showInfoDrawer/infoDrawerPage)
    // and JSX live at the app shell level instead of here; see <TopBar/>.
    // The row of profile tile buttons (My Garage, My Routes, Settings, …) is
    // now a row of toggle icons under TOP 3 instead of a grid — which of
    // them is open reuses `subPanel` itself (same as every other subpage),
    // so links elsewhere in the app that jump straight to e.g.
    // setSubPanel("routes") still land in the right place.
    // Confirm-before-delete for a car in the garage — {id,name} of the car
    // pending deletion, or null. Deleting a car wipes its photos/details,
    // so this is a deliberate extra tap rather than an instant ✕.
    const [confirmDeleteCar, setConfirmDeleteCar] = useState(null);

    // Friends tab — search box filters your existing friends by name; a
    // separate search inside the "Add a Friend" sheet looks people up (by
    // name) across the sample community directory + your followers, so you
    // can add someone directly from the results instead of typing them in
    // by hand.
    const [friendSearch, setFriendSearch] = useState("");
    const [addFriendSearch, setAddFriendSearch] = useState("");
    // Special Top 3 Friend page — a combined walkie-talkie + text chat box
    // for whichever Top 3 friend you tapped (see subPanel==="top3friend").
    const [top3ChatText, setTop3ChatText] = useState("");
    const top3AudioRef = useRef(null);
    const [top3PlayingId, setTop3PlayingId] = useState(null);
    const toggleTop3Voice = (msg) => {
      if (!msg.audioUrl) return;
      const audio = top3AudioRef.current || (top3AudioRef.current = new Audio());
      if (top3PlayingId === msg.id) { audio.pause(); setTop3PlayingId(null); return; }
      audio.src = msg.audioUrl;
      audio.onended = () => setTop3PlayingId(null);
      audio.play().catch(()=>{});
      setTop3PlayingId(msg.id);
    };
    // Real-backend mode: results of searching actual signed-up users by
    // name (debounced), used instead of the local demo directory below.
    const [supaFriendResults, setSupaFriendResults] = useState([]);
    useEffect(() => {
      if (!isSupabaseConfigured) return;
      if (!addFriendSearch.trim()) { setSupaFriendResults([]); return; }
      const t = setTimeout(() => { searchProfilesSupabase(addFriendSearch).then(setSupaFriendResults); }, 250);
      return () => clearTimeout(t);
    }, [addFriendSearch]);
    // Simulated call overlay — { friend, status:"ringing"|"live", secs } —
    // status flips to "live" a beat after opening and a running timer ticks
    // while it's up, mirroring how the rest of the app fakes real-time
    // social features without a backend.
    const [callingFriend, setCallingFriend] = useState(null);
    useEffect(() => {
      if (!callingFriend) return;
      if (callingFriend.status === "ringing") {
        const t = setTimeout(() => setCallingFriend(c => c && ({...c, status:"live", secs:0})), 1400);
        return () => clearTimeout(t);
      }
      if (callingFriend.status === "live") {
        const t = setInterval(() => setCallingFriend(c => c && ({...c, secs:c.secs+1})), 1000);
        return () => clearInterval(t);
      }
    }, [callingFriend?.status, callingFriend?.friend?.id]);

    // Simulated in-call overlay — shared by every page with a Call button
    // (Friends, Shared Garage members) so calling feels the same everywhere.
    const CallOverlay = () => !callingFriend ? null : (
      <div style={{position:"fixed",inset:0,background:"#111",zIndex:900,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#fff",fontFamily:F}}>
        <div style={{fontSize:12,fontWeight:700,letterSpacing:1.5,color:"#888",marginBottom:24}}>{callingFriend.status==="ringing"?"CALLING":"LIVE CALL"}</div>
        <FriendAvatar fr={callingFriend.friend} size={96} fontSize={32} style={{marginBottom:18,animation:callingFriend.status==="ringing"?"pulse 1.4s ease-in-out infinite":"none"}}/>
        <div style={{fontSize:20,fontWeight:800,marginBottom:6}}>{callingFriend.friend.name}</div>
        <div style={{fontSize:14,color:"#aaa",marginBottom:48}}>
          {callingFriend.status==="ringing" ? "Ringing…" : String(Math.floor(callingFriend.secs/60)).padStart(2,"0")+":"+String(callingFriend.secs%60).padStart(2,"0")}
        </div>
        <button onClick={()=>setCallingFriend(null)} style={{width:60,height:60,borderRadius:"50%",background:"#ef4444",border:"none",color:"#fff",fontSize:24,cursor:"pointer"}}>✕</button>
      </div>
    );

    // Quick walkie-talkie voice message — replaces the old "Call" button on
    // a friend's card. Tap the mic to start recording, tap it again to stop
    // and send right away (a one-shot push-to-talk clip, not a call), or
    // Cancel to back out without sending. Uses the same real getUserMedia +
    // MediaRecorder recording as Lanes' voice messages, and appends into the
    // same friendMsgs store so the clip shows up in that friend's DM thread.
    const [walkieTarget, setWalkieTarget] = useState(null); // friend object, or null when closed
    const [walkiePhase,  setWalkiePhase]  = useState("idle"); // idle | recording | sent
    const [walkieSeconds,setWalkieSeconds]= useState(0);
    const walkieMR = useRef(null);
    const walkieChunks = useRef([]);
    const walkieStream = useRef(null);
    const walkieTimer = useRef(null);
    const closeWalkie = () => {
      clearInterval(walkieTimer.current); walkieTimer.current = null;
      if(walkieStream.current){ walkieStream.current.getTracks().forEach(t=>t.stop()); walkieStream.current=null; }
      walkieChunks.current = []; walkieMR.current = null;
      setWalkieTarget(null); setWalkiePhase("idle"); setWalkieSeconds(0);
    };
    const startWalkie = async () => {
      if(walkiePhase!=="idle") return;
      try{
        const stream = await navigator.mediaDevices.getUserMedia({audio:true});
        walkieStream.current = stream;
        const mr = new MediaRecorder(stream);
        walkieChunks.current = [];
        mr.ondataavailable = e => { if(e.data && e.data.size>0) walkieChunks.current.push(e.data); };
        walkieMR.current = mr;
        mr.start();
        setWalkiePhase("recording"); setWalkieSeconds(0);
        walkieTimer.current = setInterval(()=>setWalkieSeconds(s=>s+1), 1000);
      }catch{
        setWalkieTarget(null); // mic permission denied / no mic — nothing to record
      }
    };
    const sendWalkie = () => {
      const mr = walkieMR.current;
      const target = walkieTarget;
      if(!mr || !target){ closeWalkie(); return; }
      clearInterval(walkieTimer.current); walkieTimer.current = null;
      const secs = walkieSeconds;
      mr.onstop = () => {
        const usedMime = mr.mimeType || "audio/webm";
        const blob = new Blob(walkieChunks.current, {type:usedMime});
        const audioUrl = URL.createObjectURL(blob);
        const msg = {
          id:Date.now(), text:"", mine:true,
          user:userName||"You",
          initials:userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?",
          color:OR, ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
          isVoice:true, voiceSeconds:secs||1, audioUrl,
        };
        setFriendMsgs(m=>({...m,[target.id]:[...(m[target.id]||[]),msg]}));
        setNotifications(n=>[{id:Date.now(),icon:"🎙️",text:"Walkie-talkie message sent to "+target.name+".",ts:"now",read:false},...n]);
        if(walkieStream.current){ walkieStream.current.getTracks().forEach(t=>t.stop()); walkieStream.current=null; }
        walkieChunks.current = []; walkieMR.current = null;
        setWalkiePhase("sent");
        // Simulated reply, same idea as the CB/lane auto-reply pattern.
        setTimeout(()=>{
          const reply = {id:Date.now()+1, text:"", mine:false, user:target.name, initials:target.initials, color:target.color, ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}), isVoice:true, voiceSeconds:Math.floor(Math.random()*6)+2, transcript:VOICE_TRANSCRIPTS[Math.floor(Math.random()*VOICE_TRANSCRIPTS.length)]};
          setFriendMsgs(m=>({...m,[target.id]:[...(m[target.id]||[]),reply]}));
          setNotifications(n=>[{id:Date.now()+2,icon:"🎙️",text:target.name+" sent you a voice message back.",ts:"now",read:false},...n]);
        }, 1800+Math.random()*1200);
        setTimeout(closeWalkie, 700);
      };
      try{ mr.stop(); }catch{ closeWalkie(); }
    };
    // Don't leak an open mic stream if this panel unmounts mid-recording.
    useEffect(() => () => {
      if(walkieStream.current) walkieStream.current.getTracks().forEach(t=>t.stop());
      clearInterval(walkieTimer.current);
    }, []);
    // Text side of the special Top 3 Friend page's chat box — appends into
    // the same friendMsgs thread the walkie voice clips use, so both kinds
    // of messages show up together in one combined thread.
    const sendTop3Text = (target) => {
      const text = top3ChatText.trim();
      if(!text || !target) return;
      const msg = {
        id:Date.now(), text, mine:true,
        user:userName||"You",
        initials:userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?",
        color:OR, ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
        isVoice:false, voiceSeconds:0,
      };
      setFriendMsgs(m=>({...m,[target.id]:[...(m[target.id]||[]),msg]}));
      setTop3ChatText("");
      setTimeout(()=>{
        const replies = ["👍","On my way!","Haha same","Let's do it this weekend","Sounds good.","😂"];
        const reply = {id:Date.now()+1, text:replies[Math.floor(Math.random()*replies.length)], mine:false, user:target.name, initials:target.initials, color:target.color, ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}), isVoice:false, voiceSeconds:0};
        setFriendMsgs(m=>({...m,[target.id]:[...(m[target.id]||[]),reply]}));
      }, 1400+Math.random()*1200);
    };
    const WalkieTalkieSheet = () => !walkieTarget ? null : (
      <div style={{position:"fixed",inset:0,background:"#111",zIndex:900,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#fff",fontFamily:F}}>
        <div style={{fontSize:12,fontWeight:700,letterSpacing:1.5,color:"#888",marginBottom:24}}>WALKIE-TALKIE</div>
        <FriendAvatar fr={walkieTarget} size={96} fontSize={32} style={{marginBottom:18,animation:walkiePhase==="recording"?"pulse 1.4s ease-in-out infinite":"none"}}/>
        <div style={{fontSize:20,fontWeight:800,marginBottom:6}}>{walkieTarget.name}</div>
        <div style={{fontSize:14,color:"#aaa",marginBottom:40}}>
          {walkiePhase==="idle" ? "Tap the mic to record" : walkiePhase==="recording" ? "Recording… "+String(Math.floor(walkieSeconds/60)).padStart(2,"0")+":"+String(walkieSeconds%60).padStart(2,"0") : "Sent!"}
        </div>
        {walkiePhase!=="sent" && (
          <button onClick={walkiePhase==="idle"?startWalkie:sendWalkie} title={walkiePhase==="idle"?"Start recording":"Stop and send"} style={{width:76,height:76,borderRadius:"50%",background:walkiePhase==="recording"?"#ef4444":"#22c55e",border:"none",color:"#fff",fontSize:30,cursor:"pointer",marginBottom:28,display:"flex",alignItems:"center",justifyContent:"center"}}>
            {walkiePhase==="recording" ? "■" : "🎙️"}
          </button>
        )}
        {walkiePhase!=="sent" && <button onClick={closeWalkie} style={{background:"none",border:"1px solid #444",color:"#aaa",borderRadius:20,padding:"8px 20px",fontSize:13,cursor:"pointer",fontFamily:F}}>Cancel</button>}
      </div>
    );

    // Quick-access account sheet — opened by tapping a row in Following /
    // Followers. Gives fast access to that person's basics, a follow toggle,
    // and a shortcut into a direct message with them in Lanes.
    const QuickUserSheet = () => {
      if(!quickUser) return null;
      const isF = following.some(f=>f.id===quickUser.id);
      const isFriend = friends.some(f=>f.id===quickUser.id);
      const reqSent = friendRequestsSent.includes(quickUser.id);
      return (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>setQuickUser(null)}>
          <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18}} onClick={e=>e.stopPropagation()}>
            <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
            <button onClick={()=>{setQuickUser(null);setViewedProfile(quickUser);}} style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,width:"100%",background:"none",border:"none",cursor:"pointer",fontFamily:F,textAlign:"left",padding:0}}>
              <div style={{width:52,height:52,borderRadius:"50%",background:quickUser.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#fff",flexShrink:0}}>{quickUser.initials}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:17,fontWeight:800,color:"#111"}}>{quickUser.name}</div>
                <div style={{fontSize:13,color:"#111"}}>@{quickUser.handle}</div>
              </div>
              <div style={{fontSize:12,fontWeight:700,color:OR,flexShrink:0}}>View Profile ›</div>
            </button>
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              <button onClick={()=>{
                if(isF){setFollowing(f=>f.filter(x=>x.id!==quickUser.id));}
                else{setFollowing(f=>[...f,quickUser]);setNotifications(n=>[{id:Date.now(),icon:"✨",text:"Now following "+quickUser.name+"! Their events and routes appear in your feeds.",ts:"now",read:false},...n]);}
              }} style={{flex:1,padding:"12px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,fontSize:14,fontWeight:800,background:isF?"#f3f3f3":OR,color:isF?"#555":"#fff"}}>
                {isF?"✓ Following":"+ Follow"}
              </button>
              <button disabled={isFriend||reqSent} onClick={()=>{
                setFriendRequestsSent(r=>[...r,quickUser.id]);
                setNotifications(n=>[{id:Date.now(),icon:"🤝",text:"Friend request sent to "+quickUser.name+".",ts:"now",read:false},...n]);
              }} style={{flex:1,padding:"12px",borderRadius:10,border:"none",cursor:(isFriend||reqSent)?"default":"pointer",fontFamily:F,fontSize:14,fontWeight:800,background:isFriend?"#22c55e11":reqSent?"#f3f3f3":OR+"15",color:isFriend?"#22c55e":reqSent?"#888":OR}}>
                {isFriend?"✓ Friends":reqSent?"Request Sent":"🤝 Send Friend Request"}
              </button>
            </div>
            <button onClick={()=>{
              const already = friends.some(f=>f.id===quickUser.id);
              if(!already) setFriends(f=>[...f,quickUser]);
              setQuickUser(null);
              setActiveChan(quickUser.id);
              go("create", {lanesRoom:true});
            }} style={{width:"100%",padding:"12px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F,fontSize:14,fontWeight:800}}>
              💬 Message
            </button>
            <button onClick={()=>setQuickUser(null)} style={{width:"100%",padding:"10px",marginTop:10,borderRadius:9,background:"none",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontSize:13,fontFamily:F}}>Close</button>
          </div>
        </div>
      );
    };

    // Full public profile page — every account is public, so tapping a
    // person's name anywhere (Followers/Following, Friends, Add a Friend
    // search, the quick-access sheet) opens this: their garage/car avatar
    // and whatever routes/events they've posted. Simulated people have no
    // real posts linked to them, so their Routes/Events sections just show
    // a friendly empty state — "me" is the only account with real data.
    const ProfileViewSheet = () => {
      if(!viewedProfile) return null;
      const person = viewedProfile;
      const isMe = person.id === "me";
      const isF = following.some(f=>f.id===person.id);
      const isFriend = isMe || friends.some(f=>f.id===person.id);
      const reqSent = friendRequestsSent.includes(person.id);
      const theirRoutes = posts.filter(p=>p.authorId===(isMe?"me":person.id));
      const theirEvents = events.filter(ev=>ev.authorId===(isMe?"me":person.id));
      const cars = isMe
        ? [{id:activeCarId,name:carName,color:carColor,model:carModel,bodyStyle:carBodyStyle,mods:carMods,avatarMode:carAvatarMode,avatarPhoto:carAvatarPhoto,saved:carSaved}, ...myCars]
        : [];
      const displayName = isMe ? (userName||"You") : (person.name||"Unnamed");
      const displayHandle = isMe ? (userName?userName.toLowerCase().replace(/\s+/g,""):"you") : (person.handle||"—");
      const avatarPhoto = isMe ? profilePhoto : person.photo;
      return (
        <div style={{position:"fixed",inset:0,background:"#fff",zIndex:850,display:"flex",flexDirection:"column",paddingTop:"env(safe-area-inset-top, 0px)",boxSizing:"border-box"}}>
          <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #ebebeb",flexShrink:0}}>
            <button onClick={()=>setViewedProfile(null)} style={{fontSize:20,background:"none",border:"none",color:"#111",cursor:"pointer"}}>←</button>
            <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1}}>Profile</div>
          </div>
          <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"18px 16px 32px"}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",marginBottom:22}}>
              <div style={{width:76,height:76,borderRadius:"50%",background:person.color||OR,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,fontWeight:800,color:"#fff",marginBottom:10,overflow:"hidden",flexShrink:0}}>
                {avatarPhoto ? <img src={avatarPhoto} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : (person.initials||"?")}
              </div>
              <div style={{fontSize:19,fontWeight:800,color:"#111",textAlign:"center"}}>{displayName}</div>
              <div style={{fontSize:13,color:"#111",marginBottom:10}}>@{displayHandle}</div>
              {!isMe && (
                <div style={{display:"flex",gap:8,width:"100%",maxWidth:280}}>
                  <button onClick={()=>{
                    if(isF){setFollowing(f=>f.filter(x=>x.id!==person.id));}
                    else{setFollowing(f=>[...f,person]);setNotifications(n=>[{id:Date.now(),icon:"✨",text:"Now following "+person.name+"! Their events and routes appear in your feeds.",ts:"now",read:false},...n]);}
                  }} style={{flex:1,padding:"10px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,fontSize:13,fontWeight:800,background:isF?"#f3f3f3":OR,color:isF?"#555":"#fff"}}>
                    {isF?"✓ Following":"+ Follow"}
                  </button>
                  <button disabled={isFriend||reqSent} onClick={()=>{
                    setFriendRequestsSent(r=>[...r,person.id]);
                    setNotifications(n=>[{id:Date.now(),icon:"🤝",text:"Friend request sent to "+person.name+".",ts:"now",read:false},...n]);
                  }} style={{flex:1,padding:"10px",borderRadius:10,border:"none",cursor:(isFriend||reqSent)?"default":"pointer",fontFamily:F,fontSize:13,fontWeight:800,background:isFriend?"#22c55e11":reqSent?"#f3f3f3":OR+"15",color:isFriend?"#22c55e":reqSent?"#888":OR}}>
                    {isFriend?"✓ Friends":reqSent?"Request Sent":"🤝 Add Friend"}
                  </button>
                </div>
              )}
            </div>

            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>GARAGE</div>
            {cars.length===0 ? (
              <div style={{textAlign:"center",padding:"24px 12px",color:"#111",background:"#f8f8f8",borderRadius:14,marginBottom:24}}>
                <div style={{fontSize:28,marginBottom:6}}>🚗</div>
                <div style={{fontSize:13}}>{isMe?"You haven't":(person.name?person.name+" hasn't":"They haven't")} saved a car yet.</div>
              </div>
            ) : (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:24}}>
                {cars.map(car=>(
                  <div key={car.id} style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 10px 12px",borderRadius:16,border:"1.5px solid "+(car.saved?OR+"44":"#ebebeb"),background:car.saved?"#fff9f5":"#f8f8f8"}}>
                    <div style={{width:64,height:64,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",marginBottom:8,flexShrink:0}}>
                      {car.avatarMode==="photo" && car.avatarPhoto
                        ? <img src={car.avatarPhoto} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        : <CarSVG color={car.color} mods={car.mods} size={54} styleId={car.bodyStyle}/>}
                    </div>
                    {car.name && <div style={{fontSize:13,fontWeight:700,color:"#111",textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{car.name}</div>}
                    <div style={{fontSize:11,color:"#111",marginTop:2}}>{car.model}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>ROUTES POSTED</div>
            {theirRoutes.length===0 ? (
              <div style={{textAlign:"center",padding:"18px 12px",color:"#111",background:"#f8f8f8",borderRadius:14,marginBottom:24,fontSize:13}}>No routes posted yet.</div>
            ) : (
              <div style={{marginBottom:24}}>
                {theirRoutes.map(r=>(
                  <div key={r.id} style={{...CARD,marginBottom:10}}>
                    <div style={{fontSize:14,fontWeight:800,color:"#111"}}>{r.title}</div>
                    <div style={{fontSize:11,color:"#111"}}>{r.type}{r.distance?" · "+r.distance:""} · ❤️ {r.likes||0}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>EVENTS POSTED</div>
            {theirEvents.length===0 ? (
              <div style={{textAlign:"center",padding:"18px 12px",color:"#111",background:"#f8f8f8",borderRadius:14,fontSize:13}}>No events posted yet.</div>
            ) : (
              <div>
                {theirEvents.map(ev=>(
                  <div key={ev.id} onClick={()=>{setViewedProfile(null);setFlyerEvent(ev);}} style={{...CARD,marginBottom:10,cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
                    <div style={{fontSize:24,flexShrink:0}}>{ev.icon}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:800,color:"#111"}}>{ev.title}</div>
                      {ev.date && <div style={{fontSize:11,color:"#111"}}>📅 {new Date(ev.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    };

    // Dispatches an objective's icon id to the right icon set — "road" (Routes)
    // and "event" (Events) use the app-wide DPad symbol/color for consistency
    // with the bottom nav; everything else uses the neutral profile outline set.
    const ObjIcon = ({icon, size}) => (
      icon==="road" || icon==="event"
        ? <DPadIcon id={icon} color={DPAD_COLORS[icon]} size={size}/>
        : <ProfileIcon id={icon} size={size} color="#8a8f98"/>
    );

    // Renders a Shared Garage vehicle's real car avatar — the same uploaded
    // photo or CarSVG a member picked from their own garage — inside a
    // circle tile, falling back to a plain 🚘 for older entries that were
    // only ever given a typed name (no avatar data attached).
    const VehicleAvatar = ({ v, size=40 }) => (
      <div style={{width:size,height:size,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",fontSize:size*0.45,flexShrink:0}}>
        {v.avatarMode==="photo" && v.avatarPhoto
          ? <img src={v.avatarPhoto} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          : v.color
            ? <CarSVG color={v.color} mods={v.mods||{}} size={size-12} styleId={v.bodyStyle||"sedan"}/>
            : "🚘"}
      </div>
    );

    // Reusable photo-gallery grid — used for the garage's exterior/interior
    // shots. Tap the dashed "+" tile to upload (multi-select), tap the ×
    // on a thumbnail to remove it.
    const PhotoGallery = (photos, setPhotos, fileRef, max=12) => {
      // One empty slot shown at a time — uploading a photo fills it and adds
      // a fresh empty slot right after, growing one at a time until `max`
      // photos are filled. Small galleries (car's 4 exterior/interior slots)
      // still get the shadowed grid-tile look, just without pre-showing all
      // the unfilled slots up front.
      const showAllSlots = max<=4;
      const cols = showAllSlots ? 2 : 3;
      const emptyCount = photos.length<max ? 1 : 0;
      const slotShadow = showAllSlots ? "0 1px 4px rgba(0,0,0,0.08)" : "none";
      return (
      <>
        <div style={{display:"grid",gridTemplateColumns:"repeat("+cols+",1fr)",gap:8,marginBottom:8}}>
          {photos.map(p=>(
            <div key={p.id} style={{position:"relative",aspectRatio:"1",borderRadius:10,overflow:"hidden",background:"#f5f5f5",boxShadow:slotShadow}}>
              <img src={p.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
              <button onClick={()=>setPhotos(ps=>ps.filter(x=>x.id!==p.id))} style={{position:"absolute",top:3,right:3,width:18,height:18,borderRadius:"50%",background:"rgba(0,0,0,0.55)",border:"none",color:"#fff",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
            </div>
          ))}
          {Array.from({length:emptyCount}).map((_,i)=>(
            <button key={"empty"+i} onClick={()=>fileRef.current?.click()} style={{aspectRatio:"1",borderRadius:10,border:"1.5px dashed #ddd",background:"#f8f8f8",boxShadow:slotShadow,fontSize:26,color:"#bbb",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
          ))}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>{
          Array.from(e.target.files||[]).slice(0,Math.max(0,max-photos.length)).forEach(f=>{
            readImageCompressed(f).then(url=>{ if(url) setPhotos(p=>[...p,{id:Date.now()+Math.random(),url}]); });
          });
          e.target.value="";
        }}/>
      </>
      );
    };

    /* ── My Stuff sections — My Garage, My Routes, My Events, Drive
         History, Dashcam, Achievements, Radio Stations, Settings all used to
         be their own full-screen pages under Profile; now each just fills
         one of these variables with its content, shown inline below the
         icon toggle row on the Profile home screen instead (see "home
         grid" below). Each block below still only runs its content when
         its own subPanel value is active, same as before. ── */
    let garageSection = null, routesSection = null, myeventsSection = null,
        historySection = null,
        radiostationsSection = null, settingsSection = null;

    /* routes sub */
    const myPostedRoutes = posts.filter(p=>p.authorId==="me");
    if(subPanel==="routes") routesSection = (
      <div>
        <div style={{padding:"0 14px 12px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1,display:"flex",alignItems:"center",gap:6}}><DPadIcon id="road" color={DPAD_COLORS.road} size={15}/> My Routes</div>
          <VN action={()=>{setNewRoute({title:"",type:"commute",distance:"",bio:"",stops:[""],public:false});setEditingRouteId(null);setSubPanel("createroute");}} style={{padding:"6px 13px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>+ Create Route</VN>
        </div>
        <div style={{padding:"10px 14px 4px"}}>

          {/* My Created Routes */}
          {routes.length===0 && savedFromFeed.length===0 && myPostedRoutes.length===0 && (
            <div style={{textAlign:"center",padding:"40px 0",color:"#111"}}>
              <div style={{fontSize:38,marginBottom:8}}>🗺️</div>
              <div style={{fontSize:14,fontWeight:700,color:"#111",marginBottom:4}}>No saved routes</div>
              <div style={{fontSize:13,color:"#111"}}>Create your own route or save one from the Route feed.</div>
            </div>
          )}

          {/* My Route Posts — routes you've published to the community Route
              feed (includes the starter San Diego routes posted to your
              account), each editable only by you via the feed's pencil icon. */}
          {myPostedRoutes.length>0 && (
            <>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>MY ROUTE POSTS</div>
              {myPostedRoutes.map(r => (
                <div key={r.id} style={{...CARD,border:"1.5px solid "+OR+"22",background:OR+"06"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:15,fontWeight:800,color:"#111"}}>{r.title}</div>
                      <div style={{fontSize:11,color:"#111"}}>{r.type}{r.distance?" · "+r.distance:""} · ❤️ {r.likes||0}</div>
                    </div>
                    <button onClick={()=>{
                      setNewPost({title:r.title||"",body:r.body||"",type:r.type||"scenic",distance:r.distance||"",stops:r.stops?.length?[...r.stops,""]:["",""],highlights:r.highlights||""});
                      setPostPhotos(r.photos||[]); setPostSavedRoute(null); setPostRouteMode("new"); setEditingPostId(r.id); setShowPost(true);
                      go("discover"); setDiscoverTab("routes");
                    }} title="Edit route post" style={{width:26,height:26,borderRadius:"50%",background:"#fff",border:"1px solid #ebebeb",color:"#111",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                  </div>
                  {r.stops?.length>0 && (
                    <>
                      <RouteMap route={r} height={110} color={OR}/>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap",margin:"8px 0"}}>
                        {r.stops.map((s,i)=><span key={i} style={{fontSize:11,background:OR+"11",borderRadius:20,padding:"2px 7px",color:OR}}>📍 {s}</span>)}
                      </div>
                    </>
                  )}
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>startRouteDirections(r)} style={{flex:1,padding:"7px",borderRadius:8,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>🧭 Get Directions</button>
                    <button onClick={()=>setPosts(p=>p.filter(x=>x.id!==r.id))} style={{padding:"7px 10px",borderRadius:8,background:"#f8f8f8",border:"1px solid #ebebeb",fontSize:12,color:"#111",cursor:"pointer"}}>✕</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {routes.length>0 && (
            <>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>MY ROUTES</div>
              {routes.map(r => (
                <div key={r.id} style={CARD}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:r.color||OR,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:15,fontWeight:800,color:"#111"}}>{r.title}</div>
                      <div style={{fontSize:11,color:"#111"}}>{r.type}{r.distance?" · "+r.distance:""}</div>
                    </div>
                    <button onClick={()=>openEditRoute(r)} title="Edit route" style={{width:26,height:26,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                  </div>
                  {r.bio && <div style={{fontSize:12,color:"#111",fontStyle:"italic",marginBottom:8,lineHeight:1.5}}>{r.bio}</div>}
                  {r.stops?.filter(s=>s&&s.trim()).length>0 && (
                    <>
                      <RouteMap route={r} height={110} color={r.color||OR}/>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap",margin:"8px 0"}}>
                        {r.stops.filter(s=>s&&s.trim()).map((s,i)=><span key={i} style={{fontSize:11,background:OR+"11",borderRadius:20,padding:"2px 7px",color:OR}}>📍 {s}</span>)}
                      </div>
                    </>
                  )}
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>startRouteDirections(r)} style={{flex:1,padding:"7px",borderRadius:8,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>🧭 Get Directions</button>
                    <button onClick={()=>setRoutes(rs=>rs.filter(x=>x.id!==r.id))} style={{padding:"7px 10px",borderRadius:8,background:"#f8f8f8",border:"1px solid #ebebeb",fontSize:12,color:"#111",cursor:"pointer"}}>✕</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Saved from Feed */}
          {savedFromFeed.length>0 && (
            <>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8,marginTop:routes.length>0?14:0}}>SAVED FROM FEED</div>
              {savedFromFeed.map(r => (
                <div key={r.id} style={{...CARD,border:"1.5px solid #6366f122",background:"#f8f8ff"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:r.color,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:15,fontWeight:800,color:"#111"}}>{r.title}</div>
                      <div style={{fontSize:11,color:"#111"}}>{r.type}{r.distance?" · "+r.distance:""}</div>
                    </div>
                    <div style={{fontSize:10,background:"#6366f1",color:"#fff",borderRadius:20,padding:"2px 7px",fontWeight:700,flexShrink:0}}>Feed</div>
                  </div>
                  {r.highlights && <div style={{fontSize:12,color:"#111",fontStyle:"italic",marginBottom:8}}>✨ {r.highlights}</div>}
                  {r.stops?.length>0 && (
                    <>
                      <RouteMap route={r} height={110} color="#6366f1"/>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap",margin:"8px 0"}}>
                        {r.stops.map((s,i)=><span key={i} style={{fontSize:11,background:"#ebebf5",borderRadius:20,padding:"2px 7px",color:"#6366f1"}}>📍 {s}</span>)}
                      </div>
                    </>
                  )}
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>startRouteDirections(r)} style={{flex:1,padding:"7px",borderRadius:8,background:"#6366f1",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>🧭 Get Directions</button>
                    <button onClick={()=>{
                      const C=[OR,"#22c55e","#6366f1","#a855f7"];
                      setRoutes(rs=>{const nr=[{id:Date.now(),title:r.title,type:r.type,distance:r.distance,color:C[rs.length%C.length]},...rs]; setTimeout(()=>checkAchievements({routes:nr}),200); return nr;});
                      setSavedFromFeed(s=>s.filter(x=>x.id!==r.id));
                    }} style={{padding:"7px 10px",borderRadius:8,background:"#f3f3f3",border:"1px solid #ebebeb",fontSize:11,color:"#6366f1",fontWeight:700,cursor:"pointer",fontFamily:F}}>+ Add to Mine</button>
                    <button onClick={()=>setSavedFromFeed(s=>s.filter(x=>x.id!==r.id))} style={{padding:"7px 10px",borderRadius:8,background:"#f8f8f8",border:"1px solid #ebebeb",fontSize:12,color:"#111",cursor:"pointer"}}>✕</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );

    /* create-route sub — dedicated full page for building a route: name,
       type, an open bio/description, and any number of stop addresses. */
    if(subPanel==="createroute") {
      const setStop = (i,val) => setNewRoute(r=>({...r,stops:r.stops.map((s,j)=>j===i?val:s)}));
      const addStop = () => setNewRoute(r=>({...r,stops:[...r.stops,""]}));
      const removeStop = i => setNewRoute(r=>({...r,stops:r.stops.filter((_,j)=>j!==i)}));
      // Save/cancel now live at the SonoLane() top level as saveCreateRoute
      // / cancelCreateRoute, so the shared TopBar's back/Save buttons can
      // call the same logic this page used to run from its own header.
      return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows back/Save while this
            page is open (see <TopBar/>). */}
        <div style={{padding:"10px 14px 0",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <DPadIcon id="road" color={DPAD_COLORS.road} size={15}/>
          <div style={{fontSize:16,fontWeight:800,color:"#111"}}>{editingRouteId?"Edit Route":"Create Route"}</div>
        </div>
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"16px 14px 32px"}}>

          <div style={SEC}>NAME</div>
          <input value={newRoute.title} onChange={e=>setNewRoute(r=>({...r,title:e.target.value}))} placeholder="Route name *" style={{...INP,marginBottom:14}}/>

          <div style={SEC}>TYPE</div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
            {["commute","home","scenic","hike","road trip","bike"].map(t=><button key={t} onClick={()=>setNewRoute(r=>({...r,type:t}))} style={TAG(newRoute.type===t)}>{t}</button>)}
          </div>

          <div style={SEC}>STOPS</div>
          {newRoute.stops.map((s,i)=>(
            <div key={i} style={{display:"flex",gap:6,marginBottom:8}}>
              <input value={s} onChange={e=>setStop(i,e.target.value)} placeholder={"Address for stop "+(i+1)+"…"} style={{...INP,flex:1}}/>
              {newRoute.stops.length>1 && <button onClick={()=>removeStop(i)} style={{padding:"0 12px",borderRadius:8,background:"#f8f8f8",border:"1px solid #ebebeb",fontSize:14,color:"#111",cursor:"pointer"}}>✕</button>}
            </div>
          ))}
          <button onClick={addStop} style={{width:"100%",padding:"10px",borderRadius:9,background:"none",border:"1.5px dashed "+OR+"66",color:OR,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,marginBottom:14}}>+ Add Stop</button>

          <div style={SEC}>DISTANCE (OPTIONAL)</div>
          <input value={newRoute.distance} onChange={e=>setNewRoute(r=>({...r,distance:e.target.value}))} placeholder="e.g. 12 mi" style={{...INP,marginBottom:14}}/>

          <div style={SEC}>BIO</div>
          <textarea value={newRoute.bio} onChange={e=>setNewRoute(r=>({...r,bio:e.target.value}))} placeholder="Describe the route — what makes it worth driving, things to look out for…" rows={4} style={{...INP,resize:"none",marginBottom:14}}/>

          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"11px 12px",borderRadius:12,background:"#f8f8f8",marginBottom:14}}>
            <div style={{flex:1,paddingRight:10}}>
              <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Make Public</div>
              <div style={{fontSize:12,color:"#888",marginTop:2}}>Public routes also show up in the Route feed for others to discover.</div>
            </div>
            <button onClick={()=>setNewRoute(r=>({...r,public:!r.public}))} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:newRoute.public?OR:"#ddd",position:"relative",flexShrink:0,padding:0}}>
              <div style={{position:"absolute",top:2,left:newRoute.public?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
            </button>
          </div>

          <button onClick={saveCreateRoute} style={{width:"100%",padding:"13px",borderRadius:11,background:OR,color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F}}>{editingRouteId?"💾 Save Changes":"💾 Save Route"}</button>
        </div>
      </div>
      );
    }

    /* garage sub — grid of your saved cars (up to MAX_CARS, currently 3),
       plus shared garages; tap a car tile to make it active and open its
       full detail view (banner, stats, photos), or "Add Another Car" to
       park the current one and start a new blank one. */
    if(subPanel==="garage") garageSection = (
      <div>
        <div style={{padding:"0 14px 12px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1,display:"flex",alignItems:"center",gap:6}}><DefaultAvatar size={18} color="#555"/> My Profile</div>
        </div>
        <div style={{padding:"16px 14px 7px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <span style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2}}>MY CARS</span>
            <span style={{fontSize:11,color:"#999",fontWeight:700}}>{1+myCars.length}/{MAX_CARS}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
            {/* Active car — reads the live carName/carColor/etc. fields, same as every other screen that shows "your car". */}
            <div style={{position:"relative"}}>
              <button onClick={()=>{setCarDetailFrom("garage");setSubPanel("car");}} style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",padding:"18px 10px 14px",borderRadius:16,border:carSaved?"1.5px solid "+OR+"44":"1.5px solid #ebebeb",background:carSaved?"#fff9f5":"#f8f8f8",cursor:"pointer",fontFamily:F}}>
                <div style={{width:72,height:72,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",marginBottom:8,flexShrink:0}}>
                  {carAvatarMode==="photo" && carAvatarPhoto
                    ? <img src={carAvatarPhoto} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                    : <CarSVG color={carColor} mods={carMods} size={62} styleId={carBodyStyle}/>}
                </div>
                {carName && <div style={{fontSize:14,fontWeight:700,color:"#111",textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{carName}</div>}
                <div style={{fontSize:11,color:"#111",marginTop:carName?2:0}}>{carSaved?"✓ saved":carModel}</div>
              </button>
              <button onClick={()=>setConfirmDeleteCar({id:activeCarId,name:carName||carModel||"this car"})} title="Delete car" style={{position:"absolute",top:6,right:6,width:24,height:24,borderRadius:"50%",background:"rgba(255,255,255,0.9)",border:"1px solid #ebebeb",color:"#ef4444",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            {/* Other saved cars — tap to make one active and open its details. */}
            {myCars.map(car=>(
              <div key={car.id} style={{position:"relative"}}>
                <button onClick={()=>{switchToCar(car.id);setCarDetailFrom("garage");setSubPanel("car");}} style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",padding:"18px 10px 14px",borderRadius:16,border:car.saved?"1.5px solid "+OR+"44":"1.5px solid #ebebeb",background:car.saved?"#fff9f5":"#f8f8f8",cursor:"pointer",fontFamily:F}}>
                  <div style={{width:72,height:72,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",marginBottom:8,flexShrink:0}}>
                    {car.avatarMode==="photo" && car.avatarPhoto
                      ? <img src={car.avatarPhoto} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      : <CarSVG color={car.color} mods={car.mods} size={62} styleId={car.bodyStyle}/>}
                  </div>
                  {car.name && <div style={{fontSize:14,fontWeight:700,color:"#111",textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{car.name}</div>}
                  <div style={{fontSize:11,color:"#111",marginTop:car.name?2:0}}>{car.saved?"✓ saved":car.model}</div>
                </button>
                <button onClick={()=>setConfirmDeleteCar({id:car.id,name:car.name||car.model||"this car"})} title="Delete car" style={{position:"absolute",top:6,right:6,width:24,height:24,borderRadius:"50%",background:"rgba(255,255,255,0.9)",border:"1px solid #ebebeb",color:"#ef4444",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            ))}
            {/* Add another car — up to MAX_CARS total. */}
            {(1+myCars.length) < MAX_CARS && (
              <button onClick={()=>{addNewCar();setCarDetailFrom("garage");setSubPanel("car");}} style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"18px 10px 14px",borderRadius:16,border:"2px dashed #ddd",background:"#fafafa",cursor:"pointer",fontFamily:F}}>
                <div style={{width:72,height:72,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8,flexShrink:0,fontSize:30,color:"#ccc"}}>＋</div>
                <div style={{fontSize:14,fontWeight:700,color:"#111",textAlign:"center"}}>Add Another Car</div>
                <div style={{fontSize:11,color:"#111",marginTop:2}}>{MAX_CARS-1-myCars.length} slot{MAX_CARS-1-myCars.length===1?"":"s"} left</div>
              </button>
            )}
          </div>

          {/* Confirm before deleting a car — wipes its photos/details, so a
              deliberate extra step rather than an instant delete. */}
          {confirmDeleteCar && (
            <div onClick={()=>setConfirmDeleteCar(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}}>
              <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18}}>
                <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
                <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:6}}>Delete {confirmDeleteCar.name}?</div>
                <div style={{fontSize:13,color:"#111",lineHeight:1.6,marginBottom:16}}>This removes it from your garage for good, including its photos and details. This can't be undone.</div>
                <button onClick={()=>{deleteCar(confirmDeleteCar.id);setConfirmDeleteCar(null);}} style={{width:"100%",padding:"13px",borderRadius:12,background:"#ef4444",color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F,marginBottom:10}}>Delete Car</button>
                <button onClick={()=>setConfirmDeleteCar(null)} style={{width:"100%",padding:"12px",borderRadius:12,background:"transparent",color:"#111",border:"1px solid #ebebeb",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F}}>Cancel</button>
              </div>
            </div>
          )}

          {sharedGarages.length>0 && (
            <>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,margin:"0 0 12px"}}>SHARED GARAGES</div>
              <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
                {sharedGarages.map(g=>(
                  <button key={g.id} onClick={()=>{setSelSharedGarage(g.id);setSubPanel("sharedgarage");}} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:14,border:"1.5px solid #ebebeb",background:"#fff",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                    <div style={{width:44,height:44,borderRadius:12,background:g.color+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>🚗</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:15,fontWeight:800,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.name}</div>
                      <div style={{fontSize:12,color:"#111"}}>{g.vehicles.length} vehicle{g.vehicles.length===1?"":"s"} · {g.memberIds.length+1} member{g.memberIds.length===0?"":"s"}</div>
                    </div>
                    <span style={{fontSize:16,color:"#ccc"}}>›</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <button onClick={()=>setShowCreateSharedGarage(true)} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"12px 14px",borderRadius:14,border:"1.5px dashed #ddd",background:"#fafafa",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
            <div style={{width:40,height:40,borderRadius:10,background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#ccc",flexShrink:0}}>＋</div>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Create Shared Garage</div>
              <div style={{fontSize:11,color:"#111",marginTop:1}}>Invite friends to add their own vehicle, chat, and call.</div>
            </div>
          </button>
        </div>

        {showCreateSharedGarage && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>{setShowCreateSharedGarage(false);setNewGarageInvitees([]);}}>
            <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18,maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
              <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
              <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:4}}>Create a Shared Garage</div>
              <div style={{fontSize:12,color:"#111",marginBottom:14}}>Invite friends to add their own vehicle, chat as a group, and call each other — all in one place.</div>
              <input value={newSharedGarageName} onChange={e=>setNewSharedGarageName(e.target.value)} placeholder="e.g. The Crew's Builds" style={{...INP,marginBottom:14}}/>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:0.8,marginBottom:8}}>INVITE FRIENDS</div>
              {friends.length===0 && <div style={{fontSize:13,color:"#111",marginBottom:14}}>Add some friends first to invite them.</div>}
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
                {friends.map(fr=>{
                  const picked = newGarageInvitees.includes(fr.id);
                  return (
                    <button key={fr.id} onClick={()=>setNewGarageInvitees(p=>picked?p.filter(x=>x!==fr.id):[...p,fr.id])} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:10,border:picked?"1.5px solid "+OR:"1px solid #ebebeb",background:picked?OR+"08":"#fff",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                      <FriendAvatar fr={fr} size={30} fontSize={11}/>
                      <div style={{flex:1,fontSize:14,fontWeight:700,color:"#111"}}>{fr.name}</div>
                      <div style={{width:18,height:18,borderRadius:5,border:picked?"none":"1.5px solid #ddd",background:picked?OR:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#fff",flexShrink:0}}>{picked?"✓":""}</div>
                    </button>
                  );
                })}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{
                  if(!newSharedGarageName.trim())return;
                  const COLS=[OR,"#6366f1","#22c55e","#a855f7","#ec4899","#14b8a6"];
                  const gid = "sg_"+Date.now();
                  const laneId = "garage_"+gid;
                  const invited = friends.filter(f=>newGarageInvitees.includes(f.id));
                  const garage = {
                    id:gid, name:newSharedGarageName.trim(),
                    color:COLS[sharedGarages.length%COLS.length],
                    memberIds:invited.map(f=>f.id),
                    vehicles:[], laneId,
                  };
                  setSharedGarages(g=>[...g,garage]);
                  // Dedicated group chat lane — reuses the same Lanes chat plumbing as
                  // every other lane; kept out of the sidebar lists via garageId.
                  setCustomLanes(l=>[...l,{id:laneId,name:garage.name.toLowerCase().replace(/\s+/g,"-"),color:garage.color,desc:"Shared garage chat",visibility:"friends",authorId:"me",garageId:gid}]);
                  invited.forEach((fr,i)=>{
                    setTimeout(()=>{
                      const car = SAMPLE_GARAGE_CARS[Math.floor(Math.random()*SAMPLE_GARAGE_CARS.length)];
                      setSharedGarages(gs=>gs.map(x=>x.id===gid ? {...x,vehicles:[...x.vehicles,{id:"v_"+Date.now()+"_"+i,ownerId:fr.id,ownerName:fr.name,ownerInitials:fr.initials,ownerColor:fr.color,name:car.name,bio:car.bio,color:car.color,bodyStyle:car.bodyStyle}]} : x));
                      setNotifications(n=>[{id:Date.now()+i,icon:"🚗",text:fr.name+" joined "+garage.name+" and added their "+car.name+".",ts:"now",read:false},...n]);
                    }, 1600+i*900);
                  });
                  setNewSharedGarageName("");setNewGarageInvitees([]);setShowCreateSharedGarage(false);
                  setSelSharedGarage(gid);setSubPanel("sharedgarage");
                }} style={{flex:1,padding:"12px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Create</button>
                <button onClick={()=>{setShowCreateSharedGarage(false);setNewGarageInvitees([]);}} style={{padding:"12px 14px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );

    /* shared garage sub — a garage co-owned with invited friends: each
       member's vehicle + bio, a shortcut into the dedicated group chat, and
       direct Call/Text access to every member. */
    if(subPanel==="sharedgarage") {
      const g = sharedGarages.find(x=>x.id===selSharedGarage);
      if(!g) { setSubPanel("garage"); return null; }
      const myVehicle = g.vehicles.find(v=>v.ownerId==="me");
      const members = g.memberIds.map(id=>friends.find(f=>f.id===id)).filter(Boolean);
      const invitableFriends = friends.filter(f=>!g.memberIds.includes(f.id));
      return (
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Own header removed — the shared TopBar shows back/Group Chat
              while this page is open (see <TopBar/>). */}
          <div style={{padding:"10px 14px 0",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
            <div style={{flex:1,minWidth:0,fontSize:16,fontWeight:800,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {g.photo ? <img src={g.photo} alt="" style={{width:22,height:22,borderRadius:"50%",objectFit:"cover",verticalAlign:"middle",marginRight:6}}/> : "🚗 "}
              {g.name}
            </div>
            <button onClick={()=>{setEditGarageDraft({name:g.name,bio:g.bio||"",photo:g.photo||null});setShowEditGarage(true);}} title="Edit garage" style={{width:30,height:30,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
          </div>
          <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"12px 14px 7px"}}>
            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:12}}>{g.vehicles.length} VEHICLE{g.vehicles.length===1?"":"S"} · {members.length+1} MEMBER{members.length===0?"":"S"}</div>
            {g.bio && g.bio.trim() && <div style={{fontSize:13,color:"#111",lineHeight:1.5,marginBottom:14}}>{g.bio}</div>}

            {/* Car avatar window grid — same visual language as the MY CARS
                grid on the Profile/Garage page: a bordered rounded tile per
                person with a circular avatar window, name, and status line. */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:4}}>
              {/* Your vehicle tile */}
              {myVehicle ? (
                <div style={{position:"relative"}}>
                  <button onClick={()=>{setShareCarId(myVehicle.sourceCarId||null);setNewVehicle({name:myVehicle.name,bio:myVehicle.bio});setShowAddVehicle(true);}} style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",padding:"18px 10px 14px",borderRadius:16,border:"1.5px solid "+OR+"44",background:"#fff9f5",cursor:"pointer",fontFamily:F}}>
                    <VehicleAvatar v={myVehicle} size={72}/>
                    <div style={{fontSize:14,fontWeight:700,color:"#111",marginTop:8,textAlign:"center",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{myVehicle.name}</div>
                    <div style={{fontSize:11,color:OR,fontWeight:700,marginTop:2}}>· You</div>
                  </button>
                  <button onClick={()=>setSharedGarages(gs=>gs.map(x=>x.id===g.id?{...x,vehicles:x.vehicles.filter(v=>v.id!==myVehicle.id)}:x))} title="Remove your vehicle" style={{position:"absolute",top:6,right:6,width:24,height:24,borderRadius:"50%",background:"#fff",border:"1px solid #ebebeb",color:"#ef4444",fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                </div>
              ) : (
                <button onClick={()=>{setShareCarId(null);setNewVehicle({name:"",bio:""});setShowAddVehicle(true);}} style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"18px 10px 14px",borderRadius:16,border:"2px dashed #ddd",background:"#fafafa",cursor:"pointer",fontFamily:F}}>
                  <div style={{width:72,height:72,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,color:"#ccc"}}>＋</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#111",marginTop:8,textAlign:"center"}}>Share Your Car</div>
                  <div style={{fontSize:10,color:"#111",marginTop:2,textAlign:"center"}}>· You</div>
                </button>
              )}

              {/* Member tiles — tapping opens a Call/Text action sheet
                  instead of always-visible inline buttons. */}
              {members.map(fr=>{
                const v = g.vehicles.find(x=>x.ownerId===fr.id);
                return (
                  <button key={fr.id} onClick={()=>setGarageMemberAction(fr)} style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"18px 10px 14px",borderRadius:16,border:"1.5px solid #ebebeb",background:"#f8f8f8",cursor:"pointer",fontFamily:F}}>
                    {v ? <VehicleAvatar v={v} size={72}/> : <FriendAvatar fr={fr} size={72} fontSize={26}/>}
                    <div style={{fontSize:14,fontWeight:700,color:"#111",marginTop:8,textAlign:"center",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v ? v.name : fr.name}</div>
                    <div style={{fontSize:11,color:"#111",marginTop:2,textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{v ? fr.name : "Invited · pending"}</div>
                  </button>
                );
              })}
            </div>

            {/* Invite more friends */}
            {invitableFriends.length>0 && (
              <div style={{marginTop:18}}>
                <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>INVITE MORE FRIENDS</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {invitableFriends.map(fr=>(
                    <div key={fr.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:10,border:"1px solid #ebebeb"}}>
                      <FriendAvatar fr={fr} size={30} fontSize={11}/>
                      <div style={{flex:1,fontSize:14,fontWeight:700,color:"#111"}}>{fr.name}</div>
                      <button onClick={()=>{
                        setSharedGarages(gs=>gs.map(x=>x.id===g.id?{...x,memberIds:[...x.memberIds,fr.id]}:x));
                        setTimeout(()=>{
                          const car = SAMPLE_GARAGE_CARS[Math.floor(Math.random()*SAMPLE_GARAGE_CARS.length)];
                          setSharedGarages(gs=>gs.map(x=>x.id===g.id ? {...x,vehicles:[...x.vehicles,{id:"v_"+Date.now(),ownerId:fr.id,ownerName:fr.name,ownerInitials:fr.initials,ownerColor:fr.color,name:car.name,bio:car.bio,color:car.color,bodyStyle:car.bodyStyle}]} : x));
                          setNotifications(n=>[{id:Date.now(),icon:"🚗",text:fr.name+" joined "+g.name+" and added their "+car.name+".",ts:"now",read:false},...n]);
                        }, 1800);
                      }} style={{padding:"6px 12px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>Invite</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Member action sheet — tap a member's tile to Call or Text them.
              Text opens the Lanes room with lanesGarageOrigin set so the
              back button from that room returns here, not the Lanes list. */}
          {garageMemberAction && (
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>setGarageMemberAction(null)}>
              <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18,paddingBottom:26}} onClick={e=>e.stopPropagation()}>
                <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
                  <FriendAvatar fr={garageMemberAction} size={44} fontSize={16}/>
                  <div style={{fontSize:16,fontWeight:800,color:"#111"}}>{garageMemberAction.name}</div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{setCallingFriend({friend:garageMemberAction,status:"ringing",secs:0});setGarageMemberAction(null);}} style={{flex:1,padding:"12px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,fontSize:14,fontWeight:800,background:"#22c55e11",color:"#22c55e"}}>📞 Call</button>
                  <button onClick={()=>{const fr=garageMemberAction;setGarageMemberAction(null);setActiveChan(fr.id);go("create",{lanesRoom:true,lanesGarageOrigin:{garageId:g.id}});}} style={{flex:1,padding:"12px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,fontSize:14,fontWeight:800,background:"#5865f211",color:"#5865f2"}}>💬 Text</button>
                </div>
              </div>
            </div>
          )}

          {/* Edit Garage sheet — photo, name, bio, and members (remove). */}
          {showEditGarage && (
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowEditGarage(false)}>
              <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18,maxHeight:"82vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
                <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
                <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:14}}>Edit Garage</div>

                <div style={{display:"flex",justifyContent:"center",marginBottom:16}}>
                  <button onClick={()=>garagePhotoRef.current?.click()} style={{width:80,height:80,borderRadius:"50%",background:editGarageDraft.photo?"transparent":"#f3f3f3",border:"1.5px solid #ebebeb",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
                    {editGarageDraft.photo ? <img src={editGarageDraft.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <span style={{fontSize:24,color:"#ccc"}}>🚗</span>}
                  </button>
                  <input ref={garagePhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;readImageCompressed(f,800,0.85).then(url=>{if(url)setEditGarageDraft(d=>({...d,photo:url}));});e.target.value="";}}/>
                </div>
                <div style={{textAlign:"center",marginBottom:16}}>
                  <button onClick={()=>garagePhotoRef.current?.click()} style={{padding:"6px 14px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>{editGarageDraft.photo?"Replace Photo":"Upload Photo"}</button>
                  {editGarageDraft.photo && <button onClick={()=>setEditGarageDraft(d=>({...d,photo:null}))} style={{marginLeft:8,padding:"6px 14px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#ef4444",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>Remove</button>}
                </div>

                <input value={editGarageDraft.name} onChange={e=>setEditGarageDraft(d=>({...d,name:e.target.value}))} placeholder="Garage name" style={{...INP,marginBottom:8}}/>
                <textarea value={editGarageDraft.bio} onChange={e=>setEditGarageDraft(d=>({...d,bio:e.target.value.slice(0,140)}))} placeholder="Short bio — what this garage/crew is about" maxLength={140} style={{...INP,minHeight:70,resize:"vertical",marginBottom:4}}/>
                <div style={{fontSize:10,color:"#bbb",textAlign:"right",marginBottom:12}}>{editGarageDraft.bio.length}/140</div>

                {members.length>0 && (
                  <div style={{marginBottom:16}}>
                    <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>MEMBERS</div>
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {members.map(fr=>(
                        <div key={fr.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:10,border:"1px solid #ebebeb"}}>
                          <FriendAvatar fr={fr} size={30} fontSize={11}/>
                          <div style={{flex:1,fontSize:14,fontWeight:700,color:"#111"}}>{fr.name}</div>
                          <button onClick={()=>setSharedGarages(gs=>gs.map(x=>x.id===g.id?{...x,memberIds:x.memberIds.filter(id=>id!==fr.id),vehicles:x.vehicles.filter(v=>v.ownerId!==fr.id)}:x))} title="Remove member" style={{width:26,height:26,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#ef4444",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✕</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{
                    if(!editGarageDraft.name.trim())return;
                    setSharedGarages(gs=>gs.map(x=>x.id===g.id?{...x,name:editGarageDraft.name.trim(),bio:editGarageDraft.bio.trim(),photo:editGarageDraft.photo}:x));
                    setShowEditGarage(false);
                  }} style={{flex:1,padding:"12px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Save</button>
                  <button onClick={()=>setShowEditGarage(false)} style={{padding:"12px 14px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {showAddVehicle && (() => {
            // Every saved car in your garage (the active one + parked ones from
            // myCars) that you can post here as-is, avatar and all — picking one
            // fills the name/bio below with its real data, but they stay
            // editable, and typing over the name clears the pick so a fully
            // custom manual entry still works same as before.
            const myGarageCars = [
              {id:activeCarId, name:carName||carModel, model:carModel, color:carColor, bodyStyle:carBodyStyle, mods:carMods, avatarMode:carAvatarMode, avatarPhoto:carAvatarPhoto, bio:carBio, saved:carSaved},
              ...myCars.map(c=>({id:c.id, name:c.name||c.model, model:c.model, color:c.color, bodyStyle:c.bodyStyle, mods:c.mods, avatarMode:c.avatarMode, avatarPhoto:c.avatarPhoto, bio:c.bio, saved:c.saved})),
            ].filter(c=>c.saved);
            const picked = myGarageCars.find(c=>c.id===shareCarId);
            return (
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>{setShowAddVehicle(false);setShareCarId(null);}}>
              <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18,maxHeight:"82vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
                <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
                <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:4}}>Share a Car From Your Garage</div>
                <div style={{fontSize:12,color:"#111",marginBottom:14}}>Pick one of your saved car avatars, or type one in manually below.</div>
                {myGarageCars.length>0 && (
                  <div style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:6,marginBottom:16}}>
                    {myGarageCars.map(car=>(
                      <button key={car.id} onClick={()=>{setShareCarId(car.id);setNewVehicle({name:car.name,bio:car.bio||""});}} style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"10px 8px",borderRadius:14,border:shareCarId===car.id?"1.5px solid "+OR:"1.5px solid #ebebeb",background:shareCarId===car.id?OR+"08":"#fff",cursor:"pointer",fontFamily:F,flexShrink:0,minWidth:76}}>
                        <VehicleAvatar v={car} size={48}/>
                        <div style={{fontSize:11,fontWeight:700,color:"#111",marginTop:6,textAlign:"center",maxWidth:70,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{car.name}</div>
                      </button>
                    ))}
                  </div>
                )}
                <input value={newVehicle.name} onChange={e=>{setShareCarId(null);setNewVehicle(v=>({...v,name:e.target.value}));}} placeholder="e.g. '20 Civic Type R" style={{...INP,marginBottom:8}}/>
                <textarea value={newVehicle.bio} onChange={e=>setNewVehicle(v=>({...v,bio:e.target.value}))} placeholder="Short bio — mods, story, whatever you want the crew to know" style={{...INP,minHeight:70,resize:"vertical",marginBottom:14}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{
                    if(!newVehicle.name.trim())return;
                    setSharedGarages(gs=>gs.map(x=>x.id===g.id?{
                      ...x,
                      vehicles:[
                        ...x.vehicles.filter(v=>v.ownerId!=="me"),
                        {id:"v_me_"+Date.now(), ownerId:"me", ownerName:userName||"You", ownerInitials:"ME", ownerColor:OR,
                         name:newVehicle.name.trim(), bio:newVehicle.bio.trim()||"No bio yet.",
                         avatarMode:picked?.avatarMode, avatarPhoto:picked?.avatarPhoto, color:picked?.color, bodyStyle:picked?.bodyStyle, mods:picked?.mods, sourceCarId:picked?.id},
                      ],
                    }:x));
                    setNewVehicle({name:"",bio:""});setShareCarId(null);setShowAddVehicle(false);
                  }} style={{flex:1,padding:"12px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Save</button>
                  <button onClick={()=>{setShowAddVehicle(false);setShareCarId(null);}} style={{padding:"12px 14px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Cancel</button>
                </div>
              </div>
            </div>
            );
          })()}
          <CallOverlay/>
        </div>
      );
    }

    /* car sub — garage / stats view */
    if(subPanel==="car") {
      const bannerBg = carBannerPhoto ? "url("+carBannerPhoto+") center/cover no-repeat" : (CAR_BANNERS.find(b=>b.id===carBannerPreset)||CAR_BANNERS[0]).css;
      return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar switches to back(left)/
            edit(right) buttons while this page is open (see <TopBar/>). */}
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"0 0 7px"}}>

          {/* Hero — customizable banner (upload or premade) behind either the custom SVG avatar or an uploaded car photo. Banner is edited from the Edit Car menu. */}
          <div style={{background:bannerBg,padding:"28px 20px 20px",display:"flex",flexDirection:"column",alignItems:"center",position:"relative"}}>
            {!carBannerPhoto && <div style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"70%",height:40,background:carColor+"33",filter:"blur(20px)",borderRadius:"50%"}}/>}
            <div style={{position:"relative",zIndex:1}}>
              {carAvatarMode==="photo" && carAvatarPhoto
                ? <img src={carAvatarPhoto} alt="" style={{width:150,height:150,borderRadius:20,objectFit:"cover",border:"3px solid rgba(255,255,255,0.85)",boxShadow:"0 6px 20px rgba(0,0,0,0.4)"}}/>
                : <CarSVG color={carColor} mods={carMods} size={200} styleId={carBodyStyle}/>}
            </div>
            <div style={{marginTop:10,textAlign:"center",zIndex:1}}>
              <div style={{fontSize:20,fontWeight:900,color:"#fff",textShadow:"0 1px 4px rgba(0,0,0,0.5)"}}>{carName || CAR_BRANDS.find(b=>b.id===carBrand)?.name || "My Car"}</div>
              {(carName || carModel) && <div style={{fontSize:13,color:"#ddd",marginTop:2,textShadow:"0 1px 4px rgba(0,0,0,0.5)"}}>{(carName && carBrand) ? (CAR_BRANDS.find(b=>b.id===carBrand)?.name+" ") : ""}{carModel} · {Object.values(carMods).filter(v=>v&&v!=="None"&&v!=="Stock").length} mods</div>}
            </div>
            {/* Private car info — opens from this wallet button on the car
                avatar window instead of always sitting inline on the page.
                Same data, edited from Edit Car, only ever visible to you. */}
            <button onClick={()=>setShowPrivateCard(true)} title="Private Car Info" style={{position:"absolute",bottom:10,right:10,width:38,height:38,borderRadius:"50%",background:"rgba(0,0,0,0.55)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}}>
              <ProfileIcon id="briefcase" size={18} color="#fff"/>
            </button>
          </div>

          {Object.values(carMods).filter(v=>v&&v!=="None"&&v!=="Stock").length>0&&(
            <div style={{padding:"12px 16px 0",display:"flex",gap:5,flexWrap:"wrap"}}>
              {Object.entries(carMods).filter(([,v])=>v&&v!=="None"&&v!=="Stock").map(([k,v])=>(
                <div key={k} style={{background:OR+"15",border:"1px solid "+OR+"33",borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700,color:OR}}>{k}: {v}</div>
              ))}
            </div>
          )}

          <div style={{padding:"14px 16px 0"}}>
            {/* Bio — build story / mod description, set from Edit Car. Shown
                right above Photos, only when the owner has written one. */}
            {carBio && carBio.trim() && (<>
              <div style={SEC}>BIO</div>
              <div style={{...CARD,fontSize:14,color:"#111",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{carBio}</div>
            </>)}

            <div style={SEC}>PHOTOS</div>
            <div style={{fontSize:12,color:"#111",fontWeight:700,marginBottom:6}}>EXTERIOR (UP TO 4)</div>
            {PhotoGallery(carExteriorPhotos, setCarExteriorPhotos, carExteriorPhotoRef, 4)}
            <div style={{fontSize:12,color:"#111",fontWeight:700,marginTop:10,marginBottom:6}}>INTERIOR (UP TO 4)</div>
            {PhotoGallery(carInteriorPhotos, setCarInteriorPhotos, carInteriorPhotoRef, 4)}

            <div style={{...SEC,marginTop:16}}>DRIVING STATS</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
              {[
                {icKind:"profile",ic:"car",   label:"Total Mileage",val:totalMiles.toFixed(1),unit:"mi driven"},
                {icKind:"profile",ic:"history",label:"Total Drives",val:tripHistory.length,unit:"recorded"},
                {icKind:"dpad",   ic:"road",   dc:DPAD_COLORS.road,  label:"Total Routes",val:routes.length,unit:"saved"},
                {icKind:"profile",ic:"video",  label:"Dashcam Clips",val:clips.length,unit:"recorded"},
                {icKind:"profile",ic:"star",   label:"Star Points",val:pts,unit:"earned"},
                {icKind:"profile",ic:"trophy", pc:"#f5a623",         label:"Driver Level",val:"Lv "+Math.floor(pts/200),unit:"rank"},
                {icKind:"dpad",   ic:"event",  dc:DPAD_COLORS.event, label:"Events",val:events.length,unit:"attended"},
                {icKind:"profile",ic:"people", label:"Friends",val:friends.length,unit:"connected"},
              ].map(s=>(
                <div key={s.label} style={{background:"#f8f8f8",borderRadius:12,border:"1px solid #ebebeb",padding:"12px 14px"}}>
                  <div style={{marginBottom:6}}>{s.icKind==="dpad" ? <DPadIcon id={s.ic} color={s.dc} size={20}/> : <ProfileIcon id={s.ic} size={20} color={s.pc||"#8a8f98"}/>}</div>
                  <div style={{fontSize:18,fontWeight:900,color:"#111",lineHeight:1}}>{s.val}</div>
                  <div style={{fontSize:10,color:"#111",marginTop:3}}>{s.label}</div>
                </div>
              ))}
            </div>

            {routes.length>0&&<>
              <div style={SEC}>RECENT ROUTES</div>
              {routes.slice(0,3).map(r=>(
                <div key={r.id} style={{...CARD,display:"flex",alignItems:"center",gap:10,padding:"10px 12px"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:r.color||OR,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#111"}}>{r.title}</div>
                    <div style={{fontSize:11,color:"#111"}}>{r.type}{r.distance?" · "+r.distance:""}</div>
                  </div>
                  <button onClick={()=>startRouteDirections(r)} title="Get Directions" style={{padding:"4px 10px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>🧭</button>
                </div>
              ))}
            </>}

            {/* Private car info is no longer shown inline on this page at
                all — the only way to open it is the briefcase button on the
                car avatar banner above. Same data, edited from Edit Car,
                only ever visible to you on your own device. */}
          </div>
        </div>

        {/* Private car info sheet — only visible to the owner here on their
            own device; never shown on posts, the home hero, or anywhere else
            public. Opened only via the wallet button above. */}
        {showPrivateCard && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowPrivateCard(false)}>
            <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",maxHeight:"80%",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
              <div style={{width:30,height:3,background:"#e8e8e8",borderRadius:2,margin:"12px auto 0",flexShrink:0}}/>
              <div style={{padding:"10px 16px 12px",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid #ebebeb",flexShrink:0}}>
                <ProfileIcon id="briefcase" size={18} color="#111"/>
                <div style={{flex:1,fontSize:16,fontWeight:800,color:"#111"}}>Private Car Info</div>
                <button onClick={()=>setShowPrivateCard(false)} style={{width:28,height:28,borderRadius:"50%",border:"none",background:"#f3f3f3",color:"#111",fontSize:15,cursor:"pointer"}}>✕</button>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 24px"}}>
                <div style={{...CARD,background:"#fdf8ec",border:"1px solid #eeddb0"}}>
                  <div style={{fontSize:11,color:"#111",fontWeight:700,marginBottom:8}}>🔒 Only visible to you.</div>
                  {carPrivatePhotos.length>0 && (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:carPlate||carRegDate||carMileage||carPrivateNotes?10:0}}>
                      {carPrivatePhotos.map(p=>(
                        <div key={p.id} style={{aspectRatio:"1",borderRadius:8,overflow:"hidden",background:"#f0e6c8"}}>
                          <img src={p.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                        </div>
                      ))}
                    </div>
                  )}
                  {carPlate && (
                    <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #f2f2f2"}}>
                      <span style={{fontSize:12,color:"#111"}}>License Plate</span>
                      <span style={{fontSize:13,fontWeight:700,color:"#111"}}>{carPlate}</span>
                    </div>
                  )}
                  {carRegDate && (
                    <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #f2f2f2"}}>
                      <span style={{fontSize:12,color:"#111"}}>Registration Date</span>
                      <span style={{fontSize:13,fontWeight:700,color:"#111"}}>{new Date(carRegDate+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</span>
                    </div>
                  )}
                  {carMileage && (
                    <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:(carPrivateNotes?"1px solid #f2f2f2":"none")}}>
                      <span style={{fontSize:12,color:"#111"}}>Current Mileage</span>
                      <span style={{fontSize:13,fontWeight:700,color:"#111"}}>{Number(carMileage).toLocaleString()} mi</span>
                    </div>
                  )}
                  {carPrivateNotes && (
                    <div style={{padding:"8px 0 0"}}>
                      <div style={{fontSize:12,color:"#111",marginBottom:4}}>Other Notes</div>
                      <div style={{fontSize:13,color:"#111",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{carPrivateNotes}</div>
                    </div>
                  )}
                  {!(carPlate||carRegDate||carMileage||carPrivateNotes||carPrivatePhotos.length>0) && (
                    <div style={{fontSize:13,color:"#111",textAlign:"center",padding:"10px 0"}}>No private info added yet — add it from Edit Car.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      );
    }

    /* editcar sub — dedicated Edit Car tab: avatar (custom SVG or uploaded
       photo), color, name, model, mods. Reached only from My Garage's
       "Edit Car" button — this is the sole place the car can be named/edited. */
    if(subPanel==="editcar"){
      const editBannerBg = carBannerPhoto ? "url("+carBannerPhoto+") center/cover no-repeat" : (CAR_BANNERS.find(b=>b.id===carBannerPreset)||CAR_BANNERS[0]).css;
      return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows back/Save while this
            page is open (see <TopBar/>). */}
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"14px 16px 32px"}}>

          <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:4}}>Edit Car</div>
          {/* Avatar mode — custom SVG avatar or an uploaded photo of the real car */}
          <div style={SEC}>CAR AVATAR</div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            {[["avatar","🎨","Custom Avatar"],["photo","📷","Upload Photo"]].map(([id,ic,label])=>(
              <button key={id} onClick={()=>setCarAvatarMode(id)} style={{
                flex:1,padding:"10px 8px",borderRadius:12,cursor:"pointer",fontFamily:F,textAlign:"center",
                border:"1.5px solid "+(carAvatarMode===id?OR:"#ebebeb"),
                background:carAvatarMode===id?OR+"0f":"#f8f8f8",
              }}>
                <div style={{fontSize:20,marginBottom:2}}>{ic}</div>
                <div style={{fontSize:12,fontWeight:700,color:carAvatarMode===id?OR:"#111"}}>{label}</div>
              </button>
            ))}
          </div>

          {carAvatarMode==="avatar" ? (
            <div style={{...CARD,padding:0,overflow:"hidden",marginBottom:14}}>
              <div style={{background:editBannerBg,padding:"14px",display:"flex",alignItems:"center",justifyContent:"center"}}>
                <CarSVG color={carColor} mods={carMods} size={140} styleId={carBodyStyle}/>
              </div>
            </div>
          ) : (
            <div style={{...CARD,padding:0,overflow:"hidden",marginBottom:14,display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
              <div style={{width:"100%",background:editBannerBg,padding:"14px",display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
                <button onClick={()=>carAvatarPhotoRef.current?.click()} style={{width:280,height:280,maxWidth:"100%",borderRadius:28,overflow:"hidden",border:"1.5px dashed "+(carAvatarPhoto?"transparent":"rgba(255,255,255,0.6)"),background:carAvatarPhoto?"transparent":"rgba(255,255,255,0.15)",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {carAvatarPhoto ? <img src={carAvatarPhoto} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <span style={{fontSize:48,color:"#fff"}}>+</span>}
                </button>
                <input ref={carAvatarPhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;readImageCompressed(f,1024,0.85).then(url=>{if(url)setCarAvatarPhoto(url);});e.target.value="";}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>carAvatarPhotoRef.current?.click()} style={{padding:"7px 14px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>{carAvatarPhoto?"Replace Photo":"Upload Photo"}</button>
                  {carAvatarPhoto && <button onClick={()=>setCarAvatarPhoto(null)} style={{padding:"7px 14px",borderRadius:20,background:"rgba(255,255,255,0.9)",border:"none",color:"#ef4444",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>Remove</button>}
                </div>
              </div>
              {!carAvatarPhoto && <div style={{fontSize:11,color:"#111",textAlign:"center",padding:"8px 10px"}}>Uploaded photo appears wherever your car avatar shows up.</div>}
            </div>
          )}

          {/* Appearance editor — Banner / Body Style / Color / Brand / Mods all
              live behind one toggle instead of five stacked sections, so you
              can flip between them without scrolling away from the avatar
              preview above, which updates live as you change any of them. */}
          <div style={{display:"flex",gap:5,marginBottom:12,overflowX:"auto"}}>
            {[["banner","Banner"],["bodystyle","Body Style"],["color","Color"],["brand","Brand"],["mods","Mods"]].map(([id,label])=>(
              <button key={id} onClick={()=>setCarEditTab(id)} style={{
                flexShrink:0,padding:"7px 13px",borderRadius:20,cursor:"pointer",fontFamily:F,fontSize:13,fontWeight:700,
                border:"1.5px solid "+(carEditTab===id?OR:"#ebebeb"),
                background:carEditTab===id?OR+"0f":"#f8f8f8",
                color:carEditTab===id?OR:"#111",
              }}>{label}</button>
            ))}
          </div>

          {carEditTab==="banner" && (
            <div style={{...CARD,marginBottom:14}}>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1,marginBottom:8}}>SELECT A BANNER</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <button onClick={()=>carBannerPhotoRef.current?.click()} style={{
                  height:56,borderRadius:12,cursor:"pointer",position:"relative",overflow:"hidden",
                  border:carBannerPhoto?"2.5px solid "+OR:"1.5px dashed "+OR+"66",
                  background:carBannerPhoto?"url("+carBannerPhoto+") center/cover no-repeat":OR+"08",
                  display:"flex",alignItems:"center",justifyContent:"center",
                }}>
                  {!carBannerPhoto && <span style={{fontSize:12,fontWeight:700,color:OR,display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:16}}>📤</span>Upload Photo</span>}
                  {carBannerPhoto && <span style={{position:"absolute",bottom:4,left:6,fontSize:11,fontWeight:800,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.7)"}}>Your Photo</span>}
                  {carBannerPhoto && <span style={{position:"absolute",top:4,right:5,fontSize:12,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.7)"}}>✓</span>}
                </button>
                {CAR_BANNERS.map(b=>(
                  <button key={b.id} onClick={()=>{setCarBannerPreset(b.id);setCarBannerPhoto(null);}} style={{
                    height:56,borderRadius:12,border:(!carBannerPhoto&&carBannerPreset===b.id)?"2.5px solid "+OR:"1.5px solid #ebebeb",
                    background:b.css,cursor:"pointer",position:"relative",overflow:"hidden",
                  }}>
                    <span style={{position:"absolute",bottom:4,left:6,fontSize:11,fontWeight:800,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.7)"}}>{b.label}</span>
                    {(!carBannerPhoto&&carBannerPreset===b.id) && <span style={{position:"absolute",top:4,right:5,fontSize:12,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.7)"}}>✓</span>}
                  </button>
                ))}
              </div>
              <input ref={carBannerPhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;readImageCompressed(f,1440,0.82).then(url=>{if(url)setCarBannerPhoto(url);});e.target.value="";}}/>
              {carBannerPhoto && <button onClick={()=>setCarBannerPhoto(null)} style={{width:"100%",padding:"10px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#ef4444",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,marginTop:12}}>Remove Uploaded Photo</button>}
            </div>
          )}

          {carEditTab==="bodystyle" && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:14}}>
              {CAR_BODY_STYLES.map(s=>(
                <button key={s.id} onClick={()=>{setCarBodyStyle(s.id);setCarModel(s.label);setCarSaved(false);}} style={{
                  display:"flex",flexDirection:"column",alignItems:"center",padding:"6px 3px 5px",borderRadius:10,cursor:"pointer",fontFamily:F,
                  border:"1.5px solid "+(carBodyStyle===s.id?OR:"#ebebeb"),
                  background:carBodyStyle===s.id?OR+"0f":"#f8f8f8",
                }}>
                  <div style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                    <CarSVG color={carColor} mods={{}} size={46} styleId={s.id}/>
                  </div>
                  <div style={{fontSize:9.5,fontWeight:700,color:carBodyStyle===s.id?OR:"#111",marginTop:2,textAlign:"center",lineHeight:1.15}}>{s.label}</div>
                </button>
              ))}
            </div>
          )}

          {carEditTab==="color" && (
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
              {CAR_COLORS.map(c=><button key={c} onClick={()=>{setCarColor(c);setCarSaved(false);}} style={{width:28,height:28,borderRadius:"50%",background:c,border:"none",cursor:"pointer",outline:carColor===c?"3px solid "+OR:"none",outlineOffset:2}}/>)}
            </div>
          )}

          {carEditTab==="brand" && (
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
              <button onClick={()=>{setCarBrand(null);setCarSaved(false);}} style={TAG(carBrand===null)}>None</button>
              {CAR_BRANDS.map(b=>(
                <button key={b.id} onClick={()=>{setCarBrand(b.id);setCarSaved(false);}} style={{
                  padding:"6px 11px",borderRadius:20,cursor:"pointer",fontFamily:F,fontSize:13,fontWeight:800,
                  border:"1.5px solid "+(carBrand===b.id?b.color:"#ebebeb"),
                  background:carBrand===b.id?b.color+"1a":"#f8f8f8",
                  color:carBrand===b.id?b.color:"#111",
                }}>{b.name}</button>
              ))}
            </div>
          )}

          {carEditTab==="mods" && (
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1,marginBottom:6}}>MODS — {activeModCat}</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
                {Object.keys(CAR_MODS).map(c=><button key={c} onClick={()=>setActiveModCat(c)} style={{...TAG(activeModCat===c),flexShrink:0,fontSize:12,padding:"4px 9px"}}>{c}</button>)}
              </div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
                {(CAR_MODS[activeModCat]||[]).map(o=><button key={o} onClick={()=>{setCarMods(m=>({...m,[activeModCat]:o}));setCarSaved(false);}} style={TAG(carMods[activeModCat]===o)}>{o}</button>)}
              </div>
            </div>
          )}

          <div style={SEC}>NAME</div>
          <input value={carName} onChange={e=>{setCarName(e.target.value);setCarSaved(false);}} placeholder="Name your ride…" style={{...INP,marginBottom:14}}/>

          {/* Bio — free-text build/mod description, shown publicly on the car
              details page above Photos. Distinct from the private info below. */}
          <div style={SEC}>BIO</div>
          <textarea value={carBio} onChange={e=>{setCarBio(e.target.value);setCarSaved(false);}} placeholder="Describe the mods you've done, the build story, or anything else you want shown on your car's page…" rows={4} style={{...INP,resize:"none",marginBottom:14}}/>

          {/* Home avatar display — name/model text on the home hero is opt-in */}
          <div style={SEC}>HOME AVATAR WINDOW</div>
          <button onClick={()=>setCarShowInfoHome(v=>!v)} style={{...CARD,display:"flex",alignItems:"center",gap:12,cursor:"pointer",border:"1px solid #ebebeb",width:"100%",textAlign:"left",fontFamily:F}}>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Show name &amp; model</div>
              <div style={{fontSize:12,color:"#111",marginTop:2,lineHeight:1.5}}>Display your car's name and model as text under the avatar on the home page.</div>
            </div>
            <div style={{width:40,height:23,borderRadius:20,background:carShowInfoHome?OR:"#e0e0e0",position:"relative",flexShrink:0,transition:"background 0.15s"}}>
              <div style={{position:"absolute",top:2,left:carShowInfoHome?19:2,width:19,height:19,borderRadius:"50%",background:"#fff",boxShadow:"0 1px 3px rgba(0,0,0,0.3)",transition:"left 0.15s"}}/>
            </div>
          </button>

          {/* Private car info — plate, registration, mileage, and any other
              handy details. Never shown publicly; kept strictly for the
              owner's own quick reference on their phone. Tinted (instead of
              the plain white every other card on this page uses) so it's
              obvious at a glance that this section is handled differently. */}
          <div style={SEC}>PRIVATE CAR INFO</div>
          <div style={{...CARD,background:"#fdf8ec",border:"1px solid #eeddb0",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,color:"#111"}}>
              <span style={{fontSize:14}}>🔒</span>
              <span style={{fontSize:12,fontWeight:700,color:"#111"}}>Only visible to you — never shown on your car's page or profile.</span>
            </div>
            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:0.5,marginBottom:4}}>LICENSE PLATE</div>
            <input value={carPlate} onChange={e=>{setCarPlate(e.target.value);setCarSaved(false);}} placeholder="e.g. 8ABC123" style={{...INP,marginBottom:12}}/>
            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:0.5,marginBottom:4}}>REGISTRATION DATE</div>
            <input type="date" value={carRegDate} onChange={e=>{setCarRegDate(e.target.value);setCarSaved(false);}} style={{...INP,marginBottom:12}}/>
            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:0.5,marginBottom:4}}>CURRENT MILEAGE</div>
            <input type="number" inputMode="numeric" value={carMileage} onChange={e=>{setCarMileage(e.target.value);setCarSaved(false);}} placeholder="e.g. 42500" style={{...INP,marginBottom:12}}/>
            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:0.5,marginBottom:4}}>OTHER NOTES</div>
            <textarea value={carPrivateNotes} onChange={e=>{setCarPrivateNotes(e.target.value);setCarSaved(false);}} placeholder="VIN, insurance info, service reminders, anything else handy to have on hand…" rows={3} style={{...INP,resize:"none",marginBottom:12}}/>
            {/* Snapshots of things like your insurance card or registration —
                tapping + brings up your device's normal choice between taking
                a new photo with the camera or picking an existing one. */}
            <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:0.5,marginBottom:4}}>PHOTOS — INSURANCE CARD, ETC.</div>
            {PhotoGallery(carPrivatePhotos, setCarPrivatePhotos, carPrivatePhotoRef, 6)}
          </div>
        </div>
      </div>
    );}

    /* dashcam sub */
    if(subPanel==="history") {
      const fmt2 = s => {
        const m=Math.floor(s/60), sec=s%60;
        return m>0 ? m+"m "+sec+"s" : sec+"s";
      };
      // Simulated path colors for variety
      const PATH_COLORS = ["#f97316","#6366f1","#22c55e","#a855f7","#ef4444","#14b8a6","#f59e0b","#ec4899"];

      // Calendar — merged in from the old Dashcam tab: marks any date with
      // either a logged trip or recorded footage (current month only).
      // Tapping a date with exactly one trip jumps straight into that trip's
      // detail view (nav/stops + any footage); a date with several trips (or
      // footage but no trip) expands a short list below the calendar instead.
      const tripByDate = {};
      tripHistory.forEach(t=>{ (tripByDate[t.date]=tripByDate[t.date]||[]).push(t); });
      const clipByDate = {};
      clips.forEach(c=>{ (clipByDate[c.date]=clipByDate[c.date]||[]).push(c); });
      const calToday=new Date();
      const calDim=new Date(calToday.getFullYear(),calToday.getMonth()+1,0).getDate();
      const calFd=new Date(calToday.getFullYear(),calToday.getMonth(),1).getDay();
      const calMl=calToday.toLocaleDateString("en-US",{month:"long",year:"numeric"});
      const calDk=d=>new Date(calToday.getFullYear(),calToday.getMonth(),d).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
      const onCalDateTap = (key) => {
        const dayTrips = tripByDate[key]||[];
        if(dayTrips.length===1){ setSelTrip({...dayTrips[0], path:undefined}); return; }
        setSelCalDate(prev => prev===key ? null : key);
      };

      historySection = (
        <div>
          {/* Header */}
          <div style={{padding:"0 14px 10px",display:"flex",alignItems:"center",gap:10}}>
            <div style={{flex:1,fontSize:16,fontWeight:800,color:"#111"}}>🛤️ Drive History</div>
            <div style={{fontSize:13,fontWeight:700,color:OR}}>{tripHistory.length} trip{tripHistory.length!==1?"s":""}</div>
          </div>

          {selTrip ? (
            /* ── Trip detail view ── */
            <div>
              {/* Map with simulated route highlight */}
              <div style={{position:"relative",height:220,flexShrink:0,background:"#e5e3df",overflow:"hidden"}}>
                <iframe
                  title="Trip Map"
                  style={{width:"100%",height:"100%",border:"none",display:"block"}}
                  src={"https://maps.google.com/maps?q="+encodeURIComponent(selTrip.startAddr||"San Diego, CA")+"&z=13&output=embed"}
                  loading="lazy"
                />
                {/* Route highlight overlay — SVG polyline simulating a trip path */}
                <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}} viewBox="0 0 400 300" preserveAspectRatio="none">
                  <defs>
                    <filter id="glow">
                      <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                      <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                  </defs>
                  {/* Simulated trip path — a curved route across the map */}
                  <polyline
                    points={selTrip.path || "60,240 90,200 130,170 160,140 200,120 240,100 280,90 320,85 350,80"}
                    fill="none"
                    stroke={PATH_COLORS[selTrip.id%PATH_COLORS.length]}
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    filter="url(#glow)"
                    opacity="0.85"
                  />
                  {/* Start dot */}
                  <circle cx={60} cy={240} r={7} fill="#22c55e" stroke="#fff" strokeWidth="2"/>
                  {/* End dot */}
                  <circle cx={350} cy={80} r={7} fill="#ef4444" stroke="#fff" strokeWidth="2"/>
                </svg>
                {/* Legend */}
                <div style={{position:"absolute",top:10,left:10,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"3px 8px"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#22c55e"}}/>
                    <span style={{fontSize:10,color:"#fff",fontWeight:700}}>Start</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:5,background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"3px 8px"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#ef4444"}}/>
                    <span style={{fontSize:10,color:"#fff",fontWeight:700}}>End</span>
                  </div>
                </div>
                {/* Back from detail */}
                <button onClick={()=>setSelTrip(null)} style={{position:"absolute",top:10,right:10,padding:"5px 10px",borderRadius:20,background:"rgba(0,0,0,0.6)",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>← All Trips</button>
              </div>

              {/* Trip stats */}
              <div style={{padding:"14px 16px",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
                <div style={{fontSize:17,fontWeight:900,color:"#111",marginBottom:2}}>{selTrip.date} · {selTrip.time}</div>
                <div style={{fontSize:13,color:"#111",marginBottom:12}}>{selTrip.startAddr} → {selTrip.endAddr}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[
                    {ic:"🛣️", val:selTrip.dist+" mi", label:"Distance"},
                    {ic:"⏱️", val:fmt2(selTrip.dur||0), label:"Duration"},
                    {ic:"⭐", val:"+"+selTrip.pts+" pts", label:"Earned"},
                    ...(selTrip.avgSpeed!=null ? [{ic:"⚡", val:selTrip.avgSpeed+" mph", label:"Avg Speed"}] : []),
                    ...(selTrip.maxSpeed!=null ? [{ic:"🚀", val:selTrip.maxSpeed+" mph", label:"Top Speed"}] : []),
                    ...(selTrip.lights!=null ? [{ic:"🚦", val:selTrip.lights, label:"Green Lights"}] : []),
                  ].map(s=>(
                    <div key={s.label} style={{background:"#f8f8f8",borderRadius:12,padding:"10px",textAlign:"center",border:"1px solid #ebebeb"}}>
                      <div style={{fontSize:20,marginBottom:3}}>{s.ic}</div>
                      <div style={{fontSize:15,fontWeight:800,color:"#111"}}>{s.val}</div>
                      <div style={{fontSize:10,color:"#111",marginTop:2}}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Linked clip if any */}
              {clips.find(c=>c.date===selTrip.date) && (
                <div style={{padding:"12px 16px",flexShrink:0}}>
                  <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>DASHCAM FOOTAGE</div>
                  {clips.filter(c=>c.date===selTrip.date).slice(0,2).map(clip=>(
                    <div key={clip.id} style={{background:"#111",borderRadius:10,overflow:"hidden",marginBottom:8}}>
                      <video src={clip.url} controls style={{width:"100%",display:"block",maxHeight:160,background:"#000"}}/>
                      <div style={{padding:"6px 10px",display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:11,color:"#aaa",flex:1}}>{clip.time} · {clip.dist} mi</span>
                        <button onClick={()=>{const a=document.createElement("a");a.href=clip.url;a.download="drive_"+clip.id+(clip.ext||".webm");a.click();}} style={{padding:"4px 8px",borderRadius:20,background:"#222",color:"#aaa",border:"none",fontSize:11,cursor:"pointer"}}>⬇</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* ── Calendar + trip list ── */
            <div style={{padding:"10px 14px 7px"}}>
              {/* Calendar */}
              <div style={{fontSize:10,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>{calMl.toUpperCase()}</div>
              <div style={{background:"#f8f8f8",borderRadius:12,border:"1px solid #ebebeb",marginBottom:14}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:"#f0f0f0",borderBottom:"1px solid #ebebeb",borderRadius:"12px 12px 0 0"}}>
                  {["S","M","T","W","T","F","S"].map((d,i)=><div key={i} style={{padding:"6px 0",textAlign:"center",fontSize:11,fontWeight:700,color:"#111"}}>{d}</div>)}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>
                  {Array.from({length:calFd}).map((_,i)=><div key={"e"+i} style={{minHeight:36}}/>)}
                  {Array.from({length:calDim}).map((_,i)=>{
                    const day=i+1, key=calDk(day);
                    const dayTrips=tripByDate[key]||[], dayClips=clipByDate[key]||[];
                    const isT=day===calToday.getDate(), isSel=selCalDate===key;
                    return (
                      <button key={day} onClick={()=>onCalDateTap(key)}
                        style={{minHeight:36,padding:"4px 2px",background:isSel?OR:isT?OR+"11":"transparent",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                        <span style={{fontSize:13,fontWeight:isT||isSel?800:400,color:isSel?"#fff":isT?OR:"#333"}}>{day}</span>
                        {(dayTrips.length>0||dayClips.length>0) && (
                          <div style={{display:"flex",gap:2,marginTop:1}}>
                            {dayTrips.length>0 && <span style={{width:4,height:4,borderRadius:"50%",background:isSel?"#fff":OR,display:"block"}}/>}
                            {dayClips.length>0 && <span style={{width:4,height:4,borderRadius:"50%",background:isSel?"#fff":"#6366f1",display:"block"}}/>}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Selected date — multiple trips to choose from, or footage
                  with no logged trip that day */}
              {selCalDate && (() => {
                const dayTrips = tripByDate[selCalDate]||[];
                const dayClips = clipByDate[selCalDate]||[];
                if(dayTrips.length===0 && dayClips.length===0) return (
                  <div style={{textAlign:"center",padding:"16px",color:"#111",fontSize:13}}>No activity on {selCalDate}</div>
                );
                return (
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1,marginBottom:8}}>{selCalDate}</div>
                    {/* Each trip gets the same mini route-map card as the
                        main list below — a picture of the road taken, not
                        just a text row — so browsing by calendar date shows
                        the same map + distance + footage history. */}
                    {dayTrips.map(trip=>{
                      const color=PATH_COLORS[trip.id%PATH_COLORS.length];
                      const hasClip=clips.some(c=>c.date===trip.date);
                      return (
                        <button key={trip.id} onClick={()=>setSelTrip({...trip,path:undefined})} style={{
                          width:"100%",background:"#fff",borderRadius:14,border:"1px solid #ebebeb",
                          marginBottom:8,overflow:"hidden",cursor:"pointer",fontFamily:F,textAlign:"left",
                          boxShadow:"0 2px 8px rgba(0,0,0,0.05)",padding:0,
                        }}>
                          <div style={{height:90,position:"relative",background:"#e5e3df",overflow:"hidden"}}>
                            <iframe
                              title={"calmap"+trip.id}
                              style={{width:"100%",height:"180px",border:"none",display:"block",marginTop:"-45px",pointerEvents:"none"}}
                              src={"https://maps.google.com/maps?q="+encodeURIComponent(trip.startAddr||"San Diego, CA")+"&z=12&output=embed"}
                              loading="lazy"
                            />
                            <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}} viewBox="0 0 300 100" preserveAspectRatio="none">
                              <polyline points="20,80 50,65 85,52 120,42 160,35 200,30 240,28 270,25" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity="0.9"/>
                              <circle cx={20} cy={80} r={5} fill="#22c55e" stroke="#fff" strokeWidth="1.5"/>
                              <circle cx={270} cy={25} r={5} fill="#ef4444" stroke="#fff" strokeWidth="1.5"/>
                            </svg>
                            {hasClip && <div style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"2px 8px",fontSize:10,color:"#fff"}}>📹</div>}
                          </div>
                          <div style={{padding:"9px 12px",display:"flex",alignItems:"center",gap:10}}>
                            <div style={{width:7,height:26,borderRadius:4,background:color,flexShrink:0}}/>
                            <div style={{flex:1}}>
                              <div style={{fontSize:13,fontWeight:700,color:"#111"}}>{trip.time} · {trip.startAddr}</div>
                              <div style={{fontSize:11,color:"#111"}}>{trip.dist} mi · +{trip.pts} pts{hasClip?" · 📹 footage":""}</div>
                            </div>
                            <div style={{fontSize:16,color:"#111"}}>›</div>
                          </div>
                        </button>
                      );
                    })}
                    {dayTrips.length===0 && dayClips.map(clip=>(
                      <div key={clip.id} style={{background:"#fff",borderRadius:10,border:"1px solid #ebebeb",marginBottom:10,overflow:"hidden"}}>
                        <div style={{background:"#111",position:"relative",cursor:"pointer",height:80}} onClick={()=>setPlayingClip(p=>p===clip.id?null:clip.id)}>
                          <video src={clip.url} muted style={{width:"100%",height:"100%",objectFit:"cover",opacity:0.55,display:"block",pointerEvents:"none"}}/>
                          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                            <div style={{width:34,height:34,borderRadius:"50%",background:"rgba(255,255,255,0.15)",border:"2px solid rgba(255,255,255,0.5)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>
                              {playingClip===clip.id?"⏸":"▶"}
                            </div>
                          </div>
                        </div>
                        {playingClip===clip.id && <video src={clip.url} controls autoPlay style={{width:"100%",maxHeight:200,display:"block",background:"#000"}}/>}
                        <div style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:8}}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:13,fontWeight:700,color:"#111"}}>{clip.time}</div>
                            <div style={{fontSize:11,color:"#111"}}>{clip.dist} mi · {clip.sizeMB} MB</div>
                          </div>
                          <button onClick={()=>{const a=document.createElement("a");a.href=clip.url;a.download="drive_"+clip.id+(clip.ext||".webm");a.click();}} style={{padding:"5px 9px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",fontSize:12,cursor:"pointer"}}>⬇</button>
                          <button onClick={()=>{URL.revokeObjectURL(clip.url);clipsDB.remove(clip.id);setClips(p=>p.filter(c=>c.id!==clip.id));if(playingClip===clip.id)setPlayingClip(null);}} style={{padding:"5px 9px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#ef4444",fontSize:12,cursor:"pointer"}}>🗑</button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Dashcam enable prompt — the actual "Record in Background"
                  auto-record toggle now lives in Drive Mode Settings (the ⚙️
                  inside Drive mode), not here, so it's reachable without
                  leaving Drive mode. */}
              {!dashcamConsent ? (
                <div style={{background:"#fff8f0",border:"1px solid #fde8d8",borderRadius:12,padding:"14px",marginBottom:16,textAlign:"center"}}>
                  <div style={{fontSize:28,marginBottom:6}}>📹</div>
                  <div style={{fontSize:13,fontWeight:800,color:"#111",marginBottom:4}}>Enable Dashcam</div>
                  <div style={{fontSize:12,color:"#111",lineHeight:1.6,marginBottom:12}}>Automatically record video of your drives once you're moving over 5 mph. Footage stays on this device and is only viewable here.</div>
                  <button onClick={()=>{setDashcamConsent(true);memStore.setItem("sl_dashcamConsent","1");}} style={{width:"100%",padding:"11px",borderRadius:11,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>
                    I Agree — Enable Dashcam
                  </button>
                </div>
              ) : (
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:12,background:"#f8f8f8",border:"1px solid #ebebeb",marginBottom:16}}>
                  <div style={{fontSize:12,color:"#111",lineHeight:1.6}}>The camera preview and auto-record settings for Dashcam now live in <b>Drive Mode Settings</b> (tap ⚙️ inside Drive mode).</div>
                </div>
              )}

              {tripHistory.length===0 ? (
                <div style={{textAlign:"center",padding:"52px 20px",color:"#111"}}>
                  <div style={{fontSize:50,marginBottom:12}}>🛤️</div>
                  <div style={{fontSize:16,fontWeight:700,color:"#111",marginBottom:6}}>No trips yet</div>
                  <div style={{fontSize:13,lineHeight:1.7,marginBottom:20}}>Drives record automatically once you're moving over 5 mph — open the map and every trip will appear here with speed, duration, and route.</div>
                  <button onClick={()=>go("drive")} style={{padding:"10px 22px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F,display:"inline-flex",alignItems:"center",gap:7}}><DPadIcon id="map" color="#fff" size={14}/> Open Map</button>
                </div>
              ) : (
                <>
                  {/* Summary stats strip */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                    {[
                      {ic:"🛣️", val:(tripHistory.reduce((a,t)=>a+parseFloat(t.dist||0),0)).toFixed(1)+" mi", label:"Total Miles"},
                      {ic:"⏱️", val:Math.floor(tripHistory.reduce((a,t)=>a+(t.dur||0),0)/60)+"m", label:"Drive Time"},
                      {ic:"⭐", val:tripHistory.reduce((a,t)=>a+(t.pts||0),0)+" pts", label:"Pts Earned"},
                      ...(tripHistory.some(t=>t.avgSpeed!=null) ? [{ic:"⚡", val:Math.round(tripHistory.filter(t=>t.avgSpeed!=null).reduce((a,t)=>a+t.avgSpeed,0)/tripHistory.filter(t=>t.avgSpeed!=null).length)+" mph", label:"Avg Speed"}] : []),
                      ...(tripHistory.some(t=>t.lights!=null) ? [{ic:"🚦", val:tripHistory.reduce((a,t)=>a+(t.lights||0),0), label:"Green Lights"}] : []),
                    ].map(s=>(
                      <div key={s.label} style={{background:"#f8f8f8",borderRadius:12,padding:"10px 8px",textAlign:"center",border:"1px solid #ebebeb"}}>
                        <div style={{fontSize:18,marginBottom:2}}>{s.ic}</div>
                        <div style={{fontSize:14,fontWeight:800,color:"#111"}}>{s.val}</div>
                        <div style={{fontSize:9,color:"#111",marginTop:1}}>{s.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Trip cards */}
                  {tripHistory.map((trip,idx)=>{
                    const color=PATH_COLORS[idx%PATH_COLORS.length];
                    const hasClip=clips.some(c=>c.date===trip.date);
                    return (
                      <button key={trip.id} onClick={()=>setSelTrip({...trip,path:undefined})} style={{
                        width:"100%",background:"#fff",borderRadius:14,border:"1px solid #ebebeb",
                        marginBottom:10,overflow:"hidden",cursor:"pointer",fontFamily:F,textAlign:"left",
                        boxShadow:"0 2px 8px rgba(0,0,0,0.05)",padding:0,
                      }}>
                        {/* Mini map with SVG route */}
                        <div style={{height:100,position:"relative",background:"#e5e3df",overflow:"hidden"}}>
                          <iframe
                            title={"map"+trip.id}
                            style={{width:"100%",height:"200px",border:"none",display:"block",marginTop:"-50px",pointerEvents:"none"}}
                            src={"https://maps.google.com/maps?q="+encodeURIComponent(trip.startAddr||"San Diego, CA")+"&z=12&output=embed"}
                            loading="lazy"
                          />
                          {/* Highlighted route SVG overlay */}
                          <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}} viewBox="0 0 300 100" preserveAspectRatio="none">
                            <defs>
                              <filter id={"g"+idx}>
                                <feGaussianBlur stdDeviation="2" result="b"/>
                                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                              </filter>
                            </defs>
                            <polyline
                              points={"20,80 50,65 85,52 120,42 160,35 200,30 240,28 270,25"}
                              fill="none" stroke={color} strokeWidth="4"
                              strokeLinecap="round" strokeLinejoin="round"
                              filter={"url(#g"+idx+")"} opacity="0.9"
                            />
                            <circle cx={20} cy={80} r={5} fill="#22c55e" stroke="#fff" strokeWidth="1.5"/>
                            <circle cx={270} cy={25} r={5} fill="#ef4444" stroke="#fff" strokeWidth="1.5"/>
                          </svg>
                          {/* Date badge */}
                          <div style={{position:"absolute",top:8,left:8,background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"2px 8px",fontSize:10,color:"#fff",fontWeight:700}}>{trip.date}</div>
                          {hasClip && <div style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"2px 8px",fontSize:10,color:"#111"}}>📹</div>}
                        </div>
                        {/* Trip info */}
                        <div style={{padding:"10px 12px",display:"flex",alignItems:"center",gap:10}}>
                          <div style={{width:8,height:28,borderRadius:4,background:color,flexShrink:0}}/>
                          <div style={{flex:1}}>
                            <div style={{fontSize:14,fontWeight:800,color:"#111",marginBottom:2}}>{trip.time} · {trip.startAddr}</div>
                            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                              <span style={{fontSize:11,color:"#111"}}>🛣️ {trip.dist} mi</span>
                              <span style={{fontSize:11,color:"#111"}}>⏱ {fmt2(trip.dur||0)}</span>
                              {trip.avgSpeed!=null && <span style={{fontSize:11,color:"#111"}}>⚡ {trip.avgSpeed} mph</span>}
                              <span style={{fontSize:11,color:OR}}>+{trip.pts} pts</span>
                            </div>
                          </div>
                          <div style={{fontSize:16,color:"#111"}}>›</div>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}

              {dashcamConsent && (
                <button onClick={()=>{setDashcamConsent(false);memStore.removeItem("sl_dashcamConsent");if(dashOn)stopDrive();}} style={{width:"100%",marginTop:6,padding:"10px",borderRadius:10,background:"transparent",border:"1px solid #fde8d8",color:"#ef4444",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>
                  Revoke Dashcam Access
                </button>
              )}
            </div>
          )}
        </div>
      );
    }

    /* following sub — people you follow */
    if(subPanel==="following") return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows back + "Following"
            while this page is open (see <TopBar/>). */}
        <div style={{padding:"10px 14px 0",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <ProfileIcon id="people" size={14} color="#111"/>
          <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1}}>Following</div>
          <div style={{fontSize:12,color:"#111"}}>{following.length}</div>
        </div>
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"12px 14px 24px"}}>
          {following.length===0 && (
            <div style={{textAlign:"center",color:"#111",fontSize:13,paddingTop:40}}>
              <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><ProfileIcon id="people" size={34} color="#ddd"/></div>
              Not following anyone yet.<br/>Follow people from Friends or Followers to see them here.
            </div>
          )}
          {following.map(person=>(
            <button key={person.id} onClick={()=>setQuickUser(person)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"11px 8px",borderRadius:12,border:"none",background:"none",cursor:"pointer",textAlign:"left",fontFamily:F}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:person.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:"#fff",flexShrink:0}}>{person.initials}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:15,fontWeight:700,color:"#111"}}>{person.name}</div>
                <div style={{fontSize:12,color:"#111"}}>@{person.handle}</div>
              </div>
              <span onClick={e=>{e.stopPropagation();setFollowing(f=>f.filter(x=>x.id!==person.id));}} style={{padding:"5px 10px",borderRadius:20,fontSize:12,fontWeight:700,fontFamily:F,background:"#5865f2",color:"#fff"}}>✓ Following</span>
            </button>
          ))}
        </div>
        <QuickUserSheet/>
        <ProfileViewSheet/>
      </div>
    );

    /* radio stations sub — saved (favorited) stations and stations you've
       created via Register as Radio Host in the CB Radio/Music sheet. */
    if(subPanel==="radiostations") {
      radiostationsSection = renderRadioStationsSection();
    }

    /* followers sub — people following you */
    if(subPanel==="followerslist") return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows back + "Followers"
            while this page is open (see <TopBar/>). */}
        <div style={{padding:"10px 14px 0",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <ProfileIcon id="people" size={14} color="#111"/>
          <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1}}>Followers</div>
          <div style={{fontSize:12,color:"#111"}}>{followersList.length}</div>
        </div>
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"12px 14px 24px"}}>
          {followersList.length===0 && (
            <div style={{textAlign:"center",color:"#111",fontSize:13,paddingTop:40}}>
              <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><ProfileIcon id="people" size={34} color="#ddd"/></div>
              No followers yet.
            </div>
          )}
          {followersList.map(person=>{
            const isF = following.some(f=>f.id===person.id);
            return (
              <button key={person.id} onClick={()=>setQuickUser(person)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"11px 8px",borderRadius:12,border:"none",background:"none",cursor:"pointer",textAlign:"left",fontFamily:F}}>
                <div style={{width:42,height:42,borderRadius:"50%",background:person.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:"#fff",flexShrink:0}}>{person.initials}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:15,fontWeight:700,color:"#111"}}>{person.name}</div>
                  <div style={{fontSize:12,color:"#111"}}>@{person.handle}</div>
                </div>
                <span onClick={e=>{
                  e.stopPropagation();
                  if(isF){setFollowing(f=>f.filter(x=>x.id!==person.id));}
                  else{setFollowing(f=>[...f,person]);setNotifications(n=>[{id:Date.now(),icon:"✨",text:"Now following "+person.name+"! Their events and routes appear in your feeds.",ts:"now",read:false},...n]);}
                }} style={{padding:"5px 10px",borderRadius:20,fontSize:12,fontWeight:700,fontFamily:F,background:isF?"#f3f3f3":OR,color:isF?"#555":"#fff"}}>
                  {isF?"✓ Following":"Follow back"}
                </span>
              </button>
            );
          })}
        </div>
        <QuickUserSheet/>
        <ProfileViewSheet/>
      </div>
    );

    /* friends sub */
    /* top3friend sub — special Top 3 Friend page: walkie-talkie mode with a
       combined text/voice chat box, live location sharing, and a window
       onto their car avatar. Opened by tapping a filled Top 3 slot. */
    if(subPanel==="top3friend" && selFriend) {
      const fr = selFriend;
      const locOn = locationSharing.includes(fr.id);
      const msgs = friendMsgs[fr.id] || [];
      const firstName = fr.name.split(" ")[0];
      return (
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"#14161c"}}>
          {/* Own header removed — the shared TopBar (dark, to match this
              page) shows the back button while this page is open. Name and
              avatar now live in the content below instead. */}
          <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"14px 14px 10px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <FriendAvatar fr={fr} size={38} fontSize={14}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:16,fontWeight:800,color:"#fff",display:"flex",alignItems:"center",gap:6}}>{fr.name} <span style={{fontSize:10,fontWeight:800,color:OR}}>⭐ TOP 3</span></div>
                <div style={{fontSize:12,color:"#8a8f98"}}>@{fr.handle}</div>
              </div>
            </div>
            {/* Car avatar window */}
            <div style={{background:"#1c1f27",borderRadius:16,border:"1px solid #262933",padding:"16px",marginBottom:14,display:"flex",flexDirection:"column",alignItems:"center"}}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:1.2,color:"#8a8f98",alignSelf:"flex-start",marginBottom:8}}>🚗 {firstName.toUpperCase()}'S CAR</div>
              <CarSVG color={fr.color} mods={{}} size={120} styleId={friendCarStyle(fr)}/>
            </div>

            {/* Share Live Location — the Top 3 Friend perk */}
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:14,background:"#1c1f27",border:"1px solid #262933",marginBottom:14}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>📍 Share Live Location</div>
                <div style={{fontSize:11,color:"#8a8f98",marginTop:2}}>{locOn?"On — stays on until you turn it off.":"Off"}</div>
              </div>
              <button onClick={()=>{
                toggleLocationSharing(fr.id);
                setNotifications(n=>[{id:Date.now(),icon:"📍",text:(locOn?"Stopped":"Started")+" sharing your live location with "+fr.name+".",ts:"now",read:false},...n]);
              }} style={{width:42,height:24,borderRadius:14,border:"none",cursor:"pointer",position:"relative",background:locOn?"#22c55e":"#3a3d45",flexShrink:0}}>
                <div style={{position:"absolute",top:2,left:locOn?20:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .15s"}}/>
              </button>
            </div>

            {/* Combined walkie-talkie + text thread */}
            <div style={{fontSize:10,fontWeight:700,letterSpacing:1.2,color:"#8a8f98",marginBottom:8}}>WALKIE-TALKIE &amp; CHAT</div>
            {msgs.length===0 && (
              <div style={{textAlign:"center",color:"#6b6f78",fontSize:13,padding:"30px 10px"}}>No messages yet — send a text below, or hold the mic to walkie-talkie {firstName}.</div>
            )}
            {msgs.map(m=>(
              <div key={m.id} style={{display:"flex",justifyContent:m.mine?"flex-end":"flex-start",marginBottom:8}}>
                <div style={{maxWidth:"75%",background:m.mine?OR:"#262933",color:"#fff",borderRadius:14,padding:"8px 12px"}}>
                  {m.isVoice ? (
                    <button onClick={()=>toggleTop3Voice(m)} style={{display:"flex",alignItems:"center",gap:8,background:"none",border:"none",color:"#fff",cursor:"pointer",fontFamily:F,padding:0}}>
                      <span style={{fontSize:16}}>{top3PlayingId===m.id?"⏸":"▶"}</span>
                      <span style={{fontSize:12}}>🎙️ Voice · {m.voiceSeconds}s</span>
                    </button>
                  ) : (
                    <div style={{fontSize:14}}>{m.text}</div>
                  )}
                  <div style={{fontSize:9,opacity:0.7,marginTop:3,textAlign:"right"}}>{m.ts}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Bottom bar — text chat box, or the walkie mic when the box is empty */}
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 12px",borderTop:"1px solid #262933",flexShrink:0,background:"#14161c"}}>
            <input value={top3ChatText} onChange={e=>setTop3ChatText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")sendTop3Text(fr);}} placeholder="Message…" style={{flex:1,padding:"10px 14px",borderRadius:20,border:"1px solid #2c2f38",background:"#1c1f27",color:"#fff",fontSize:14,fontFamily:F,outline:"none"}}/>
            {top3ChatText.trim() ? (
              <button onClick={()=>sendTop3Text(fr)} title="Send" style={{width:40,height:40,borderRadius:"50%",background:OR,border:"none",color:"#fff",fontSize:16,cursor:"pointer",flexShrink:0}}>➤</button>
            ) : (
              <button onClick={()=>setWalkieTarget(fr)} title="Walkie-talkie" style={{width:40,height:40,borderRadius:"50%",background:"#22c55e",border:"none",color:"#fff",fontSize:17,cursor:"pointer",flexShrink:0}}>🎙️</button>
            )}
          </div>
          <WalkieTalkieSheet/>
        </div>
      );
    }

    if(subPanel==="friends") return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows back/+ Add while
            this page is open (see <TopBar/>). */}
        <div style={{padding:"10px 14px 0",fontSize:16,fontWeight:800,color:"#111",flexShrink:0}}>👥 Friends</div>
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"16px 14px 24px"}}>
          <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:14}}>TOP 3 FRIENDS</div>
          <div style={{display:"flex",gap:12,justifyContent:"center",marginBottom:24}}>
            {[0,1,2].map(i=>{
              const fr=friends[i];
              return (
                <div key={i} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                  <button onClick={()=>fr?setSelFriend(selFriend?.id===fr.id?null:fr):setShowAddFriend(true)}
                    style={{width:72,height:72,borderRadius:"50%",background:fr?.photo?"transparent":(fr?fr.color:"#f3f3f3"),border:fr?(selFriend?.id===fr.id?"3px solid "+OR:"2px solid "+fr.color+"44"):"2px dashed #ddd",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:fr?26:28,color:fr?"#fff":"#ccc",fontWeight:800,fontFamily:F,overflow:"hidden",padding:0}}>
                    {fr?.photo ? <img src={fr.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : (fr?fr.initials:"＋")}
                  </button>
                  <div style={{fontSize:12,fontWeight:fr?700:400,color:fr?"#111":"#bbb"}}>{fr?fr.name:"Open slot"}</div>
                </div>
              );
            })}
          </div>
          {selFriend && (() => {
            const isTop3 = friends.slice(0,3).some(f=>f.id===selFriend.id);
            const locOn = locationSharing.includes(selFriend.id);
            return (
              <div style={{...CARD,border:"1.5px solid "+OR+"33",marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                  <button onClick={()=>setViewedProfile(selFriend)} style={{display:"flex",alignItems:"center",gap:12,flex:1,minWidth:0,background:"none",border:"none",cursor:"pointer",fontFamily:F,textAlign:"left",padding:0}}>
                    <div style={{width:44,height:44,borderRadius:"50%",background:selFriend.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:800,color:"#fff",flexShrink:0}}>{selFriend.initials}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:16,fontWeight:800,color:"#111"}}>{selFriend.name}</div>
                      <div style={{fontSize:12,color:"#111"}}>@{selFriend.handle}</div>
                    </div>
                  </button>
                  <button onClick={()=>{if(window.confirm("Remove "+selFriend.name+"?")){removeFriendSupabase(selFriend.id);setFriends(f=>f.filter(x=>x.id!==selFriend.id));setSelFriend(null);}}} style={{padding:"5px 8px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#ef4444",fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>✕</button>
                </div>
                {/* Special connections — quick walkie-talkie voice message,
                    text, and a follow toggle */}
                <div style={{display:"flex",gap:8,marginBottom:isTop3?12:0}}>
                  <button onClick={()=>setWalkieTarget(selFriend)} style={{flex:1,padding:"10px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,fontSize:13,fontWeight:800,background:"#22c55e11",color:"#22c55e"}}>🎙️ Walkie</button>
                  <button onClick={()=>{setActiveChan(selFriend.id);go("create",{lanesRoom:true});}} style={{flex:1,padding:"10px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,fontSize:13,fontWeight:800,background:"#5865f211",color:"#5865f2"}}>💬 Text</button>
                  <button onClick={()=>{
                    const isF=following.some(f=>f.id===selFriend.id);
                    if(isF){setFollowing(f=>f.filter(x=>x.id!==selFriend.id));}
                    else{setFollowing(f=>[...f,selFriend]);setNotifications(n=>[{id:Date.now(),icon:"✨",text:"Now following "+selFriend.name+"! Their events and routes appear in your feeds.",ts:"now",read:false},...n]);}
                  }} style={{flex:1,padding:"10px",borderRadius:10,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F,border:"none",background:following.some(f=>f.id===selFriend.id)?"#5865f2":"#f3f3f3",color:following.some(f=>f.id===selFriend.id)?"#fff":"#555"}}>
                    {following.some(f=>f.id===selFriend.id)?"✓ Following":"+ Follow"}
                  </button>
                </div>
                {/* Top 3 Friend perk — live location sharing */}
                {isTop3 && (
                  <div style={{borderTop:"1px solid #f5f5f5",paddingTop:12}}>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:1,color:"#8a8f98",marginBottom:8}}>⭐ TOP 3 FRIEND PERKS</div>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div>
                        <div style={{fontSize:13,fontWeight:700,color:"#111"}}>📍 Share Live Location</div>
                        <div style={{fontSize:11,color:"#8a8f98"}}>{locOn?"On — stays on until you turn it off.":"Off"}</div>
                      </div>
                      <button onClick={()=>{
                        toggleLocationSharing(selFriend.id);
                        setNotifications(n=>[{id:Date.now(),icon:"📍",text:(locOn?"Stopped":"Started")+" sharing your live location with "+selFriend.name+".",ts:"now",read:false},...n]);
                      }} style={{width:42,height:24,borderRadius:14,border:"none",cursor:"pointer",position:"relative",background:locOn?"#22c55e":"#e2e2e2",flexShrink:0}}>
                        <div style={{position:"absolute",top:2,left:locOn?20:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .15s"}}/>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {friends.length>0 && (
            <input value={friendSearch} onChange={e=>setFriendSearch(e.target.value)} placeholder="🔍 Search your friends by name" style={{...INP,marginBottom:14}}/>
          )}
          {friends.length===0 && <div style={{textAlign:"center",color:"#111",fontSize:13,paddingTop:8}}>Add friends to share drives.</div>}
          {friends.length>0 && (() => {
            const q=friendSearch.trim().toLowerCase();
            const list = q ? friends.filter(f=>f.name.toLowerCase().includes(q)) : friends;
            return (
              <>
                <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>{q?"RESULTS":"ALL FRIENDS"} ({list.length})</div>
                {list.length===0 && <div style={{textAlign:"center",color:"#8a8f98",fontSize:13,padding:"8px 0"}}>No friends match "{friendSearch}".</div>}
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {list.map(fr=>(
                    <button key={fr.id} onClick={()=>setSelFriend(selFriend?.id===fr.id?null:fr)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:10,border:selFriend?.id===fr.id?"1.5px solid "+OR:"1px solid #ebebeb",background:selFriend?.id===fr.id?OR+"08":"#fff",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                      <FriendAvatar fr={fr} size={34} fontSize={12}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:14,fontWeight:700,color:"#111"}}>{fr.name}</div>
                        <div style={{fontSize:11,color:"#8a8f98"}}>@{fr.handle}</div>
                      </div>
                      {friends.slice(0,3).some(x=>x.id===fr.id) && <span style={{fontSize:10,fontWeight:700,color:OR}}>⭐ TOP 3</span>}
                    </button>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
        {showAddFriend && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={()=>{setShowAddFriend(false);setAddFriendSearch("");}}>
            <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18,maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
              <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
              <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:14}}>Add a Friend</div>
              <input value={addFriendSearch} onChange={e=>setAddFriendSearch(e.target.value)} placeholder="🔍 Search people by name" style={{...INP,marginBottom:12}}/>
              {addFriendSearch.trim() && (() => {
                const q=addFriendSearch.trim().toLowerCase();
                const results = isSupabaseConfigured
                  ? supaFriendResults.filter(p=>!friends.some(f=>f.id===p.id))
                  : (()=>{const dir=[...SAMPLE_PEOPLE,...followersList].filter((p,i,arr)=>arr.findIndex(x=>x.id===p.id)===i); return dir.filter(p=>p.name.toLowerCase().includes(q) && !friends.some(f=>f.id===p.id));})();
                return (
                  <div style={{marginBottom:16}}>
                    {results.length===0 && <div style={{fontSize:13,color:"#8a8f98",padding:"6px 0 14px"}}>No one found matching "{addFriendSearch}"{isSupabaseConfigured?" — they may not have signed up yet.":"."}</div>}
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {results.map(p=>(
                        <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 4px"}}>
                          <button onClick={()=>{setViewedProfile({...p, photo:p.photo_url});setShowAddFriend(false);}} style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0,background:"none",border:"none",cursor:"pointer",fontFamily:F,textAlign:"left",padding:0}}>
                            <FriendAvatar fr={{...p, photo:p.photo_url}} size={36} fontSize={13}/>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:14,fontWeight:700,color:"#111"}}>{p.name||"Unnamed"}</div>
                              <div style={{fontSize:11,color:"#8a8f98"}}>@{p.handle||"—"}</div>
                            </div>
                          </button>
                          <button onClick={()=>{
                            const friendObj = {...p, photo:p.photo_url};
                            addFriendSupabase(p.id);
                            sendNotificationSupabase(p.id, "🤝", (userName||"Someone")+" added you as a friend.");
                            setFriends(f=>{const nf=[...f,friendObj]; setTimeout(()=>checkAchievements({friends:nf}),200); return nf;});
                            setNotifications(n=>[{id:Date.now(),icon:"🤝",text:(p.name||"Your friend")+" was added to your friends.",ts:"now",read:false},...n]);
                            setAddFriendSearch("");setShowAddFriend(false);
                          }} style={{padding:"6px 12px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>+ Add</button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {isSupabaseConfigured ? (
                <div style={{fontSize:12,color:"#8a8f98",textAlign:"center",padding:"4px 0 6px"}}>Don't see them? They'll show up here once they sign up for SonoLane too.</div>
              ) : (<>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"#8a8f98",marginBottom:10}}>OR ADD MANUALLY</div>
              <input value={newFriend.name} onChange={e=>setNewFriend(f=>({...f,name:e.target.value}))} placeholder="Name *" style={{...INP,marginBottom:8}}/>
              <input value={newFriend.handle} onChange={e=>setNewFriend(f=>({...f,handle:e.target.value}))} placeholder="@handle" style={{...INP,marginBottom:14}}/>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{
                  if(!newFriend.name.trim())return;
                  const C=["#6366f1","#f97316","#22c55e","#a855f7","#ec4899","#14b8a6"];
                  const ini=newFriend.name.trim().split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
                  setFriends(f=>{const nf=[...f,{id:Date.now(),name:newFriend.name,handle:newFriend.handle||newFriend.name.toLowerCase(),initials:ini,color:C[f.length%C.length]}]; setTimeout(()=>checkAchievements({friends:nf}),200); return nf;});
                  setNewFriend({name:"",handle:""});setShowAddFriend(false);setAddFriendSearch("");
                }} style={{flex:1,padding:"12px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Add</button>
                <button onClick={()=>{setShowAddFriend(false);setAddFriendSearch("");}} style={{padding:"12px 14px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Cancel</button>
              </div>
              </>)}
              {isSupabaseConfigured && (
                <button onClick={()=>{setShowAddFriend(false);setAddFriendSearch("");}} style={{width:"100%",padding:"12px 14px",borderRadius:10,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Close</button>
              )}
            </div>
          </div>
        )}
        <CallOverlay/>
        <WalkieTalkieSheet/>
        <ProfileViewSheet/>
      </div>
    );

    /* edit profile sub — full config page */
    if(subPanel==="edit") return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows back/Save while this
            page is open (see <TopBar/>). */}
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"14px 16px 32px"}}>

          {/* Profile photo */}
          <div style={SEC}>PROFILE PHOTO</div>
          <div style={{...CARD,display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
            <div style={{position:"relative",flexShrink:0}}>
              <button onClick={()=>profilePhotoRef.current?.click()} style={{width:64,height:64,borderRadius:"50%",background:profilePhoto?"transparent":"#fff",border:"1.5px solid #ececec",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
                {profilePhoto
                  ? (<img src={profilePhoto} alt="profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>)
                  : <DefaultAvatar size={64} color="#111"/>}
              </button>
              <div style={{position:"absolute",bottom:0,right:0,width:20,height:20,borderRadius:"50%",background:OR,border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#fff",pointerEvents:"none"}}>✎</div>
              <input ref={profilePhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;readImageCompressed(f,800,0.85).then(url=>{if(url)setProfilePhoto(url);});}}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:"#111",marginBottom:3}}>Tap to change photo</div>
              {profilePhoto&&<button onClick={()=>setProfilePhoto(null)} style={{padding:"3px 10px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",fontSize:12,color:"#ef4444",cursor:"pointer",fontFamily:F}}>Remove</button>}
            </div>
          </div>

          {/* Name, username, region & bio — Serial Position Effect: Name
              first (highest-frequency, zero-validation field), Username
              right after while attention's still highest since it's the
              one with a live checked/taken state to notice, Region/Bio
              after that once the important decision is already made. */}
          <div style={SEC}>NAME</div>
          <input value={userName} onChange={e=>setUserName(e.target.value)} placeholder="Your name" style={{...INP,marginBottom:10}}/>

          <div style={SEC}>USERNAME</div>
          <div style={{fontSize:12,color:"#111",marginBottom:8,lineHeight:1.5}}>Separate from your name — this is what your account is actually found and saved by, and only you can change it.</div>
          <div style={{position:"relative",marginBottom:4}}>
            <input value={userHandle} onChange={e=>setUserHandle(e.target.value)} placeholder={"@"+suggestUsername(userName)} autoCapitalize="none" style={{...INP,paddingRight:34}}/>
            {userHandle.trim() && (
              <span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:15}}>
                {editUsernameStatus==="checking" && <span style={{color:"#bbb"}}>⋯</span>}
                {editUsernameStatus==="available" && <span style={{color:"#22c55e"}}>✓</span>}
                {(editUsernameStatus==="taken"||editUsernameStatus==="invalid") && <span style={{color:"#ef4444"}}>✕</span>}
              </span>
            )}
          </div>
          <div style={{fontSize:11,marginBottom:10,color:editUsernameStatus==="taken"?"#ef4444":editUsernameStatus==="invalid"?"#ef4444":editUsernameStatus==="available"?"#22c55e":"#999"}}>
            {editUsernameStatus==="taken" ? "That username is taken" : editUsernameStatus==="invalid" ? (usernameError(normalizeUsername(userHandle))||"Letters, numbers, _ and . only") : editUsernameStatus==="available" ? "Available" : "3–20 characters, letters/numbers/_ /."}
          </div>
          {editSaveError && <div style={{fontSize:13,color:"#ef4444",marginBottom:10,lineHeight:1.5}}>{editSaveError}</div>}

          <div style={SEC}>REGION</div>
          <input value={userRegion} onChange={e=>setUserRegion(e.target.value)} placeholder="Region (e.g. Los Angeles, CA)" style={{...INP,marginBottom:10}}/>
          <div style={SEC}>BIO</div>
          <input value={userBio} onChange={e=>setUserBio(e.target.value.slice(0,150))} placeholder="Short bio" maxLength={150} style={{...INP,marginBottom:4}}/>
          {/* Parkinson's Law — an unbounded bio field invites rambling; a
              visible cap (with a live count, not just a silent maxLength)
              keeps it a bio instead of a blog post. */}
          <div style={{fontSize:10,color:"#bbb",textAlign:"right",marginBottom:10}}>{userBio.length}/150</div>

          {/* Top 3 Friends — pick who shows up in your TOP 3 row on Profile
              and gets the Top 3 perks (Live Location Sharing). Tapping a
              star promotes/demotes that friend; friends.slice(0,3) is what
              every other page already reads as "Top 3", so this just
              reorders the same array instead of needing new state. */}
          <div style={SEC}>TOP 3 FRIENDS</div>
          <div style={{...CARD,marginBottom:14}}>
            {friends.length===0 ? (
              <div style={{fontSize:13,color:"#111"}}>Add some friends first, then pick your Top 3 here.</div>
            ) : (<>
              <div style={{fontSize:12,color:"#111",marginBottom:10,lineHeight:1.5}}>Tap the star on up to 3 friends — they'll show as your Top 3 on Profile.</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {friends.map(fr=>{
                  const inTop3 = friends.slice(0,3).some(f=>f.id===fr.id);
                  return (
                    <button key={fr.id} onClick={()=>{
                      setFriends(list=>{
                        const target = list.find(f=>f.id===fr.id);
                        if(!target) return list;
                        const currentTop3 = list.slice(0,3);
                        const isTop3 = currentTop3.some(f=>f.id===fr.id);
                        const others = list.filter(f=>f.id!==fr.id);
                        if(isTop3){
                          // Demote: drop target after everyone currently
                          // outside the top 3, so whoever was next in line
                          // (the front of `tail`) slides into the vacated
                          // slot instead of target landing right back in
                          // slice(0,3) at the boundary index.
                          const remainingTop3 = currentTop3.filter(f=>f.id!==fr.id);
                          const tail = others.filter(f=>!remainingTop3.some(r=>r.id===f.id));
                          return [...remainingTop3, ...tail, target];
                        } else {
                          if(currentTop3.length>=3) return list; // full — demote one first
                          const tail = others.filter(f=>!currentTop3.some(r=>r.id===f.id));
                          return [...currentTop3, target, ...tail];
                        }
                      });
                    }} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 8px",borderRadius:10,border:inTop3?"1.5px solid "+OR:"1px solid #ebebeb",background:inTop3?OR+"08":"#fff",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                      <FriendAvatar fr={fr} size={30} fontSize={11}/>
                      <div style={{flex:1,fontSize:13,fontWeight:700,color:"#111"}}>{fr.name}</div>
                      <span style={{fontSize:16,color:inTop3?OR:"#ccc"}}>{inTop3?"★":"☆"}</span>
                    </button>
                  );
                })}
              </div>
            </>)}
          </div>

          {/* Discovery Radius bar color — the radius value/controls
              themselves are only ever edited from the Discovery Radius
              card's own Edit page. */}
          <div style={SEC}>DISCOVERY RADIUS COLOR</div>
          <div style={{...CARD,marginBottom:14,display:"flex",gap:10,flexWrap:"wrap"}}>
            {[OR,"#6366f1","#22c55e","#a855f7","#ec4899","#14b8a6","#f59e0b","#ef4444"].map(c=>(
              <button key={c} onClick={()=>setRadiusColor(c)} title={c} style={{width:32,height:32,borderRadius:"50%",background:c,border:radiusColor===c?"3px solid #111":"3px solid transparent",boxShadow:"0 0 0 1.5px #ebebeb",cursor:"pointer",padding:0}}/>
            ))}
          </div>

          {/* Start Drive button — style + accent color */}
          <div style={SEC}>START DRIVE BUTTON</div>
          <div style={{...CARD,marginBottom:14}}>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              {[["flag","Flag"],["solid","Solid"],["outline","Outline"]].map(([id,label])=>(
                <button key={id} onClick={()=>setStartDriveStyle(id)} style={{flex:1,padding:"9px 4px",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,border:startDriveStyle===id?"1.5px solid "+OR:"1px solid #ebebeb",background:startDriveStyle===id?OR+"10":"#fff",color:startDriveStyle===id?OR:"#555"}}>{label}</button>
              ))}
            </div>
            <div style={{fontSize:11,color:"#111",marginBottom:8,fontWeight:700,letterSpacing:0.6}}>ACCENT COLOR</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {["#000000",OR,"#6366f1","#22c55e","#a855f7","#ec4899","#14b8a6","#ffffff"].map(c=>(
                <button key={c} onClick={()=>setStartDriveColor(c)} title={c} style={{width:32,height:32,borderRadius:"50%",background:c,border:startDriveColor===c?"3px solid #111":"3px solid transparent",boxShadow:"0 0 0 1.5px #ebebeb",cursor:"pointer",padding:0}}/>
              ))}
            </div>
          </div>

          {/* Drive Mode Settings (Startup Sound, Widgets, and Drive mode's
              own voice toggle) now live only inside Drive mode itself — the
              small ⚙️ at the end of its apps bar — instead of being
              duplicated here on the Profile Edit page. */}

          {/* AI (Select Co-Pilot + the outside-Drive-mode voice toggle) now
              lives on the Settings tab instead of here — see subPanel
              "settings" below. Drive mode has its own separate voice toggle
              in its own Settings sheet. */}

          {/* Wheel side */}
          <div style={SEC}>STATS</div>
          <div style={CARD}>
            {[["⭐",pts,"Points"],["event",events.length,"Events"],["road",routes.length,"Routes"],["👥",friends.length,"Friends"],["📹",clips.length,"Clips"]].map(([ic,v,l])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid #f5f5f5"}}>
                <span style={{fontSize:13,color:"#111",display:"flex",alignItems:"center",gap:5}}>{ic==="event"||ic==="road"?<DPadIcon id={ic} color={DPAD_COLORS[ic]} size={12}/>:ic} {l}</span>
                <span style={{fontSize:13,fontWeight:700,color:"#111"}}>{v}</span>
              </div>
            ))}
          </div>

        </div>
      </div>
    );

    /* radius sub — the ONLY place Discovery Radius can be edited now, opened
       only via the Edit button on the Discovery Radius card in Profile. */
    if(subPanel==="radius") return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Own header removed — the shared TopBar shows the back button
            while this page is open (see <TopBar/>). */}
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"14px 16px 24px"}}>
          <div style={{...CARD,marginBottom:14}}>
            <div style={{fontSize:13,color:"#111",marginBottom:12,lineHeight:1.5}}>Only show route posts, events, and CB lanes within this distance of you.</div>
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:22,fontWeight:900,color:radiusColor}}>{radiusDraft>=RADIUS_MAX ? "100+ mi" : radiusDraft+" mi"}</span>
              <span style={{fontSize:12,color:"#111"}}>{radiusDraft>=RADIUS_MAX ? "no limit" : "within "+radiusDraft+" miles"}</span>
            </div>
            <input
              type="range" min={RADIUS_MIN} max={RADIUS_MAX} step={5}
              value={radiusDraft}
              onChange={e=>setRadiusDraft(Number(e.target.value))}
              onMouseUp={commitRadius} onTouchEnd={commitRadius} onKeyUp={commitRadius}
              style={{width:"100%",accentColor:radiusColor,height:20,cursor:"pointer"}}
            />
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#111"}}>
              <span>{RADIUS_MIN} mi</span>
              <span>100+ mi</span>
            </div>
          </div>

          {/* Global Discovery — like Instagram, every public post is visible
              to everyone regardless of location. Overrides the mile radius
              above entirely while on, without losing the mile setting for
              when it's turned back off. */}
          <div style={{...CARD}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{flex:1,paddingRight:10}}>
                <div style={{fontSize:14,fontWeight:800,color:"#111",marginBottom:3}}>🌎 Global Discovery</div>
                <div style={{fontSize:12,color:"#111",lineHeight:1.5}}>See any public route or event around the world, like Instagram — ignores the mile radius above while on.</div>
              </div>
              <button onClick={()=>setGlobalDiscovery(v=>!v)} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:globalDiscovery?OR:"#d8d8d8",position:"relative",flexShrink:0,padding:0}}>
                <div style={{position:"absolute",top:2,left:globalDiscovery?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
              </button>
            </div>
          </div>
        </div>
      </div>
    );

    /* settings sub — the AI Co-Pilot picker + outside-Drive-mode voice
       toggle live here now instead of on the Edit Profile page. */
    if(subPanel==="settings") settingsSection = (
      <div>
        <div style={{padding:"0 16px 12px"}}>
          <div style={{fontSize:16,fontWeight:800,color:"#111"}}>⚙️ Settings</div>
        </div>
        <div style={{padding:"4px 16px 24px"}}>

          <button onClick={()=>setSubPanel("edit")} style={{width:"100%",padding:"9px",borderRadius:9,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,marginBottom:12}}>Edit full profile →</button>

          {/* AI — Co-Pilot picker, plus the voice-control setting for
              everywhere OUTSIDE Drive mode. Drive mode has its own separate
              voice toggle in its own Settings sheet. */}
          <div style={SEC}>AI</div>
          <div style={{...CARD,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,paddingBottom:14,borderBottom:"1px solid #ebebeb"}}>
              <div style={{flex:1,paddingRight:10}}>
                <div style={{fontSize:13,fontWeight:700,color:"#111"}}>Say "Sono" to Wake</div>
                <div style={{fontSize:12,color:"#111",marginTop:2,lineHeight:1.5}}>Keep voice control on everywhere outside Drive mode, so you can talk to your Co-Pilot hands-free without tapping the mic first. This setting saves.</div>
              </div>
              <button onClick={()=>setSayWakeEnabled(v=>!v)} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:sayWakeEnabled?OR:"#d8d8d8",position:"relative",flexShrink:0,padding:0}}>
                <div style={{position:"absolute",top:2,left:sayWakeEnabled?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
              </button>
            </div>
            <div style={{fontSize:13,fontWeight:700,color:"#111",marginBottom:2}}>Select Co-Pilot</div>
            <div style={{fontSize:12,color:"#111",marginBottom:10,lineHeight:1.5}}>Choose who talks back when you say "Sono" or tap the car avatar while driving.</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {AI_PALS.map(p=>(
                <button key={p.id} onClick={()=>setAiPalId(p.id)} style={{
                  display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:12,
                  cursor:"pointer",fontFamily:F,textAlign:"left",
                  border:"1.5px solid "+(aiPalId===p.id?p.color:"#ebebeb"),
                  background:aiPalId===p.id?p.color+"0f":"#f8f8f8",
                }}>
                  <div style={{width:34,height:34,borderRadius:"50%",background:p.color+"22",border:"1.5px solid "+p.color+"44",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><CompassStar size={19} color={p.color}/></div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:aiPalId===p.id?p.color:"#111"}}>{p.name}</div>
                    <div style={{fontSize:11,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.desc}</div>
                  </div>
                  {aiPalId===p.id && <div style={{width:18,height:18,borderRadius:"50%",background:p.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",flexShrink:0}}>✓</div>}
                </button>
              ))}
            </div>
          </div>

          {/* Lanes — used to live in its own separate "Lanes Settings" sheet
              (reached only from a gear icon in the chat list's user bar);
              moved here so every setting in the app lives in the one place
              people already expect to find settings (Jakob's Law), instead
              of Lanes having its own hidden second Settings page. */}
          <div style={SEC}>LANES</div>
          <div style={{...CARD,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,paddingBottom:14,borderBottom:"1px solid #ebebeb"}}>
              <div style={{flex:1,paddingRight:10}}>
                <div style={{fontSize:13,fontWeight:700,color:"#111"}}>Show online status</div>
                <div style={{fontSize:12,color:"#111",marginTop:2,lineHeight:1.5}}>Let others see the "● Online" indicator next to your name in Lanes.</div>
              </div>
              <button onClick={()=>setShowOnlineStatus(v=>!v)} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:showOnlineStatus?OR:"#d8d8d8",position:"relative",flexShrink:0,padding:0}}>
                <div style={{position:"absolute",top:2,left:showOnlineStatus?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
              </button>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,paddingBottom:14,borderBottom:"1px solid #ebebeb"}}>
              <div style={{flex:1,paddingRight:10}}>
                <div style={{fontSize:13,fontWeight:700,color:"#111"}}>Lanes notifications</div>
                <div style={{fontSize:12,color:"#111",marginTop:2,lineHeight:1.5}}>Get badge alerts for new messages and activity in Lanes.</div>
              </div>
              <button onClick={()=>setLanesNotifications(v=>!v)} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:lanesNotifications?OR:"#d8d8d8",position:"relative",flexShrink:0,padding:0}}>
                <div style={{position:"absolute",top:2,left:lanesNotifications?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
              </button>
            </div>
            <div style={{fontSize:13,fontWeight:700,color:"#111",marginBottom:2}}>📌 Pinning chats</div>
            <div style={{fontSize:12,color:"#111",lineHeight:1.5}}>Tap the pin icon next to any lane or direct message in the Lanes list to keep it at the top.</div>
          </div>

          <div style={SEC}>STATS</div>
          <div style={CARD}>
            {[["⭐",pts,"Points"],["event",events.length,"Events"],["road",routes.length,"Routes"],["👥",friends.length,"Friends"],["📹",clips.length,"Clips"]].map(([ic,v,l])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid #f5f5f5"}}>
                <span style={{fontSize:13,color:"#111",display:"flex",alignItems:"center",gap:5}}>{ic==="event"||ic==="road"?<DPadIcon id={ic} color={DPAD_COLORS[ic]} size={12}/>:ic} {l}</span>
                <span style={{fontSize:13,fontWeight:700,color:"#111"}}>{v}</span>
              </div>
            ))}
          </div>

          {isSupabaseConfigured && (
            <button onClick={()=>supabase.auth.signOut()} style={{width:"100%",padding:"11px",borderRadius:9,background:"#fff",border:"1px solid #ef444444",color:"#ef4444",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,marginTop:14}}>Log Out</button>
          )}
        </div>
      </div>
    );

    /* my events sub */
    if(subPanel==="myevents") {
      const myCreatedEvents = events.filter(ev=>ev.authorId==="me");
      const mySavedEvents = events.filter(ev=>ev.authorId!=="me" && savedEventIds.includes(ev.id));
      const renderEventCard = ev => {
        const accent = EV_COLORS[ev.type]||OR;
        return (
          <div key={ev.id} onClick={()=>setFlyerEvent(ev)} style={{background:"#fff",borderRadius:16,border:"1px solid #ebebeb",marginBottom:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,0.05)",cursor:"pointer"}}>
            {/* Cover */}
            <div style={{height:140,position:"relative",background:ev.photos?.length?"#111":"linear-gradient(145deg,"+accent+"cc,"+accent+"55)"}}>
              {ev.photos?.length>0 && <img src={ev.photos[0].url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>}
              {!ev.photos?.length && <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:46}}>{ev.icon}</div>}
              <div style={{position:"absolute",top:10,left:10,background:accent,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700,color:"#fff",textTransform:"uppercase"}}>{ev.type}</div>
              {/* Live dot — only when the event's date is today, not on every event */}
              {isLiveEvent(ev.date) && (
                <div style={{position:"absolute",top:10,right:10,display:"flex",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:"#ef4444",boxShadow:"0 0 6px #ef4444"}}/>
                </div>
              )}
            </div>
            {/* Info */}
            <div style={{padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:4}}>
                <div style={{fontSize:17,fontWeight:900,color:"#111",flex:1}}>{ev.title}</div>
                {ev.authorId==="me" && (
                  <button onClick={e=>{e.stopPropagation();openEditEvent(ev);}} title="Edit event" style={{width:26,height:26,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                )}
              </div>
              {ev.authorId!=="me" && <div style={{fontSize:12,color:"#8a8f98",marginBottom:4}}>Posted by {ev.authorName||"a driver"}</div>}
              {ev.date && <div style={{fontSize:12,color:"#111",fontWeight:600,marginBottom:5}}>📅 {new Date(ev.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>}
              {ev.address && (
                <button onClick={e=>{e.stopPropagation();openMaps(ev.address);}} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",cursor:"pointer",padding:0,marginBottom:6,fontFamily:F}}>
                  <span style={{fontSize:13,color:"#22c55e",fontWeight:600}}>📍 {ev.address}</span>
                </button>
              )}
              {ev.desc && <div style={{fontSize:14,color:"#111",lineHeight:1.6,marginBottom:10}}>{ev.desc}</div>}
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={e=>{e.stopPropagation();setFlyerEvent(ev);}} style={{flex:1,padding:"8px",borderRadius:9,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>View Flyer</button>
                {ev.address && <button onClick={e=>{e.stopPropagation();openMaps(ev.address);}} style={{flex:1,padding:"8px",borderRadius:9,background:"#4285F4",color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>🚗 Directions</button>}
                {isFutureEvent(ev.date) && (
                  <button onClick={e=>{e.stopPropagation();toggleRsvp(ev.id);}} style={{flex:1,padding:"8px",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,border:"none",background:rsvpedEvents[ev.id]?"#22c55e":"#f3f3f3",color:rsvpedEvents[ev.id]?"#fff":"#111"}}>{rsvpedEvents[ev.id]?"✓ Going":"RSVP"} · {(ev.rsvps||0)+(rsvpedEvents[ev.id]?1:0)}</button>
                )}
                <button onClick={e=>{e.stopPropagation();if(ev.sbId)deleteEventSupabase(ev.sbId);setEvents(p=>p.filter(x=>x.id!==ev.id));setSavedEventIds(s=>s.filter(x=>x!==ev.id));}} style={{padding:"8px 10px",borderRadius:9,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#ef4444",fontSize:13,cursor:"pointer",fontFamily:F}}>✕</button>
              </div>
            </div>
          </div>
        );
      };
      myeventsSection = (
      <div>
        <div style={{padding:"0 14px 12px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1,display:"flex",alignItems:"center",gap:6}}><DPadIcon id="event" color={DPAD_COLORS.event} size={15}/> My Events</div>
          <button onClick={()=>{resetEventForm();setShowEvent(true);}} style={{padding:"6px 13px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>+ Create Event</button>
        </div>
        <div style={{padding:"0 14px 7px"}}>
          {myCreatedEvents.length===0 && mySavedEvents.length===0 ? (
            <div style={{textAlign:"center",padding:"48px 20px",color:"#111"}}>
              <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><CompassStar size={48}/></div>
              <div style={{fontSize:16,fontWeight:700,color:"#111",marginBottom:6}}>No events yet</div>
              <div style={{fontSize:13,lineHeight:1.7}}>Create your first event, or RSVP to one in the community feed to save it here.</div>
            </div>
          ) : (<>
            {myCreatedEvents.length>0 && (
              <>
                <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>MY EVENTS</div>
                {myCreatedEvents.map(renderEventCard)}
              </>
            )}
            {mySavedEvents.length>0 && (
              <>
                <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8,marginTop:myCreatedEvents.length>0?14:0}}>SAVED EVENTS</div>
                {mySavedEvents.map(renderEventCard)}
              </>
            )}
          </>)}
        </div>
        {/* Flyer overlay (reuse global flyerEvent) */}
        {flyerEvent && (
          <div onClick={()=>setFlyerEvent(null)} style={{position:"fixed",inset:0,zIndex:800,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"flex-end"}}>
            <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxHeight:"92vh",background:"#fff",borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",overflow:"hidden"}}>
              <div style={{height:200,position:"relative",overflow:"hidden",flexShrink:0,background:flyerEvent.photos?.length?"#111":"linear-gradient(160deg,"+(EV_COLORS[flyerEvent.type]||OR)+","+(EV_COLORS[flyerEvent.type]||OR)+"55,#111)"}}>
                {flyerEvent.photos?.length>0 && <img src={flyerEvent.photos[0].url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>}
                {!flyerEvent.photos?.length && <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:62}}>{flyerEvent.icon}</div>}
                <div style={{position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",width:36,height:4,borderRadius:2,background:"rgba(255,255,255,0.4)"}}/>
                <button onClick={()=>setFlyerEvent(null)} style={{position:"absolute",top:12,right:12,width:28,height:28,borderRadius:"50%",background:"rgba(0,0,0,0.5)",border:"none",color:"#fff",fontSize:16,cursor:"pointer"}}>×</button>
                <div style={{position:"absolute",bottom:12,left:12,background:EV_COLORS[flyerEvent.type]||OR,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:800,color:"#fff",textTransform:"uppercase"}}>{flyerEvent.type}</div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"16px 16px 24px"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:4}}>
                  <div style={{fontSize:22,fontWeight:900,color:"#111",flex:1}}>{flyerEvent.title}</div>
                  {flyerEvent.authorId==="me" && (
                    <button onClick={()=>openEditEvent(flyerEvent)} title="Edit event" style={{width:30,height:30,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                  )}
                </div>
                {flyerEvent.authorId!=="me" && <div style={{fontSize:13,color:"#8a8f98",marginBottom:6}}>Posted by {flyerEvent.authorName||"a driver"}</div>}
                {flyerEvent.date && <div style={{fontSize:13,color:"#111",fontWeight:600,marginBottom:8}}>📅 {new Date(flyerEvent.date+"T00:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})}</div>}
                {flyerEvent.address && (
                  <button onClick={()=>openMaps(flyerEvent.address)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:12,background:"#f0fdf4",border:"1.5px solid #22c55e33",cursor:"pointer",fontFamily:F,marginBottom:12,textAlign:"left"}}>
                    <div style={{width:34,height:34,borderRadius:9,background:"#22c55e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🗺️</div>
                    <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:700,color:"#22c55e"}}>Get Directions</div><div style={{fontSize:12,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{flyerEvent.address}</div></div>
                    <div style={{fontSize:18,color:"#22c55e"}}>›</div>
                  </button>
                )}
                {flyerEvent.desc && <div style={{fontSize:15,color:"#111",lineHeight:1.65,marginBottom:14}}>{flyerEvent.desc}</div>}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {flyerEvent.address && <button onClick={()=>openMaps(flyerEvent.address)} style={{flex:2,padding:"12px",borderRadius:11,background:"#4285F4",color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>🚗 Start Route</button>}
                  {isFutureEvent(flyerEvent.date) && (
                    <button onClick={()=>toggleRsvp(flyerEvent.id)} style={{flex:1,padding:"12px",borderRadius:11,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F,border:"none",background:rsvpedEvents[flyerEvent.id]?"#22c55e":"#f3f3f3",color:rsvpedEvents[flyerEvent.id]?"#fff":"#111"}}>{rsvpedEvents[flyerEvent.id]?"✓ Going":"✋ RSVP"} · {(flyerEvent.rsvps||0)+(rsvpedEvents[flyerEvent.id]?1:0)}</button>
                  )}
                  <button onClick={()=>setFlyerEvent(null)} style={{flex:1,padding:"12px",borderRadius:11,background:"#f3f3f3",color:"#111",border:"1px solid #ebebeb",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>Close</button>
                </div>
              </div>
            </div>
          </div>
        )}
        {/* Create event sheet */}
        {showEvent && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={closeEventSheet}>
            <div style={{background:"#fff",borderRadius:"22px 22px 0 0",width:"100%",maxHeight:"90%",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
              <div style={{width:32,height:3,background:"#e0e0e0",borderRadius:2,margin:"12px auto",flexShrink:0}}/>
              <div style={{padding:"0 16px 10px",borderBottom:"1px solid #ebebeb",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{fontSize:17,fontWeight:800,color:"#111"}}>{editingEventId?"Edit Event":"⚡ Create Event"}</div>
                <button onClick={closeEventSheet} style={{width:26,height:26,borderRadius:13,border:"none",background:"#f2f2f2",color:"#666",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✕</button>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>
                <div style={{display:"flex",gap:8,marginBottom:12}}>
                  {eventPhotos.map((p,i)=>(
                    <div key={i} style={{flex:1,height:80,borderRadius:10,overflow:"hidden",position:"relative"}}>
                      <img src={p.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      <button onClick={()=>setEventPhotos(ps=>ps.filter((_,j)=>j!==i))} style={{position:"absolute",top:3,right:3,width:16,height:16,borderRadius:"50%",background:"rgba(0,0,0,0.55)",border:"none",color:"#fff",fontSize:11,cursor:"pointer"}}>×</button>
                    </div>
                  ))}
                  {eventPhotos.length<3 && <button onClick={()=>eventPhotoRef.current?.click()} style={{flex:1,height:80,borderRadius:10,border:"1.5px dashed #ddd",background:"#f8f8f8",fontSize:26,color:"#111",cursor:"pointer"}}>+</button>}
                  {Array.from({length:Math.max(0,2-eventPhotos.length)}).map((_,i)=><div key={i} style={{flex:1,height:80,borderRadius:10,background:"#f5f5f5"}}/>)}
                  <input ref={eventPhotoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>Array.from(e.target.files||[]).slice(0,3-eventPhotos.length).forEach(f=>{readImageCompressed(f).then(url=>{if(url)setEventPhotos(p=>[...p,{url}]);});})}/>
                </div>
                <input value={newEvent.title} onChange={e=>setNewEvent(p=>({...p,title:e.target.value}))} placeholder="Event name *" style={{...INP,marginBottom:8}}/>
                <input value={newEvent.address} onChange={e=>setNewEvent(p=>({...p,address:e.target.value}))} placeholder="Address or venue" style={{...INP,marginBottom:8}}/>
                <input type="date" value={newEvent.date} onChange={e=>setNewEvent(p=>({...p,date:e.target.value}))} style={{...INP,marginBottom:8,color:newEvent.date?"#111":"#999"}}/>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                  {Object.keys(EV_ICONS).map(t=><button key={t} onClick={()=>setNewEvent(p=>({...p,type:t}))} style={{...TAG(newEvent.type===t),background:newEvent.type===t?(EV_COLORS[t]||OR):"#f3f3f3"}}>{EV_ICONS[t]} {t}</button>)}
                </div>
                <textarea value={newEvent.desc} onChange={e=>setNewEvent(p=>({...p,desc:e.target.value}))} placeholder="Description…" rows={3} style={{...INP,resize:"none",marginBottom:16}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={submitEvent} style={{flex:1,padding:"13px",borderRadius:11,background:OR,color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F}}>{editingEventId?"✓ Save Changes":"📍 Post Event"}</button>
                  <button onClick={closeEventSheet} style={{padding:"13px 16px",borderRadius:11,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      );
    }

    /* profile completion vars */
    // Save a route / record a drive / create an event / create 3 events / add a
    // friend used to be objectives here — they're tracked as achievements
    // instead now (first_route, first_drive, first_event, three_events,
    // first_friend in ACHIEVEMENTS), so profile completion only covers the
    // one-time setup items.
    const _OBJECTIVES = [
      { id:"name",    label:"Add name & bio",       done:!!(userName&&userBio),     icon:"person", pts:20  },
      // Zeigarnik Effect — an unclaimed username is exactly the kind of
      // small, visibly-incomplete task that nags at people until it's
      // checked off, which is the whole mechanism this Profile Completion
      // card already runs on for the other three objectives.
      { id:"handle",  label:"Choose a username",    done:!usernameError(normalizeUsername(userHandle)) && !!normalizeUsername(userHandle), icon:"person", pts:10 },
      { id:"photo",   label:"Set profile photo",    done:!!profilePhoto,             icon:"camera", pts:15  },
      { id:"car",     label:"Create car avatar",    done:!!carSaved,                 icon:"car",    pts:30  },
    ];
    const _doneCount = _OBJECTIVES.filter(o=>o.done).length;
    const _pct       = Math.round(_doneCount / _OBJECTIVES.length * 100);
    const _incomplete= _OBJECTIVES.filter(o=>!o.done);

        /* rewards sub */
    if(subPanel==="rewards") return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"linear-gradient(180deg,#1a1a2e 0%,#16213e 40%,#0f3460 100%)"}}>
        {/* Own header removed — the shared TopBar (dark, to match this page)
            shows the back button while this page is open (see <TopBar/>). */}
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"24px 20px 40px",display:"flex",flexDirection:"column",alignItems:"center"}}>

          {/* Coming soon hero */}
          <div style={{width:96,height:96,borderRadius:"50%",background:"linear-gradient(135deg,#e94560,#f5a623)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:46,marginBottom:16,boxShadow:"0 0 0 10px rgba(233,69,96,0.12), 0 0 0 20px rgba(233,69,96,0.06)"}}>🏆</div>
          <div style={{fontSize:26,fontWeight:900,color:"#fff",marginBottom:6,textAlign:"center"}}>Coming Soon</div>
          <div style={{fontSize:15,color:"#aaa",textAlign:"center",lineHeight:1.7,marginBottom:32,maxWidth:280}}>Earn points every time you drive, share routes, attend events, and connect with the SonoLane community.</div>

          {/* Feature preview cards */}
          {[
            {icon:"⭐",title:"Drive Points",desc:"Earn pts per mile driven with dashcam on"},
            {icon:"🎁",title:"Unlock Perks",desc:"Redeem points for app features & partner deals"},
            {icon:"🏅",title:"Driver Ranks",desc:"Bronze → Silver → Gold → SonoLane Elite"},
            {icon:"🛣️",title:"Route Badges",desc:"Special badges for iconic routes & milestones"},
            {icon:"👥",title:"Referral Bonus",desc:"Invite friends and earn bonus points together"},
          ].map(f=>(
            <div key={f.title} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:14,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",marginBottom:10}}>
              <div style={{width:40,height:40,borderRadius:11,background:"linear-gradient(135deg,#e9456033,#f5a62333)",border:"1px solid #e9456033",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{f.icon}</div>
              <div>
                <div style={{fontSize:14,fontWeight:800,color:"#fff",marginBottom:2}}>{f.title}</div>
                <div style={{fontSize:12,color:"#666"}}>{f.desc}</div>
              </div>
            </div>
          ))}

          {/* Sign-up CTA */}
          <div style={{width:"100%",marginTop:8,padding:"20px",borderRadius:16,background:"rgba(233,69,96,0.1)",border:"1.5px solid rgba(233,69,96,0.3)",textAlign:"center"}}>
            <div style={{fontSize:15,fontWeight:800,color:"#fff",marginBottom:4}}>Get Early Access</div>
            <div style={{fontSize:12,color:"#888",marginBottom:14}}>Sign up to be notified when Rewards launches and lock in your founding member status.</div>
            <button style={{width:"100%",padding:"13px",borderRadius:11,background:"linear-gradient(90deg,#e94560,#f5a623)",color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F}}>🏆 Join the Waitlist</button>
          </div>
        </div>
      </div>
    );

    /* home grid */
    return (
      <div ref={setScroll} style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column"}}>

        {/* ── Car hero — standalone car banner/avatar; tap for details.
             Uses the same banner (custom photo or preset) set on the car
             detail page, so any banner edit shows up here immediately. ── */}
        <div style={{margin:"14px 16px 0",borderRadius:18,overflow:"hidden",background:carBannerPhoto ? "url("+carBannerPhoto+") center/cover no-repeat" : (CAR_BANNERS.find(b=>b.id===carBannerPreset)||CAR_BANNERS[0]).css,flexShrink:0}}>
          <button onClick={()=>{setCarDetailFrom("profile");setSubPanel("car");}} style={{width:"100%",padding:"20px 16px",display:"flex",flexDirection:"column",alignItems:"center",background:"none",border:"none",cursor:"pointer",fontFamily:F}}>
            {carAvatarMode==="photo" && carAvatarPhoto
              ? <img src={carAvatarPhoto} alt="" style={{width:104,height:104,borderRadius:16,objectFit:"cover",border:"2px solid rgba(255,255,255,0.85)",boxShadow:"0 6px 20px rgba(0,0,0,0.4)"}}/>
              : <CarSVG color={carColor} mods={carMods} size={140} styleId={carBodyStyle}/>}
            {carShowInfoHome && (carName || carBrand) && (<>
              <div style={{marginTop:8,fontSize:18,fontWeight:900,color:"#fff",textShadow:"0 1px 4px rgba(0,0,0,0.5)"}}>{carName || CAR_BRANDS.find(b=>b.id===carBrand)?.name}</div>
              {(carName && (carBrand||carModel)) && <div style={{fontSize:12,color:"#ddd",marginTop:2,textShadow:"0 1px 4px rgba(0,0,0,0.5)"}}>{carBrand ? (CAR_BRANDS.find(b=>b.id===carBrand)?.name+" ") : ""}{carModel}</div>}
            </>)}
          </button>
        </div>

        {/* ── Start Drive — style + accent color changeable from Edit Profile
             (see the START DRIVE BUTTON section there). "flag" is the
             original racing-sticker look; "solid" and "outline" are plainer
             alternatives that lean fully on the chosen accent color. ── */}
        {startDriveStyle==="solid" ? (
          <button onClick={()=>{playStartupSound(startupSound);go("drive");}} style={{
            margin:"14px 16px 0",width:"calc(100% - 32px)",padding:"16px 0",border:"none",borderRadius:14,cursor:"pointer",fontFamily:F,
            background:startDriveColor,flexShrink:0,
          }}>
            <span style={{fontSize:18,fontWeight:900,letterSpacing:0.5,textTransform:"uppercase",color:"#fff"}}>▶ Start Drive</span>
          </button>
        ) : startDriveStyle==="outline" ? (
          <button onClick={()=>{playStartupSound(startupSound);go("drive");}} style={{
            margin:"14px 16px 0",width:"calc(100% - 32px)",padding:"14px 0",border:"2.5px solid "+startDriveColor,borderRadius:14,cursor:"pointer",fontFamily:F,
            background:"#fff",flexShrink:0,
          }}>
            <span style={{fontSize:18,fontWeight:900,letterSpacing:0.5,textTransform:"uppercase",color:startDriveColor}}>▶ Start Drive</span>
          </button>
        ) : (
          <button onClick={()=>{playStartupSound(startupSound);go("drive");}} style={{
            width:"100%",padding:"14px 0",marginTop:14,border:"none",cursor:"pointer",fontFamily:F,
            display:"flex",alignItems:"center",justifyContent:"center",gap:10,flexShrink:0,
            background:"#fff",overflow:"hidden",
          }}>
            <div style={{
              flex:1,height:20,transform:"skewX(-18deg)",
              backgroundColor:"#000",
              backgroundImage:"linear-gradient(45deg,#fff 25%,transparent 25%),linear-gradient(-45deg,#fff 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#fff 75%),linear-gradient(-45deg,transparent 75%,#fff 75%)",
              backgroundSize:"10px 10px",
              backgroundPosition:"0 0,0 5px,5px -5px,-5px 0px",
            }}/>
            <span style={{
              flexShrink:0,padding:"7px 22px",borderRadius:9,
              background:"#f0f0f0",border:"2.5px solid "+startDriveColor,
              fontSize:24,fontWeight:900,fontStyle:"italic",letterSpacing:1,textTransform:"uppercase",
              color:startDriveColor,
            }}>Start Drive</span>
            <div style={{
              flex:1,height:20,transform:"skewX(18deg)",
              backgroundColor:"#000",
              backgroundImage:"linear-gradient(45deg,#fff 25%,transparent 25%),linear-gradient(-45deg,#fff 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#fff 75%),linear-gradient(-45deg,transparent 75%,#fff 75%)",
              backgroundSize:"10px 10px",
              backgroundPosition:"0 0,0 5px,5px -5px,-5px 0px",
            }}/>
          </button>
        )}

        {/* ── Profile header ── */}
        <div style={{padding:"14px 16px 12px",display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
          {/* Avatar — only tappable in edit mode */}
          <div style={{position:"relative",flexShrink:0}}>
            <button
              onClick={()=>{ if(editMode) profilePhotoRef.current?.click(); }}
              style={{
                width:58,height:58,borderRadius:"50%",
                background:profilePhoto?"transparent":"#fff",
                border:"1.5px solid #ececec",padding:0,
                display:"flex",alignItems:"center",justifyContent:"center",
                overflow:"hidden",flexShrink:0,
                cursor:editMode?"pointer":"default",
              }}>
              {profilePhoto
                ? (<img src={profilePhoto} alt="profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>)
                : <DefaultAvatar size={58} color="#111"/>}
            </button>
            {editMode&&<div style={{position:"absolute",bottom:0,right:0,width:18,height:18,borderRadius:"50%",background:OR,border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",pointerEvents:"none"}}>✎</div>}
            <input ref={profilePhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;readImageCompressed(f,800,0.85).then(url=>{if(url)setProfilePhoto(url);});}}/>
          </div>

          {/* Name / bio */}
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:19,fontWeight:800,color:userName?"#111":"#ccc",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{userName||"Your name"}</div>
            <div style={{fontSize:13,color:"#111",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{userBio||"No bio yet"}</div>
          </div>

          {/* Edit button — opens the edit sub-page (icon only, no label, no background plate) */}
          <button onClick={()=>setSubPanel("edit")} title="Edit profile" style={{width:34,height:34,borderRadius:"50%",fontSize:24,background:"none",color:"#111",border:"none",cursor:"pointer",fontFamily:F,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
            ✎
          </button>
        </div>

        {/* ── Stats bar — Pts / Following / Followers ── */}
        <div style={{display:"flex",background:"#f8f8f8",borderTop:"1px solid #ebebeb",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
          {[["star",pts,"Pts","points"],["people",following.length,"Following","following"],["people",followersList.length,"Followers","followerslist"]].map(([ic,v,l,sp])=>(
            <button key={l} onClick={()=>sp==="points"?setWidgetAction("points"):setSubPanel(sp)} style={{flex:1,padding:"9px 4px",textAlign:"center",borderRight:"1px solid #ebebeb",background:"none",border:"none",borderRightWidth:1,borderRightStyle:"solid",borderRightColor:"#ebebeb",cursor:"pointer",fontFamily:F}}>
              <div style={{display:"flex",justifyContent:"center"}}>{ic==="road"?<DPadIcon id="road" color={DPAD_COLORS.road} size={15}/>:<ProfileIcon id={ic} size={15} color="#8a8f98"/>}</div>
              <div style={{fontSize:14,fontWeight:800,color:"#111",marginTop:2}}>{v}</div>
              <div style={{fontSize:10,color:"#111"}}>{l}</div>
            </button>
          ))}
        </div>

        {/* ── Tile grid ── */}
        <div style={{padding:"14px 14px 7px",display:"flex",flexDirection:"column"}}>

          {/* ── Discovery radius — just the bar + distance here; the full
              explanation and controls live on the Edit page (tap Edit). ── */}
          <div style={{flexShrink:0,background:"#fff",borderRadius:16,border:"1px solid #ebebeb",padding:"14px",marginBottom:12,boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:14,fontWeight:800,color:"#111"}}>Discovery Radius</div>
              <button onClick={()=>setSubPanel("radius")} style={{background:"none",border:"none",color:OR,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,padding:0}}>Edit</button>
            </div>
            <div style={{fontSize:20,fontWeight:900,color:radiusColor,marginBottom:6}}>{radiusDraft>=RADIUS_MAX ? "100+ mi" : radiusDraft+" mi"}</div>
            <div style={{height:6,borderRadius:3,background:"#f0f0f0",overflow:"hidden"}}>
              <div style={{height:"100%",borderRadius:3,background:radiusColor,width:(Math.min(100,Math.max(0,(radiusDraft-RADIUS_MIN)/(RADIUS_MAX-RADIUS_MIN)*100)))+"%"}}/>
            </div>
          </div>

          {/* ── Profile completion + objectives — dismissible like a notification ── */}
          {!objectivesDismissed && (
              <div style={{flexShrink:0,background:"#fff",borderRadius:16,border:"1px solid #ebebeb",padding:"14px 14px 12px",marginBottom:12,boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
                {/* Header */}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:800,color:"#111"}}>Profile Completion</div>
                    <div style={{fontSize:11,color:"#111",marginTop:1}}>{_doneCount} of {_OBJECTIVES.length} objectives done</div>
                  </div>
                  <div style={{fontSize:20,fontWeight:900,color:_pct===100?"#22c55e":OR}}>{_pct}%</div>
                  <button onClick={dismissObjectives} title="Dismiss" style={{background:"none",border:"none",color:"#bbb",fontSize:18,fontWeight:700,cursor:"pointer",padding:"0 0 0 2px",lineHeight:1,flexShrink:0}}>×</button>
                </div>
                {/* Progress bar */}
                <div style={{height:6,borderRadius:3,background:"#f0f0f0",overflow:"hidden",marginBottom:12}}>
                  <div style={{height:"100%",borderRadius:3,background:_pct===100?"#22c55e":"linear-gradient(90deg,"+OR+",#fb923c)",width:_pct+"%",transition:"width 0.4s ease"}}/>
                </div>
                {/* Objectives list — collapsed shows the next 3 to do; expanded
                    shows every objective (done and not) with its point value. */}
                {!showAllObjectives && _incomplete.length>0 && (
                  <div>
                    <div style={{fontSize:10,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>NEXT UP</div>
                    {_incomplete.slice(0,3).map(obj=>(
                      <div key={obj.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:"1px solid #f8f8f8"}}>
                        <div style={{width:24,height:24,borderRadius:8,background:"#f3f3f3",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><ObjIcon icon={obj.icon} size={13}/></div>
                        <div style={{flex:1,fontSize:13,color:"#111"}}>{obj.label}</div>
                        <div style={{fontSize:11,fontWeight:700,color:OR}}>+{obj.pts} pts</div>
                      </div>
                    ))}
                  </div>
                )}
                {/* All done, collapsed view */}
                {!showAllObjectives && _incomplete.length===0 && (
                  <div style={{textAlign:"center",padding:"6px 0"}}>
                    <div style={{fontSize:22,marginBottom:3}}>🏆</div>
                    <div style={{fontSize:13,fontWeight:700,color:"#22c55e"}}>Profile complete!</div>
                  </div>
                )}
                {/* Expanded — every objective, done or not, with its points */}
                {showAllObjectives && (
                  <div>
                    <div style={{fontSize:10,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>ALL OBJECTIVES</div>
                    {_OBJECTIVES.map(obj=>(
                      <div key={obj.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:"1px solid #f8f8f8",opacity:obj.done?0.55:1}}>
                        <div style={{width:24,height:24,borderRadius:8,background:obj.done?"#22c55e11":"#f3f3f3",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><ObjIcon icon={obj.icon} size={13}/></div>
                        <div style={{flex:1,fontSize:13,color:"#111",textDecoration:obj.done?"line-through":"none"}}>{obj.label}</div>
                        {obj.done
                          ? <div style={{fontSize:11,fontWeight:700,color:"#22c55e"}}>✓ done</div>
                          : <div style={{fontSize:11,fontWeight:700,color:OR}}>+{obj.pts} pts</div>}
                      </div>
                    ))}
                  </div>
                )}
                {/* Expand/collapse toggle */}
                {_OBJECTIVES.length>3 && (
                  <button onClick={()=>setShowAllObjectives(v=>!v)} style={{width:"100%",background:"none",border:"none",padding:"8px 0 0",marginTop:showAllObjectives?8:0,fontSize:12,fontWeight:700,color:OR,cursor:"pointer",fontFamily:F}}>
                    {showAllObjectives ? "Show less ▲" : "View all "+_OBJECTIVES.length+" objectives ▼"}
                  </button>
                )}
                {/* Completed objectives */}
                {!showAllObjectives && _OBJECTIVES.filter(o=>o.done).length>0 && (
                  <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #f5f5f5"}}>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {_OBJECTIVES.filter(o=>o.done).map(obj=>(
                        <div key={obj.id} style={{display:"flex",alignItems:"center",gap:3,background:"#22c55e11",border:"1px solid #22c55e33",borderRadius:20,padding:"2px 7px"}}>
                          <ObjIcon icon={obj.icon} size={10}/>
                          <span style={{fontSize:10,fontWeight:600,color:"#22c55e"}}>{obj.label}</span>
                          <span style={{fontSize:10,color:"#22c55e"}}>✓</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
          )}

          {/* ── Header bar sitting directly on top of the Top 3 Friends row —
               "TOP 3" on the left, "Friends" + a list icon in the corner on
               the right; the whole bar opens the full Friends tab. ── */}
          <button onClick={()=>setSubPanel("friends")} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",margin:"0 0 6px",padding:"2px 1px",background:"none",border:"none",cursor:"pointer",fontFamily:F}}>
            <span style={{fontSize:11,fontWeight:800,letterSpacing:1.2,color:"#111"}}>TOP 3</span>
            <span style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:13,fontWeight:700,color:"#8a8f98"}}>Friends</span>
              <ListBarsIcon size={15} color="#8a8f98"/>
            </span>
          </button>
          {/* ── Top 3 Friends — full-bleed row spanning edge to edge, replaces
               the standalone Friends tile. Filled slots jump straight to that
               friend in Friends; empty slots open Friends to add one. ── */}
          <div style={{display:"flex",margin:"0 -14px 12px",borderTop:"1px solid #ebebeb",borderBottom:"1px solid #ebebeb"}}>
            {[0,1,2].map(i=>{
              // The AI Co-Pilot can take up the first Top 3 slot — tapping it
              // starts a live voice call instead of opening the Friends tab.
              if(aiInTop3 && i===0){
                return (
                  <button key="ai" onClick={startAiCall} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6,padding:"14px 6px",background:"none",border:"none",borderRight:"1px solid #ebebeb",cursor:"pointer",fontFamily:F}}>
                    <div style={{width:42,height:42,borderRadius:"50%",background:pal.color+"22",border:"1.5px solid "+pal.color+"44",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><CompassStar size={20} color={pal.color}/></div>
                    <div style={{fontSize:12,fontWeight:700,color:"#111",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pal.name}</div>
                  </button>
                );
              }
              const fr=friends[aiInTop3?i-1:i];
              return (
                <button key={i} onClick={()=>{if(fr){setSelFriend(fr);setSubPanel("top3friend");}else{setShowTop3Chooser(true);}}} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6,padding:"14px 6px",background:"none",border:"none",borderRight:i<2?"1px solid #ebebeb":"none",cursor:"pointer",fontFamily:F}}>
                  <div style={{width:42,height:42,borderRadius:"50%",background:fr?.photo?"transparent":(fr?fr.color:"#f3f3f3"),border:fr?"none":"2px dashed #ddd",display:"flex",alignItems:"center",justifyContent:"center",fontSize:fr?17:20,color:fr?"#fff":"#ccc",fontWeight:800,overflow:"hidden"}}>
                    {fr?.photo ? <img src={fr.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : (fr?fr.initials:"＋")}
                  </div>
                  <div style={{fontSize:12,fontWeight:fr?700:400,color:fr?"#111":"#bbb",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fr?fr.name:"Add Friend"}</div>
                </button>
              );
            })}
          </div>

          {/* Choosing what to add to an empty Top 3 slot — a real friend, or
              the AI Co-Pilot (only offered once, and only if not already in). */}
          {showTop3Chooser && (
            <div onClick={()=>setShowTop3Chooser(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}}>
              <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18}}>
                <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
                <div style={{fontSize:15,fontWeight:800,color:"#111",marginBottom:14}}>Add to Top 3</div>
                <button onClick={()=>{setShowTop3Chooser(false);setSubPanel("friends");}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:14,border:"1.5px solid #ebebeb",background:"#f8f8f8",cursor:"pointer",fontFamily:F,textAlign:"left",marginBottom:10}}>
                  <div style={{width:38,height:38,borderRadius:"50%",background:"#fff",border:"1.5px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>👥</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Add a Friend</div>
                    <div style={{fontSize:12,color:"#888",marginTop:1}}>Find someone you know on SonoLane.</div>
                  </div>
                </button>
                {!aiInTop3 && (
                  <button onClick={()=>{setAiInTop3(true);setShowTop3Chooser(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:14,border:"1.5px solid "+pal.color+"44",background:pal.color+"0f",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                    <div style={{width:38,height:38,borderRadius:"50%",background:pal.color+"22",border:"1.5px solid "+pal.color+"44",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><CompassStar size={18} color={pal.color}/></div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Add {pal.name} (AI Co-Pilot)</div>
                      <div style={{fontSize:12,color:"#888",marginTop:1}}>Tap to start a live voice call anytime.</div>
                    </div>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Row of icon toggles — My Garage, My Routes, My Events, History
              (drive history + dashcam calendar/footage, merged), Radio
              Stations — tap one to show its content right below this row;
              tap the active one again (or another one) to switch. Reuses
              `subPanel` itself as the toggle state, so every other link in
              the app that jumps straight to e.g. setSubPanel("routes")
              still lands here. Trophies moved into the Points detail page;
              Settings is still reachable from the ☰ menu. */}
          <div style={{display:"flex",margin:"0 -14px",borderTop:"1px solid #ebebeb",borderBottom:"1px solid #ebebeb",overflowX:"auto"}}>
            {[
              {id:"garage",        label:"Garage",   icon:<GarageDoorIcon size={22} color={subPanel==="garage"?OR:(carSaved?OR:"#8a8f98")}/>},
              {id:"routes",        label:"Routes",   icon:<DPadIcon id="road" color={subPanel==="routes"?OR:DPAD_COLORS.road} size={22}/>},
              {id:"myevents",      label:"Events",   icon:<DPadIcon id="event" color={subPanel==="myevents"?OR:DPAD_COLORS.event} size={22}/>},
              {id:"history",       label:"History",  icon:<ProfileIcon id="history" size={22} color={subPanel==="history"?OR:"#8a8f98"}/>},
              {id:"radiostations", label:"Radio",    icon:<span style={{fontSize:20}}>📻</span>},
            ].map(t=>{
              const active = subPanel===t.id;
              return (
                <button key={t.id} onClick={()=>setSubPanel(active?null:t.id)} style={{
                  flex:"1 0 auto",minWidth:52,display:"flex",flexDirection:"column",alignItems:"center",gap:5,
                  padding:"10px 4px 8px",background:active?OR+"10":"none",border:"none",
                  borderBottom:"2px solid "+(active?OR:"transparent"),cursor:"pointer",fontFamily:F,
                }}>
                  {t.icon}
                  <span style={{fontSize:9,fontWeight:active?800:600,color:active?OR:"#8a8f98",whiteSpace:"nowrap"}}>{t.label}</span>
                </button>
              );
            })}
          </div>

          {/* Whichever tile is toggled on shows its content right here,
              below the row — same content each page always had, just
              inline on the home screen now instead of its own full page. */}
          {subPanel==="garage" && <div style={{margin:"14px -14px 0"}}>{garageSection}</div>}
          {subPanel==="routes" && <div style={{margin:"14px -14px 0"}}>{routesSection}</div>}
          {subPanel==="myevents" && <div style={{margin:"14px -14px 0"}}>{myeventsSection}</div>}
          {subPanel==="history" && <div style={{margin:"14px -14px 0"}}>{historySection}</div>}
          {subPanel==="radiostations" && <div style={{margin:"14px -14px 0"}}>{radiostationsSection}</div>}
          {subPanel==="settings" && <div style={{margin:"14px -14px 0"}}>{settingsSection}</div>}
        </div>
      </div>
    );
  });

  /* ── FEED ── */
  const FEED_CATS = ["All","Following","scenic","hike","commute","home","road trip","bike"];
  const FeedPanel = useStablePanel(() => {
    // Multi-select category filter — tap "All" to reset, tap any other chip to
    // toggle it in/out of the active set (posts matching ANY selected chip show).
    const [feedCats, setFeedCats] = useState(["All"]);
    const toggleFeedCat = c => {
      if (c === "All") { setFeedCats(["All"]); return; }
      setFeedCats(prev => {
        const withoutAll = prev.filter(x => x !== "All");
        const next = withoutAll.includes(c) ? withoutAll.filter(x => x !== c) : [...withoutAll, c];
        return next.length ? next : ["All"];
      });
    };
    const filtered = posts.filter(p=>{
      const matchSearch = !feedSearch||p.title.toLowerCase().includes(feedSearch.toLowerCase());
      const matchCat = feedCats.includes("All") ? true
        : feedCats.some(c => c==="Following" ? following.some(f=>f.id===p.authorId) : p.type===c);
      const matchRadius = !radiusActive || p.authorId==="me" || milesAwayFor(p.id)<=appRadius;
      return matchSearch&&matchCat&&matchRadius;
    });
    const GhostPost = () => (
      <div style={{background:"#fff",borderRadius:14,border:"1px solid #ebebeb",marginBottom:10,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
        <div style={{height:120,background:"#f0f0f0"}}/>
        <div style={{padding:"12px 14px"}}>
          <div style={{height:9,borderRadius:6,background:"#f0f0f0",width:"30%",marginBottom:8}}/>
          <div style={{height:13,borderRadius:6,background:"#ececec",width:"75%",marginBottom:6}}/>
          <div style={{height:9,borderRadius:6,background:"#f3f3f3",width:"90%",marginBottom:4}}/>
          <div style={{height:9,borderRadius:6,background:"#f3f3f3",width:"60%"}}/>
        </div>
      </div>
    );
    const resetPostForm = () => {
      setNewPost({title:"",body:"",type:"scenic",distance:"",stops:["",""],highlights:""});
      setPostPhotos([]);
      setPostSavedRoute(null);
      setPostRouteMode("new");
      setEditingPostId(null);
    };
    const closePostSheet = () => { setShowPost(false); setEditingPostId(null); };
    // Every route is yours (authorId "me"), so tapping the pencil on any
    // route card — feed or its full-screen info page — reopens this same
    // sheet pre-filled, in edit mode instead of create mode.
    const openEditPost = (post) => {
      setNewPost({
        title: post.title||"", body: post.body||"", type: post.type||"scenic",
        distance: post.distance||"", stops: post.stops?.length ? [...post.stops,""] : ["",""],
        highlights: post.highlights||"",
      });
      setPostPhotos(post.photos||[]);
      setPostSavedRoute(null);
      setPostRouteMode("new");
      setEditingPostId(post.id);
      setShowPost(true);
    };
    const submitPost = () => {
      if(!newPost.title.trim()) return;
      const saved = postRouteMode==="existing" && postSavedRoute
        ? routes.find(r=>r.id===postSavedRoute)
        : null;
      const postData = {
        title: newPost.title,
        type: saved?.type || newPost.type,
        body: newPost.body,
        distance: saved?.distance || newPost.distance,
        stops: newPost.stops.filter(s=>s.trim()),
        highlights: newPost.highlights,
        photos: postPhotos,
        fromSaved: !!saved,
        savedRouteName: saved?.title,
      };
      if(editingPostId){
        setPosts(p=>p.map(x=>x.id===editingPostId?{...x,...postData}:x));
      } else {
        const post = { id: Date.now(), ...postData, likes: 0, authorId: "me", authorName: userName||"You" };
        setPosts(p=>[post,...p]);
        setNotifications(n=>[{id:Date.now(),icon:"🗺️",text:"Your route \""+post.title+"\" has been posted to the feed!",ts:"now",read:false},...n]);
      }
      resetPostForm();
      setShowPost(false);
    };
    return (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* Header — matches the Events page: page symbol + name + Routes/Events
          toggle, My Routes / Create on their own row underneath */}
      <div style={{padding:"10px 14px 8px",borderBottom:"1px solid #ebebeb",flexShrink:0,background:"#fff"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:17,fontWeight:900,color:"#111",display:"flex",alignItems:"center",gap:7}}><DPadIcon id="road" color={DPAD_COLORS.road} size={16}/> Routes</div>
          </div>
          {/* Routes/Events toggle — now lives up here since the main nav moved to the bottom */}
          <div style={{display:"flex",gap:4,background:"#f3f3f3",borderRadius:40,padding:4,flexShrink:0}}>
            <button onClick={()=>setDiscoverTab("routes")} title="Routes" style={{padding:"14px 22px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,background:discoverTab==="routes"?"#fff":"transparent",boxShadow:discoverTab==="routes"?"0 1px 3px rgba(0,0,0,0.15)":"none",display:"flex",alignItems:"center"}}>
              <DPadIcon id="road" color={discoverTab==="routes"?DPAD_COLORS.road:"#999"} size={28}/>
            </button>
            <button onClick={()=>setDiscoverTab("events")} title="Events" style={{padding:"14px 22px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,background:discoverTab==="events"?"#fff":"transparent",boxShadow:discoverTab==="events"?"0 1px 3px rgba(0,0,0,0.15)":"none",display:"flex",alignItems:"center"}}>
              <DPadIcon id="event" color={discoverTab==="events"?DPAD_COLORS.event:"#999"} size={28}/>
            </button>
          </div>
        </div>
        <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:2}}>
          {FEED_CATS.map(c=>(
            <button key={c} onClick={()=>toggleFeedCat(c)} style={{...TAG(feedCats.includes(c)),whiteSpace:"nowrap",flexShrink:0,fontSize:12,padding:"4px 10px"}}>{c==="Following"?"👥 Following":c}</button>
          ))}
        </div>
        {/* Radius indicator — set in Profile Settings */}
        {radiusActive&&<div style={{display:"flex",alignItems:"center",gap:4,paddingTop:2,paddingBottom:2}}>
          <span style={{fontSize:11,color:"#111"}}>📍</span>
          <span style={{fontSize:11,color:"#111"}}>{appRadius} mi radius</span>
          <button onClick={()=>{go("profile");setTimeout(()=>setSubPanel("radius"),100);}} style={{fontSize:11,color:OR,fontWeight:700,background:"none",border:"none",cursor:"pointer",fontFamily:F}}>Change</button>
        </div>}
      </div>

      {/* Feed */}
      <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"10px 14px 24px"}}>
        {filtered.length===0 && feedCats.length===1 && feedCats[0]==="Following" && (
          <div style={{textAlign:"center",padding:"30px 20px",color:"#111"}}>
            <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><ProfileIcon id="people" size={34} color="#ddd"/></div>
            <div style={{fontSize:14,color:"#111"}}>No routes from people you follow yet.</div>
          </div>
        )}
        {filtered.length===0 && !(feedCats.length===1 && feedCats[0]==="Following") && radiusActive && posts.length>0 && (
          <div style={{textAlign:"center",padding:"30px 20px",color:"#111"}}>
            <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><ProfileIcon id="road" size={34} color="#ddd"/></div>
            <div style={{fontSize:14,color:"#111",marginBottom:4}}>No routes within {appRadius} mi.</div>
            <button onClick={()=>{go("profile");setSubPanel("edit");}} style={{fontSize:12,color:OR,fontWeight:700,background:"none",border:"none",cursor:"pointer",fontFamily:F}}>Widen your radius →</button>
          </div>
        )}
        {filtered.length===0 && !(feedCats.length===1 && feedCats[0]==="Following") && !(radiusActive && posts.length>0) && <><GhostPost/><GhostPost/><GhostPost/></>}
        {filtered.map(post=>(
          <div key={post.id} onClick={()=>setViewRouteId(post.id)} style={{...CARD,padding:0,overflow:"hidden",cursor:"pointer"}}>
            {post.photos?.length>0 && (
              <div style={{display:"grid",gridTemplateColumns: post.photos.length===1?"1fr":"1fr 1fr",gap:2}}>
                {post.photos.slice(0,4).map((p,i)=>(
                  <img key={i} src={p.url} alt="" style={{width:"100%",height: post.photos.length===1?160:100,objectFit:"cover",display:"block"}}/>
                ))}
              </div>
            )}
            <div style={{padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{fontSize:11,color:"#fff",background:OR,borderRadius:20,padding:"2px 7px",fontWeight:700,textTransform:"uppercase"}}>{post.type}</span>
                {post.fromSaved && <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>🗺️ {post.savedRouteName}</span>}
                {post.distance && <span style={{fontSize:11,color:"#111"}}>{post.distance}</span>}
                {post.authorId!=="me" && <span style={{fontSize:11,color:"#111",marginLeft:"auto"}}>📍 {milesAwayFor(post.id)} mi away</span>}
                {post.authorId==="me" && (
                  <button onClick={e=>{e.stopPropagation();openEditPost(post);}} title="Edit route" style={{marginLeft:"auto",width:24,height:24,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                )}
              </div>
              <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:2}}>{post.title}</div>
              {post.authorId!=="me" && <div style={{fontSize:12,color:"#8a8f98",marginBottom:post.body?5:6}}>Posted by {post.authorName||"a driver"}</div>}
              {post.body && <div style={{fontSize:14,color:"#111",lineHeight:1.6,marginBottom:6}}>{post.body}</div>}
              {post.highlights && <div style={{fontSize:13,color:"#111",fontStyle:"italic",marginBottom:6}}>✨ {post.highlights}</div>}
              {post.stops?.length>0 && (
                <>
                  <div onClick={e=>e.stopPropagation()}><RouteMap route={post} height={120}/></div>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap",margin:"8px 0"}}>
                    {post.stops.map((s,i)=><span key={i} style={{fontSize:11,background:"#f3f3f3",border:"1px solid #ebebeb",borderRadius:20,padding:"2px 8px",color:"#111"}}>📍 {s}</span>)}
                  </div>
                </>
              )}
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <button onClick={e=>{e.stopPropagation();startRouteDirections(post);}} style={{padding:"5px 12px",borderRadius:20,fontSize:13,fontWeight:700,background:OR,color:"#fff",border:"none",cursor:"pointer",fontFamily:F}}>🧭 Get Directions</button>
                <button onClick={e=>{e.stopPropagation();setLikedPosts(l=>({...l,[post.id]:!l[post.id]}));}} style={{...TAG(likedPosts[post.id]),padding:"5px 12px",fontSize:13}}>♥ {(post.likes||0)+(likedPosts[post.id]?1:0)}</button>
                <button onClick={e=>{
                  e.stopPropagation();
                  const already=savedFromFeed.some(r=>r.feedId===post.id);
                  if(already){setSavedFromFeed(s=>s.filter(r=>r.feedId!==post.id));}
                  else{
                    setSavedFromFeed(s=>[...s,{
                      id:Date.now(), feedId:post.id,
                      title:post.title, type:post.type,
                      distance:post.distance||"", stops:post.stops||[],
                      highlights:post.highlights||"", body:post.body||"",
                      color:["#6366f1","#22c55e","#a855f7","#f97316","#ec4899"][s.length%5],
                    }]);
                  }
                }} style={{
                  padding:"5px 12px",borderRadius:20,fontSize:13,fontWeight:600,cursor:"pointer",
                  background:savedFromFeed.some(r=>r.feedId===post.id)?"#22c55e":"#f3f3f3",
                  color:savedFromFeed.some(r=>r.feedId===post.id)?"#fff":"#888",
                  border:"none",fontFamily:F,
                }}>
                  {savedFromFeed.some(r=>r.feedId===post.id)?"✓ Saved":"🗺️ Save Route"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Route Info — full-screen page opened by tapping a route card,
          expanding it out of the feed entirely. Every route is yours, so
          it always offers an Edit action. */}
      {viewRouteId && (() => {
        const vr = posts.find(p=>p.id===viewRouteId);
        if(!vr) return null;
        return (
          <div style={{position:"fixed",inset:0,background:"#fff",zIndex:750,display:"flex",flexDirection:"column",paddingTop:"env(safe-area-inset-top, 0px)",boxSizing:"border-box"}}>
            <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #ebebeb",flexShrink:0}}>
              <button onClick={()=>setViewRouteId(null)} style={{fontSize:20,background:"none",border:"none",color:"#111",cursor:"pointer"}}>←</button>
              <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{vr.title}</div>
              {vr.authorId==="me" && (
                <button onClick={()=>{setViewRouteId(null);openEditPost(vr);}} title="Edit route" style={{width:34,height:34,borderRadius:"50%",fontSize:18,background:"none",color:"#111",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
              )}
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"0 0 24px"}}>
              {vr.photos?.length>0 && (
                <div style={{display:"grid",gridTemplateColumns: vr.photos.length===1?"1fr":"1fr 1fr",gap:2}}>
                  {vr.photos.slice(0,4).map((p,i)=>(
                    <img key={i} src={p.url} alt="" style={{width:"100%",height: vr.photos.length===1?220:150,objectFit:"cover",display:"block"}}/>
                  ))}
                </div>
              )}
              <div style={{padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:"#fff",background:OR,borderRadius:20,padding:"2px 7px",fontWeight:700,textTransform:"uppercase"}}>{vr.type}</span>
                  {vr.fromSaved && <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>🗺️ {vr.savedRouteName}</span>}
                  {vr.distance && <span style={{fontSize:12,color:"#111"}}>{vr.distance}</span>}
                </div>
                {vr.authorId!=="me" && <div style={{fontSize:13,color:"#8a8f98",marginBottom:10}}>Posted by {vr.authorName||"a driver"}</div>}
                {vr.body && <div style={{fontSize:15,color:"#111",lineHeight:1.7,marginBottom:10}}>{vr.body}</div>}
                {vr.highlights && <div style={{fontSize:14,color:"#111",fontStyle:"italic",marginBottom:10}}>✨ {vr.highlights}</div>}
                {vr.stops?.length>0 && (
                  <>
                    <div style={{margin:"0 -16px 10px"}}><RouteMap route={vr} height={220} interactive/></div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
                      {vr.stops.map((s,i)=><span key={i} style={{fontSize:12,background:"#f3f3f3",border:"1px solid #ebebeb",borderRadius:20,padding:"4px 10px",color:"#111"}}>📍 {s}</span>)}
                    </div>
                  </>
                )}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>startRouteDirections(vr)} style={{flex:1,padding:"11px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F}}>🧭 Get Directions</button>
                  <button onClick={()=>setLikedPosts(l=>({...l,[vr.id]:!l[vr.id]}))} style={{...TAG(likedPosts[vr.id]),padding:"11px 16px",fontSize:14}}>♥ {(vr.likes||0)+(likedPosts[vr.id]?1:0)}</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Create Route Post sheet — doubles as the Edit Route sheet whenever
          editingPostId is set (opened via a route card's pencil). */}
      {showPost && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={closePostSheet}>
          <div style={{background:"#fff",borderRadius:"22px 22px 0 0",width:"100%",maxHeight:"94vh",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>

            {/* Header */}
            <div style={{padding:"10px 16px 12px",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
              <div style={{width:32,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 10px"}}/>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{fontSize:17,fontWeight:800,color:"#111"}}>{editingPostId?"Edit Route":"Create Route Post"}</div>
                <button onClick={closePostSheet} style={{width:26,height:26,borderRadius:13,border:"none",background:"#f2f2f2",color:"#666",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✕</button>
              </div>
            </div>

            <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>

              {/* Add from Saved Routes button — always visible */}
              <button onClick={()=>setShowRoutePicker(true)} style={{
                width:"100%",display:"flex",alignItems:"center",gap:10,
                padding:"11px 14px",borderRadius:12,marginBottom:16,
                background:postSavedRoute?"#fff9f5":OR+"0a",
                border:"1.5px solid "+(postSavedRoute?OR:"#e0e0e0"),
                cursor:"pointer",fontFamily:F,textAlign:"left",
              }}>
                <div style={{width:32,height:32,borderRadius:9,background:postSavedRoute?OR:"#f3f3f3",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                  🗺️
                </div>
                <div style={{flex:1,minWidth:0}}>
                  {postSavedRoute && routes.find(x=>x.id===postSavedRoute) ? (
                    <>
                      <div style={{fontSize:13,fontWeight:700,color:OR}}>Auto-filled from saved route</div>
                      <div style={{fontSize:12,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{routes.find(x=>x.id===postSavedRoute)?.title}{routes.find(x=>x.id===postSavedRoute)?.distance?" · "+routes.find(x=>x.id===postSavedRoute).distance:""}</div>
                    </>
                  ) : (
                    <>
                      <div style={{fontSize:13,fontWeight:700,color:"#111"}}>Add from My Saved Routes</div>
                      <div style={{fontSize:12,color:"#111"}}>Auto-fill title, type & distance</div>
                    </>
                  )}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
                  {postSavedRoute && <button onClick={e=>{e.stopPropagation();setPostSavedRoute(null);setNewPost(p=>({...p,title:"",distance:""}));}} style={{padding:"3px 8px",borderRadius:20,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",fontSize:12,cursor:"pointer",fontFamily:F}}>× Clear</button>}
                  <div style={{fontSize:16,color:"#111"}}>›</div>
                </div>
              </button>

              {/* Route picker sheet */}
              {showRoutePicker && (
                <div onClick={()=>setShowRoutePicker(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:900,display:"flex",alignItems:"flex-end"}}>
                  <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",maxHeight:"70vh",display:"flex",flexDirection:"column"}}>
                    <div style={{padding:"10px 16px 12px",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
                      <div style={{width:28,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 10px"}}/>
                      <div style={{fontSize:16,fontWeight:800,color:"#111"}}>My Saved Routes</div>
                      <div style={{fontSize:12,color:"#111",marginTop:2}}>Tap a route to auto-fill the form</div>
                    </div>
                    <div style={{flex:1,overflowY:"auto",padding:"10px 14px 24px"}}>
                      {routes.length===0 ? (
                        <div style={{textAlign:"center",padding:"30px 20px",color:"#111"}}>
                          <div style={{fontSize:38,marginBottom:8}}>🗺️</div>
                          <div style={{fontSize:14,color:"#111",marginBottom:12}}>No saved routes yet.</div>
                          <button onClick={()=>{setShowRoutePicker(false);setShowPost(false);go("profile");setTimeout(()=>setSubPanel("routes"),100);}} style={{padding:"8px 18px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>Save a Route First</button>
                        </div>
                      ) : routes.map(r=>(
                        <button key={r.id} onClick={()=>{
                          setPostSavedRoute(r.id);
                          setNewPost(p=>({...p,title:r.title,type:r.type||p.type,distance:r.distance||""}));
                          setShowRoutePicker(false);
                        }} style={{
                          width:"100%",display:"flex",alignItems:"center",gap:12,
                          padding:"12px 14px",marginBottom:8,borderRadius:12,
                          border:"1.5px solid "+(postSavedRoute===r.id?OR:"#ebebeb"),
                          background:postSavedRoute===r.id?OR+"08":"#f8f8f8",
                          cursor:"pointer",fontFamily:F,textAlign:"left",
                        }}>
                          <div style={{width:10,height:10,borderRadius:"50%",background:r.color||OR,flexShrink:0}}/>
                          <div style={{flex:1}}>
                            <div style={{fontSize:15,fontWeight:700,color:"#111"}}>{r.title}</div>
                            <div style={{fontSize:12,color:"#111",marginTop:2}}>{r.type}{r.distance?" · "+r.distance:""}</div>
                          </div>
                          {postSavedRoute===r.id
                            ? (<div style={{width:22,height:22,borderRadius:"50%",background:OR,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#fff",flexShrink:0}}>✓</div>)
                            : (<div style={{fontSize:16,color:"#111",flexShrink:0}}>›</div>)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Dashcam footage share */}
              {clips.length>0 && (
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>SHARE DASHCAM FOOTAGE</div>
                  <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:2}}>
                    {clips.map(c=>{
                      const attached=postPhotos.some(p=>p.clipId===c.id);
                      return (
                        <button key={c.id} onClick={()=>{
                          if(attached) setPostPhotos(ps=>ps.filter(p=>p.clipId!==c.id));
                          else if(postPhotos.length<4) setPostPhotos(ps=>[...ps,{url:c.url,clipId:c.id,isClip:true}]);
                        }} style={{
                          flexShrink:0,width:80,height:80,borderRadius:10,overflow:"hidden",
                          position:"relative",border:"2px solid "+(attached?OR:"transparent"),
                          cursor:"pointer",background:"#000",padding:0,
                        }}>
                          <video src={c.url} muted style={{width:"100%",height:"100%",objectFit:"cover",opacity:0.7,display:"block",pointerEvents:"none"}}/>
                          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                            <span style={{fontSize:attached?18:16,color:"#fff"}}>{attached?"✓":"📹"}</span>
                          </div>
                          <div style={{position:"absolute",bottom:2,left:0,right:0,textAlign:"center",fontSize:9,color:"#fff",fontWeight:700}}>{c.date}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Photos */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>PHOTOS (up to 4)</div>
              <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto"}}>
                {postPhotos.filter(p=>!p.isClip).map((p,i)=>(
                  <div key={i} style={{width:80,height:80,borderRadius:10,overflow:"hidden",flexShrink:0,position:"relative"}}>
                    <img src={p.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                    <button onClick={()=>setPostPhotos(ps=>ps.filter((_,j)=>j!==i))} style={{position:"absolute",top:3,right:3,width:16,height:16,borderRadius:"50%",background:"rgba(0,0,0,0.55)",border:"none",color:"#fff",fontSize:11,cursor:"pointer"}}>×</button>
                  </div>
                ))}
                {postPhotos.filter(p=>!p.isClip).length<4 && (
                  <button onClick={()=>postPhotoRef.current?.click()} style={{width:80,height:80,borderRadius:10,border:"1.5px dashed #ddd",background:"#f8f8f8",fontSize:24,color:"#111",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                )}
                <input ref={postPhotoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>Array.from(e.target.files||[]).slice(0,4-postPhotos.filter(p=>!p.isClip).length).forEach(f=>{readImageCompressed(f).then(url=>{if(url)setPostPhotos(p=>[...p,{url}]);});})}/>
              </div>

              {/* Route title */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:5}}>ROUTE TITLE *</div>
              <input value={newPost.title} onChange={e=>setNewPost(p=>({...p,title:e.target.value}))} placeholder="e.g. Sunset PCH Run" style={{...INP,marginBottom:10}}/>

              {/* Type */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>ROUTE TYPE</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                {["scenic","hike","commute","home","road trip","bike","chill"].map(t=><button key={t} onClick={()=>setNewPost(p=>({...p,type:t}))} style={TAG(newPost.type===t)}>{t}</button>)}
              </div>

              {/* Distance */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:5}}>DISTANCE</div>
              <input value={newPost.distance} onChange={e=>setNewPost(p=>({...p,distance:e.target.value}))} placeholder="e.g. 42 miles" style={{...INP,marginBottom:10}}/>

              {/* Stops */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:6}}>KEY STOPS</div>
              {newPost.stops.map((stop,i)=>(
                <div key={i} style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:OR+"22",border:"1px solid "+OR+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:OR,flexShrink:0}}>{i+1}</div>
                  <input value={stop} onChange={e=>setNewPost(p=>({...p,stops:p.stops.map((s,j)=>j===i?e.target.value:s)}))} placeholder={"Stop "+(i+1)+" (e.g. Malibu Beach)"} style={{...INP,flex:1}}/>
                  {newPost.stops.length>1 && <button onClick={()=>setNewPost(p=>({...p,stops:p.stops.filter((_,j)=>j!==i)}))} style={{padding:"5px 8px",borderRadius:8,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontSize:12}}>✕</button>}
                </div>
              ))}
              {newPost.stops.length<6 && (
                <button onClick={()=>setNewPost(p=>({...p,stops:[...p.stops,""]}))} style={{width:"100%",padding:"7px",borderRadius:9,border:"1.5px dashed #ddd",background:"#f8f8f8",color:"#111",fontSize:13,cursor:"pointer",marginBottom:10,fontFamily:F}}>+ Add Stop</button>
              )}

              {/* Story */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:5}}>YOUR STORY</div>
              <textarea value={newPost.body} onChange={e=>setNewPost(p=>({...p,body:e.target.value}))} placeholder="What made this route special? Describe the drive…" rows={3} style={{...INP,resize:"none",marginBottom:10}}/>

              {/* Highlight */}
              <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:5}}>BEST HIGHLIGHT</div>
              <input value={newPost.highlights} onChange={e=>setNewPost(p=>({...p,highlights:e.target.value}))} placeholder="e.g. The ocean view at mile 12 was unreal" style={{...INP,marginBottom:16}}/>

              {/* Submit */}
              <button onClick={submitPost} style={{width:"100%",padding:"13px",borderRadius:11,background:OR,color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F}}>{editingPostId?"✓ Save Changes":"📤 Post Route"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
    );
  });

  /* ── EVENTS FEED ── */
  const MapPanel = useStablePanel(() => {
    // Multi-select category filter — tap "All" to reset, tap any other chip to
    // toggle it in/out of the active set (events matching ANY selected chip show).
    const [evFilters, setEvFilters] = useState(["All"]);
    const toggleEvFilter = t => {
      if (t === "All") { setEvFilters(["All"]); return; }
      setEvFilters(prev => {
        const withoutAll = prev.filter(x => x !== "All");
        const next = withoutAll.includes(t) ? withoutAll.filter(x => x !== t) : [...withoutAll, t];
        return next.length ? next : ["All"];
      });
    };
    const [userLoc,  setUserLoc]  = useState(null);
    const [locErr,   setLocErr]   = useState(false);





    // Geocode an address to lat/lng using Google Maps Geocoding (no key needed for display)
    // Since we don't have a geocoding key, we'll show radius as a preference label
    // and note when location is/isn't available
    const filtered = events.filter(ev => {
      const ms = !evSearch || ev.title.toLowerCase().includes(evSearch.toLowerCase()) || (ev.address||"").toLowerCase().includes(evSearch.toLowerCase());
      const mf = evFilters.includes("All") ? true
        : evFilters.some(t => t==="Following" ? following.some(f=>f.id===ev.authorId) : ev.type===t);
      const mr = !radiusActive || ev.authorId==="me" || milesAwayFor(ev.id)<=appRadius;
      return ms && mf && mr;
    });

    return (
      <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f8f8f8",overflow:"hidden"}}>
        {/* Header */}
        <div style={{padding:"10px 14px 8px",background:"#fff",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:17,fontWeight:900,color:"#111",display:"flex",alignItems:"center",gap:7}}><DPadIcon id="event" color={DPAD_COLORS.event} size={16}/> Events</div>
            </div>
            {/* Routes/Events toggle — now lives up here since the main nav moved to the bottom */}
            <div style={{display:"flex",gap:4,background:"#f3f3f3",borderRadius:40,padding:4,flexShrink:0}}>
              <button onClick={()=>setDiscoverTab("routes")} title="Routes" style={{padding:"14px 22px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,background:discoverTab==="routes"?"#fff":"transparent",boxShadow:discoverTab==="routes"?"0 1px 3px rgba(0,0,0,0.15)":"none",display:"flex",alignItems:"center"}}>
                <DPadIcon id="road" color={discoverTab==="routes"?DPAD_COLORS.road:"#999"} size={28}/>
              </button>
              <button onClick={()=>setDiscoverTab("events")} title="Events" style={{padding:"14px 22px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,background:discoverTab==="events"?"#fff":"transparent",boxShadow:discoverTab==="events"?"0 1px 3px rgba(0,0,0,0.15)":"none",display:"flex",alignItems:"center"}}>
                <DPadIcon id="event" color={discoverTab==="events"?DPAD_COLORS.event:"#999"} size={28}/>
              </button>
            </div>
          </div>
          {/* Category filter */}
          <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:6}}>
            {["All","Following",...Object.keys(EV_ICONS)].map(t=>(
              <button key={t} onClick={()=>toggleEvFilter(t)} style={{...TAG(evFilters.includes(t)),whiteSpace:"nowrap",flexShrink:0,fontSize:12,padding:"4px 10px",background:evFilters.includes(t)?(EV_COLORS[t]||OR):"#f3f3f3"}}>{t==="All"?"All":t==="Following"?"👥 Following":EV_ICONS[t]+" "+t}</button>
            ))}
          </div>
          {/* Radius indicator — set in Profile Settings */}
          {radiusActive&&<div style={{display:"flex",alignItems:"center",gap:4,paddingTop:2,paddingBottom:2}}>
            <span style={{fontSize:11,color:"#111"}}>📍</span>
            <span style={{fontSize:11,color:"#111"}}>{appRadius} mi radius</span>
            <button onClick={()=>{go("profile");setTimeout(()=>setSubPanel("radius"),100);}} style={{fontSize:11,color:OR,fontWeight:700,background:"none",border:"none",cursor:"pointer",fontFamily:F}}>Change</button>
          </div>}
        </div>

        {/* Feed */}
        <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"10px 12px 7px"}}>
          {filtered.length===0 && events.length===0 && (
            <div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                <GhostCard/><GhostCard/><GhostCard/><GhostCard/>
              </div>
            </div>
          )}
          {filtered.length===0 && events.length>0 && evFilters.length===1 && evFilters[0]==="Following" && (
            <div style={{textAlign:"center",padding:"40px 20px",color:"#111"}}>
              <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><ProfileIcon id="people" size={34} color="#ddd"/></div>
              <div style={{fontSize:14,color:"#111"}}>No events from people you follow yet.</div>
            </div>
          )}
          {filtered.length===0 && events.length>0 && !(evFilters.length===1 && evFilters[0]==="Following") && radiusActive && !evSearch && (
            <div style={{textAlign:"center",padding:"40px 20px",color:"#111"}}>
              <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><DPadIcon id="event" color="#ddd" size={34}/></div>
              <div style={{fontSize:14,color:"#111",marginBottom:4}}>No events within {appRadius} mi.</div>
              <button onClick={()=>{go("profile");setSubPanel("edit");}} style={{fontSize:12,color:OR,fontWeight:700,background:"none",border:"none",cursor:"pointer",fontFamily:F}}>Widen your radius →</button>
            </div>
          )}
          {filtered.length===0 && events.length>0 && !(evFilters.length===1 && evFilters[0]==="Following") && !(radiusActive && !evSearch) && (
            <div style={{textAlign:"center",padding:"40px 20px",color:"#111"}}>
              <div style={{fontSize:34,marginBottom:8}}>🔍</div>
              <div style={{fontSize:14,color:"#111"}}>No events match your search.</div>
            </div>
          )}
          {filtered.map((ev,idx) => {
            const accent = EV_COLORS[ev.type]||OR;
            return (
              <div key={ev.id} onClick={()=>setFlyerEvent(ev)} style={{background:"#fff",borderRadius:16,marginBottom:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,0.06)",cursor:"pointer"}}>
                {/* Cover photo */}
                <div style={{height:180,position:"relative",background:ev.photos?.length?"#111":"linear-gradient(145deg,"+accent+"cc,"+accent+"55)"}}>
                    {ev.photos?.length>0 && <img src={ev.photos[0].url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>}
                    {!ev.photos?.length && <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:58}}>{ev.icon}</div>}
                    {/* Type badge */}
                    <div style={{position:"absolute",top:12,left:12,background:accent,borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:800,color:"#fff",textTransform:"uppercase",letterSpacing:0.3}}>{ev.type}</div>
                    {/* Live dot — only when the event's date is today, not on every event */}
                    {isLiveEvent(ev.date) && (
                      <div style={{position:"absolute",top:12,right:12,display:"flex",alignItems:"center",gap:4,background:"rgba(0,0,0,0.5)",borderRadius:20,padding:"3px 8px"}}>
                        <span style={{width:5,height:5,borderRadius:"50%",background:"#ef4444",boxShadow:"0 0 5px #ef4444",display:"block"}}/>
                        <span style={{fontSize:10,color:"#fff",fontWeight:700}}>LIVE</span>
                      </div>
                    )}
                </div>
                {/* Post body */}
                <div style={{padding:"12px 14px 14px"}}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:ev.address?5:8}}>
                    <div style={{fontSize:18,fontWeight:900,color:"#111",lineHeight:1.2,flex:1}}>{ev.title}</div>
                    {ev.authorId!=="me" && <span style={{fontSize:11,color:"#111",flexShrink:0,paddingTop:3}}>📍 {milesAwayFor(ev.id)} mi</span>}
                    {ev.authorId==="me" && (
                      <button onClick={e=>{e.stopPropagation();openEditEvent(ev);}} title="Edit event" style={{width:26,height:26,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                    )}
                  </div>
                  {ev.authorId!=="me" && <div style={{fontSize:12,color:"#8a8f98",marginBottom:4}}>Posted by {ev.authorName||"a driver"}</div>}
                  {ev.date && <div style={{fontSize:12,color:"#111",fontWeight:600,marginBottom:5}}>📅 {new Date(ev.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>}
                  {ev.address && (
                    <button onClick={e=>{e.stopPropagation();openMaps(ev.address);}} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",padding:0,marginBottom:8,fontFamily:F}}>
                      <span style={{fontSize:12,color:"#22c55e",fontWeight:600}}>📍 {ev.address}</span>
                      <span style={{fontSize:11,color:"#22c55e"}}>›</span>
                    </button>
                  )}
                  {ev.desc && <div style={{fontSize:14,color:"#111",lineHeight:1.65,marginBottom:10}}>{ev.desc}</div>}
                  {/* Actions */}
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <button onClick={e=>{e.stopPropagation();setFlyerEvent(ev);}} style={{flex:1,padding:"9px",borderRadius:9,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>⚡ View Event</button>
                    {ev.address && <button onClick={e=>{e.stopPropagation();openMaps(ev.address);}} style={{flex:1,padding:"9px",borderRadius:9,background:"#4285F4",color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>🚗 Directions</button>}
                    {isFutureEvent(ev.date) && (
                      <button onClick={e=>{e.stopPropagation();toggleRsvp(ev.id);}} style={{flex:1,padding:"9px",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,border:"none",background:rsvpedEvents[ev.id]?"#22c55e":"#f3f3f3",color:rsvpedEvents[ev.id]?"#fff":"#111"}}>{rsvpedEvents[ev.id]?"✓ Going":"✋ RSVP"} · {(ev.rsvps||0)+(rsvpedEvents[ev.id]?1:0)}</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Flyer overlay */}
        {flyerEvent && (
          <div onClick={()=>setFlyerEvent(null)} style={{position:"fixed",inset:0,zIndex:800,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"flex-end"}}>
            <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxHeight:"92vh",background:"#fff",borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",overflow:"hidden"}}>
              <div style={{height:210,position:"relative",overflow:"hidden",flexShrink:0,background:flyerEvent.photos?.length?"#111":"linear-gradient(160deg,"+(EV_COLORS[flyerEvent.type]||OR)+","+(EV_COLORS[flyerEvent.type]||OR)+"55,#111)"}}>
                {flyerEvent.photos?.length>0 && <img src={flyerEvent.photos[0].url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>}
                {!flyerEvent.photos?.length && <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:66}}>{flyerEvent.icon}</div>}
                <div style={{position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",width:36,height:4,borderRadius:2,background:"rgba(255,255,255,0.5)"}}/>
                <button onClick={()=>setFlyerEvent(null)} style={{position:"absolute",top:14,right:14,width:30,height:30,borderRadius:"50%",background:"rgba(0,0,0,0.5)",border:"none",color:"#fff",fontSize:17,cursor:"pointer"}}>×</button>
                <div style={{position:"absolute",bottom:14,left:14,background:EV_COLORS[flyerEvent.type]||OR,borderRadius:20,padding:"4px 12px",fontSize:12,fontWeight:800,color:"#fff",textTransform:"uppercase"}}>{flyerEvent.type}</div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"18px 18px 7px"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:4}}>
                  <div style={{fontSize:24,fontWeight:900,color:"#111",lineHeight:1.2,flex:1}}>{flyerEvent.title}</div>
                  {flyerEvent.authorId==="me" && (
                    <button onClick={()=>openEditEvent(flyerEvent)} title="Edit event" style={{width:32,height:32,borderRadius:"50%",background:"#f3f3f3",border:"none",color:"#111",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✎</button>
                  )}
                </div>
                {flyerEvent.authorId!=="me" && <div style={{fontSize:13,color:"#8a8f98",marginBottom:8}}>Posted by {flyerEvent.authorName||"a driver"}</div>}
                {flyerEvent.date && <div style={{fontSize:13,color:"#111",fontWeight:600,marginBottom:10}}>📅 {new Date(flyerEvent.date+"T00:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})}</div>}
                {flyerEvent.address && (
                  <button onClick={()=>openMaps(flyerEvent.address)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:13,background:"#f0fdf4",border:"1.5px solid #22c55e33",cursor:"pointer",fontFamily:F,marginBottom:14,textAlign:"left"}}>
                    <div style={{width:38,height:38,borderRadius:10,background:"#22c55e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🗺️</div>
                    <div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:700,color:"#22c55e",marginBottom:1}}>Get Directions</div><div style={{fontSize:12,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{flyerEvent.address}</div></div>
                    <div style={{fontSize:20,color:"#22c55e"}}>›</div>
                  </button>
                )}
                {flyerEvent.desc && <div style={{fontSize:15,color:"#111",lineHeight:1.7,marginBottom:16}}>{flyerEvent.desc}</div>}
                {flyerEvent.photos?.length>1 && (
                  <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto"}}>
                    {flyerEvent.photos.map((p,i)=><img key={i} src={p.url} alt="" style={{width:70,height:70,borderRadius:10,objectFit:"cover",flexShrink:0}}/>)}
                  </div>
                )}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {flyerEvent.address && <button onClick={()=>openMaps(flyerEvent.address)} style={{flex:2,padding:"13px",borderRadius:12,background:"#4285F4",color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F}}>🚗 Start Route</button>}
                  {isFutureEvent(flyerEvent.date) && (
                    <button onClick={()=>toggleRsvp(flyerEvent.id)} style={{flex:1,padding:"13px",borderRadius:12,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F,border:"none",background:rsvpedEvents[flyerEvent.id]?"#22c55e":"#f3f3f3",color:rsvpedEvents[flyerEvent.id]?"#fff":"#111"}}>{rsvpedEvents[flyerEvent.id]?"✓ Going":"✋ RSVP"} · {(flyerEvent.rsvps||0)+(rsvpedEvents[flyerEvent.id]?1:0)}</button>
                  )}
                  <button onClick={()=>setFlyerEvent(null)} style={{flex:1,padding:"13px",borderRadius:12,background:"#f3f3f3",color:"#111",border:"1px solid #ebebeb",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F}}>Close</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Create event sheet */}
        {showEvent && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:700,display:"flex",alignItems:"flex-end"}} onClick={closeEventSheet}>
            <div style={{background:"#fff",borderRadius:"22px 22px 0 0",width:"100%",maxHeight:"90%",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
              <div style={{width:32,height:3,background:"#e0e0e0",borderRadius:2,margin:"12px auto",flexShrink:0}}/>
              <div style={{padding:"0 16px 10px",borderBottom:"1px solid #ebebeb",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{fontSize:17,fontWeight:800,color:"#111"}}>{editingEventId?"Edit Event":"⚡ Create Event"}</div>
                <button onClick={closeEventSheet} style={{width:26,height:26,borderRadius:13,border:"none",background:"#f2f2f2",color:"#666",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✕</button>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>
                <div style={{display:"flex",gap:8,marginBottom:12}}>
                  {eventPhotos.map((p,i)=>(
                    <div key={i} style={{flex:1,height:80,borderRadius:10,overflow:"hidden",position:"relative"}}>
                      <img src={p.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      <button onClick={()=>setEventPhotos(ps=>ps.filter((_,j)=>j!==i))} style={{position:"absolute",top:3,right:3,width:16,height:16,borderRadius:"50%",background:"rgba(0,0,0,0.55)",border:"none",color:"#fff",fontSize:11,cursor:"pointer"}}>×</button>
                    </div>
                  ))}
                  {eventPhotos.length<3 && <button onClick={()=>eventPhotoRef.current?.click()} style={{flex:1,height:80,borderRadius:10,border:"1.5px dashed #ddd",background:"#f8f8f8",fontSize:26,color:"#111",cursor:"pointer"}}>+</button>}
                  {Array.from({length:Math.max(0,2-eventPhotos.length)}).map((_,i)=><div key={i} style={{flex:1,height:80,borderRadius:10,background:"#f5f5f5"}}/>)}
                  <input ref={eventPhotoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>Array.from(e.target.files||[]).slice(0,3-eventPhotos.length).forEach(f=>{readImageCompressed(f).then(url=>{if(url)setEventPhotos(p=>[...p,{url}]);});})}/>
                </div>
                <input value={newEvent.title} onChange={e=>setNewEvent(p=>({...p,title:e.target.value}))} placeholder="Event name *" style={{...INP,marginBottom:8}}/>
                <input value={newEvent.address} onChange={e=>setNewEvent(p=>({...p,address:e.target.value}))} placeholder="Address or venue" style={{...INP,marginBottom:8}}/>
                <input type="date" value={newEvent.date} onChange={e=>setNewEvent(p=>({...p,date:e.target.value}))} style={{...INP,marginBottom:8,color:newEvent.date?"#111":"#999"}}/>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                  {Object.keys(EV_ICONS).map(t=><button key={t} onClick={()=>setNewEvent(p=>({...p,type:t}))} style={{...TAG(newEvent.type===t),background:newEvent.type===t?(EV_COLORS[t]||OR):"#f3f3f3"}}>{EV_ICONS[t]} {t}</button>)}
                </div>
                <textarea value={newEvent.desc} onChange={e=>setNewEvent(p=>({...p,desc:e.target.value}))} placeholder="Description…" rows={3} style={{...INP,resize:"none",marginBottom:16}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={submitEvent} style={{flex:1,padding:"13px",borderRadius:11,background:OR,color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F}}>{editingEventId?"✓ Save Changes":"📍 Post Event"}</button>
                  <button onClick={closeEventSheet} style={{padding:"13px 16px",borderRadius:11,background:"#f3f3f3",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontFamily:F}}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  });

  /* ── DISCOVER — Routes feed + Events feed on one page; the Routes/Events
       toggle itself lives at the top of each page's own header (see the
       segmented control next to the title in FeedPanel/MapPanel below),
       now that the main Lanes/SonoLane/Discover nav moved to the bottom. ── */
  const DiscoverPanel = useStablePanel(() => (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {discoverTab==="routes" ? <FeedPanel/> : <MapPanel/>}
    </div>
  ));

  /* ── LANES / CB RADIO ── */
  const CreatePanel = useStablePanel(() => {
    const unreadNotifs = notifications.filter(n=>!n.read).length;
    const curFriend = friends.find(f=>f.id===activeChan);
    // Self-chat avatar/initials — "You" (notifications) uses the same
    // initials fallback as everywhere else your own avatar shows without a
    // photo (see the old notes-lane bubble this replaced).
    const myInitials = userName ? userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase() : "ME";
    const [pinnedChans, setPinnedChans] = usePersistedState("sl_pinnedChans", []);
    // Which section pill is showing on the chat list — "chats" (your
    // friends' DMs) is the default/main view, matching a normal messaging
    // app inbox; Lanes and Notifications are one tap away instead of
    // always being stacked below in their own always-visible sections.
    const [lanesListTab, setLanesListTab] = useState("chats");
    const togglePin = (id) => setPinnedChans(p => p.includes(id) ? p.filter(x=>x!==id) : [...p, id]);
    const sortPinned = (list) => {
      const pinned = list.filter(x=>pinnedChans.includes(x.id));
      const rest = list.filter(x=>!pinnedChans.includes(x.id));
      return [...pinned, ...rest];
    };
    // Public lanes near you — your own public-visibility lanes always show;
    // other community-created ones are filtered by the discovery radius,
    // same as posts/events (see milesAwayFor). This is the "Public Lanes"
    // browse section: a live network of public proximity chats, like
    // freeway CB channels but for any lane, not just a freeway.
    // Shared Garage group chats are real lanes (so all the existing chat
    // plumbing just works) but they're opened from the garage page, not
    // browsed here, so they're kept out of the My Lanes list.
    const sidebarCustomLanes = customLanes.filter(l=>!l.garageId);
    const myPublicLanes = customLanes.filter(l=>l.visibility==="public" && !l.garageId);
    const communityPublicLanes = SEED_PUBLIC_LANES.filter(l=>!radiusActive || milesAwayFor(l.id)<=appRadius);
    const publicLanes = [...myPublicLanes, ...communityPublicLanes];

    const curCustomLane = customLanes.find(l=>l.id===activeChan) || communityPublicLanes.find(l=>l.id===activeChan);
    const curCityLane = CB_CITY_LANES.find(l=>l.id===activeChan);
    const curLane = curCityLane || curCustomLane;
    const laneLocked = !!curCityLane && curCityLane.id!==currentFreewayId; // view-only until location matches this freeway
    const isLaneChat = !!(curCityLane || curCustomLane); // a broadcast/group lane, vs. notes/Sono AI/a friend DM

    // Lane chats default to a walkie-talkie style layout — a big hold-to-talk
    // circle instead of a text bar. The keyboard icon in its corner switches
    // to typing; switching lanes resets back to voice by default.
    const [chatInputMode, setChatInputMode] = useState("voice"); // "voice" | "text"
    // Real voice-message recording for the lane walkie-talkie button — tap
    // once to start, tap again while recording to pause (so you can listen
    // back to what's captured so far), tap again while paused to keep
    // going, or hit Send at any point to stop and send it. Backed by real
    // getUserMedia + MediaRecorder audio (see startLaneVoiceMsg etc below),
    // replacing the old hold-down/release simulated recording.
    const [laneRecPhase, setLaneRecPhase] = useState("idle"); // idle | recording | paused
    const [laneRecSeconds, setLaneRecSeconds] = useState(0);
    const [laneRecPreviewUrl, setLaneRecPreviewUrl] = useState(null);
    const laneRecMR = useRef(null);
    const laneRecChunks = useRef([]);
    const laneRecStream = useRef(null);
    const laneRecTimer = useRef(null);
    const laneRecPendingPause = useRef(false);
    // Playback for real recorded voice messages (msg.audioUrl) — one shared
    // <audio> element, tracking which message id is currently playing.
    const voiceAudioRef = useRef(null);
    const [playingVoiceId, setPlayingVoiceId] = useState(null);
    const toggleVoicePlayback = (msg) => {
      if (!msg.audioUrl) return;
      const audio = voiceAudioRef.current || (voiceAudioRef.current = new Audio());
      if (playingVoiceId === msg.id) { audio.pause(); setPlayingVoiceId(null); return; }
      audio.src = msg.audioUrl;
      audio.onended = () => setPlayingVoiceId(null);
      audio.play().catch(()=>{});
      setPlayingVoiceId(msg.id);
    };
    // Which voice messages have their transcript expanded, keyed by msg.id —
    // every voice clip has a simulated speech-to-text caption, shown only
    // when you tap to read it instead of playing it back.
    const [openTranscripts, setOpenTranscripts] = useState({});
    const toggleTranscript = id => setOpenTranscripts(p=>({...p,[id]:!p[id]}));
    useEffect(() => { setChatInputMode("voice"); }, [activeChan]);

    // Real backend — load this friend's message history when their DM is
    // opened, then keep polling so incoming messages actually show up
    // without needing to close and reopen the chat.
    useEffect(() => {
      if (!isSupabaseConfigured || !currentUserId || !curFriend) return;
      let cancelled = false;
      const load = async () => {
        const rows = await fetchMessagesSupabase(curFriend.id);
        if (cancelled || !rows.length) return;
        setFriendMsgs(m => {
          const known = new Set((m[curFriend.id]||[]).map(x=>String(x.id)));
          const mapped = rows.filter(r=>!known.has(String(r.id))).map(r => ({
            id: r.id, text: r.text, mine: r.sender_id === currentUserId,
            user: r.sender_id === currentUserId ? (userName||"You") : curFriend.name,
            initials: r.sender_id === currentUserId
              ? (userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?")
              : curFriend.initials,
            color: r.sender_id === currentUserId ? OR : curFriend.color,
            ts: new Date(r.created_at).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
            isVoice: false, voiceSeconds: 0,
          }));
          if (!mapped.length) return m;
          return { ...m, [curFriend.id]: [...(m[curFriend.id]||[]), ...mapped] };
        });
      };
      load();
      const iv = setInterval(load, 4000);
      return () => { cancelled = true; clearInterval(iv); };
    }, [curFriend?.id, currentUserId]);

    const sendChanMsg = (text, isVoice=false, voiceSecs=0) => {
      if(!text.trim() && !isVoice) return;
      if(curCityLane && curCityLane.id!==currentFreewayId) return; // must be on this freeway to talk
      const tempId = Date.now();
      const msg = {
        id:tempId, text:text.trim(), mine:true,
        user:userName||"You",
        initials:userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?",
        color:OR, ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
        isVoice, voiceSeconds:voiceSecs,
      };
      if(activeChan==="notes"){
        setTLines(p=>[...p, text.trim()]);
      } else if(curCityLane){
        // City/freeway lanes are keyed in laneMsgs only, same store the CB
        // Radio sheet writes to — keeps a saved lane's history in sync
        // whether it's opened from there or from this sidebar.
        setLaneMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));
      } else {
        setLaneMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));
        setFriendMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));
        // Real backend + this is an actual friend DM (not a custom lane) —
        // send it for real so the other person actually receives it, and
        // drop a notification in their feed.
        if (isSupabaseConfigured && curFriend && !isVoice) {
          const friendId = curFriend.id;
          sendMessageSupabase(friendId, text).then(realId => {
            // Swap the optimistic tempId for the DB's real row id so the
            // next poll (which dedupes by id) recognizes this message as
            // already-shown instead of appending it a second time.
            if (!realId) return;
            setFriendMsgs(m => {
              const list = m[friendId];
              if (!list) return m;
              return { ...m, [friendId]: list.map(x => x.id===tempId ? {...x, id:realId} : x) };
            });
          });
          sendNotificationSupabase(curFriend.id, "💬", (userName||"Someone")+" sent you a message.");
        }
      }
      setChanInput("");
    };

    // Real lane voice-message recording — tap-to-start / tap-to-pause /
    // Send-to-finish, replacing the old hold-to-talk simulated recording.
    const pickAudioMime = () => {
      if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
      const candidates = ["audio/mp4","audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus"];
      return candidates.find(c => { try { return MediaRecorder.isTypeSupported(c); } catch { return false; } }) || "";
    };
    const clearLaneRecTimer = () => { clearInterval(laneRecTimer.current); laneRecTimer.current = null; };
    const teardownLaneRec = () => {
      clearLaneRecTimer();
      if (laneRecStream.current) { laneRecStream.current.getTracks().forEach(t=>t.stop()); laneRecStream.current = null; }
      if (laneRecPreviewUrl) { try { URL.revokeObjectURL(laneRecPreviewUrl); } catch {} }
      laneRecChunks.current = [];
      laneRecMR.current = null;
      setLaneRecPhase("idle"); setLaneRecSeconds(0); setLaneRecPreviewUrl(null);
    };
    const startLaneVoiceMsg = async () => {
      if(curCityLane && curCityLane.id!==currentFreewayId) return; // must be on this freeway to talk
      if(laneRecPhase!=="idle") return;
      try{
        const stream = await navigator.mediaDevices.getUserMedia({audio:true});
        laneRecStream.current = stream;
        const mime = pickAudioMime();
        const mr = mime ? new MediaRecorder(stream,{mimeType:mime}) : new MediaRecorder(stream);
        laneRecChunks.current = [];
        mr.ondataavailable = e => {
          if(e.data && e.data.size>0) laneRecChunks.current.push(e.data);
          if(laneRecPendingPause.current){
            laneRecPendingPause.current = false;
            const usedMime = mr.mimeType || "audio/webm";
            const blob = new Blob(laneRecChunks.current, {type:usedMime});
            setLaneRecPreviewUrl(URL.createObjectURL(blob));
          }
        };
        laneRecMR.current = mr;
        mr.start(250);
        setLaneRecPhase("recording"); setLaneRecSeconds(0); setLaneRecPreviewUrl(null);
        laneRecTimer.current = setInterval(()=>setLaneRecSeconds(s=>s+1), 1000);
      }catch{
        // mic permission denied, or no mic available — silently no-op
      }
    };
    const pauseLaneVoiceMsg = () => {
      const mr = laneRecMR.current;
      if(!mr || laneRecPhase!=="recording") return;
      clearLaneRecTimer();
      setLaneRecPhase("paused");
      laneRecPendingPause.current = true;
      try{ mr.requestData(); }catch{ laneRecPendingPause.current = false; }
      try{ mr.pause(); }catch{}
    };
    const resumeLaneVoiceMsg = () => {
      const mr = laneRecMR.current;
      if(!mr || laneRecPhase!=="paused") return;
      if(laneRecPreviewUrl){ try{ URL.revokeObjectURL(laneRecPreviewUrl); }catch{} setLaneRecPreviewUrl(null); }
      try{ mr.resume(); }catch{}
      setLaneRecPhase("recording");
      laneRecTimer.current = setInterval(()=>setLaneRecSeconds(s=>s+1), 1000);
    };
    const cancelLaneVoiceMsg = () => {
      const mr = laneRecMR.current;
      if(mr){ try{ mr.onstop = null; mr.stop(); }catch{} }
      teardownLaneRec();
    };
    const sendLaneVoiceMsg = () => {
      const mr = laneRecMR.current;
      if(!mr || laneRecPhase==="idle") return;
      clearLaneRecTimer();
      const secs = laneRecSeconds;
      const laneId = activeChan;
      const wasLaneChat = isLaneChat;
      mr.onstop = () => {
        const usedMime = mr.mimeType || "audio/webm";
        const blob = new Blob(laneRecChunks.current, {type:usedMime});
        const audioUrl = URL.createObjectURL(blob);
        const msg = {
          id:Date.now(), text:"", mine:true,
          user:userName||"You",
          initials:userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?",
          color:OR,
          ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),
          isVoice:true, voiceSeconds:secs||1, audioUrl,
        };
        setLaneMsgs(m=>({...m,[laneId]:[...(m[laneId]||[]),msg]}));
        if(!wasLaneChat) setFriendMsgs(m=>({...m,[laneId]:[...(m[laneId]||[]),msg]})); // friend DM — keep both stores in sync, like text messages
        if(laneRecStream.current){ laneRecStream.current.getTracks().forEach(t=>t.stop()); laneRecStream.current = null; }
        laneRecChunks.current = [];
        laneRecMR.current = null;
        setLaneRecPhase("idle"); setLaneRecSeconds(0); setLaneRecPreviewUrl(null);
        // Simulate someone responding in city/custom lanes (CB effect)
        if(wasLaneChat) {
          const HANDLES=["SoCalDrifter","NightOwl_Mike","TruckDog99","FreewayFiona","CruiseCtrl","VanLife_KC"];
          const COLORS=["#6366f1","#22c55e","#a855f7","#14b8a6","#ec4899","#f59e0b"];
          const ri=Math.floor(Math.random()*HANDLES.length);
          setTimeout(()=>{
            const reply={id:Date.now()+1,text:"",mine:false,user:HANDLES[ri],initials:HANDLES[ri].slice(0,2).toUpperCase(),color:COLORS[ri],ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),isVoice:true,voiceSeconds:Math.floor(Math.random()*8)+2,transcript:VOICE_TRANSCRIPTS[Math.floor(Math.random()*VOICE_TRANSCRIPTS.length)]};
            setLaneMsgs(m=>({...m,[laneId]:[...(m[laneId]||[]),reply]}));
          }, 1400+Math.random()*1200);
        }
      };
      try{ mr.stop(); }catch{ teardownLaneRec(); }
    };
    // Don't leak an open mic stream if this chat panel unmounts mid-recording.
    useEffect(() => () => {
      if(laneRecStream.current) laneRecStream.current.getTracks().forEach(t=>t.stop());
      clearInterval(laneRecTimer.current);
    }, []);

    const allMsgs = activeChan==="notes"||activeChan==="notifications"||activeChan==="sono" ? [] : (friendMsgs[activeChan]||laneMsgs[activeChan]||[]);

    return (
      <div style={{flex:1,display:"flex",flexDirection:"row",overflow:"hidden",background:"#36393f",position:"relative"}}>

        {/* ── Chat list — its own full page now (was a fixed 196px sidebar
            always shown alongside the chat). Tapping any chat switches
            lanesView to "room"; the shared TopBar becomes that room's back
            button to return here. ── */}
        {lanesView==="list" && (
        <div style={{width:"100%",background:"#2f3136",display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden"}}>
          {/* The "Lanes" icon+title used to live here as its own header row —
              it's now the shared TopBar's centered title instead (see
              <TopBar/>), so this page starts straight at its own content. */}

          {/* Quick-access bubbles — "You" (notifications) and your AI pal
              are always here, pinned first and second respectively, since
              they're the two chats everyone always has; anything else you
              tap 📌 Pin on below shows up here right after them. Both used
              to also have their own rows in the Chats list below — those
              were removed so each chat lives in exactly one place instead
              of two (Law of Uniform Connectedness / avoiding duplication).
              Starting something new (a Lane, a Shared Garage, a Radio
              Channel) moved to the ＋ up in the header / Profile, instead of
              competing for space in a row about chats you already have
              (Law of Proximity: different kind of action, doesn't belong in
              this group anymore). */}
          <div style={{display:"flex",gap:14,padding:"12px 14px 10px",overflowX:"auto",flexShrink:0}}>
            <button onClick={()=>{setActiveChan("notifications");setLanesView("room");}} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",fontFamily:F,flexShrink:0,width:58}}>
              <div style={{position:"relative"}}>
                <FriendAvatar fr={{photo:profilePhoto,color:OR,initials:myInitials}} size={52} fontSize={19} style={{border:"2px solid "+(activeChan==="notifications"&&lanesView==="room"?OR:"#4f545c")}}/>
                {unreadNotifs>0 && <div style={{position:"absolute",top:-2,right:-2,minWidth:18,height:18,borderRadius:9,background:"#ed4245",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#fff",padding:"0 4px",border:"2px solid #2f3136",boxSizing:"border-box"}}>{unreadNotifs}</div>}
              </div>
              <span style={{fontSize:10,color:"#8e9297",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:58}}>You</span>
            </button>
            <button onClick={()=>{setActiveChan("sono");setLanesView("room");}} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",fontFamily:F,flexShrink:0,width:58}}>
              <div style={{width:52,height:52,borderRadius:"50%",background:pal.color+"22",border:"2px solid "+(activeChan==="sono"&&lanesView==="room"?pal.color:"#4f545c"),display:"flex",alignItems:"center",justifyContent:"center"}}>
                <CompassStar size={24} color={pal.color}/>
              </div>
              <span style={{fontSize:10,color:"#8e9297",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:58}}>{pal.name}</span>
            </button>
            {friends.filter(fr=>pinnedChans.includes(fr.id)).map(fr=>(
              <button key={fr.id} onClick={()=>{setActiveChan(fr.id);setLanesView("room");}} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",fontFamily:F,flexShrink:0,width:58}}>
                <FriendAvatar fr={fr} size={52} fontSize={19} style={{border:"2px solid "+(activeChan===fr.id&&lanesView==="room"?OR:"#4f545c")}}/>
                <span style={{fontSize:10,color:"#8e9297",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:58}}>{fr.name.split(" ")[0]}</span>
              </button>
            ))}
            {sidebarCustomLanes.filter(lane=>pinnedChans.includes(lane.id)).map(lane=>(
              <button key={lane.id} onClick={()=>{setActiveChan(lane.id);setLanesView("room");}} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",fontFamily:F,flexShrink:0,width:58}}>
                <div style={{width:52,height:52,borderRadius:"50%",background:"#40444b",border:"2px solid "+(activeChan===lane.id&&lanesView==="room"?OR:"#4f545c"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:lane.color||"#8e9297",fontWeight:700}}>#</div>
                <span style={{fontSize:10,color:"#8e9297",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:58}}>{lane.name}</span>
              </button>
            ))}
          </div>
          {/* Section pills — Chats (your friends, the main list) / Lanes
              (public + your own) / Radio (SonoLane Radio's saved stations
              and your own host registration, same content as Profile's
              Radio Stations page) — a toggle row instead of always-stacked
              section headers. Chats opens by default so your personal DMs
              are what you see first, like a normal messaging inbox.
              Notifications used to be a third pill here; it's the "You"
              chat now instead (see the Chats list above) — Law of Uniform
              Connectedness: activity about you reads as a conversation with
              you, not a separate inbox. */}
          <div style={{display:"flex",gap:8,padding:"2px 14px 12px",flexShrink:0,overflowX:"auto"}}>
            {[["chats","Chats"],["lanes","Lanes"],["radio","SonoLane Radio"]].map(([id,label])=>(
              <button key={id} onClick={()=>setLanesListTab(id)} style={{
                padding:"7px 16px",borderRadius:20,border:"none",cursor:"pointer",fontFamily:F,
                fontSize:13,fontWeight:700,whiteSpace:"nowrap",flexShrink:0,
                background:lanesListTab===id?"#fff":"#40444b",
                color:lanesListTab===id?"#111":"#dcddde",
              }}>{label}</button>
            ))}
          </div>

          <div style={{flex:1,overflowY:"auto",padding:"0 8px 8px"}}>

            {/* Chats — friends' DMs, filtered by the "Find users…" search in
                the shared TopBar (see laneUserSearch). Bigger avatars, one
                real messaging-app-style row per friend. "You" (notifications)
                and your AI pal used to also have permanent rows up here —
                they're pinned bubbles up top now instead (see the bubble
                row above), so they don't appear twice. */}
            {lanesListTab==="chats" && (<>
              {friends.length===0 ? (
                !laneUserSearch.trim() && (
                  <div style={{textAlign:"center",color:"#4f545c",padding:"30px 20px"}}>
                    <div style={{fontSize:30,marginBottom:8}}>💬</div>
                    <div style={{fontSize:14,fontWeight:700,color:"#8e9297"}}>No friend chats yet</div>
                    <div style={{fontSize:12,marginTop:4,lineHeight:1.6}}>Add some friends to start messaging them here.</div>
                  </div>
                )
              ) : (<>
                {laneUserSearch.trim() && friends.filter(f=>f.name.toLowerCase().includes(laneUserSearch.trim().toLowerCase())).length===0 && (
                  <div style={{fontSize:12,color:"#4f545c",padding:"16px 10px",fontStyle:"italic",textAlign:"center"}}>No users match "{laneUserSearch}".</div>
                )}
                {sortPinned(laneUserSearch.trim() ? friends.filter(f=>f.name.toLowerCase().includes(laneUserSearch.trim().toLowerCase())) : friends).map(fr=>(
                  <div key={fr.id} style={{display:"flex",alignItems:"center",gap:2}}>
                    <button onClick={()=>{setActiveChan(fr.id);setLanesView("room");}} style={{
                      flex:1,minWidth:0,display:"flex",alignItems:"center",gap:12,
                      padding:"8px 8px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:F,textAlign:"left",
                      background:(activeChan===fr.id&&lanesView==="room")?"#3a3d42":"transparent",
                    }}>
                      <div style={{position:"relative",flexShrink:0}}>
                        <FriendAvatar fr={fr} size={54} fontSize={19}/>
                        <div style={{position:"absolute",bottom:1,right:1,width:13,height:13,borderRadius:"50%",background:"#23a55a",border:"2.5px solid #2f3136"}}/>
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:15,fontWeight:700,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fr.name}</div>
                        <div style={{fontSize:12,color:"#8e9297",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pinnedChans.includes(fr.id)?"📌 Pinned · Active now":"Active now"}</div>
                      </div>
                    </button>
                    <button onClick={()=>togglePin(fr.id)} title={pinnedChans.includes(fr.id)?"Unpin":"Pin to top"} style={{width:26,height:26,flexShrink:0,border:"none",background:"transparent",cursor:"pointer",fontSize:13,color:pinnedChans.includes(fr.id)?OR:"#4f545c",padding:0}}>📌</button>
                  </div>
                ))}
              </>)}
            </>)}

            {/* Lanes — Public Lanes (a live network of public proximity
                chats, anybody can create one and anybody nearby can see or
                join it, filtered to the discovery radius like the freeway
                CB channels) plus your own private/friends lanes. */}
            {lanesListTab==="lanes" && (<>
              <div style={{padding:"10px 6px 3px"}}>
                <span style={{fontSize:10,fontWeight:700,color:"#8e9297",letterSpacing:0.8,textTransform:"uppercase"}}>Public Lanes</span>
                <div style={{fontSize:10,color:"#5b5e66",marginTop:1}}>{radiusActive ? "Live · within "+appRadius+" mi" : "Live · everywhere"}</div>
              </div>
              {publicLanes.length===0 && <div style={{fontSize:11,color:"#4f545c",padding:"2px 7px 4px",fontStyle:"italic"}}>None nearby right now.</div>}
              {publicLanes.map(lane=>(
                <button key={lane.id} onClick={()=>{setActiveChan(lane.id);setLanesView("room");}} style={{
                  width:"100%",display:"flex",alignItems:"center",gap:6,
                  padding:"5px 7px",borderRadius:4,border:"none",cursor:"pointer",fontFamily:F,
                  background:(activeChan===lane.id&&lanesView==="room")?"#42464d":"transparent",marginBottom:1,
                }}>
                  <span style={{fontSize:11}}>🌐</span>
                  <span style={{flex:1,fontSize:13,fontWeight:activeChan===lane.id?700:400,color:activeChan===lane.id?"#fff":"#8e9297",textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lane.name}</span>
                  {!lane.host && <span style={{fontSize:9,color:"#5b5e66"}}>you</span>}
                </button>
              ))}

              <div style={{padding:"14px 6px 3px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:10,fontWeight:700,color:"#8e9297",letterSpacing:0.8,textTransform:"uppercase"}}>My Lanes</span>
                <button onClick={()=>setShowCreateLane(true)} style={{width:14,height:14,borderRadius:3,background:"#4f545c",border:"none",cursor:"pointer",color:"#8e9297",fontSize:13,lineHeight:"14px",textAlign:"center",padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>＋</button>
              </div>
              {sidebarCustomLanes.length===0 && <div style={{fontSize:11,color:"#4f545c",padding:"2px 7px 4px",fontStyle:"italic"}}>No lanes yet. Tap ＋ to create one.</div>}
              {sortPinned(sidebarCustomLanes).map(lane=>(
                <div key={lane.id} style={{display:"flex",alignItems:"center",gap:2,marginBottom:1}}>
                  <button onClick={()=>{setActiveChan(lane.id);setLanesView("room");}} style={{
                    flex:1,minWidth:0,display:"flex",alignItems:"center",gap:6,
                    padding:"5px 7px",borderRadius:4,border:"none",cursor:"pointer",fontFamily:F,
                    background:(activeChan===lane.id&&lanesView==="room")?"#42464d":"transparent",
                  }}>
                    <span style={{fontSize:12,color:lane.color||"#8e9297"}}>#</span>
                    <span style={{flex:1,fontSize:13,fontWeight:activeChan===lane.id?700:400,color:activeChan===lane.id?"#fff":"#8e9297",textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lane.name}</span>
                    <span style={{fontSize:10,color:"#5b5e66",flexShrink:0}} title={lane.visibility==="public"?"Public":"Friends only"}>{lane.visibility==="public"?"🌐":"👥"}</span>
                  </button>
                  <button onClick={()=>togglePin(lane.id)} title={pinnedChans.includes(lane.id)?"Unpin":"Pin to top"} style={{width:16,height:16,flexShrink:0,border:"none",background:"transparent",cursor:"pointer",fontSize:11,color:pinnedChans.includes(lane.id)?OR:"#4f545c",padding:0}}>📌</button>
                </div>
              ))}
            </>)}

            {/* SonoLane Radio — same Radio Stations content as Profile
                (saved stations + your own host registration), reachable
                right from Lanes now instead of needing a trip to Profile.
                dark:true keeps it on Lanes' own dark background instead of
                dropping a white card onto it. */}
            {lanesListTab==="radio" && (
              <div style={{margin:"6px 0 0"}}>
                {renderRadioStationsSection(true)}
              </div>
            )}

          </div>
        </div>
        )}

        {/* ── Chat room — its own full page, opened by tapping a chat in the
            list. The shared TopBar's back arrow (see BACK_PAGES-style
            handling in TopBar for panel==="create") returns to the list;
            this page's own header below still shows who/what the chat is,
            same pattern as the Top 3 Friend page. ── */}
        {lanesView==="room" && (
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",width:"100%"}}>

          {/* Header */}
          <div style={{padding:"9px 14px",borderBottom:"1px solid #202225",flexShrink:0,display:"flex",alignItems:"center",gap:8,background:"#36393f"}}>
            {curCityLane ? (
              <>
                <span style={{fontSize:16}}>📡</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:700,color:"#fff"}}>{curCityLane.name}</div>
                  <div style={{fontSize:11,color:"#72767d"}}>{curCityLane.desc} · Freeway Lane</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:3,background:curCityLane.id===currentFreewayId?"#23a55a22":"#66666622",borderRadius:20,padding:"3px 8px",flexShrink:0}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:curCityLane.id===currentFreewayId?"#23a55a":"#666"}}/>
                  <span style={{fontSize:10,color:curCityLane.id===currentFreewayId?"#23a55a":"#8e9297",fontWeight:700}}>{curCityLane.id===currentFreewayId?"On this freeway":"View only"}</span>
                </div>
              </>
            ) : curCustomLane ? (
              <>
                <span style={{fontSize:14,color:"#8e9297"}}>#</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:700,color:"#fff"}}>#{curCustomLane.name}</div>
                  <div style={{fontSize:11,color:"#72767d"}}>
                    {curCustomLane.garageId ? "🚗 Shared Garage Chat"
                      : curCustomLane.host ? "🌐 Public Lane · Hosted by "+curCustomLane.host
                      : curCustomLane.visibility==="public" ? "🌐 Public Lane · Anyone can join"
                      : "👥 Friends Lane"}
                  </div>
                </div>
              </>
            ) : activeChan==="notes" ? (
              <><span style={{color:"#8e9297",fontSize:15}}>#</span><div style={{flex:1}}><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>notes</div><div style={{fontSize:11,color:"#72767d"}}>Your personal notes</div></div></>
            ) : activeChan==="notifications" ? (
              <><span style={{fontSize:16}}>🔔</span><div style={{flex:1}}><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>notifications</div><div style={{fontSize:11,color:"#72767d"}}>SonoLane activity</div></div>
              {unreadNotifs>0 && (
                <button onClick={()=>{
                  setNotifications(ns=>ns.map(x=>x.read?x:{...x,read:true}));
                  if(isSupabaseConfigured && currentUserId){
                    supabase.from("notifications").update({read:true}).eq("recipient_id", currentUserId).eq("read", false);
                  }
                }} style={{padding:"5px 10px",borderRadius:20,background:"#5865f222",border:"none",color:"#5865f2",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,flexShrink:0}}>Mark all read</button>
              )}</>
            ) : activeChan==="sono" ? (
              <><span style={{fontSize:16}}>#</span><div style={{flex:1}}><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>Sono AI · {pal.name}</div><div style={{fontSize:11,color:pal.color}}>{pal.desc}</div></div>
              <div style={{display:"flex",gap:4}}>{AI_PALS.map(p=><button key={p.id} onClick={()=>setAiPalId(p.id)} title={p.name} style={{width:20,height:20,borderRadius:"50%",border:"none",cursor:"pointer",background:aiPalId===p.id?p.color+"33":"transparent",display:"flex",alignItems:"center",justifyContent:"center",padding:0,flexShrink:0}}><CompassStar size={aiPalId===p.id?14:11} color={p.color}/></button>)}</div></>
            ) : curFriend ? (
              <><FriendAvatar fr={curFriend} size={26} fontSize={10}/>
              <div style={{flex:1}}><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>{curFriend.name}</div><div style={{fontSize:11,color:"#23a55a"}}>● Online</div></div></>
            ) : null}
            {/* Voice chat indicator in header */}
            {voiceChatActive===activeChan && (
              <div style={{display:"flex",alignItems:"center",gap:4,background:"#23a55a22",borderRadius:20,padding:"3px 8px",flexShrink:0}}>
                <div style={{width:5,height:5,borderRadius:"50%",background:"#23a55a",animation:"pulse 1s infinite"}}/>
                <span style={{fontSize:10,color:"#23a55a",fontWeight:700}}>{(voiceChatMembers[activeChan]||[]).length || 1} in voice</span>
              </div>
            )}
          </div>

          {/* Messages */}
          <div ref={setScroll} style={{flex:1,overflowY:"auto",padding:"14px 14px 8px"}}>

            {/* NOTIFICATIONS */}
            {activeChan==="notifications"&&(
              notifications.length===0
                ? (<div style={{textAlign:"center",color:"#4f545c",paddingTop:40}}><div style={{fontSize:38,marginBottom:8}}>🔔</div><div style={{fontSize:14}}>No notifications</div></div>)
                : notifications.map(n=>(
                  <div key={n.id} onClick={()=>{
                    setNotifications(ns=>ns.map(x=>x.id===n.id?{...x,read:true}:x));
                    // Real (Supabase-backed) notifications have a UUID string
                    // id — the seeded/local ones use a plain number, so this
                    // only ever touches the backend for real rows.
                    if (isSupabaseConfigured && typeof n.id === "string") {
                      supabase.from("notifications").update({read:true}).eq("id", n.id);
                    }
                  }}
                    style={{display:"flex",gap:10,padding:"8px 10px",borderRadius:8,marginBottom:6,background:n.read?"transparent":"#5865f222",border:n.read?"none":"1px solid #5865f222",cursor:"pointer"}}>
                    <div style={{fontSize:20,flexShrink:0}}>{n.icon}</div>
                    <div style={{flex:1}}><div style={{fontSize:14,color:n.read?"#72767d":"#dcddde",lineHeight:1.5}}>{n.text}</div><div style={{fontSize:11,color:"#72767d",marginTop:2}}>{n.ts}</div></div>
                    {!n.read&&<div style={{width:6,height:6,borderRadius:"50%",background:"#5865f2",marginTop:4}}/>}
                  </div>
                ))
            )}

            {/* NOTES */}
            {activeChan==="notes"&&(<>
              {tLines.length===0&&<div style={{textAlign:"center",color:"#4f545c",paddingTop:40}}><div style={{fontSize:38,marginBottom:8}}>📝</div><div style={{fontSize:15,fontWeight:700,color:"#72767d",marginBottom:4}}>Your notes lane</div><div style={{fontSize:13,color:"#4f545c",lineHeight:1.6}}>Just for you. Jot, voice-transcribe, think out loud.</div></div>}
              {tLines.map((l,i)=>(
                <div key={i} style={{display:"flex",gap:9,marginBottom:3,padding:"1px 0"}}>
                  <div style={{width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,"+OR+",#fb923c)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:"#fff",flexShrink:0}}>
                    {userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?"}
                  </div>
                  <div style={{flex:1}}><div style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:1}}><span style={{fontSize:14,fontWeight:700,color:"#fff"}}>{userName||"You"}</span><span style={{fontSize:11,color:"#72767d"}}>Today</span></div><div style={{fontSize:15,color:"#dcddde",lineHeight:1.5}}>{l}</div></div>
                </div>
              ))}
            </>)}

            {/* SONO AI */}
            {activeChan==="sono"&&(<>
              {aiChat.map((c,i)=>(
                <div key={i} style={{display:"flex",gap:9,marginBottom:3,flexDirection:c.role==="user"?"row-reverse":"row"}}>
                  <div style={{width:30,height:30,borderRadius:"50%",background:c.role==="user"?"linear-gradient(135deg,"+OR+",#fb923c)":pal.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:c.role==="user"?12:15,fontWeight:800,color:"#fff",flexShrink:0}}>{c.role==="user"?(userName?userName[0].toUpperCase():"?"):<CompassStar size={16} color="#fff"/>}</div>
                  <div style={{flex:1,maxWidth:"80%"}}>
                    <div style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:1,flexDirection:c.role==="user"?"row-reverse":"row"}}><span style={{fontSize:14,fontWeight:700,color:c.role==="user"?"#fff":pal.color}}>{c.role==="user"?(userName||"You"):pal.name}</span><span style={{fontSize:11,color:"#72767d"}}>Today</span></div>
                    <div style={{fontSize:15,color:"#dcddde",lineHeight:1.5,background:c.role==="user"?"#4f545c22":"transparent",borderRadius:4,padding:c.role==="user"?"4px 8px":"0"}}>{c.text}</div>
                  </div>
                </div>
              ))}
              {aiThinking&&<div style={{display:"flex",gap:9,padding:"1px 0"}}><div style={{width:30,height:30,borderRadius:"50%",background:pal.color,display:"flex",alignItems:"center",justifyContent:"center"}}><CompassStar size={16} color="#fff"/></div><div style={{paddingTop:8,color:"#72767d",fontSize:14,fontStyle:"italic"}}>{pal.name} is typing…</div></div>}
            </>)}

            {/* CB LANE OR FRIEND DM */}
            {(curCityLane||curCustomLane||curFriend)&&(<>
              {allMsgs.length===0&&(
                <div style={{textAlign:"center",color:"#4f545c",paddingTop:40}}>
                  {curCityLane&&<><div style={{fontSize:30,marginBottom:6}}>📡</div><div style={{fontSize:15,fontWeight:700,color:"#72767d",marginBottom:3}}>{curLane.name}{curLane.city?" — "+curLane.city:""}</div><div style={{fontSize:13,color:"#4f545c",lineHeight:1.6}}>Hold the mic button below to broadcast a voice message to everyone on this lane.</div></>}
                  {curCustomLane&&<><div style={{fontSize:30,marginBottom:6}}>{curCustomLane.garageId?"🚗":"🛣️"}</div><div style={{fontSize:15,fontWeight:700,color:"#72767d",marginBottom:3}}>#{curLane.name}</div><div style={{fontSize:13,color:"#4f545c"}}>{curCustomLane.garageId ? "Your Shared Garage's group chat." : curCustomLane.host ? "A public lane hosted by "+curCustomLane.host+"." : curCustomLane.visibility==="public" ? "Your public lane — anyone can join." : "Your friends-only lane."} Hold mic to voice message.</div></>}
                  {curFriend&&<><FriendAvatar fr={curFriend} size={44} fontSize={16} style={{margin:"0 auto 8px"}}/><div style={{fontSize:15,fontWeight:700,color:"#72767d",marginBottom:3}}>Start a DM with {curFriend.name}</div></>}
                </div>
              )}
              {allMsgs.map(msg=>(
                <div key={msg.id} style={{display:"flex",gap:9,marginBottom:6,padding:"1px 0",flexDirection:msg.mine?"row-reverse":"row"}}>
                  <div style={{width:30,height:30,borderRadius:"50%",background:msg.mine?"linear-gradient(135deg,"+OR+",#fb923c)":msg.color||"#6366f1",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:"#fff",flexShrink:0}}>{msg.initials||"?"}</div>
                  <div style={{flex:1,maxWidth:"78%"}}>
                    <div style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:2,flexDirection:msg.mine?"row-reverse":"row"}}>
                      <span style={{fontSize:13,fontWeight:700,color:msg.mine?"#fff":msg.color||"#dcddde"}}>{msg.user||"Rider"}</span>
                      <span style={{fontSize:11,color:"#72767d"}}>{msg.ts}</span>
                    </div>
                    {msg.isVoice ? (
                      <div style={{display:"flex",flexDirection:"column",alignItems:msg.mine?"flex-end":"flex-start",gap:3}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,background:msg.mine?"#f97316":"#40444b",borderRadius:20,padding:"7px 12px",width:"fit-content"}}>
                          <button onClick={()=>toggleVoicePlayback(msg)} disabled={!msg.audioUrl} style={{width:24,height:24,borderRadius:"50%",background:msg.mine?"rgba(255,255,255,0.2)":"rgba(255,255,255,0.1)",border:"none",padding:0,color:"#fff",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,cursor:msg.audioUrl?"pointer":"default"}}>{playingVoiceId===msg.id?"❚❚":"▶"}</button>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",gap:2,alignItems:"center",height:16}}>
                              {Array.from({length:16}).map((_,wi)=>(
                                <div key={wi} style={{width:2,borderRadius:1,background:msg.mine?"rgba(255,255,255,0.7)":"#72767d",height:Math.max(3,Math.sin(wi*0.8)*7+8)+"px"}}/>
                              ))}
                            </div>
                          </div>
                          <span style={{fontSize:11,color:msg.mine?"rgba(255,255,255,0.7)":"#72767d",fontWeight:600,flexShrink:0}}>{"0:"+(String(msg.voiceSeconds||3).padStart(2,"0"))}</span>
                        </div>
                        {msg.transcript && (
                          <button onClick={()=>toggleTranscript(msg.id)} style={{background:"none",border:"none",cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:3,fontFamily:F}}>
                            <span style={{fontSize:11,color:"#72767d"}}>📝</span>
                            <span style={{fontSize:11,color:"#72767d",fontWeight:600}}>{openTranscripts[msg.id]?"Hide transcript":"Show transcript"}</span>
                          </button>
                        )}
                        {msg.transcript && openTranscripts[msg.id] && (
                          <div style={{fontSize:13,color:"#b9bbbe",lineHeight:1.4,background:"#2f3136",border:"1px solid #202225",borderRadius:8,padding:"6px 10px",maxWidth:220}}>"{msg.transcript}"</div>
                        )}
                      </div>
                    ) : (
                      <div style={{fontSize:15,color:"#dcddde",lineHeight:1.5,background:msg.mine?"#5865f233":"transparent",borderRadius:4,padding:msg.mine?"5px 9px":"0"}}>{msg.text}</div>
                    )}
                  </div>
                </div>
              ))}
            </>)}
          </div>

          {/* Input bar */}
          {activeChan!=="notifications"&&(
            <div style={{padding:"4px 10px 6px",flexShrink:0,background:"#36393f"}}>

              {/* Voice chat banner — shows when VC is active in this channel */}
              {voiceChatActive===activeChan && (
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",marginBottom:6,borderRadius:8,background:"#23a55a22",border:"1px solid #23a55a44"}}>
                  <div style={{width:7,height:7,borderRadius:"50%",background:"#23a55a",animation:"pulse 1s infinite",flexShrink:0}}/>
                  <span style={{flex:1,fontSize:12,fontWeight:700,color:"#23a55a"}}>Voice chat active · {(voiceChatMembers[activeChan]||[userName||"You"]).join(", ")}</span>
                  <button
                    onMouseDown={()=>{setVcRecording(true);setVcTimer(0);vcTimerRef.current=setInterval(()=>setVcTimer(t=>t+1),1000);}}
                    onMouseUp={()=>{clearInterval(vcTimerRef.current);setVcRecording(false);setVcTimer(0);const msg={id:Date.now(),text:"",mine:true,user:userName||"You",initials:userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?",color:OR,ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),isVoice:true,voiceSeconds:vcTimer||1,transcript:VOICE_TRANSCRIPTS[Math.floor(Math.random()*VOICE_TRANSCRIPTS.length)]};setLaneMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));setFriendMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));}}
                    onTouchStart={e=>{e.preventDefault();setVcRecording(true);setVcTimer(0);vcTimerRef.current=setInterval(()=>setVcTimer(t=>t+1),1000);}}
                    onTouchEnd={e=>{e.preventDefault();clearInterval(vcTimerRef.current);setVcRecording(false);setVcTimer(0);const msg={id:Date.now(),text:"",mine:true,user:userName||"You",initials:userName?userName.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase():"?",color:OR,ts:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),isVoice:true,voiceSeconds:vcTimer||1,transcript:VOICE_TRANSCRIPTS[Math.floor(Math.random()*VOICE_TRANSCRIPTS.length)]};setLaneMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));setFriendMsgs(m=>({...m,[activeChan]:[...(m[activeChan]||[]),msg]}));}}
                    style={{padding:"4px 10px",borderRadius:20,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F,border:"none",background:vcRecording?"#ed4245":"#23a55a",color:"#fff",flexShrink:0}}>
                    {vcRecording?"🔴 "+vcTimer+"s":"🎙 Talk"}
                  </button>
                  <button onClick={()=>{setVoiceChatActive(null);setVcRecording(false);clearInterval(vcTimerRef.current);}} style={{padding:"4px 8px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",border:"none",background:"#ed424522",color:"#ed4245",fontFamily:F}}>Leave</button>
                </div>
              )}

              {/* Locked notice — city lane, but location doesn't match this freeway yet */}
              {laneLocked && (
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",marginBottom:6,borderRadius:8,background:"#66666622",border:"1px solid #66666644"}}>
                  <span style={{fontSize:15}}>🔒</span>
                  <span style={{flex:1,fontSize:12,color:"#8e9297"}}>Get on {curCityLane.name} to talk here — you can still read what's posted.</span>
                </div>
              )}

              {/* Lane chats default to a walkie-talkie layout: a big hold-to-talk
                  circle, with a keyboard icon in the corner to switch to typing. */}
              {isLaneChat && chatInputMode==="voice" ? (
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",position:"relative",padding:"4px 0 2px",opacity:laneLocked?0.6:1}}>
                  <button onClick={()=>setChatInputMode("text")} title="Type a message instead" style={{position:"absolute",left:4,bottom:0,width:34,height:34,borderRadius:8,background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,color:"#72767d"}}>⌨️</button>
                  <button disabled={laneLocked} onClick={()=>{
                    if(laneLocked) return;
                    if(voiceChatActive===activeChan){setVoiceChatActive(null);clearInterval(vcTimerRef.current);}
                    else{
                      setVoiceChatActive(activeChan);
                      const SAMPLE=["SoCalDrifter","NightOwl","TruckDog"];
                      setVoiceChatMembers(m=>({...m,[activeChan]:[userName||"You",...SAMPLE.slice(0,Math.floor(Math.random()*3))]}));
                    }
                  }} title={laneLocked?"Get on this freeway to join voice chat":voiceChatActive===activeChan?"Leave voice chat":"Join voice chat"} style={{position:"absolute",right:4,bottom:0,width:34,height:34,borderRadius:8,background:voiceChatActive===activeChan?"#23a55a22":"transparent",border:"none",cursor:laneLocked?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:voiceChatActive===activeChan?"#23a55a":"#72767d"}}>🔊</button>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5}}>
                    {laneRecPhase==="paused" && laneRecPreviewUrl && (
                      <audio controls src={laneRecPreviewUrl} style={{height:26,width:190,marginBottom:2}}/>
                    )}
                    <div style={{display:"flex",alignItems:"center",gap:14}}>
                      {laneRecPhase!=="idle" && (
                        <button onClick={cancelLaneVoiceMsg} title="Cancel" style={{width:32,height:32,borderRadius:"50%",background:"#40444b",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"#8e9297",flexShrink:0}}>✕</button>
                      )}
                      <button
                        disabled={laneLocked}
                        onClick={()=>{
                          if(laneLocked) return;
                          if(laneRecPhase==="idle") startLaneVoiceMsg();
                          else if(laneRecPhase==="recording") pauseLaneVoiceMsg();
                          else resumeLaneVoiceMsg();
                        }}
                        title={laneRecPhase==="idle"?"Tap to record":laneRecPhase==="recording"?"Tap to pause":"Tap to resume"}
                        style={{width:64,height:64,borderRadius:"50%",background:laneRecPhase==="recording"?"#ed4245":laneRecPhase==="paused"?"#f0a020":"#5865f2",border:"none",cursor:laneLocked?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:laneRecPhase==="recording"?"0 0 0 8px #ed424522":"0 2px 10px rgba(0,0,0,0.35)",transition:"box-shadow .15s",flexShrink:0}}>
                        <span style={{fontSize:24,color:"#fff"}}>{laneRecPhase==="recording"?"❚❚":laneRecPhase==="paused"?"🎙":"🎙"}</span>
                      </button>
                      {laneRecPhase!=="idle" && (
                        <button onClick={sendLaneVoiceMsg} title="Send" style={{width:32,height:32,borderRadius:"50%",background:"#23a55a",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"#fff",flexShrink:0}}>➤</button>
                      )}
                    </div>
                    <span style={{fontSize:11,fontWeight:700,color:laneRecPhase==="recording"?"#ed4245":laneRecPhase==="paused"?"#f0a020":"#72767d"}}>
                      {laneLocked ? "Get on "+curCityLane.name+" to talk" : laneRecPhase==="recording" ? "Recording… "+laneRecSeconds+"s — tap to pause" : laneRecPhase==="paused" ? "Paused "+laneRecSeconds+"s — tap to resume, or send" : "Tap to record a voice message"}
                    </span>
                  </div>
                </div>
              ) : (
              <div style={{display:"flex",alignItems:"center",gap:6,opacity:laneLocked?0.6:1}}>
                {/* A second, always-reachable way back besides the shared
                    TopBar's back arrow above — same destination either way
                    (see backFromLanesRoom): the Shared Garage page this
                    chat was opened from, or the plain chat list. */}
                <button onClick={backFromLanesRoom} title="Back" style={{width:34,height:34,borderRadius:8,background:"#40444b",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:"#8e9297",flexShrink:0}}>
                  ☰
                </button>

                {/* Text bar */}
                <div style={{flex:1,display:"flex",alignItems:"center",gap:6,background:"#40444b",borderRadius:8,padding:"4px 6px 4px 12px",minWidth:0}}>
                  {/* Voice chat join button */}
                  <button disabled={laneLocked} onClick={()=>{
                    if(laneLocked) return;
                    if(voiceChatActive===activeChan){setVoiceChatActive(null);clearInterval(vcTimerRef.current);}
                    else{
                      setVoiceChatActive(activeChan);
                      const SAMPLE=["SoCalDrifter","NightOwl","TruckDog"];
                      setVoiceChatMembers(m=>({...m,[activeChan]:[userName||"You",...SAMPLE.slice(0,Math.floor(Math.random()*3))]}));
                    }
                  }} title={laneLocked?"Get on this freeway to join voice chat":voiceChatActive===activeChan?"Leave voice chat":"Join voice chat"} style={{width:26,height:26,borderRadius:6,background:voiceChatActive===activeChan?"#23a55a22":"transparent",border:"none",cursor:laneLocked?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:voiceChatActive===activeChan?"#23a55a":"#72767d",flexShrink:0}}>🔊</button>
                  <input value={chanInput} onChange={e=>setChanInput(e.target.value)} disabled={laneLocked}
                    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();
                      if(activeChan==="sono"){
                        if(!chanInput.trim())return;
                        const q=chanInput.trim();
                        setAiChat(c=>[...c,{role:"user",text:q}]);
                        setChanInput(""); setAiThinking(true);
                        callClaude([...aiChat,{role:"user",content:q}].map(m=>({role:m.role==="ai"?"assistant":"user",content:m.text||m.content})),"You are "+pal.name+", a "+pal.desc+" AI driving assistant. Be concise.").then(r=>{setAiChat(c=>[...c,{role:"ai",text:r}]);setAiThinking(false);});
                      } else { sendChanMsg(chanInput); }
                    }}}
                    placeholder={laneLocked?"Get on "+curCityLane.name+" to talk…":curCityLane?"Message "+curCityLane.name+"…":curCustomLane?"Message #"+curCustomLane.name+"…":activeChan==="notes"?"Jot a note…":activeChan==="sono"?"Ask "+pal.name+"…":curFriend?"Message "+curFriend.name+"…":""}
                    style={{flex:1,minWidth:0,background:"transparent",border:"none",outline:"none",color:"#dcddde",fontSize:15,fontFamily:F}}/>
                  <button disabled={laneLocked} onClick={()=>{
                    if(laneLocked) return;
                    if(activeChan==="sono"){
                      if(!chanInput.trim())return;
                      const q=chanInput.trim();
                      setAiChat(c=>[...c,{role:"user",text:q}]);
                      setChanInput(""); setAiThinking(true);
                      callClaude([...aiChat,{role:"user",content:q}].map(m=>({role:m.role==="ai"?"assistant":"user",content:m.text||m.content})),"You are "+pal.name+", a "+pal.desc+" AI driving assistant.").then(r=>{setAiChat(c=>[...c,{role:"ai",text:r}]);setAiThinking(false);});
                    } else { sendChanMsg(chanInput); }
                  }} style={{width:14,height:14,borderRadius:6,background:chanInput.trim()?"#5865f2":"transparent",border:"none",cursor:laneLocked?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:chanInput.trim()?"#fff":"#72767d",flexShrink:0}}>↑</button>
                </div>

                {/* Voice message button — hold-to-talk voice notes, lane chats only */}
                {isLaneChat && (
                  <button onClick={()=>setChatInputMode("voice")} title="Switch to hold-to-talk" style={{width:34,height:34,borderRadius:8,background:"#40444b",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:"#8e9297",flexShrink:0}}>🎙</button>
                )}
              </div>
              )}
            </div>
          )}
        </div>
        )}

        {/* Create Lane sheet */}
        {showCreateLane&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:800,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowCreateLane(false)}>
            <div style={{background:"#2f3136",borderRadius:"20px 20px 0 0",width:"100%",padding:18}} onClick={e=>e.stopPropagation()}>
              <div style={{width:30,height:3,background:"#40444b",borderRadius:2,margin:"0 auto 16px"}}/>
              <div style={{fontSize:16,fontWeight:800,color:"#fff",marginBottom:4}}>Create a Lane</div>
              <div style={{fontSize:12,color:"#72767d",marginBottom:14}}>Lanes are your own private or shared CB channels.</div>
              <div style={{fontSize:11,color:"#8e9297",fontWeight:700,letterSpacing:0.8,marginBottom:6}}>LANE NAME</div>
              <input value={newLaneName} onChange={e=>setNewLaneName(e.target.value)} placeholder="e.g. Car Meet Crew, Night Rides…" style={{...INP,background:"#40444b",border:"1px solid #202225",color:"#dcddde",marginBottom:16}}/>
              <div style={{fontSize:11,color:"#8e9297",fontWeight:700,letterSpacing:0.8,marginBottom:6}}>WHO CAN JOIN</div>
              <div style={{display:"flex",gap:8,marginBottom:6}}>
                <button onClick={()=>setNewLaneVisibility("friends")} style={{flex:1,padding:"10px 8px",borderRadius:10,cursor:"pointer",fontFamily:F,border:newLaneVisibility==="friends"?"1.5px solid #5865f2":"1px solid #202225",background:newLaneVisibility==="friends"?"#5865f222":"#40444b",color:newLaneVisibility==="friends"?"#fff":"#8e9297",fontSize:13,fontWeight:700,textAlign:"left"}}>
                  👥 Friends<div style={{fontSize:10,fontWeight:400,color:"#8e9297",marginTop:2}}>Only your friends</div>
                </button>
                <button onClick={()=>setNewLaneVisibility("public")} style={{flex:1,padding:"10px 8px",borderRadius:10,cursor:"pointer",fontFamily:F,border:newLaneVisibility==="public"?"1.5px solid "+OR:"1px solid #202225",background:newLaneVisibility==="public"?OR+"22":"#40444b",color:newLaneVisibility==="public"?"#fff":"#8e9297",fontSize:13,fontWeight:700,textAlign:"left"}}>
                  🌐 Public<div style={{fontSize:10,fontWeight:400,color:"#8e9297",marginTop:2}}>Anyone nearby can join</div>
                </button>
              </div>
              <div style={{fontSize:11,color:"#5b5e66",marginBottom:16}}>{newLaneVisibility==="public" ? "Shows in Public Lanes for anyone within your discovery radius." : "Stays in My Lanes, visible only to your friends."}</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{
                  if(!newLaneName.trim())return;
                  const COLS=[OR,"#6366f1","#22c55e","#a855f7","#ec4899","#14b8a6"];
                  const lane={id:"custom_"+Date.now(),name:newLaneName.trim().toLowerCase().replace(/\s+/g,"-"),color:COLS[customLanes.length%COLS.length],desc:"Your lane",visibility:newLaneVisibility,authorId:"me"};
                  setCustomLanes(l=>[...l,lane]);
                  setActiveChan(lane.id);
                  setNewLaneName("");setNewLaneVisibility("friends");setShowCreateLane(false);
                }} style={{flex:1,padding:"12px",borderRadius:10,background:"#5865f2",color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Create Lane</button>
                <button onClick={()=>setShowCreateLane(false)} style={{padding:"12px 16px",borderRadius:10,background:"#40444b",border:"none",color:"#8e9297",cursor:"pointer",fontFamily:F}}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  });

  /* ── DRIVE — maps only. Dashcam recording is fully automatic and
     runs in the background (see the automation effects above); nothing
     about it is shown on this page. Recorded footage surfaces in the
     profile's Dashcam section, and speed/duration/lights surface in
     Drive History once a drive ends. ── */
  // 5 apps in Drive mode's bottom apps bar — tapping one swaps only the main
  // ~2/3-width app area (driveApp), leaving the widgets column untouched.
  // Maps is the default app and also sits in this bar, per the CarPlay-style
  // reference layout: a wide main app + a stack of glanceable widgets beside it.
  const DRIVE_APPS = [
    {id:"map",     icon:"🗺️", label:"Maps"},
    {id:"radio",   icon:"📻", label:"SonoLane Radio"},
    {id:"cbradio", icon:"📡", label:"CB Radio"},
    {id:"agent",   icon:"⭐", label:"Sono"},
  ];
  const DrivePanel = useStablePanel(() => {
    const isPortrait = driveOrientation==="portrait";
    // Which CB freeway lane is open in Drive mode's inline CB Radio app —
    // separate from MusicModal's own activeCbLane so browsing a lane here
    // doesn't disturb the CB Radio sheet's state (and vice versa).
    const [driveCbLane, setDriveCbLane] = useState(null);
    // Drive Mode Settings sheet (opened via the ⚙️ at the end of the apps
    // bar) — a toggle up top switches between Startup Sound, Widgets, and
    // Voice Control instead of stacking all three. These all used to live
    // on the Profile Edit page; now they live only here, inside Drive mode.
    const [driveSettingsTab, setDriveSettingsTab] = useState("sound");

    const mainAppBox = (
          <div style={{flex:1,position:"relative",overflow:"hidden",minHeight:0,background:driveApp==="map"?"#e5e3df":"#111"}}>

            {driveApp==="map" && (<>
              <iframe
                title="Live Map"
                style={{width:"100%",height:"100%",border:"none",display:"block",pointerEvents:mapInteractive?"auto":"none"}}
                src={driveDirections ? buildEmbedDirectionsSrc(driveDirections) : "https://maps.google.com/maps?q=current+location&z=15&output=embed"}
                loading="lazy"
                allow="geolocation"
              />
              {/* Route banner — only shown while a "Get Directions" route is
                  loaded; lets you see the stops at a glance or drop back to
                  the plain live map. */}
              {driveDirections && !mapInteractive && (
                <div style={{position:"absolute",top:10,left:10,right:52,zIndex:2,background:"rgba(0,0,0,0.7)",borderRadius:12,padding:"8px 10px",display:"flex",alignItems:"flex-start",gap:8}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:800,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🗺️ {driveDirections.title}</div>
                    {driveDirections.stops?.length>0 && (
                      <div style={{fontSize:10,color:"#ccc",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{driveDirections.stops.map(s=>"📍 "+s).join("  ")}</div>
                    )}
                  </div>
                  <button onClick={()=>setDriveDirections(null)} title="Exit directions" style={{width:20,height:20,borderRadius:"50%",background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",fontSize:12,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                </div>
              )}
              {/* Tap-to-interact overlay — tap toggles into the map so the user can pan/zoom it. */}
              {!mapInteractive && (
                <div onClick={()=>setMapInteractive(true)} style={{position:"absolute",inset:0,background:"transparent",cursor:"pointer"}}/>
              )}
              {mapInteractive && (
                <button onClick={()=>setMapInteractive(false)} style={{position:"absolute",top:10,left:10,padding:"6px 12px",borderRadius:20,background:"rgba(0,0,0,0.6)",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,zIndex:2}}>
                  ✓ Done
                </button>
              )}
              {!dashcamConsent && !mapInteractive && (
                <button onClick={()=>setShowDashcamSetup(true)} style={{position:"absolute",bottom:12,left:12,padding:"7px 12px",borderRadius:20,background:"rgba(0,0,0,0.65)",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,zIndex:2,display:"flex",alignItems:"center",gap:6}}>
                  📹 Enable dashcam
                </button>
              )}
              {driveDirections ? (
                <button onClick={()=>startTurnByTurn(driveDirections)} style={{position:"absolute",bottom:12,right:12,padding:"9px 16px",borderRadius:20,background:"#4285F4",color:"#fff",border:"none",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F,boxShadow:"0 2px 10px rgba(0,0,0,0.25)",display:"flex",alignItems:"center",gap:6,zIndex:2}}>
                  🧭 Start Navigation
                </button>
              ) : (
                <button onClick={()=>window.open("https://maps.google.com","_blank")} style={{position:"absolute",bottom:12,right:12,padding:"9px 16px",borderRadius:20,background:"#4285F4",color:"#fff",border:"none",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F,boxShadow:"0 2px 10px rgba(0,0,0,0.25)",display:"flex",alignItems:"center",gap:6,zIndex:2}}>
                  🗺️ Open in Maps
                </button>
              )}
            </>)}

            {driveApp==="radio" && (
              <div style={{position:"absolute",inset:0,overflowY:"auto",padding:"14px 16px 20px"}}>
                <div style={{fontSize:11,color:"#8e9297",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>MY BROADCAST</div>
                {isBroad ? (
                  <div style={{background:"#ef444422",border:"1px solid #ef444444",borderRadius:14,padding:"12px",display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:"#ef4444",animation:"pulse 1s infinite",flexShrink:0}}/>
                    <div style={{flex:1}}><div style={{fontSize:14,fontWeight:800,color:"#ef4444"}}>{broadName}</div><div style={{fontSize:11,color:"#8e9297"}}>Broadcasting live now</div></div>
                    <button onClick={()=>setIsBroad(false)} style={{padding:"5px 12px",borderRadius:20,background:"#2a2a2a",border:"none",color:"#ef4444",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>⏹ End</button>
                  </div>
                ) : radioHosts.length>0 ? (
                  <div style={{marginBottom:16}}>
                    {radioHosts.map((h,i)=>(
                      <div key={i} style={{background:"#1a1a1a",borderRadius:12,padding:"11px",marginBottom:7,display:"flex",alignItems:"center",gap:10}}>
                        <div style={{width:38,height:38,borderRadius:10,background:OR+"22",border:"1px solid "+OR+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>📻</div>
                        <div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:700,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</div><div style={{fontSize:11,color:"#8e9297"}}>{h.genre} · @{h.handle}</div></div>
                        <button onClick={()=>{setBroadName(h.name);setIsBroad(true);}} style={{padding:"5px 10px",borderRadius:20,background:"#ef4444",color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,flexShrink:0}}>Go Live</button>
                      </div>
                    ))}
                  </div>
                ) : !showReg ? (
                  <button onClick={()=>setShowReg(true)} style={{width:"100%",padding:"12px",borderRadius:14,background:"transparent",border:"1.5px dashed #ef444466",color:"#ef4444",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,marginBottom:16}}>📻 Register as Radio Host</button>
                ) : null}

                {showReg && (
                  <div style={{background:"#1a1a1a",borderRadius:14,padding:"14px",marginBottom:16}}>
                    <div style={{fontSize:14,fontWeight:800,color:"#fff",marginBottom:10}}>Host Registration</div>
                    <input value={hostForm.name} onChange={e=>setHostForm(f=>({...f,name:e.target.value}))} placeholder="Station name *" style={{...INP,background:"#222",border:"1px solid #333",color:"#fff",marginBottom:8}}/>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                      {["Hip-Hop","Lo-Fi","Rock","R&B","Electronic","Pop","Jazz","Talk"].map(g=>(
                        <button key={g} onClick={()=>setHostForm(f=>({...f,genre:g}))} style={{padding:"4px 10px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",background:hostForm.genre===g?OR:"#222",color:hostForm.genre===g?"#fff":"#8e9297",border:"none",fontFamily:F}}>{g}</button>
                      ))}
                    </div>
                    <input value={hostForm.handle} onChange={e=>setHostForm(f=>({...f,handle:e.target.value}))} placeholder="@handle" style={{...INP,background:"#222",border:"1px solid #333",color:"#fff",marginBottom:8}}/>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>{if(!hostForm.name.trim())return;setRadioHosts(h=>[...h,{...hostForm}]);setHostForm({name:"",genre:"",bio:"",handle:""});setShowReg(false);}} style={{flex:1,padding:"9px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F}}>Register</button>
                      <button onClick={()=>setShowReg(false)} style={{padding:"9px 14px",borderRadius:10,background:"#222",border:"1px solid #333",color:"#8e9297",cursor:"pointer",fontFamily:F}}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{fontSize:11,color:"#8e9297",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>
                  {radiusActive ? "STATIONS · "+appRadius+" MI" : "ALL STATIONS"}
                </div>
                {radioHosts.length===0 ? (
                  <div style={{textAlign:"center",padding:"30px 10px",color:"#555"}}>
                    <div style={{fontSize:32,marginBottom:8}}>📻</div>
                    <div style={{fontSize:13,fontWeight:700,color:"#8e9297",marginBottom:4}}>No stations nearby yet</div>
                    <div style={{fontSize:12,color:"#555"}}>Be the first to register a station above.</div>
                  </div>
                ) : radioHosts.map((h,i)=>(
                  <div key={i} style={{background:"#1a1a1a",borderRadius:12,padding:"11px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:40,height:40,borderRadius:10,background:OR+"22",border:"1.5px solid "+OR+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📻</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:800,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</div>
                      <div style={{fontSize:11,color:"#8e9297"}}>{h.genre} · @{h.handle}</div>
                    </div>
                    <button onClick={()=>toggleSavedStation(h.name)} style={{background:"none",border:"none",color:savedStations.includes(h.name)?OR:"#555",fontSize:16,cursor:"pointer",padding:2,flexShrink:0}}>{savedStations.includes(h.name)?"★":"☆"}</button>
                    {isBroad&&broadName===h.name
                      ? (<div style={{display:"flex",alignItems:"center",gap:4,background:"#ef444422",borderRadius:20,padding:"3px 8px",flexShrink:0}}><div style={{width:5,height:5,borderRadius:"50%",background:"#ef4444"}}/><span style={{fontSize:10,color:"#ef4444",fontWeight:700}}>LIVE</span></div>)
                      : (<button style={{padding:"5px 10px",borderRadius:20,background:"#2a2a2a",color:"#8e9297",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,flexShrink:0}}>▶ Listen</button>)}
                  </div>
                ))}
              </div>
            )}

            {driveApp==="cbradio" && (() => {
              const visibleLanes = radiusActive ? CB_CITY_LANES.filter(l=>!l.city||l.city==="San Diego") : CB_CITY_LANES;
              if(!driveCbLane){
                return (
                  <div style={{position:"absolute",inset:0,overflowY:"auto",padding:"14px 16px 20px"}}>
                    <div style={{fontSize:11,color:"#8e9297",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>
                      {radiusActive ? "NEARBY FREEWAY LANES · "+appRadius+" MI" : "ALL FREEWAY LANES"}
                    </div>
                    <div style={{fontSize:12,color:currentFreewayId?"#23a55a":"#8e9297",marginBottom:10,lineHeight:1.5}}>
                      {currentFreewayId
                        ? "📍 You're on "+(CB_CITY_LANES.find(l=>l.id===currentFreewayId)?.name||"a freeway lane")+" — you can talk here."
                        : "🔒 You can view any lane here, but can only talk once your location matches that freeway."}
                    </div>
                    {visibleLanes.map(lane=>{
                      const updates=laneTrafficUpdates[lane.id]||[];
                      const last=updates[0];
                      const here = lane.id===currentFreewayId;
                      return (
                        <button key={lane.id} onClick={()=>setDriveCbLane(lane.id)} style={{
                          width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px",
                          marginBottom:7,borderRadius:12,border:"none",cursor:"pointer",fontFamily:F,
                          background:"#1a1a1a",textAlign:"left",
                        }}>
                          <div style={{width:40,height:40,borderRadius:10,background:lane.color+"22",border:"1.5px solid "+lane.color+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📡</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                              <span style={{fontSize:14,fontWeight:800,color:"#fff"}}>{lane.name}</span>
                              <div style={{width:5,height:5,borderRadius:"50%",background:here?"#23a55a":"#555"}}/>
                            </div>
                            <div style={{fontSize:11,color:"#8e9297",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{last ? last.icon+" \""+last.text+"\"" : lane.desc}</div>
                          </div>
                          <div style={{fontSize:17,color:"#555"}}>›</div>
                        </button>
                      );
                    })}
                  </div>
                );
              }
              const laneObj = CB_CITY_LANES.find(l=>l.id===driveCbLane);
              const riders = 2 + ((laneObj?.id.split("").reduce((s,c)=>s+c.charCodeAt(0),0))%4);
              const updates = laneTrafficUpdates[driveCbLane]||[];
              const onThisLane = driveCbLane===currentFreewayId;
              return (
                <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",overflow:"hidden"}}>
                  <div style={{padding:"9px 14px",borderBottom:"1px solid #222",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
                    <button onClick={()=>setDriveCbLane(null)} style={{fontSize:18,background:"none",border:"none",color:"#8e9297",cursor:"pointer"}}>←</button>
                    <div style={{width:7,height:7,borderRadius:"50%",background:laneObj?.color||OR}}/>
                    <div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:800,color:"#fff"}}>{laneObj?.name}</div></div>
                    <div style={{display:"flex",alignItems:"center",gap:3,background:onThisLane?"#23a55a22":"#66666622",borderRadius:20,padding:"2px 7px",flexShrink:0}}>
                      <div style={{width:5,height:5,borderRadius:"50%",background:onThisLane?"#23a55a":"#666"}}/>
                      <span style={{fontSize:9,color:onThisLane?"#23a55a":"#8e9297",fontWeight:700}}>{onThisLane?"LIVE":"BROWSING"}</span>
                    </div>
                  </div>
                  {onThisLane ? (
                    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"16px 20px"}}>
                      <div style={{position:"relative",width:88,height:88,marginBottom:14}}>
                        <div style={{position:"absolute",inset:0,borderRadius:"50%",background:(laneObj?.color||OR)+"22",animation:"pulse 1.6s infinite"}}/>
                        <div style={{position:"absolute",inset:10,borderRadius:"50%",background:"linear-gradient(135deg,"+(laneObj?.color||OR)+",#000)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>📡</div>
                      </div>
                      <div style={{fontSize:14,fontWeight:800,color:"#fff",marginBottom:4,textAlign:"center"}}>Connected — ready to talk</div>
                      <div style={{fontSize:11,color:"#555",fontWeight:700}}>🎧 {riders} riders connected</div>
                    </div>
                  ) : (
                    <div style={{flex:1,overflowY:"auto",padding:"10px 12px"}}>
                      {updates.length===0 ? (
                        <div style={{textAlign:"center",color:"#555",paddingTop:20}}>
                          <div style={{fontSize:22,marginBottom:6}}>📡</div>
                          <div style={{fontSize:12}}>No recent updates on this lane.</div>
                        </div>
                      ) : updates.map(u=>(
                        <div key={u.id} style={{display:"flex",gap:8,padding:"9px 10px",marginBottom:6,borderRadius:10,background:"#1a1a1a"}}>
                          <div style={{fontSize:16,flexShrink:0}}>{u.icon}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:12,color:"#ddd",lineHeight:1.4,marginBottom:2}}>{u.text}</div>
                            <div style={{fontSize:10,color:"#555"}}><span style={{color:u.color,fontWeight:700}}>{u.handle}</span> · {timeAgo(u.ts)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {onThisLane && (
                    <div style={{padding:"6px 12px 10px",flexShrink:0}}>
                      <button
                        onMouseDown={()=>{setCbRecording(true);setCbTimer(0);cbTimerRef.current=setInterval(()=>setCbTimer(t=>t+1),1000);}}
                        onMouseUp={()=>{clearInterval(cbTimerRef.current);setCbRecording(false);setCbTimer(0);broadcastOnLane(driveCbLane);}}
                        onTouchStart={e=>{e.preventDefault();setCbRecording(true);setCbTimer(0);cbTimerRef.current=setInterval(()=>setCbTimer(t=>t+1),1000);}}
                        onTouchEnd={e=>{e.preventDefault();clearInterval(cbTimerRef.current);setCbRecording(false);setCbTimer(0);broadcastOnLane(driveCbLane);}}
                        style={{width:"100%",padding:"12px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:F,background:cbRecording?"#ed4245":"#23a55a",color:"#fff",fontSize:13,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                        {cbRecording ? (<><span style={{width:6,height:6,borderRadius:"50%",background:"#fff",animation:"pulse 0.5s infinite",display:"block"}}/>{"Broadcasting… "+cbTimer+"s"}</>) : (<><span>📡</span>{"Hold to Talk"}</>)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {driveApp==="agent" && (
              <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",overflow:"hidden"}}>
                <div style={{padding:"10px 14px",borderBottom:"1px solid #222",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                  <CompassStar size={18} color={pal.color}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>{pal.name}</div>
                    <div style={{fontSize:11,color:"#8e9297"}}>{pal.desc}</div>
                  </div>
                </div>
                <div style={{flex:1,overflowY:"auto",padding:"10px 14px"}}>
                  {roadMsgs.slice(-6).map((m,i)=><div key={i} style={{fontSize:13,color:"#dcddde",padding:"5px 0",lineHeight:1.5}}>{pal.emoji} {m}</div>)}
                </div>
                <div style={{padding:"8px 10px",display:"flex",gap:6,flexShrink:0,borderTop:"1px solid #222"}}>
                  <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")sendChat();}} placeholder={"Ask "+pal.name+"…"} style={{...INP,flex:1,background:"#1a1a1a",border:"1px solid #2a2a2a",color:"#fff"}}/>
                  <button onClick={sendChat} style={{padding:"7px 14px",borderRadius:8,background:pal.color,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer"}}>↑</button>
                </div>
              </div>
            )}

            {/* Persistent overlay controls, on top of whichever app is showing */}
            <button onClick={()=>go("profile")} style={{position:"absolute",top:10,right:10,width:32,height:32,borderRadius:"50%",background:"#1a1a1a",border:"none",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,zIndex:3,boxShadow:"0 2px 6px rgba(0,0,0,0.4)"}}>
              ←
            </button>
            {dashOn && (
              <div style={{position:"absolute",top:10,left:10,display:"flex",alignItems:"center",gap:4,background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"4px 9px",zIndex:3}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:"#ef4444",animation:"pulse 1s infinite",display:"block"}}/>
                <span style={{color:"#fff",fontSize:11,fontWeight:800}}>REC</span>
              </div>
            )}
          </div>
    );

    /* Apps bar — 5 apps, switches only the main app area above, plus a small
       "⚙️" button at the end to jump straight to the widget-slot picker
       without leaving Drive mode. Horizontal strip (landscape, sits under
       the main area) or a narrow vertical strip (portrait, along the side). */
    const appsBarHorizontal = (
      <div style={{flexShrink:0,display:"flex",background:"#111",borderTop:"1px solid #222"}}>
        {DRIVE_APPS.map(a=>{
          const active = driveApp===a.id;
          return (
            <button key={a.id} onClick={()=>setDriveApp(a.id)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"8px 4px",border:"none",cursor:"pointer",fontFamily:F,background:active?OR+"22":"transparent"}}>
              <span style={{fontSize:19}}>{a.icon}</span>
              <span style={{fontSize:10,fontWeight:active?800:600,color:active?OR:"#8e9297"}}>{a.label}</span>
            </button>
          );
        })}
        <button onClick={()=>setShowWidgetSettings(true)} title="Drive Mode Settings" style={{flexShrink:0,width:40,display:"flex",alignItems:"center",justifyContent:"center",border:"none",borderLeft:"1px solid #222",cursor:"pointer",background:"transparent",fontSize:15}}>⚙️</button>
      </div>
    );
    const appsBarVertical = (
      <div style={{flexShrink:0,width:56,display:"flex",flexDirection:"column",background:"#111",borderRight:"1px solid #222"}}>
        {DRIVE_APPS.map(a=>{
          const active = driveApp===a.id;
          return (
            <button key={a.id} onClick={()=>setDriveApp(a.id)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,padding:"8px 2px",border:"none",cursor:"pointer",fontFamily:F,background:active?OR+"22":"transparent"}}>
              <span style={{fontSize:19}}>{a.icon}</span>
              <span style={{fontSize:9,fontWeight:active?800:600,color:active?OR:"#8e9297",textAlign:"center"}}>{a.label}</span>
            </button>
          );
        })}
        <button onClick={()=>setShowWidgetSettings(true)} title="Drive Mode Settings" style={{flexShrink:0,height:36,display:"flex",alignItems:"center",justifyContent:"center",border:"none",borderTop:"1px solid #222",cursor:"pointer",background:"transparent",fontSize:14}}>⚙️</button>
      </div>
    );

    /* Widgets — up to 3 slots, stacked (landscape, side column) or
       side-by-side (portrait, bottom bar). A slot marked "only show when
       turned on" simply isn't rendered until it's active — the remaining
       slot(s) are equal flex children of the same row/column, so 2 widgets
       split the space 50/50 and 1 widget fills it completely, automatically. */
    const widgetIsActive = id => {
      if(id==="dashcam") return camLive || dashOn;
      if(id==="spotify") return spotifyPlaying;
      if(id==="cbradio") return isBroad || !!currentFreewayId;
      if(id==="none") return false; // Empty is never "active" — with the
      // toggle on, an Empty slot just stays hidden permanently, letting the
      // other widget(s) split the bottom bar between them (or fill it, if
      // it's the only one left).
      return true; // no real on/off state for weather/points/friends/topfriends/routes/music
    };
    const slotShow = (w, onlyOn) => !onlyOn || widgetIsActive(w);
    const slot1Show = slotShow(widget1, widget1OnlyOn);
    const slot2Show = slotShow(widget2, widget2OnlyOn);
    const slot3Show = slotShow(widget3, widget3OnlyOn);
    const slotBox = (w, side) => (
      <div style={{flex:1,background:"#f8f8f8",borderRadius:12,border:"1px solid #ebebeb",overflow:"hidden",display:"flex",alignItems:"stretch",minHeight:0}}>{renderWidget(w,side)}</div>
    );
    const widgetsColVertical = (
      <div style={{flex:1,display:"flex",flexDirection:"column",gap:6,padding:6,background:"#fff",overflow:"hidden",minHeight:0}}>
        {slot1Show && slotBox(widget1,"1")}
        {slot2Show && slotBox(widget2,"2")}
        {slot3Show && slotBox(widget3,"3")}
      </div>
    );
    const widgetsRowHorizontal = (
      <div style={{flexShrink:0,height:110,display:"flex",flexDirection:"row",gap:6,padding:6,background:"#fff",overflow:"hidden"}}>
        {slot1Show && slotBox(widget1,"1")}
        {slot2Show && slotBox(widget2,"2")}
        {slot3Show && slotBox(widget3,"3")}
      </div>
    );

    return (
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
        {voiceOn && (
          <div style={{flexShrink:0,padding:"3px 12px",background:"#fff9f5",borderBottom:"1px solid #fde8d8",display:"flex",alignItems:"center",gap:6}}>
            <span style={{width:5,height:5,borderRadius:"50%",background:"#ef4444",animation:"pulse 1s infinite",flexShrink:0,display:"block"}}/>
            <span style={{fontSize:10,color:OR,fontStyle:"italic",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{voiceText || (showAgent ? "Agent open — speak your question" : "Listening… say \"Sono\" for agent")}</span>
          </div>
        )}
        {isPortrait ? (
          <>
            <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
              {appsBarVertical}
              <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
                {mainAppBox}
              </div>
            </div>
            {widgetsRowHorizontal}
          </>
        ) : (
          <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
            <div style={{flex:2,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0,borderRight:"1px solid #ebebeb"}}>
              {mainAppBox}
              {appsBarHorizontal}
            </div>
            {widgetsColVertical}
          </div>
        )}

        {/* Drive Mode Settings — the small ⚙️ at the end of the apps bar
            opens this sheet. Startup Sound, Widgets, and Voice Control all
            live here now instead of on the Profile Edit page, so every
            Drive-mode setting can be reached without leaving Drive mode. */}
        {showWidgetSettings && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:590,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowWidgetSettings(false)}>
            <div style={{background:"#1a1a1a",borderRadius:"20px 20px 0 0",width:"100%",padding:18,maxHeight:"82vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
              <div style={{width:30,height:3,background:"#333",borderRadius:2,margin:"0 auto 14px"}}/>
              <div style={{fontSize:15,fontWeight:800,color:"#fff",marginBottom:12}}>Drive Mode Settings</div>

              <div style={{display:"flex",gap:4,background:"#242424",borderRadius:40,padding:4,marginBottom:14}}>
                <button onClick={()=>setDriveSettingsTab("sound")} style={{flex:1,padding:"7px 6px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,fontSize:11,fontWeight:700,background:driveSettingsTab==="sound"?OR:"transparent",color:driveSettingsTab==="sound"?"#fff":"#8e9297"}}>Startup Sound</button>
                <button onClick={()=>setDriveSettingsTab("widgets")} style={{flex:1,padding:"7px 6px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,fontSize:11,fontWeight:700,background:driveSettingsTab==="widgets"?OR:"transparent",color:driveSettingsTab==="widgets"?"#fff":"#8e9297"}}>Widgets</button>
                <button onClick={()=>setDriveSettingsTab("voice")} style={{flex:1,padding:"7px 6px",borderRadius:36,border:"none",cursor:"pointer",fontFamily:F,fontSize:11,fontWeight:700,background:driveSettingsTab==="voice"?OR:"transparent",color:driveSettingsTab==="voice"?"#fff":"#8e9297"}}>Voice Control</button>
              </div>

              {driveSettingsTab==="sound" && (<>
                <div style={{fontSize:12,color:"#8e9297",marginBottom:10,lineHeight:1.5}}>Plays every time you tap Start to begin a drive.</div>
                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
                  {Object.entries(STARTUP_SOUNDS).map(([key,cfg])=>(
                    <button key={key} onClick={()=>{setStartupSound(key);memStore.setItem("sl_startupSound",key);playStartupSound(key);}} style={{
                      display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:12,
                      cursor:"pointer",fontFamily:F,textAlign:"left",
                      border:"1.5px solid "+(startupSound===key?OR:"#333"),
                      background:startupSound===key?OR+"22":"#242424",
                    }}>
                      <div style={{width:30,height:30,borderRadius:"50%",background:startupSound===key?OR+"33":"#1a1a1a",border:"1.5px solid "+(startupSound===key?OR+"66":"#333"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>
                        {key==="none"?"🔇":key==="engine"?"🏎":key==="digital"?"🔔":key==="warm"?"🎶":"🎵"}
                      </div>
                      <div style={{flex:1,fontSize:14,fontWeight:700,color:startupSound===key?OR:"#fff"}}>{cfg.label}</div>
                      {startupSound===key && <div style={{width:18,height:18,borderRadius:"50%",background:OR,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",flexShrink:0}}>✓</div>}
                    </button>
                  ))}
                </div>
                <div style={{fontSize:11,color:"#8e9297",textAlign:"center"}}>Tap a sound to preview it</div>
              </>)}

              {driveSettingsTab==="widgets" && (<>
                {[["1","Top",widget1,widget1OnlyOn],["2","Mid",widget2,widget2OnlyOn],["3","Bottom",widget3,widget3OnlyOn]].map(([slot,label,w,onlyOn])=>(
                  <button key={slot} onClick={()=>{setShowWidgetSettings(false);setWidgetEditFrom("drive");setWidgetEdit(slot);}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px",borderRadius:12,background:"#242424",border:"none",cursor:"pointer",fontFamily:F,marginBottom:8,textAlign:"left"}}>
                    <div style={{fontSize:20}}>{w==="routes"?<DPadIcon id="road" color={DPAD_COLORS.road} size={18}/>:w==="weather"?"☀️":w==="music"?"🎵":w==="spotify"?"🎧":w==="cbradio"?"📡":w==="points"?"⭐":w==="friends"?"👥":w==="topfriends"?"👥":w==="dashcam"?"📹":"＋"}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11,color:"#8e9297",fontWeight:700}}>{label.toUpperCase()}</div>
                      <div style={{fontSize:14,fontWeight:700,color:"#fff",textTransform:"capitalize"}}>{w}{onlyOn?" · only when on":""}</div>
                    </div>
                    <span style={{color:"#8e9297",fontSize:18}}>›</span>
                  </button>
                ))}

                {dashcamConsent && (
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px",borderRadius:12,background:"#242424",marginTop:4}}>
                    <div style={{flex:1,paddingRight:10}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>Auto-Record Dashcam</div>
                      <div style={{fontSize:11,color:"#8e9297",marginTop:2,lineHeight:1.5}}>The Dashcam widget always shows the live camera in Drive mode. With this on, it also starts saving a clip automatically once you're over 5 mph — no need to open the widget. Turn off to only record when you start a clip yourself.</div>
                    </div>
                    <button onClick={()=>{const next=!dashcamBgRecord;setDashcamBgRecord(next);if(!next&&dashOn)stopDrive();}} style={{width:44,height:26,borderRadius:13,border:"none",background:dashcamBgRecord?OR:"#333",position:"relative",cursor:"pointer",flexShrink:0,padding:0}}>
                      <div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:dashcamBgRecord?21:3,transition:"left 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
                    </button>
                  </div>
                )}
              </>)}

              {driveSettingsTab==="voice" && (<>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 2px"}}>
                  <div style={{flex:1,paddingRight:10}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>Say "Sono" to Wake</div>
                    <div style={{fontSize:12,color:"#8e9297",marginTop:2,lineHeight:1.5}}>Keep voice control on every time you open Drive mode, so you can talk to your Co-Pilot hands-free without tapping the mic first. This setting saves.</div>
                  </div>
                  <button onClick={()=>setDriveSayWakeEnabled(v=>!v)} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:driveSayWakeEnabled?OR:"#333",position:"relative",flexShrink:0,padding:0}}>
                    <div style={{position:"absolute",top:2,left:driveSayWakeEnabled?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
                  </button>
                </div>
              </>)}

              <button onClick={()=>setShowWidgetSettings(false)} style={{width:"100%",padding:"10px",marginTop:14,borderRadius:9,background:"none",border:"1px solid #333",color:"#8e9297",cursor:"pointer",fontSize:13,fontFamily:F}}>Close</button>
            </div>
          </div>
        )}
      </div>
    );
  });


  /* ── MODALS ── */
  const MusicModal = useStablePanel(() => {
    // Hooks always run first, unconditionally — this used to "if (!showMusic)
    // return null" BEFORE the useState/useEffect calls below, which breaks
    // React's Rules of Hooks (a different number of hooks run depending on
    // showMusic). Since this component never actually unmounts (it's always
    // in the tree; see useStablePanel above), that mismatch made React
    // silently drop this component's hook state and remount it fresh every
    // single time it opened — including mid-session tab/drag state. All
    // hooks now run every render; only the returned JSX is conditional.
    const [activeCbLane, setActiveCbLane] = useState(null);
    const [dragY, setDragY] = useState(0);
    const [dragging, setDragging] = useState(false);
    const dragStartYRef = useRef(null);
    const closeSheet = () => { setShowMusic(false); setActiveCbLane(null); };
    const onDragStart = (e) => { dragStartYRef.current = e.touches?e.touches[0].clientY:e.clientY; setDragging(true); };
    const onDragMove = (e) => {
      if(dragStartYRef.current==null) return;
      const y = e.touches?e.touches[0].clientY:e.clientY;
      const delta = y - dragStartYRef.current;
      if(delta>0) setDragY(delta);
    };
    const onDragEnd = () => {
      if(dragY>90) closeSheet(); else setDragY(0);
      setDragging(false);
      dragStartYRef.current = null;
    };
    const visibleLanes = radiusActive
      ? CB_CITY_LANES.filter(l=>!l.city||l.city==="San Diego")
      : CB_CITY_LANES;
    // Auto-join: opening CB Radio drops you straight into whichever freeway
    // lane your location currently matches, if any.
    useEffect(() => {
      if(showMusic && musicTab==="lanes" && !activeCbLane && currentFreewayId) setActiveCbLane(currentFreewayId);
    }, [showMusic, musicTab, currentFreewayId]);
    if (!showMusic) return null;
    const onCurrentLane = !!activeCbLane && activeCbLane===currentFreewayId;
    // Broadcasting on a lane (pushReport/broadcastOnLane) is shared at the
    // top level now — Drive mode's inline CB Radio app uses the same two
    // functions, so a broadcast reads the same everywhere.
    const switchTab = (id) => {
      setMusicTab(id);
      memStore.setItem("sl_radioTab", id);
      setActiveCbLane(null);
    };

    const TABS = [
      {id:"lanes",   icon:"📡", label:"CB Radio"},
      {id:"music",   icon:"🎵", label:"My Music"},
      {id:"nearby",  icon:"📻", label:"Nearby Stations"},
    ];

    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:600,display:"flex",flexDirection:"column",justifyContent:"flex-end"}} onClick={closeSheet}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:"#0d0d0d",borderRadius:"20px 20px 0 0",height:"86vh",maxHeight:"86vh",
        display:"flex",flexDirection:"column",overflow:"hidden",
        transform:"translateY("+dragY+"px)",transition:dragging?"none":"transform 0.25s ease",
        boxShadow:"0 -8px 30px rgba(0,0,0,0.5)",
      }}>

        {/* Drag handle + header — swipe down to close, like a pop-up tab */}
        <div
          onTouchStart={onDragStart} onTouchMove={onDragMove} onTouchEnd={onDragEnd}
          onMouseDown={onDragStart} onMouseMove={e=>{if(dragging)onDragMove(e);}} onMouseUp={onDragEnd} onMouseLeave={()=>{if(dragging)onDragEnd();}}
          style={{flexShrink:0,cursor:"grab",touchAction:"none"}}>
          <div style={{width:36,height:4,background:"#333",borderRadius:2,margin:"8px auto 6px"}}/>
          <div style={{padding:"4px 16px 10px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #1f1f1f"}}>
            <div style={{flex:1}}>
              <div style={{fontSize:15,fontWeight:800,color:"#fff"}}>{TABS.find(t=>t.id===musicTab)?.label}</div>
            </div>
            <button onClick={closeSheet} style={{width:30,height:30,borderRadius:"50%",background:"#1a1a1a",border:"none",color:"#666",cursor:"pointer",fontSize:17}}>×</button>
          </div>
        </div>

        {/* ── CB RADIO — lane list ── */}
        {musicTab==="lanes" && !activeCbLane && (
          <div style={{flex:1,overflowY:"auto",padding:"14px 16px 24px"}}>
            <div style={{fontSize:11,color:"#555",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>
              {radiusActive ? "NEARBY FREEWAY LANES · "+appRadius+" MI" : "ALL FREEWAY LANES"}
            </div>
            <div style={{fontSize:12,color:currentFreewayId?"#23a55a":"#666",marginBottom:10,lineHeight:1.5}}>
              {currentFreewayId
                ? "📍 You're on "+CB_CITY_LANES.find(l=>l.id===currentFreewayId)?.name+" — you can talk on that lane."
                : "🔒 You can view any lane here, but can only talk once your location matches that freeway."}
            </div>
            {visibleLanes.map(lane=>{
              const updates=laneTrafficUpdates[lane.id]||[];
              const last=updates[0];
              const here = lane.id===currentFreewayId;
              return (
                <button key={lane.id} onClick={()=>setActiveCbLane(lane.id)} style={{
                  width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px",
                  marginBottom:8,borderRadius:14,border:"none",cursor:"pointer",fontFamily:F,
                  background:"#181818",textAlign:"left",
                }}>
                  <div style={{width:48,height:48,borderRadius:12,background:lane.color+"22",border:"1.5px solid "+lane.color+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>📡</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                      <span style={{fontSize:16,fontWeight:800,color:"#fff"}}>{lane.name}</span>
                      <div style={{width:5,height:5,borderRadius:"50%",background:here?"#23a55a":"#555"}}/>
                      <span style={{fontSize:10,color:here?"#23a55a":"#666",fontWeight:700}}>{here?"YOU'RE HERE":"VIEW ONLY"}</span>
                    </div>
                    <div style={{fontSize:12,color:"#555"}}>{lane.desc}</div>
                    {last
                      ? <div style={{fontSize:11,color:"#888",marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{last.icon} "{last.text}" · {timeAgo(last.ts)}</div>
                      : <div style={{fontSize:11,color:"#3a3a3a",marginTop:3,fontStyle:"italic"}}>No recent updates</div>}
                  </div>
                  <div style={{fontSize:20,color:"#333"}}>›</div>
                </button>
              );
            })}
            {radiusActive && <div style={{fontSize:11,color:"#444",textAlign:"center",paddingTop:4}}>Radius: {appRadius} mi · <button onClick={()=>{setShowMusic(false);go("profile");setTimeout(()=>setSubPanel("radius"),100);}} style={{background:"none",border:"none",color:OR,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>Change</button></div>}
          </div>
        )}

        {/* ── CB RADIO — active lane ── a pure voice call room while you're on that
             freeway (no text at all — just hold-to-talk, live the instant you
             enter); a read-only feed of transcribed/summarized reports when
             you're browsing a lane you're not currently on, e.g. before driving. ── */}
        {musicTab==="lanes" && activeCbLane && (() => {
          const laneObj = CB_CITY_LANES.find(l=>l.id===activeCbLane);
          const riders = 2 + ((laneObj?.id.split("").reduce((s,c)=>s+c.charCodeAt(0),0))%4);
          const updates = laneTrafficUpdates[activeCbLane]||[];
          return (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:"1px solid #1f1f1f",flexShrink:0,display:"flex",alignItems:"center",gap:10}}>
              <button onClick={()=>setActiveCbLane(null)} style={{fontSize:20,background:"none",border:"none",color:"#555",cursor:"pointer"}}>←</button>
              <div style={{width:8,height:8,borderRadius:"50%",background:laneObj?.color||OR}}/>
              <div style={{flex:1}}><div style={{fontSize:15,fontWeight:800,color:"#fff"}}>{laneObj?.name}</div><div style={{fontSize:11,color:"#555"}}>{laneObj?.desc}</div></div>
              <div style={{display:"flex",alignItems:"center",gap:3,background:onCurrentLane?"#23a55a22":"#66666622",borderRadius:20,padding:"3px 8px"}}>
                <div style={{width:5,height:5,borderRadius:"50%",background:onCurrentLane?"#23a55a":"#666",...(onCurrentLane?{animation:"pulse 1s infinite"}:{})}}/>
                <span style={{fontSize:10,color:onCurrentLane?"#23a55a":"#888",fontWeight:700}}>{onCurrentLane?"LIVE":"BROWSING"}</span>
              </div>
            </div>

            {onCurrentLane ? (
              /* ── Live voice call room — no text, connected the instant you enter ── */
              <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"20px 24px"}}>
                <div style={{position:"relative",width:120,height:120,marginBottom:18}}>
                  <div style={{position:"absolute",inset:0,borderRadius:"50%",background:(laneObj?.color||OR)+"22",animation:"pulse 1.6s infinite"}}/>
                  <div style={{position:"absolute",inset:14,borderRadius:"50%",background:"linear-gradient(135deg,"+(laneObj?.color||OR)+",#000)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:42}}>📡</div>
                </div>
                <div style={{fontSize:17,fontWeight:800,color:"#fff",marginBottom:4}}>Connected — ready to talk</div>
                <div style={{fontSize:13,color:"#666",textAlign:"center",lineHeight:1.6,marginBottom:6}}>You're live on {laneObj?.name}. Hold the button below to broadcast.</div>
                <div style={{fontSize:12,color:"#444",fontWeight:700}}>🎧 {riders} riders connected</div>
              </div>
            ) : (
              /* ── Browsing (not on this freeway) — read-only transcribed/summarized
                   traffic reports, so conditions can be checked before driving ── */
              <div style={{flex:1,overflowY:"auto",padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",marginBottom:12,borderRadius:10,background:"#181818"}}>
                  <span style={{fontSize:17}}>🔒</span>
                  <span style={{fontSize:12,color:"#888",lineHeight:1.5}}>Get on {laneObj?.name} to join the live call. Meanwhile, here's what's been reported recently.</span>
                </div>
                {updates.length===0 ? (
                  <div style={{textAlign:"center",color:"#444",paddingTop:30}}>
                    <div style={{fontSize:26,marginBottom:6}}>📡</div>
                    <div style={{fontSize:13}}>No recent updates on this lane.</div>
                  </div>
                ) : updates.map(u=>(
                  <div key={u.id} style={{display:"flex",gap:10,padding:"11px 12px",marginBottom:8,borderRadius:12,background:"#181818"}}>
                    <div style={{fontSize:20,flexShrink:0}}>{u.icon}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,color:"#ddd",lineHeight:1.5,marginBottom:3}}>{u.text}</div>
                      <div style={{fontSize:11,color:"#555"}}><span style={{color:u.color,fontWeight:700}}>{u.handle}</span> · {timeAgo(u.ts)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {onCurrentLane && (
              <div style={{padding:"6px 14px 12px",flexShrink:0}}>
                <button
                  onMouseDown={()=>{setCbRecording(true);setCbTimer(0);cbTimerRef.current=setInterval(()=>setCbTimer(t=>t+1),1000);}}
                  onMouseUp={()=>{clearInterval(cbTimerRef.current);setCbRecording(false);setCbTimer(0);broadcastOnLane(activeCbLane);}}
                  onTouchStart={e=>{e.preventDefault();setCbRecording(true);setCbTimer(0);cbTimerRef.current=setInterval(()=>setCbTimer(t=>t+1),1000);}}
                  onTouchEnd={e=>{e.preventDefault();clearInterval(cbTimerRef.current);setCbRecording(false);setCbTimer(0);broadcastOnLane(activeCbLane);}}
                  style={{width:"100%",padding:"14px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:F,background:cbRecording?"#ed4245":"#23a55a",color:"#fff",fontSize:15,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  {cbRecording ? (<><span style={{width:7,height:7,borderRadius:"50%",background:"#fff",animation:"pulse 0.5s infinite",display:"block"}}/>{"Broadcasting… "+cbTimer+"s"}</>) : (<><span>{"📡"}</span>{"Hold to Talk"}</>)}
                </button>
              </div>
            )}
          </div>
          );
        })()}

        {/* ── MY MUSIC — full view ── */}
        {musicTab==="music" && (
          <div style={{flex:1,overflowY:"auto",padding:"14px 16px 24px"}}>
            {/* Now Playing — a real Spotify connection needs Spotify's own
                developer OAuth key, which we don't have, so once you connect
                below this drives an actually-ticking player (real elapsed
                time, auto-advancing tracks) instead of a static mockup. */}
            {spotifyLinked && (
              <div style={{background:"linear-gradient(160deg,"+SPOTIFY_TRACKS[spotifyTrackIdx].color+",#111)",borderRadius:16,padding:"16px",marginBottom:16}}>
                <div style={{fontSize:10,color:"#fff",opacity:0.8,fontWeight:700,letterSpacing:1.2,marginBottom:10}}>🎧 NOW PLAYING</div>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                  <div style={{width:52,height:52,borderRadius:10,background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>🎵</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:16,fontWeight:800,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SPOTIFY_TRACKS[spotifyTrackIdx].title}</div>
                    <div style={{fontSize:13,color:"#fff",opacity:0.85,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SPOTIFY_TRACKS[spotifyTrackIdx].artist}</div>
                  </div>
                </div>
                <div style={{width:"100%",height:4,borderRadius:2,background:"rgba(255,255,255,0.25)",overflow:"hidden",marginBottom:6}}>
                  <div style={{height:"100%",background:"#fff",width:(spotifyElapsed/SPOTIFY_TRACKS[spotifyTrackIdx].dur*100)+"%"}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#fff",opacity:0.75,marginBottom:12}}>
                  <span>{Math.floor(spotifyElapsed/60)}:{String(spotifyElapsed%60).padStart(2,"0")}</span>
                  <span>{Math.floor(SPOTIFY_TRACKS[spotifyTrackIdx].dur/60)}:{String(SPOTIFY_TRACKS[spotifyTrackIdx].dur%60).padStart(2,"0")}</span>
                </div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:22}}>
                  <button onClick={()=>{setSpotifyTrackIdx(i=>(i-1+SPOTIFY_TRACKS.length)%SPOTIFY_TRACKS.length);setSpotifyElapsed(0);}} style={{background:"none",border:"none",color:"#fff",fontSize:20,cursor:"pointer"}}>⏮</button>
                  <button onClick={()=>setSpotifyPlaying(p=>!p)} style={{width:44,height:44,borderRadius:"50%",background:"#fff",border:"none",color:"#111",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{spotifyPlaying?"⏸":"▶️"}</button>
                  <button onClick={()=>{setSpotifyTrackIdx(i=>(i+1)%SPOTIFY_TRACKS.length);setSpotifyElapsed(0);}} style={{background:"none",border:"none",color:"#fff",fontSize:20,cursor:"pointer"}}>⏭</button>
                </div>
              </div>
            )}
            <div style={{fontSize:11,color:"#555",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>STREAMING SERVICES</div>
            {[{name:"Spotify",color:"#1DB954",icon:"🎧",linked:spotifyLinked,set:setSpotifyLinked},{name:"Apple Music",color:"#fc3c44",icon:"🎶",linked:appleOn,set:setAppleOn}].map(svc=>(
              <div key={svc.name} style={{background:"#181818",borderRadius:14,padding:"14px",marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:44,height:44,borderRadius:11,background:svc.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>{svc.icon}</div>
                <div style={{flex:1}}><div style={{fontSize:16,fontWeight:700,color:"#fff"}}>{svc.name}</div><div style={{fontSize:12,color:svc.linked?svc.color:"#555"}}>{svc.linked?"Connected":"Not connected"}</div></div>
                <button onClick={()=>svc.set(l=>!l)} style={{padding:"7px 14px",borderRadius:20,fontSize:13,fontWeight:700,background:svc.linked?"#2a2a2a":svc.color,color:svc.linked?"#ef4444":"#fff",border:"none",cursor:"pointer",fontFamily:F}}>{svc.linked?"Unlink":"Connect"}</button>
              </div>
            ))}
          </div>
        )}

        {/* ── NEARBY STATIONS — full view (also hosts My Broadcast / registration) ── */}
        {musicTab==="nearby" && (
          <div style={{flex:1,overflowY:"auto",padding:"14px 16px 24px"}}>
            <div style={{fontSize:11,color:"#555",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>MY BROADCAST</div>
            {isBroad ? (
              <div style={{background:"#ef444422",border:"1px solid #ef444444",borderRadius:14,padding:"14px",display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
                <div style={{width:12,height:12,borderRadius:"50%",background:"#ef4444",animation:"pulse 1s infinite",flexShrink:0}}/>
                <div style={{flex:1}}><div style={{fontSize:16,fontWeight:800,color:"#ef4444"}}>{broadName}</div><div style={{fontSize:12,color:"#666"}}>Broadcasting live now</div></div>
                <button onClick={()=>setIsBroad(false)} style={{padding:"6px 14px",borderRadius:20,background:"#2a2a2a",border:"none",color:"#ef4444",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>⏹ End</button>
              </div>
            ) : radioHosts.length>0 ? (
              <div style={{marginBottom:18}}>
                {radioHosts.map((h,i)=>(
                  <div key={i} style={{background:"#181818",borderRadius:14,padding:"14px",marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
                    <div style={{width:44,height:44,borderRadius:11,background:OR+"22",border:"1px solid "+OR+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📻</div>
                    <div style={{flex:1}}><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>{h.name}</div><div style={{fontSize:12,color:"#555"}}>{h.genre} · @{h.handle}</div></div>
                    <button onClick={()=>{setBroadName(h.name);setIsBroad(true);}} style={{padding:"6px 12px",borderRadius:20,background:"#ef4444",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>Go Live</button>
                  </div>
                ))}
              </div>
            ) : !showReg ? (
              <button onClick={()=>setShowReg(true)} style={{width:"100%",padding:"14px",borderRadius:14,background:"transparent",border:"1.5px dashed #ef444466",color:"#ef4444",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F,marginBottom:18}}>📻 Register as Radio Host</button>
            ) : null}

            {showReg && (
              <div style={{background:"#181818",borderRadius:14,padding:"16px",marginBottom:18}}>
                <div style={{fontSize:15,fontWeight:800,color:"#fff",marginBottom:12}}>Host Registration</div>
                <input value={hostForm.name} onChange={e=>setHostForm(f=>({...f,name:e.target.value}))} placeholder="Station name *" style={{...INP,background:"#222",border:"1px solid #333",color:"#fff",marginBottom:8}}/>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                  {["Hip-Hop","Lo-Fi","Rock","R&B","Electronic","Pop","Jazz","Talk"].map(g=>(
                    <button key={g} onClick={()=>setHostForm(f=>({...f,genre:g}))} style={{padding:"5px 11px",borderRadius:20,fontSize:12,fontWeight:600,cursor:"pointer",background:hostForm.genre===g?OR:"#222",color:hostForm.genre===g?"#fff":"#666",border:"none",fontFamily:F}}>{g}</button>
                  ))}
                </div>
                <input value={hostForm.handle} onChange={e=>setHostForm(f=>({...f,handle:e.target.value}))} placeholder="@handle" style={{...INP,background:"#222",border:"1px solid #333",color:"#fff",marginBottom:8}}/>
                <textarea value={hostForm.bio} onChange={e=>setHostForm(f=>({...f,bio:e.target.value}))} placeholder="Short bio…" rows={2} style={{...INP,background:"#222",border:"1px solid #333",color:"#fff",resize:"none",marginBottom:12}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{if(!hostForm.name.trim())return;setRadioHosts(h=>[...h,{...hostForm}]);setHostForm({name:"",genre:"",bio:"",handle:""});setShowReg(false);}} style={{flex:1,padding:"11px",borderRadius:10,background:OR,color:"#fff",border:"none",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F}}>Register</button>
                  <button onClick={()=>setShowReg(false)} style={{padding:"11px 16px",borderRadius:10,background:"#222",border:"1px solid #333",color:"#555",cursor:"pointer",fontFamily:F}}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{fontSize:11,color:"#555",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>
              {radiusActive ? "RADIO HOSTS · "+appRadius+" MI" : "ALL RADIO HOSTS"}
            </div>
            {radioHosts.length===0 ? (
              <div style={{textAlign:"center",padding:"40px 20px",color:"#444"}}>
                <div style={{fontSize:38,marginBottom:10}}>📻</div>
                <div style={{fontSize:15,fontWeight:700,color:"#666",marginBottom:6}}>No stations nearby yet</div>
                <div style={{fontSize:13,color:"#444",marginBottom:14}}>Be the first to register a station above.</div>
              </div>
            ) : radioHosts.map((h,i)=>(
              <div key={i} style={{background:"#181818",borderRadius:14,padding:"14px",marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:48,height:48,borderRadius:12,background:OR+"22",border:"1.5px solid "+OR+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>📻</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:16,fontWeight:800,color:"#fff"}}>{h.name}</div>
                  <div style={{fontSize:12,color:"#555"}}>{h.genre} · @{h.handle}</div>
                  {h.bio && <div style={{fontSize:12,color:"#444",marginTop:3}}>{h.bio}</div>}
                </div>
                <button onClick={()=>toggleSavedStation(h.name)} title={savedStations.includes(h.name)?"Remove from saved stations":"Save station"} style={{background:"none",border:"none",color:savedStations.includes(h.name)?OR:"#555",fontSize:18,cursor:"pointer",padding:4,flexShrink:0}}>{savedStations.includes(h.name)?"★":"☆"}</button>
                {isBroad&&broadName===h.name
                  ? (<div style={{display:"flex",alignItems:"center",gap:4,background:"#ef444422",borderRadius:20,padding:"4px 10px"}}><div style={{width:5,height:5,borderRadius:"50%",background:"#ef4444"}}/><span style={{fontSize:11,color:"#ef4444",fontWeight:700}}>LIVE</span></div>)
                  : (<button style={{padding:"6px 12px",borderRadius:20,background:"#2a2a2a",color:"#888",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>▶ Listen</button>)}
              </div>
            ))}
          </div>
        )}

        {/* ── Bottom 3-button nav ── */}
        {!activeCbLane && (
          <div style={{flexShrink:0,display:"flex",borderTop:"1px solid #1f1f1f",background:"#0d0d0d",paddingBottom:"env(safe-area-inset-bottom, 4px)"}}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>switchTab(t.id)} style={{
                flex:1,padding:"10px 4px 8px",border:"none",cursor:"pointer",fontFamily:F,
                background:"transparent",display:"flex",flexDirection:"column",alignItems:"center",gap:3,
              }}>
                <span style={{fontSize:21,opacity:musicTab===t.id?1:0.4}}>{t.icon}</span>
                <span style={{fontSize:11,fontWeight:musicTab===t.id?800:500,color:musicTab===t.id?OR:"#555"}}>{t.label}</span>
                {musicTab===t.id && <div style={{width:16,height:2,borderRadius:1,background:OR,marginTop:1}}/>}
              </button>
            ))}
          </div>
        )}
      </div>
      </div>
    );
  });
  const WidgetPicker = useStablePanel(() => {
    if (!widgetEdit) return null;
    const curOnlyOn = widgetEdit==="1"?widget1OnlyOn:widgetEdit==="2"?widget2OnlyOn:widget3OnlyOn;
    const setCurOnlyOn = widgetEdit==="1"?setWidget1OnlyOn:widgetEdit==="2"?setWidget2OnlyOn:setWidget3OnlyOn;
    const curWidget = widgetEdit==="1"?widget1:widgetEdit==="2"?widget2:widget3;
    // Back returns to the small ⚙️ widgets list if that's where this was
    // opened from (Drive mode); otherwise it just closes, same as Done.
    const closePicker = () => {
      setWidgetEdit(null);
      if(widgetEditFrom==="drive") setShowWidgetSettings(true);
      setWidgetEditFrom(null);
    };
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:600,display:"flex",alignItems:"flex-end"}} onClick={closePicker}>
        <div style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:18}} onClick={e=>e.stopPropagation()}>
          <div style={{width:30,height:3,background:"#e8e8e8",borderRadius:2,margin:"0 auto 14px"}}/>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <button onClick={closePicker} style={{fontSize:20,background:"none",border:"none",color:"#111",cursor:"pointer",padding:0}}>←</button>
            <div style={{fontSize:15,fontWeight:800,color:"#111",flex:1}}>{widgetEdit==="1"?"Top":widgetEdit==="2"?"Mid":"Bottom"} Widget</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[["weather","☀️","Weather"],["music","🎵","My Music"],["spotify","🎧","Spotify"],["cbradio","📡","CB Radio"],["points","⭐","Star Points"],["friends","👥","Friends"],["topfriends","👥","Top 3 Friends"],["routes","🗺️","My Routes"],["dashcam","📹","Dashcam"],["none","＋","Empty"]].map(([id,ic,label])=>{
              const cur=widgetEdit==="1"?widget1:widgetEdit==="2"?widget2:widget3;
              return (
                <button key={id} onClick={()=>{if(widgetEdit==="1")setWidget1(id);else if(widgetEdit==="2")setWidget2(id);else setWidget3(id);}}
                  style={{padding:"14px 10px",borderRadius:12,border:"2px solid "+(cur===id?OR:"#ebebeb"),background:cur===id?OR+"08":"#f8f8f8",cursor:"pointer",textAlign:"left",fontFamily:F}}>
                  <div style={{marginBottom:4}}>{id==="routes"?<DPadIcon id="road" color={DPAD_COLORS.road} size={22}/>:<span style={{fontSize:24}}>{ic}</span>}</div>
                  <div style={{fontSize:13,fontWeight:700,color:cur===id?OR:"#111"}}>{label}</div>
                </button>
              );
            })}
          </div>
          {/* For every widget except Empty, this hides the slot until it's
              actually active (dashcam recording, Spotify playing, etc.). For
              Empty specifically there's no "active" state, so the toggle
              simply hides it outright — either way the other widget(s)
              stretch to fill the freed space since each is just an equal
              flex slot in the same row/column. */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 2px 2px",marginTop:10,borderTop:"1px solid #ebebeb"}}>
            <div style={{flex:1,paddingRight:10}}>
              <div style={{fontSize:13,fontWeight:700,color:"#111"}}>{curWidget==="none"?"Hide this slot":"Only show when turned on"}</div>
              <div style={{fontSize:11,color:"#111",marginTop:2,lineHeight:1.5}}>{curWidget==="none"?"Remove this empty slot from the bar so the other widget(s) split the space between them.":"Hide this slot until it's active — the other widgets stretch to fill the space."}</div>
            </div>
            <button onClick={()=>setCurOnlyOn(v=>!v)} style={{width:38,height:22,borderRadius:11,border:"none",cursor:"pointer",background:curOnlyOn?OR:"#d8d8d8",position:"relative",flexShrink:0,padding:0}}>
              <div style={{position:"absolute",top:2,left:curOnlyOn?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s ease"}}/>
            </button>
          </div>
          <button onClick={closePicker} style={{width:"100%",padding:"10px",marginTop:12,borderRadius:9,background:OR,border:"none",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:F}}>Done</button>
        </div>
      </div>
    );
  });

  /* ── RENDER ── */
  const PANELS = {profile:ProfilePanel,discover:DiscoverPanel,create:CreatePanel,drive:DrivePanel};
  const ActivePanel = PANELS[panel] || ProfilePanel;

  // Top page-switcher — Lanes / Garage / Discover — replaces the old dpad.
  // Highlights the current page, jumps directly on tap, hidden during Drive mode.
  const TOPNAV_ITEMS = [
    {id:"create",   label:"Lanes",    iconId:"chat"},
    {id:"profile",  label:"SonoLane", iconId:"profile"},
    {id:"discover", label:"Discover", iconId: discoverTab==="events" ? "event" : "road"},
  ];
  // Now a bottom tab bar (moved down from the top) — a top border separates
  // it from the page content above instead of a bottom border below it.
  // While Lanes is the active page, it picks up Lanes' own dark grey theme
  // (matching the chat above it) instead of staying white like every other
  // page — only the currently-open page's own nav bar tints, not the app
  // globally.
  const TopNav = () => {
    const onLanes = panel==="create";
    return (
    <div style={{flexShrink:0,display:"flex",gap:4,padding:"6px 8px 0",paddingBottom:"calc(2px + env(safe-area-inset-bottom, 0px))",background:onLanes?"#36393f":"#fff",borderTop:"1px solid "+(onLanes?"#202225":"#ebebeb"),zIndex:100}}>
      {TOPNAV_ITEMS.map(it=>{
        const active = panel===it.id;
        const color = DPAD_COLORS[it.iconId];
        return (
          <button key={it.id} onClick={()=>go(it.id)} style={{
            flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:7,
            padding:"7px 6px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:F,
            background:active?color+"14":"transparent",
          }}>
            {it.id==="profile" ? <CompassStar size={20} color={color}/> : <DPadIcon id={it.iconId} color={color} size={20}/>}
            <span style={{fontSize:14,fontWeight:active?800:600,color:active?color:(onLanes?"#8e9297":"#888")}}>{it.label}</span>
          </button>
        );
      })}
    </div>
    );
  };

  // Shared top bar — a persistent header above every page (Profile, Discover,
  // Lanes), matching the persistent TopNav below. "+" opens the same
  // quick-create sheet (Route Post / Event) from anywhere; "☰" opens the
  // info drawer (Settings, Terms of Service, Privacy Policy, About, Help).
  // Used to live only inside Profile — now shared so Discover and Lanes get
  // it too, instead of only Profile having quick access to it.
  // Every full-screen Profile sub-page that draws its own back button gets
  // its entry here instead — whenever one of these is open, the shared
  // TopBar itself becomes that page's back button (and its one main
  // right-side action, where it has one), replacing the usual +/☰, rather
  // than the page drawing a second header row underneath. `back`/`onBack`
  // handlers were hoisted up next to `go()` for exactly this reason.
  const BACK_PAGES = {
    car:          { onBack: ()=>setSubPanel(carDetailFrom==="garage"?"garage":null), right: {icon:"✎", title:"Edit car", onClick:()=>setSubPanel("editcar")} },
    editcar:      { onBack: ()=>setSubPanel("car"), title:"Edit Car", right: {label:"Save", onClick:saveEditCar} },
    createroute:  { onBack: cancelCreateRoute, title: editingRouteId?"Edit Route":"Create Route", right: {label:"Save", onClick:saveCreateRoute} },
    sharedgarage: { onBack: cancelSharedGarage, right: {label:"💬 Chat", onClick:openSharedGarageChat} },
    following:    { onBack: back, title:"Following" },
    followerslist:{ onBack: back, title:"Followers" },
    friends:      { onBack: back, title:"Friends", right: {label:"+ Add", onClick:()=>setShowAddFriend(true)} },
    edit:         { onBack: back, title:"Edit Profile", right: {label:"Save", onClick:saveEditProfile} },
    radius:       { onBack: back, title:"Discovery Radius" },
    rewards:      { onBack: back, title:"🏆 Rewards", dark:true },
    top3friend:   { onBack: ()=>setSubPanel(null), dark:true },
  };
  const TopBar = () => {
    const onLanes = panel==="create";
    // Lanes' chat room is its own full page too (see lanesView) — the
    // shared TopBar becomes its back button the same way BACK_PAGES does
    // for Profile sub-pages, even though Lanes isn't driven by subPanel.
    // No title/right action here since the chat room's own header (name,
    // online status, etc.) already renders as page content underneath.
    const backPage = panel==="profile" ? BACK_PAGES[subPanel]
      : (onLanes && lanesView==="room") ? { onBack: backFromLanesRoom }
      : null;
    const dark = onLanes || !!backPage?.dark;
    // Top bar icon buttons are transparent now — no circular shading behind
    // them — just the glyph itself, colored for whichever background this
    // page's top bar has.
    const btnColor = dark ? "#dcddde" : "#111";
    return (
      <>
        <div style={{padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexShrink:0,background:dark?"#36393f":"#fff",borderBottom:"1px solid "+(dark?"#202225":"#ebebeb"),zIndex:100}}>
          {/* Left button — the plain "+" everywhere, except on a page that
              has its own back button, where the TopBar becomes that button.
              On the Lanes chat list specifically, + starts a new Lane
              instead of the generic Route Post/Event sheet — chat is what
              this page is for, so + here should do the chat thing (Jakob's
              Law: a + inside a chat list is expected to start a chat). */}
          {backPage ? (
            <button onClick={backPage.onBack} title="Back" style={{width:44,height:44,borderRadius:"50%",background:"transparent",border:"none",color:btnColor,fontSize:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>←</button>
          ) : (
            <button onClick={()=>(onLanes&&lanesView==="list") ? setShowCreateLane(true) : setShowQuickCreate(true)} title={(onLanes&&lanesView==="list") ? "New Lane" : "Create"} style={{width:44,height:44,borderRadius:"50%",background:"transparent",border:"none",color:btnColor,fontSize:40,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>+</button>
          )}

          {/* Middle — page-specific content: a back page's own title (when
              it has one — some, like Car Details, keep their title in the
              page content instead), search on Discover (Routes or Events,
              whichever tab is active), the username centered on Profile
              home, or — on Lanes — the page's icon+title centered by
              default, swapped for the actual search box while search is
              active (see the 🔍/✕ button on the right). */}
          {backPage ? (
            backPage.title && <div style={{flex:1,minWidth:0,textAlign:"center",fontSize:15,fontWeight:800,color:dark?"#fff":"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{backPage.title}</div>
          ) : panel==="discover" ? (
            <input
              value={discoverTab==="routes" ? feedSearch : evSearch}
              onChange={e=>discoverTab==="routes" ? setFeedSearch(e.target.value) : setEvSearch(e.target.value)}
              placeholder={discoverTab==="routes" ? "Search routes…" : "Search events…"}
              style={{flex:1,minWidth:0,padding:"8px 14px",borderRadius:20,border:"1px solid #ebebeb",background:"#f3f3f3",color:"#111",fontSize:13,fontFamily:F,outline:"none"}}
            />
          ) : panel==="profile" ? (
            <div style={{flex:1,minWidth:0,textAlign:"center",fontSize:15,fontWeight:800,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{userName || "You"}</div>
          ) : onLanes ? (
            lanesSearchActive ? (
              <input
                autoFocus
                value={laneUserSearch}
                onChange={e=>setLaneUserSearch(e.target.value)}
                placeholder="Find users…"
                style={{flex:1,minWidth:0,padding:"8px 14px",borderRadius:20,border:"1px solid #4f545c",background:"#40444b",color:"#dcddde",fontSize:13,fontFamily:F,outline:"none"}}
              />
            ) : (
              <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontSize:15,fontWeight:800,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                <DPadIcon id="chat" color={DPAD_COLORS.chat} size={16}/> Lanes
              </div>
            )
          ) : null}

          {/* Right button — the hamburger menu everywhere, except: a back
              page, where it becomes that page's one main action (Save,
              +Add, …) if it has one, or disappears entirely if it doesn't;
              and Lanes, where it's a SearchIcon that swaps the centered
              title for the search box above (and back to ✕ to close
              search and clear it) instead of the menu. */}
          {backPage ? (
            backPage.right && (
              <button onClick={backPage.right.onClick} title={backPage.right.title} style={backPage.right.label ? {padding:"6px 14px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,flexShrink:0} : {width:44,height:44,borderRadius:"50%",background:"transparent",border:"none",color:btnColor,fontSize:32,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {backPage.right.label || backPage.right.icon}
              </button>
            )
          ) : onLanes ? (
            <button onClick={()=>{
              if(lanesSearchActive){ setLanesSearchActive(false); setLaneUserSearch(""); }
              else setLanesSearchActive(true);
            }} title={lanesSearchActive?"Close search":"Search"} style={{width:44,height:44,borderRadius:"50%",background:"transparent",border:"none",color:btnColor,fontSize:32,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{lanesSearchActive?"✕":<SearchIcon size={26} color={btnColor}/>}</button>
          ) : (
            <button onClick={()=>{setInfoDrawerPage(null);setShowInfoDrawer(true);}} title="Menu" style={{width:44,height:44,borderRadius:"50%",background:"transparent",border:"none",color:btnColor,fontSize:32,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>☰</button>
          )}
        </div>

        {/* Quick create sheet */}
        {showQuickCreate && (
          <div onClick={()=>setShowQuickCreate(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:700,display:"flex",alignItems:"flex-end"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",padding:"12px 16px 20px"}}>
              <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"0 auto 16px"}}/>
              <div style={{fontSize:16,fontWeight:800,color:"#111",marginBottom:12}}>Create</div>
              <button onClick={()=>{
                setShowQuickCreate(false);
                setNewPost({title:"",body:"",type:"scenic",distance:"",stops:["",""],highlights:""});
                setPostPhotos([]); setPostRouteMode("new"); setPostSavedRoute(null); setEditingPostId(null);
                setShowPost(true); go("discover"); setDiscoverTab("routes");
              }} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:12,marginBottom:8,background:"#f8f8f8",border:"1px solid #ebebeb",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                <DPadIcon id="road" color={DPAD_COLORS.road} size={20}/>
                <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Route Post</div>
              </button>
              <button onClick={()=>{
                setShowQuickCreate(false);
                setNewEvent({title:"",type:"car meet",desc:"",address:"",date:""});
                setEventPhotos([]); setEditingEventId(null);
                setShowEvent(true); go("discover"); setDiscoverTab("events");
              }} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:12,background:"#f8f8f8",border:"1px solid #ebebeb",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                <DPadIcon id="event" color={DPAD_COLORS.event} size={20}/>
                <div style={{fontSize:14,fontWeight:700,color:"#111"}}>Event</div>
              </button>
            </div>
          </div>
        )}

        {/* Info drawer — Settings + Terms of Service / Privacy Policy /
            About / Help, opened from the hamburger in the top bar. Slides
            in from the right like a standard side menu. */}
        {showInfoDrawer && (() => {
          const INFO_PAGES = {
            tos: {
              title:"Terms of Service",
              body:[
                ["Using SonoLane","By using SonoLane, you agree to use it responsibly — never operate Drive Mode, the Dashcam, or any other in-app feature in a way that distracts you from driving safely. Pull over before interacting with the app if you need to."],
                ["Your content","Routes, events, photos, and car avatars you post stay yours. Posting something publicly gives other SonoLane users permission to view it in their feeds. Don't post anything you don't have the rights to."],
                ["Community conduct","Don't use SonoLane to harass, spam, or scam other drivers. Accounts that break these rules can be suspended."],
                ["Demo notice","SonoLane is a demo app — this text is placeholder copy, not a binding legal agreement."],
              ],
            },
            privacy: {
              title:"Privacy Policy",
              body:[
                ["What we store","Your profile info, car avatars, routes, events, messages, and location-sharing preferences are stored so the app can show them back to you and to the friends you choose to share with."],
                ["Location sharing","Live location is only ever shared with a Top 3 Friend after you explicitly turn Share Live Location on for them, and stays off for everyone else by default."],
                ["Dashcam clips","Dashcam recordings stay on your device/account and are never shared automatically — you choose if and when to share a clip."],
                ["Demo notice","SonoLane is a demo app — this text is placeholder copy describing intended behavior, not a real data-handling policy."],
              ],
            },
            about: {
              title:"About SonoLane",
              body:[
                ["What it is","SonoLane is a social driving app — track drives, share routes and meetup events, keep a garage of car avatars, and stay in touch with friends over Lanes chat and walkie-talkie voice messages."],
                ["Version","SonoLane · demo build."],
              ],
            },
            help: {
              title:"Help & Support",
              body:[
                ["Getting started","Set up your profile and car avatar from the Profile tab, then post your first route or event from Discover."],
                ["Need something else?","This is a demo build without a live support line — check back here for updates as new features ship."],
              ],
            },
          };
          const page = infoDrawerPage ? INFO_PAGES[infoDrawerPage] : null;
          return (
            <div onClick={()=>{setShowInfoDrawer(false);setInfoDrawerPage(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:850,display:"flex",justifyContent:"flex-end"}}>
              <div onClick={e=>e.stopPropagation()} style={{width:"82%",maxWidth:320,height:"100%",background:"#fff",display:"flex",flexDirection:"column",boxShadow:"-4px 0 24px rgba(0,0,0,0.15)",paddingTop:"env(safe-area-inset-top, 0px)",paddingBottom:"env(safe-area-inset-bottom, 0px)",boxSizing:"border-box"}}>
                {!page ? (<>
                  <div style={{padding:"16px 18px",borderBottom:"1px solid #ebebeb",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
                    <div style={{fontSize:17,fontWeight:800,color:"#111"}}>Menu</div>
                    <button onClick={()=>setShowInfoDrawer(false)} style={{background:"none",border:"none",fontSize:20,color:"#111",cursor:"pointer"}}>✕</button>
                  </div>
                  <div style={{flex:1,overflowY:"auto",padding:"8px 10px"}}>
                    {[
                      ["⚙️","Settings", ()=>{setShowInfoDrawer(false);go("profile");setTimeout(()=>setSubPanel("settings"),100);}],
                      ["📄","Terms of Service", ()=>setInfoDrawerPage("tos")],
                      ["🔒","Privacy Policy", ()=>setInfoDrawerPage("privacy")],
                      ["ℹ️","About SonoLane", ()=>setInfoDrawerPage("about")],
                      ["💬","Help & Support", ()=>setInfoDrawerPage("help")],
                    ].map(([icon,label,action])=>(
                      <button key={label} onClick={action} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"13px 8px",borderRadius:10,background:"none",border:"none",cursor:"pointer",fontFamily:F,textAlign:"left"}}>
                        <span style={{fontSize:17,flexShrink:0}}>{icon}</span>
                        <span style={{flex:1,fontSize:14,fontWeight:700,color:"#111"}}>{label}</span>
                        <span style={{color:"#ccc",fontSize:14}}>›</span>
                      </button>
                    ))}
                  </div>
                </>) : (<>
                  <div style={{padding:"16px 18px",borderBottom:"1px solid #ebebeb",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                    <button onClick={()=>setInfoDrawerPage(null)} style={{background:"none",border:"none",fontSize:20,color:"#111",cursor:"pointer"}}>←</button>
                    <div style={{fontSize:16,fontWeight:800,color:"#111",flex:1}}>{page.title}</div>
                  </div>
                  <div style={{flex:1,overflowY:"auto",padding:"16px 18px"}}>
                    {page.body.map(([h,b])=>(
                      <div key={h} style={{marginBottom:16}}>
                        <div style={{fontSize:13,fontWeight:800,color:"#111",marginBottom:4}}>{h}</div>
                        <div style={{fontSize:13,color:"#111",lineHeight:1.6}}>{b}</div>
                      </div>
                    ))}
                  </div>
                </>)}
              </div>
            </div>
          );
        })()}
      </>
    );
  };

  // Real-backend mode only: block on the session check, then require a
  // signed-in user before the app itself ever renders. Local demo mode
  // (isSupabaseConfigured === false) skips all of this entirely.
  if (isSupabaseConfigured && !authChecked) {
    return (
      <div style={{width:"100%",height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#fff",fontFamily:F,paddingTop:"env(safe-area-inset-top, 0px)",paddingBottom:"env(safe-area-inset-bottom, 0px)",boxSizing:"border-box"}}>
        <img src={STAR_LOGO} alt="" style={{width:44,height:44,borderRadius:10}}/>
      </div>
    );
  }
  if (isSupabaseConfigured && !session) {
    return <AuthScreen/>;
  }

  return (
    <div
      // No explicit width/height here on purpose: with position:fixed and
      // top/left/right/bottom all set to 0, the box is fully sized by those
      // four insets alone. Adding an explicit height:"100vh" on top of that
      // over-constrains it — CSS then derives `bottom` FROM top+height
      // instead of honoring bottom:0, so on any device/browser where 100vh
      // doesn't exactly equal the real visible viewport (a well-known iOS
      // Safari quirk that varies by screen size), the box's true bottom
      // edge falls short of the actual screen bottom — clipping whatever
      // sits at the bottom of the current page (a chat input bar, a
      // bottom toggle, etc.), inconsistently across phone models. Insets
      // alone track the real viewport on every device instead.
      // The bottom safe-area inset is handled by whichever bar sits at the
      // very bottom (TopNav, or Drive's own bottom bar) baking it into their
      // own paddingBottom, instead of the shell reserving a separate strip
      // below them — that separate strip was its own background peeking
      // through under the active bar, which read as a stray blank gap
      // (most visible as white under Lanes' dark chat). This way whatever
      // bar is showing runs its own background all the way to the true edge.
      style={{display:"flex",flexDirection:"column",background:panel==="create"?"#36393f":"#fff",fontFamily:F,position:"fixed",inset:0,paddingTop:"env(safe-area-inset-top, 0px)",boxSizing:"border-box"}}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}html,body{overscroll-behavior:none;background:${panel==="create"?"#36393f":"#fff"};}*{box-sizing:border-box;margin:0;padding:0;}button,input,textarea{font-family:inherit;}::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:#e0e0e0;border-radius:2px;}`}</style>

      {panel!=="drive" && <TopBar/>}

      {(() => {
        // While a live carousel drag is in progress (swipeDir set — see
        // onSwipeMove), render the current page AND whichever neighbor tab
        // is being revealed side by side in a 2x-wide row, and slide that
        // row by the live drag offset — so the next page visibly follows
        // the finger in from the edge, proportional to how far it's
        // dragged, instead of only snapping once the gesture ends.
        const carouselIdx = CAROUSEL.indexOf(panel);
        const neighborId = swipeDir==="next" ? CAROUSEL[carouselIdx+1] : swipeDir==="prev" ? CAROUSEL[carouselIdx-1] : null;
        const NeighborPanel = neighborId ? PANELS[neighborId] : null;
        const w = typeof window!=="undefined" ? window.innerWidth : 390;
        return (
          <div
            ref={swipeContainerRef}
            style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0,position:"relative",touchAction:"pan-y"}}
            onMouseDown={onSwipeStart} onMouseMove={onSwipeMove} onMouseUp={onSwipeEnd}
          >
            {/* ActivePanel always renders in this SAME first slot, on every
                render, whether or not a neighbor is showing — this is load-
                bearing, not cosmetic. The previous version swapped which
                literal JSX slot ActivePanel occupied depending on swipeDir
                (so a "prev" drag could put NeighborPanel first), which
                looked identical when idle but meant the very first
                touchmove of a real carousel drag (the one that sets
                swipeDir and mounts the neighbor) changed ActivePanel's
                position in the tree. React has no way to "move" a subtree
                across a re-parent like that — it unmounts the old DOM and
                mounts fresh — and doing that WHILE a finger is still touching
                an element inside it makes the browser cancel the rest of
                that touch sequence outright (no touchmove/touchend ever
                follow — confirmed by dispatching real touch input in
                Playwright: exactly one touchmove arrived, then silence).
                That's the actual bug behind "swipe doesn't work" — it fired
                once, tore itself down, and every gesture died right there.
                Keeping ActivePanel's slot fixed and using CSS
                (flexDirection: row-reverse) to flip which SIDE it visually
                appears on for a "prev" drag gets the same look without ever
                touching ActivePanel's position in the tree. */}
            <div ref={swipeWrapperRef} style={{
              position:"absolute", top:0, left:0, bottom:0, display:"flex",
              flexDirection: swipeDir==="prev" ? "row-reverse" : "row",
              width: NeighborPanel ? w*2 : w, willChange:"transform",
              transform:`translateX(${swipeDir==="prev" ? swipeDXRef.current-w : swipeDXRef.current}px)`,
            }}>
              <div style={{width:w,height:"100%",flexShrink:0,overflow:"hidden",display:"flex",flexDirection:"column"}}>
                <ActivePanel/>
              </div>
              {NeighborPanel && (
                <div style={{width:w,height:"100%",flexShrink:0,overflow:"hidden",display:"flex",flexDirection:"column"}}>
                  <NeighborPanel/>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {panel!=="drive" && <TopNav/>}

      {/* Voice control is purely settings-driven now — no on-screen mic
          button anywhere, in or out of Drive mode. Drive mode's own "Say
          Sono to Wake" toggle (Drive mode Settings) governs it in Drive
          mode; the Profile > AI toggle governs it everywhere else. This
          banner is just a passive "it's listening" indicator, matching the
          one built into Drive mode's own dashboard. */}
      {panel!=="drive" && voiceOn && (
        <div style={{position:"fixed",left:0,right:0,bottom:"calc(58px + env(safe-area-inset-bottom, 0px))",zIndex:150,padding:"3px 12px",background:"#fff9f5",borderTop:"1px solid #fde8d8",display:"flex",alignItems:"center",gap:6}}>
          <span style={{width:5,height:5,borderRadius:"50%",background:"#ef4444",animation:"pulse 1s infinite",flexShrink:0,display:"block"}}/>
          <span style={{fontSize:10,color:OR,fontStyle:"italic",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{voiceText || "Listening… say \"Sono\" for the AI, or a number to tap a button"}</span>
        </div>
      )}

      {/* AI Co-Pilot voice call — a full-screen takeover so it works the same
          from wherever it was started (My Profile's Top 3 row). */}
      {aiCallOpen && (
        <div style={{position:"fixed",inset:0,background:"linear-gradient(160deg,"+pal.color+",#111)",zIndex:900,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"space-between",padding:"48px 24px",boxSizing:"border-box",paddingTop:"calc(48px + env(safe-area-inset-top, 0px))",paddingBottom:"calc(32px + env(safe-area-inset-bottom, 0px))"}}>
          <div style={{textAlign:"center",marginTop:20}}>
            <div style={{width:96,height:96,borderRadius:"50%",background:"rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px",boxShadow:aiCallSpeaking?"0 0 0 10px rgba(255,255,255,0.15)":aiCallListening?"0 0 0 6px rgba(255,255,255,0.1)":"none",transition:"box-shadow 0.3s ease"}}>
              <CompassStar size={48} color="#fff"/>
            </div>
            <div style={{fontSize:22,fontWeight:800,color:"#fff"}}>{pal.name}</div>
            <div style={{fontSize:14,color:"rgba(255,255,255,0.75)",marginTop:6}}>
              {!(window.SpeechRecognition||window.webkitSpeechRecognition)
                ? "Voice input isn't supported in this browser"
                : aiCallSpeaking ? "Speaking…" : aiCallListening ? "Listening…" : "…"}
            </div>
          </div>
          <div style={{width:"100%",maxHeight:"35%",overflowY:"auto",textAlign:"center"}}>
            {aiCallInterim && <div style={{fontSize:15,color:"rgba(255,255,255,0.85)",fontStyle:"italic",lineHeight:1.5}}>{aiCallInterim}</div>}
          </div>
          <button onClick={endAiCall} style={{width:64,height:64,borderRadius:"50%",background:"#ef4444",border:"none",color:"#fff",fontSize:26,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 20px rgba(239,68,68,0.5)"}}>✕</button>
        </div>
      )}

      {showAgent && (
        <div style={{position:"fixed",bottom:panel==="drive"?58:16,left:8,right:8,zIndex:400,background:"#fff",borderRadius:14,border:"1.5px solid "+pal.color+"44",boxShadow:"0 4px 24px "+pal.color+"22"}}>
          <div style={{padding:"10px 12px",borderBottom:"1px solid "+pal.color+"22",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:18}}>{pal.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:"#111"}}>{pal.name}</div>
              <div style={{fontSize:11,color:"#111"}}>{pal.desc}</div>
            </div>
            <button onClick={()=>setShowAgent(false)} style={{fontSize:18,background:"none",border:"none",color:"#111",cursor:"pointer"}}>×</button>
          </div>
          <div style={{padding:"8px 12px",maxHeight:80,overflowY:"auto"}}>
            {roadMsgs.slice(-2).map((m,i)=><div key={i} style={{fontSize:12,color:"#111",padding:"3px 0",lineHeight:1.5}}>{pal.emoji} {m}</div>)}
          </div>
          <div style={{padding:"8px 12px 10px",display:"flex",gap:5}}>
            <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){sendChat();setShowAgent(false);}}} placeholder={"Ask "+pal.name+"…"} style={{...INP,flex:1}} autoFocus/>
            <button onClick={()=>{sendChat();setShowAgent(false);}} style={{padding:"7px 12px",borderRadius:8,background:pal.color,color:"#fff",border:"none",fontSize:13,fontWeight:800,cursor:"pointer"}}>↑</button>
          </div>
        </div>
      )}

      {/* Widget action overlays */}
      {widgetAction && (
        <div onClick={()=>setWidgetAction(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:600,display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",maxHeight:"80%",display:"flex",flexDirection:"column"}}>
            <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"12px auto",flexShrink:0}}/>
            {widgetAction==="weather" && <>
              <div style={{padding:"0 16px 10px",borderBottom:"1px solid #ebebeb",flexShrink:0,display:"flex",alignItems:"center",gap:10}}>
                <div style={{fontSize:30}}>{weather.icon}</div>
                <div><div style={{fontSize:22,fontWeight:900,color:"#111"}}>{weather.temp}°F <span style={{fontSize:15,fontWeight:400,color:"#111"}}>{weather.cond}</span></div><div style={{fontSize:12,color:"#111"}}>Los Angeles, CA</div></div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>
                <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:10}}>7-DAY FORECAST</div>
                {FORECAST.map((d,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #f5f5f5"}}>
                    <div style={{width:40,fontSize:13,fontWeight:700,color:"#111"}}>{d.day}</div>
                    <div style={{fontSize:20,marginRight:10}}>{d.icon}</div>
                    <div style={{flex:1,height:4,borderRadius:2,background:"#f0f0f0",overflow:"hidden"}}>
                      <div style={{height:"100%",borderRadius:2,background:"linear-gradient(90deg,#60a5fa,#f97316)",width:((d.hi-55)/(78-55)*100)+"%"}}/>
                    </div>
                    <div style={{width:60,textAlign:"right",fontSize:13}}>
                      <span style={{fontWeight:700,color:"#111"}}>{d.hi}°</span>
                      <span style={{color:"#111",marginLeft:4}}>{d.lo}°</span>
                    </div>
                  </div>
                ))}
              </div>
            </>}
            {widgetAction==="points" && <>
              <div style={{padding:"0 16px 10px",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
                <div style={{fontSize:18,fontWeight:800,color:"#111"}}>⭐ Star Points</div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>
                <div style={{textAlign:"center",padding:"16px 0 20px"}}>
                  <div style={{fontSize:54,fontWeight:900,color:"#f59e0b",lineHeight:1}}>{pts}</div>
                  <div style={{fontSize:14,color:"#111",marginTop:4}}>Level {Math.floor(pts/200)} · {200-(pts%200)} pts to next level</div>
                  <div style={{height:6,borderRadius:3,background:"#f3f3f3",margin:"12px 0 0",overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:"#f59e0b",width:((pts%200)/200*100)+"%"}}/></div>
                </div>
                <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8}}>HOW TO EARN</div>
                {[["🚗","Complete a drive","50 pts"],["📍","Log a route","25 pts"],["👥","Add a friend","10 pts"],["⚡","Create an event","30 pts"],["🎙","Use voice mode","5 pts"]].map(([ic,l,v])=>(
                  <div key={l} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #f5f5f5"}}>
                    <div style={{fontSize:20}}>{ic}</div>
                    <div style={{flex:1,fontSize:13,color:"#111"}}>{l}</div>
                    <div style={{fontSize:13,fontWeight:700,color:"#f59e0b"}}>{v}</div>
                  </div>
                ))}

                {/* Trophies — moved here from its own toggle icon */}
                <div style={{display:"flex",alignItems:"center",gap:10,marginTop:24,marginBottom:8}}>
                  <div style={{flex:1,fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2}}>🏅 TROPHIES</div>
                  <div style={{fontSize:12,fontWeight:700,color:"#e94560"}}>{unlockedAch.length}/{ACHIEVEMENTS.length}</div>
                </div>
                <div style={{height:6,borderRadius:3,background:"#f0f0f0",overflow:"hidden",marginBottom:14}}>
                  <div style={{height:"100%",borderRadius:3,background:"linear-gradient(90deg,#e94560,#f5a623)",width:(unlockedAch.length/ACHIEVEMENTS.length*100)+"%",transition:"width 0.5s ease"}}/>
                </div>
                {[...new Set(ACHIEVEMENTS.map(a=>a.cat))].map(cat=>{
                  const CAT_LABELS = {milestone:"🏁 Milestones", distance:"🛣️ Distance", safe:"🚦 Safe Driving", social:"👥 Social", car:"🚗 Car", bonus:"⭐ Bonus"};
                  return (
                  <div key={cat}>
                    <div style={{fontSize:11,color:"#111",fontWeight:700,letterSpacing:1.2,marginBottom:8,marginTop:10}}>{CAT_LABELS[cat]||cat.toUpperCase()}</div>
                    {ACHIEVEMENTS.filter(a=>a.cat===cat).map(ach=>{
                      const done = unlockedAch.includes(ach.id);
                      return (
                        <div key={ach.id} style={{
                          display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                          borderRadius:14,marginBottom:8,
                          background:done?"linear-gradient(135deg,#1a1a2e,#0f3460)":"#f8f8f8",
                          border:"1.5px solid "+(done?"#e9456044":"#ebebeb"),
                          opacity:done?1:0.7,
                        }}>
                          <div style={{
                            width:44,height:44,borderRadius:12,flexShrink:0,
                            display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,
                            background:done?"linear-gradient(135deg,#e94560,#f5a623)":"#e0e0e0",
                            filter:done?"none":"grayscale(1)",
                          }}>{done?ach.icon:"🔒"}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:15,fontWeight:800,color:done?"#fff":"#111",marginBottom:2}}>{ach.title}</div>
                            <div style={{fontSize:12,color:done?"#aaa":"#111",lineHeight:1.4}}>{ach.desc}</div>
                          </div>
                          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1,flexShrink:0}}>
                            <span style={{fontSize:14,fontWeight:900,color:done?"#f5a623":"#111"}}>+{ach.pts}</span>
                            <span style={{fontSize:9,color:done?"#aaa":"#111"}}>pts</span>
                            {done&&<span style={{fontSize:10,marginTop:2}}>✓</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  );
                })}

                {/* SonoLane Rewards — moved here from the bottom of the
                    Profile home screen so it sits with the rest of the
                    points/achievements story (Law of Proximity: related
                    "earn stuff by driving" content grouped in one place)
                    instead of competing for attention on the main Profile
                    tab, which now stays focused on the car/stats/tools it's
                    actually for (Occam's Razor). */}
                <VN action={()=>{setWidgetAction(null);go("profile");setTimeout(()=>setSubPanel("rewards"),100);}} style={{
                  width:"100%",display:"flex",alignItems:"center",gap:14,flexShrink:0,
                  padding:"16px 18px",borderRadius:16,marginTop:20,
                  background:"linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%)",
                  border:"1.5px solid #e94560",cursor:"pointer",textAlign:"left",fontFamily:F,
                }}>
                  <div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#e94560,#f5a623)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>🏆</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:16,fontWeight:900,color:"#fff",marginBottom:2}}>SonoLane Rewards</div>
                    <div style={{fontSize:12,color:"#111",lineHeight:1.4}}>Earn points driving. Unlock perks & exclusive features.</div>
                  </div>
                  <div style={{fontSize:20,color:"#e94560",flexShrink:0}}>›</div>
                </VN>
              </div>
            </>}
            {widgetAction==="friends" && <>
              <div style={{padding:"0 16px 10px",borderBottom:"1px solid #ebebeb",flexShrink:0}}>
                <div style={{fontSize:18,fontWeight:800,color:"#111"}}>👥 Friends</div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>
                {friends.length===0?(
                  <div style={{textAlign:"center",padding:"30px 0",color:"#111"}}>
                    <div style={{fontSize:38,marginBottom:8}}>👥</div>
                    <div style={{fontSize:14}}>No friends yet.</div>
                    <button onClick={()=>{setWidgetAction(null);go("profile");setTimeout(()=>setSubPanel("friends"),100);}} style={{marginTop:12,padding:"8px 18px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>Add Friends</button>
                  </div>
                ):friends.map(fr=>(
                  <div key={fr.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #f5f5f5"}}>
                    <FriendAvatar fr={fr} size={36} fontSize={14}/>
                    <div style={{flex:1}}><div style={{fontSize:14,fontWeight:700,color:"#111"}}>{fr.name}</div><div style={{fontSize:11,color:"#111"}}>@{fr.handle}</div></div>
                  </div>
                ))}
              </div>
            </>}
            {widgetAction==="routes" && <>
              <div style={{padding:"0 16px 10px",borderBottom:"1px solid #ebebeb",flexShrink:0,display:"flex",alignItems:"center"}}>
                <div style={{flex:1,fontSize:18,fontWeight:800,color:"#111",display:"flex",alignItems:"center",gap:7}}><DPadIcon id="road" color={DPAD_COLORS.road} size={16}/> My Routes</div>
                <button onClick={()=>{setWidgetAction(null);go("profile");setTimeout(()=>setSubPanel("routes"),100);}} style={{padding:"5px 12px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F}}>+ New</button>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"14px 16px 7px"}}>
                {routes.length===0?(
                  <div style={{textAlign:"center",padding:"30px 0",color:"#111"}}>
                    <div style={{fontSize:38,marginBottom:8}}>🗺️</div>
                    <div style={{fontSize:14,marginBottom:12}}>No routes saved yet.</div>
                    <button onClick={()=>{setWidgetAction(null);go("profile");setTimeout(()=>setSubPanel("routes"),100);}} style={{padding:"8px 18px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F}}>Save a Route</button>
                  </div>
                ):routes.map(r=>(
                  <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid #f5f5f5"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:r.color||OR,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:14,fontWeight:700,color:"#111"}}>{r.title}</div>
                      <div style={{fontSize:11,color:"#111"}}>{r.type}{r.distance?" · "+r.distance:""}</div>
                    </div>
                    <button onClick={()=>{setWidgetAction(null);startRouteDirections(r);}} title="Get Directions" style={{padding:"5px 10px",borderRadius:20,background:OR,color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>🧭</button>
                  </div>
                ))}
              </div>
            </>}
            <button onClick={()=>setWidgetAction(null)} style={{margin:"0 14px 14px",padding:"10px",borderRadius:9,background:"none",border:"1px solid #ebebeb",color:"#111",cursor:"pointer",fontSize:13,fontFamily:F,flexShrink:0}}>Close</button>
          </div>
        </div>
      )}
      <MusicModal/>
      <WidgetPicker/>

      {/* Dashcam widget — one-time inline setup prompt. Condensed version of the
          full ToS screen in Profile → Dashcam; accepting here sets the same
          dashcamConsent flag, so Profile's Dashcam page and this never conflict. */}
      {showDashcamSetup && (
        <div onClick={()=>setShowDashcamSetup(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:700,display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",maxHeight:"80%",display:"flex",flexDirection:"column"}}>
            <div style={{width:30,height:3,background:"#e0e0e0",borderRadius:2,margin:"12px auto",flexShrink:0}}/>
            <div style={{padding:"4px 20px 24px",overflowY:"auto"}}>
              <div style={{textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:38,marginBottom:6}}>📹</div>
                <div style={{fontSize:16,fontWeight:900,color:"#111",marginBottom:4}}>Set Up the Dashcam Widget</div>
                <div style={{fontSize:13,color:"#111",lineHeight:1.6}}>One-time setup. Once enabled, this widget shows a live camera preview the whole time you're in Drive mode, and starts saving a clip automatically once you're moving over 5 mph.</div>
              </div>
              <div style={{background:"#f8f8f8",borderRadius:14,border:"1px solid #ebebeb",padding:"14px",marginBottom:16,fontSize:13,color:"#111",lineHeight:1.7}}>
                Camera and mic access is used only while SonoLane is open in the foreground. Footage stays on this device and is viewable anytime from Profile → Dashcam, where you can also revoke access.
              </div>
              <button onClick={()=>{setDashcamConsent(true);memStore.setItem("sl_dashcamConsent","1");setShowDashcamSetup(false);if(panel==="drive")go("drive",{forceDashcamConsent:true});}} style={{width:"100%",padding:"13px",borderRadius:12,background:OR,color:"#fff",border:"none",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:F,marginBottom:10}}>
                I Agree — Enable Dashcam
              </button>
              <button onClick={()=>setShowDashcamSetup(false)} style={{width:"100%",padding:"12px",borderRadius:12,background:"transparent",color:"#111",border:"1px solid #ebebeb",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F}}>
                Not Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Achievement toast popup */}
      {newAchQueue.length>0 && (
        <div style={{
          position:"fixed",bottom:80,left:"50%",transform:"translateX(-50%)",
          zIndex:1000,pointerEvents:"none",
          animation:"slideUp 0.4s ease",
        }}>
          <div style={{
            background:"linear-gradient(135deg,#1a1a2e,#0f3460)",
            border:"1.5px solid #e94560",borderRadius:16,
            padding:"12px 16px",display:"flex",alignItems:"center",gap:12,
            boxShadow:"0 8px 32px rgba(233,69,96,0.35), 0 2px 8px rgba(0,0,0,0.5)",
            minWidth:240,maxWidth:300,pointerEvents:"all",
          }} onClick={()=>setNewAchQueue(q=>q.slice(1))}>
            <div style={{
              width:44,height:44,borderRadius:12,
              background:"linear-gradient(135deg,#e94560,#f5a623)",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:24,flexShrink:0,
            }}>{newAchQueue[0].icon}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,color:"#e94560",fontWeight:800,letterSpacing:1.2,marginBottom:2}}>ACHIEVEMENT UNLOCKED</div>
              <div style={{fontSize:15,fontWeight:900,color:"#fff",marginBottom:1}}>{newAchQueue[0].title}</div>
              <div style={{fontSize:11,color:"#aaa",lineHeight:1.4}}>{newAchQueue[0].desc}</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1,flexShrink:0}}>
              <span style={{fontSize:15,fontWeight:900,color:"#f5a623"}}>+{newAchQueue[0].pts}</span>
              <span style={{fontSize:9,color:"#555",fontWeight:600}}>pts</span>
            </div>
          </div>
        </div>
      )}
      <style>{"@keyframes slideUp{from{opacity:0;transform:translateX(-50%) translateY(20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}"}</style>
    </div>
  );
}
