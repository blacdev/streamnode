// Sends the gateway's notices by email, through the SMTP account the
// administrator enters under Settings. Entirely optional: with no SMTP
// settings nothing is sent, and everything else works as before.

const nodemailer = require('nodemailer');
const settings = require('./settings');
const { HttpError } = require('./errors');

const DEFAULTS = Object.freeze({ host: '', port: 587, security: 'starttls', user: '', password: '', from: '', copy_to: '' });

const smtp = async () => ({ ...DEFAULTS, ...((await settings.get('smtp')) || {}) });
const configured = async () => {
  const s = await smtp();
  return Boolean(s.host && s.from);
};

function transport(s) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    // 'tls' encrypts from the first byte (port 465); 'starttls' upgrades a plain connection (587); 'none' sends in the clear.
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

// Sends one plain-text message. Throws with the mail server's own words if it is refused.
async function send({ to, subject, text }) {
  const s = await smtp();
  if (!s.host || !s.from) throw new HttpError(409, 'email_not_configured', 'Email is not set up: enter the SMTP server and the sender address under Settings.');
  try {
    await transport(s).sendMail({ from: s.from, to, bcc: s.copy_to && s.copy_to !== to ? s.copy_to : undefined, subject, text });
  } catch (err) {
    throw new HttpError(502, 'email_failed', `The mail server did not accept the message: ${err.message}`);
  }
}

// The settings as they may be shown: the password is never returned.
async function describe() {
  const s = await smtp();
  return { host: s.host || null, port: s.port, security: s.security, user: s.user || null, password_set: Boolean(s.password), from: s.from || null, copy_to: s.copy_to || null, configured: Boolean(s.host && s.from) };
}

module.exports = { smtp, configured, send, describe, DEFAULTS };
