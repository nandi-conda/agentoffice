// WebSocket client with automatic reconnect.
export function connect(onMessage, onOpen, onClose) {
  let ws, closed = false, retry = 500;
  const queue = [];
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; onOpen(); while (queue.length) ws.send(queue.shift()); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      onClose();
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
    close() { closed = true; ws.close(); },
  };
}
