// Workstation apps that run on WASM plugins, shared by the server (the
// Workstation entity checks app ids against it) and the browser (it puts
// them on the desktop). Each names the module it runs (public/plugins), the
// same ones the objects on the map use (server/plugins.js): the app gets its
// own state and answers with the same declarative panels. To add one, list
// it here; the built-in apps live in public/js/workstation.js.

export const WS_APPS = [
  { id: 'oracle', name: 'Magic 8-Ball', icon: '🎱', plugin: 'eightball', wasm: 'eightball.wasm' },
];
