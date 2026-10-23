'use strict';
// Email alerts through Gmail (or any SMTP server with TLS on connect, port 465), with no dependencies: a minimal SMTP
// client on Node's tls module. Gmail needs an app password (Google Account -> Security -> 2-Step Verification -> App
// passwords), not the account password. Settings come from .env: GMAIL_USER, GMAIL_PASSWORD, GMAIL_RECIPIENT
// (comma-separated; default GMAIL_USER), GMAIL_SENDER_NAME, and SMTP_HOST / SMTP_PORT for another server.
const tls = require('tls');
const os = require('os');

module.exports = function createMail({ user, pass, to, senderName = 'ais-monitor', host = 'smtp.gmail.com', port = 465 }) {
  const rcpts = String(to || user || '').split(/[\s,;]+/).filter((x) => /^[^@\s<>]+@[^@\s<>]+$/.test(x));
  const ready = !!(user && pass && rcpts.length);

  // One SMTP conversation: each step sends a line (or nothing, for the greeting) and expects a reply code.
  function smtp(steps) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, servername: host });
      let buf = '', lines = [], i = 0, done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.end();
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => (finish(new Error('SMTP timed out')), sock.destroy()), 20000);
      sock.on('error', finish);
      sock.on('close', () => finish(i < steps.length ? new Error('SMTP connection closed') : null));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let n;
        while ((n = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, n);
          buf = buf.slice(n + 2);
          lines.push(line);
          if (line[3] === '-') continue; // a multi-line reply goes on
          const code = Number(line.slice(0, 3)), step = steps[i];
          if (!step || code !== step.expect) return finish(new Error(`SMTP ${step ? step.name : 'reply'}: ${lines.join(' ').slice(0, 200)}`));
          lines = [];
          if (++i === steps.length) return finish();
          sock.write(steps[i].send + '\r\n');
        }
      });
    });
  }

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
  const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

  // send({subject, text, html}): resolves true once the server took it.
  async function send({ subject, text, html }) {
    if (!ready) return false;
    const boundary = `ais-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const msg = [
      `From: ${word(senderName)} <${user}>`,
      `To: ${rcpts.join(', ')}`,
      `Subject: ${word(subject)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${boundary}@${os.hostname() || 'ais-monitor'}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(text)),
      ...(html ? [`--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(html))] : []),
      `--${boundary}--`,
    ].join('\r\n');
    await smtp([
      { name: 'greeting', expect: 220 },
      { name: 'EHLO', send: `EHLO ${os.hostname() || 'ais-monitor'}`, expect: 250 },
      { name: 'AUTH', send: 'AUTH LOGIN', expect: 334 },
      { name: 'user', send: b64(user), expect: 334 },
      { name: 'login (check GMAIL_USER and the app password)', send: b64(pass), expect: 235 },
      { name: 'MAIL FROM', send: `MAIL FROM:<${user}>`, expect: 250 },
      ...rcpts.map((r) => ({ name: `RCPT TO ${r}`, send: `RCPT TO:<${r}>`, expect: 250 })),
      { name: 'DATA', send: 'DATA', expect: 354 },
      // Base64 lines never start with a dot, so no dot-stuffing is needed.
      { name: 'message', send: `${msg}\r\n.`, expect: 250 },
      { name: 'QUIT', send: 'QUIT', expect: 221 },
    ]);
    return true;
  }

  return { ready, to: rcpts, send };
};
