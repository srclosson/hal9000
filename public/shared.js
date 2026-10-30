// Connection to the ship. Reconnects forever; callers get state merges and events.

export function roomFromUrl() {
  return (new URLSearchParams(location.search).get('room') || '').toUpperCase();
}

export function newRoomCode() {
  // No easily-confused characters (0/O, 1/I).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function connect({ room, role, panel = 0, onState, onSay, onHeard, onDisplay, onTalk, onActivity, onBoard, onViews, onDrill, onCamera, onFrame, onRoster, onStatus, onChat }) {
  const state = {};
  let ws, retry = 0, closed = false;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${room}&role=${role}&panel=${panel}`);
    ws.onopen = () => { retry = 0; onStatus?.('online'); };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return onFrame?.(e.data);   // binary: a camera frame from the eye
      const msg = JSON.parse(e.data);
      if (msg.type === 'hello') {
        Object.assign(state, msg.state);
        onState?.(state, msg.state);
        onRoster?.(msg.roster, msg.id);
      } else if (msg.type === 'state') {
        Object.assign(state, msg.state);
        onState?.(state, msg.state);
      } else if (msg.type === 'say') {
        onSay?.(msg.text, msg.parts, msg.interim);
      } else if (msg.type === 'display') {
        onDisplay?.(msg.display);
      } else if (msg.type === 'views') {
        onViews?.(msg.views, msg.current);
      } else if (msg.type === 'board') {
        onBoard?.(msg.board);
      } else if (msg.type === 'activity') {
        onActivity?.(msg.text);
      } else if (msg.type === 'talk') {
        onTalk?.(msg.on);
      } else if (msg.type === 'heard') {
        onHeard?.(msg.text, msg.about);
      } else if (msg.type === 'camera') {
        onCamera?.(msg.on);
      } else if (msg.type === 'drill') {
        onDrill?.(msg);
      } else if (msg.type === 'chat') {
        onChat?.(msg);   // { history } on joining, then { entry } for each new message
      } else if (msg.type === 'roster') {
        onRoster?.(msg.roster);
      }
    };
    ws.onclose = e => {
      // Not signed in (or the session ran out): off to sign in, coming back to this page.
      if (e.code === 4401) { closed = true; location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      onStatus?.('offline');
      if (!closed) setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
    };
  }
  open();

  const send = msg => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
  return {
    state,
    set: patch => { Object.assign(state, patch); send({ type: 'set', state: patch }); },
    say: text => send({ type: 'say', text }),
    // tz: the asker's time zone, so the 9000 knows the local time (the server runs on UTC).
    // about: the panel code a drilldown question was asked from.
    ask: (text, about) => send({ type: 'ask', text, about, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    drill: (code, part) => send({ type: 'drill', code, ...(part && { part }) }),           // ask for suggested questions about one panel
    focus: code => send({ type: 'focus', code }),           // the panel being looked at (null: none)
    watch: on => send({ type: 'watch', on }),
    snooze: (code, minutes) => send({ type: 'snooze', code, minutes }),
    ack: () => send({ type: 'ack' }),   // acknowledge the alarm
    plan: (id, decision, hash) => send({ type: 'plan', id, decision, hash }),   // approve / reject a plan (hash: what was shown), or 'undo'   // snooze (or remove) one board panel               // monitor: the EYE panel is on screen (camera wanted)
    // eye: one JPEG camera frame, skipped while the previous ones are still being sent (slow link)
    frame: blob => ws?.readyState === 1 && ws.bufferedAmount < 256 * 1024 && ws.send(blob),
    view: id => send({ type: 'view', id }),   // pick a view: 'situation', 'systems' or a remembered board
    panel: n => send({ type: 'panel', panel: n }),
    close: () => { closed = true; ws?.close(); },
  };
}

export function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// Keep the screen awake while the eye/monitor is displayed (needs a secure context).
export async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen');
    });
  } catch { /* not supported or not secure: fine */ }
}

// Page-level full screen: hides every bit of browser UI (unlike the browser's own full screen,
// which can slide the toolbar back in). Must be called from a key press or tap.
export function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
}

// The 9000 had no mouse: hide the pointer after a few seconds without movement.
export function autoHideCursor(ms = 3000) {
  let timer;
  const wake = () => {
    document.body.classList.remove('nocursor');
    clearTimeout(timer);
    timer = setTimeout(() => document.body.classList.add('nocursor'), ms);
  };
  addEventListener('mousemove', wake);
  addEventListener('mousedown', wake);
  wake();
}
