// WebSocket client with automatic reconnect.
// Close code 4001: the office replaced this connection with a newer one for
// the same identity (another tab or device), so it stays closed.
const REPLACED = 4001;
const PING = JSON.stringify({ t: 'ping' }); // answered without waking the server; keeps us from looking like a ghost

export function connect(onMessage, onOpen, onClose) {
  let ws, closed = false, retry = 500;
  const queue = [];
  const pinger = setInterval(() => { if (ws.readyState === 1) ws.send(PING); }, 30000);
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; onOpen(); while (queue.length) ws.send(queue.shift()); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = (e) => {
      const replaced = e.code === REPLACED;
      if (replaced) { closed = true; clearInterval(pinger); }
      onClose({ replaced });
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 8000)));
    };
  }
  open();
  return {
    send(msg) {
      const s = JSON.stringify(msg);
      if (ws.readyState === 1) ws.send(s);
      else if (msg.t !== 'move') queue.push(s);
    },
    close() { closed = true; clearInterval(pinger); ws.close(); },
  };
}
