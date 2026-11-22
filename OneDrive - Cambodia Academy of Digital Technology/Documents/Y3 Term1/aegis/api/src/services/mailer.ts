import nodemailer from 'nodemailer';
import { config } from '../config';
import { q } from '../db';

/** Email is on when SMTP_HOST is set. Without it, messages are logged and the teacher gets the links to share. */
export const emailEnabled = () => !!config.smtpHost;

let transport: nodemailer.Transporter | null = null;
function getTransport() {
  transport ??= nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  return transport;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Plain, readable HTML wrapper with an optional button. */
function html(title: string, paragraphs: string[], button?: { label: string; url: string }) {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f4f6fb;padding:24px;color:#1b2333">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e3e7ef">
<h2 style="margin:0 0 16px;font-size:20px">${esc(title)}</h2>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;white-space:pre-wrap">${esc(p)}</p>`).join('\n')}
${button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:#2f5bea;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${esc(button.label)}</a></p><p style="font-size:12px;color:#6b7385;word-break:break-all">${esc(button.url)}</p>` : ''}
<p style="font-size:12px;color:#6b7385;margin-top:24px">${esc(config.appName)}</p>
</div></body></html>`;
}

export interface Mail {
  to: string;
  subject: string;
  title: string;
  paragraphs: string[];
  button?: { label: string; url: string };
}

/** Sends one email. Never throws: returns whether it was really sent. */
export async function sendMail(m: Mail): Promise<boolean> {
  const text = [...m.paragraphs, ...(m.button ? ['', `${m.button.label}: ${m.button.url}`] : [])].join('\n\n');
  if (!emailEnabled()) {
    console.log(`[mail:not-configured] to=${m.to} subject="${m.subject}"${m.button ? ` link=${m.button.url}` : ''}`);
    await q(`INSERT INTO outbound_emails(to_address, subject, status) VALUES ($1,$2,'logged')`, [m.to, m.subject]).catch(() => undefined);
    return false;
  }
  try {
    await getTransport().sendMail({ from: config.smtpFrom || config.smtpUser, to: m.to, subject: m.subject, text, html: html(m.title, m.paragraphs, m.button) });
    await q(`INSERT INTO outbound_emails(to_address, subject, status) VALUES ($1,$2,'sent')`, [m.to, m.subject]).catch(() => undefined);
    return true;
  } catch (e) {
    console.error('[mail] failed', m.to, e);
    await q(`INSERT INTO outbound_emails(to_address, subject, status, error) VALUES ($1,$2,'failed',$3)`, [m.to, m.subject, String(e).slice(0, 500)]).catch(() => undefined);
    return false;
  }
}

/** Fire-and-forget batch (don't hold up the HTTP response for slow SMTP servers). */
export function sendMailLater(list: Mail[]) {
  if (!list.length) return;
  setImmediate(async () => {
    for (const m of list) await sendMail(m);
  });
}
