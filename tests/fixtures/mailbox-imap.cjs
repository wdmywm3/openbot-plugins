"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const tls = require("node:tls");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function createMailboxFixture(root) {
  const gitSsl = path.join(process.env.ProgramFiles || "", "Git", "usr", "bin", "openssl.exe");
  const openssl = process.platform === "win32" && fs.existsSync(gitSsl) ? gitSsl : "openssl";
  const ca = path.join(root, "mail-test.pem"), key = path.join(root, "key.pem");
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", ca], { stdio: "pipe" });
  const state = { messages: [], validity: 23, online: true, connections: 0, commands: [], sockets: new Set(), sent: [] };
  const folders = new Map([["INBOX", state.messages], ["Archive", []], ["Trash", []]]);
  const cert = { cert: fs.readFileSync(ca), key: fs.readFileSync(key) };
  const smtp = tls.createServer(cert, socket => {
    state.sockets.add(socket); socket.once("close", () => state.sockets.delete(socket)); socket.on("error", () => {});
    const send = value => socket.write(value + "\r\n");
    send("220 fixture SMTP");
    let buffer = "", data = null, recipients = [];
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n"), line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data !== null) {
          if (line !== ".") { data.push(line.replace(/^\.\./, ".")); continue; }
          state.sent.push({ raw: data.join("\r\n"), recipients }); data = null; recipients = [];
          if (state.loseSmtpReply) { state.loseSmtpReply = false; socket.destroy(); return; }
          send("250 accepted"); continue;
        }
        if (/^EHLO/.test(line)) send("250-fixture\r\n250 AUTH PLAIN");
        else if (/^AUTH PLAIN /.test(line)) send(Buffer.from(line.split(" ")[2], "base64").toString().endsWith("\0test-pass") ? "235 authenticated" : "535 rejected");
        else if (/^MAIL FROM/.test(line)) send("250 ok");
        else if (/^RCPT TO/.test(line)) {
          const addr = /<([^>]+)>/.exec(line)[1];
          if (addr.startsWith("reject@")) send("550 rejected"); else { recipients.push(addr); send("250 ok"); }
        } else if (line === "DATA") { data = []; send("354 go"); }
        else if (line === "QUIT") { send("221 bye"); socket.end(); }
        else send("500 unsupported");
      }
    });
  });
  await new Promise(resolve => smtp.listen(0, "127.0.0.1", resolve));
  const server = tls.createServer({ cert: fs.readFileSync(ca), key: fs.readFileSync(key) }, socket => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("error", () => {});
    state.connections++;
    if (!state.online) { socket.destroy(); return; }
    socket.setEncoding("utf8");
    const write = line => socket.write(line + "\r\n");
    write("* OK [CAPABILITY IMAP4rev1 MOVE] test mailbox");
    let selected = state.messages;
    let buffer = "", continued = "";
    socket.on("data", data => {
      buffer += data;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        let line = continued + buffer.slice(0, end);
        continued = "";
        buffer = buffer.slice(end + 2);
        const literal = /{(\d+)(\+)?}$/.exec(line);
        if (literal) {
          continued = line.slice(0, literal.index);
          if (!literal[2]) write("+ continue");
          continue;
        }
        const [, tag, command] = /^(\S+) (.+)$/.exec(line);
        if (!command.startsWith("LOGIN")) state.commands.push(command);
        const ok = () => write(tag + " OK done");
        if (command === "CAPABILITY") write("* CAPABILITY IMAP4rev1 MOVE");
        else if (command.startsWith("LOGIN ")) {
          if (!command.includes("test-pass")) { write(tag + " NO login refused"); continue; }
        } else if (/^L(?:IST|SUB) /.test(command)) {
          const term = command.split(" ").at(-1).replaceAll('"', "");
          if (!term) write('* LIST (\\Noselect) "/" ""');
          else for (const key of folders.keys()) if (term === "*" || term === "%" || term === key)
            write('* LIST (' + (["Archive", "Trash"].includes(key) ? "\\" + key : "") + ') "/" "' + key + '"');
        } else if (command.startsWith("CREATE ")) { folders.set(command.split(" ").at(-1).replaceAll('"', ""), []); }
        else if (command.startsWith("STATUS ")) { write('* STATUS INBOX (MESSAGES ' + selected.length + ' UNSEEN 0)'); }
        else if (/^(EXAMINE|SELECT) /.test(command)) {
          selected = folders.get(command.split(" ")[1].replaceAll('"', "")) || [];
          write("* FLAGS (\\Seen \\Flagged)");
          write("* OK [PERMANENTFLAGS (\\Seen \\Flagged)] flags");
          write("* " + selected.length + " EXISTS");
          write("* OK [UIDVALIDITY " + state.validity + "] uid validity");
          write("* OK [UIDNEXT " + ((selected.at(-1)?.uid || 0) + 1) + "] next");
          write(tag + (command.startsWith("SELECT") ? " OK [READ-WRITE]" : " OK [READ-ONLY]") + " opened"); continue;
        } else if (command.startsWith("UID STORE ")) {
          const [, , range, op] = command.split(" "), flag = command.includes("\\Seen") ? "\\Seen" : "\\Flagged";
          for (const m of selected.filter(m => range.split(",").includes(String(m.uid)))) {
            m.flags ||= new Set(); if (op.startsWith("+")) m.flags.add(flag); else m.flags.delete(flag);
          }
        } else if (command.startsWith("UID MOVE ")) {
          const [, , range, folder] = command.split(" "), destination = folders.get(folder.replaceAll('"', ""));
          assert(destination, command);
          for (const id of range.split(",").map(Number)) {
            const i = selected.findIndex(m => m.uid === id);
            if (i >= 0) { destination.push(...selected.splice(i, 1)); write("* " + (i + 1) + " EXPUNGE"); }
          }
        } else if (command.startsWith("UID SEARCH ")) {
          const range = /\bUID (\d+):(\d+)/i.exec(command);
          const subject = /\bSUBJECT (?:"([^"]*)"|(\S+))/i.exec(command);
          const from = /\bFROM (?:"([^"]*)"|(\S+))/i.exec(command);
          const found = selected.filter(m => (!range || m.uid >= +range[1] && m.uid <= +range[2])
            && (!from || "School office@example.test".includes(from[1] || from[2]))
            && (!subject || m.subject.includes(subject[1] || subject[2])));
          write("* SEARCH" + found.map(m => " " + m.uid).join(""));
        } else if (/^UID FETCH /.test(command)) {
          const ranges = command.split(" ")[2].split(",").map(fragment => fragment.split(":").map(Number));
          for (const [index, mail] of selected.entries()) {
            if (!ranges.some(([lo, hi]) => mail.uid >= lo && mail.uid <= (hi || lo))) continue;
            const result = ["UID " + mail.uid], data = Buffer.from(mail.text).toString("base64");
            if (command.includes("FLAGS")) result.push("FLAGS (" + [...mail.flags || []].join(" ") + ")");
            if (command.includes("ENVELOPE")) {
              const subject = /[^\x20-\x7e]/.test(mail.subject) ? "=?UTF-8?B?" + Buffer.from(mail.subject).toString("base64") + "?=" : mail.subject;
              result.push('ENVELOPE (NIL "' + subject + '" (("School" NIL "office" "example.test")) NIL NIL NIL NIL NIL NIL "<' + mail.uid + '@example.test>")');
            }
            if (command.includes("INTERNALDATE")) result.push('INTERNALDATE "21-Nov-2026 10:00:00 +0000"');
            if (command.includes("BODYSTRUCTURE")) result.push('BODYSTRUCTURE ("TEXT" "' + (mail.html ? "HTML" : "PLAIN") + '" ("CHARSET" "UTF-8") NIL NIL "BASE64" ' + data.length + ' 1)');
            if (command.includes("RFC822.SIZE")) result.push("RFC822.SIZE " + (data.length + 160));
            if (/BODY\.PEEK\[HEADER\]/i.test(command)) {
              const header = "Content-Type: text/" + (mail.html ? "html" : "plain") + "; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n";
              result.push("BODY[HEADER] {" + header.length + "}\r\n" + header);
            }
            const window = /BODY\.PEEK\[TEXT\]<(\d+)\.(\d+)>/i.exec(command);
            if (window) {
              const value = data.slice(+window[1], +window[1] + +window[2]);
              result.push("BODY[TEXT]<" + window[1] + "> {" + value.length + "}\r\n" + value);
            }
            write("* " + (index + 1) + " FETCH (" + result.join(" ") + ")");
          }
        } else if (command === "LOGOUT") { write("* BYE"); ok(); socket.end(); continue; }
        else { write(tag + " BAD unsupported command"); continue; }
        ok();
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { state, ca, endpoint: "127.0.0.1:" + server.address().port, smtp: "127.0.0.1:" + smtp.address().port,
    async close() {
      for (const socket of state.sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => smtp.close(resolve));
      assert(!state.commands.some(cmd => /^(?:EXPUNGE|UID EXPUNGE)\b/.test(cmd)));
    } };
}
module.exports = { createMailboxFixture };
