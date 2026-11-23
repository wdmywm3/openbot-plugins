"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
app.setPath("userData", path.join(root, "canvas-profile"));
app.commandLine.appendSwitch("force-renderer-accessibility");
app.commandLine.appendSwitch("disable-background-networking");
app.disableHardwareAcceleration();

let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 420, height: 240, frame: false, show: false, skipTaskbar: true,
    webPreferences: { sandbox: true } });
  const html = `<title>OpenBot canvas fixture</title><body style="margin:0">
    <canvas width="420" height="130" style="display:block"></canvas><output id="background">Untouched canvas</output>
    <button id="button">Foreground button</button><output id="buttonProof"></output><output id="canvasProof"></output>
    <script>
      const canvas = document.querySelector('canvas'), brush = canvas.getContext('2d');
      brush.fillStyle = '#2289d4'; brush.fillRect(45, 18, 165, 95);
      brush.fillStyle = '#db793a'; brush.fillRect(240, 18, 135, 95);
      let canvasClicks = 0, buttonClicks = 0, pointerFocused = false;
      document.addEventListener('pointerdown', event => { pointerFocused = event.isTrusted && document.hasFocus(); });
      document.querySelector('#button').onclick = () => {
        document.querySelector('#buttonProof').textContent = 'Button clicks ' + ++buttonClicks + ' focused ' + pointerFocused;
      };
      canvas.onclick = event => {
        if (event.offsetX > 45 && event.offsetX < 210 && event.offsetY > 18 && event.offsetY < 113) {
          document.querySelector('#background').textContent = 'Canvas clicked';
          brush.fillStyle = '#247c40'; brush.fillRect(45, 18, 165, 95);
        }
        if (event.offsetX > 240 && event.offsetX < 375 && event.offsetY > 18 && event.offsetY < 113) {
          document.querySelector('#canvasProof').textContent = 'Canvas clicks ' + ++canvasClicks + ' focused ' + pointerFocused;
        }
        pointerFocused = false;
      };
    </script>`;
  await window.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));
  window.showInactive();
  const { width, height } = window.getBounds();
  fs.writeFileSync(path.join(root, "canvas.tmp"), JSON.stringify({ pid: process.pid,
    window_id: Number(window.getNativeWindowHandle().readBigUInt64LE()), x: 120 / width, y: 65 / height,
    foregroundX: 300 / width }));
  fs.renameSync(path.join(root, "canvas.tmp"), path.join(root, "canvas.json"));
});
setInterval(async () => {
  if (fs.existsSync(path.join(root, "canvas.close"))) return app.quit();
  const request = path.join(root, "canvas.read");
  if (!window || !fs.existsSync(request)) return;
  fs.unlinkSync(request);
  const proof = await window.webContents.executeJavaScript(`({button: document.querySelector('#buttonProof').textContent,
    canvas: document.querySelector('#canvasProof').textContent})`);
  fs.writeFileSync(path.join(root, "proof.tmp"), JSON.stringify(proof));
  fs.renameSync(path.join(root, "proof.tmp"), path.join(root, "proof.json"));
}, 100).unref();
setTimeout(() => app.quit(), 5 * 60 * 1000).unref();
