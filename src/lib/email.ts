import { env } from './env';
import { SITE_NAME } from '../config';

const POSTMARK_URL = 'https://api.postmarkapp.com/email';

interface Mail {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  replyTo?: string;
}

async function send(mail: Mail): Promise<void> {
  const token = env.postmarkToken;
  const from = env.postmarkFrom;
  if (!token || !from) {
    throw new Error('POSTMARK_SERVER_TOKEN / POSTMARK_FROM_EMAIL are not set (playbook §5.2)');
  }

  const res = await fetch(POSTMARK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: mail.to,
      Subject: mail.subject,
      TextBody: mail.textBody,
      HtmlBody: mail.htmlBody,
      ReplyTo: mail.replyTo,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    // Postmark's sandbox restriction lands here as a 406 until the account is
    // approved: mail only delivers to addresses on a verified domain (playbook
    // §3.7). A stored-but-not-emailed lead usually means exactly this.
    throw new Error(`Postmark ${res.status}: ${await res.text()}`);
  }
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export interface LeadEmail {
  name: string | null;
  email: string;
  phone: string;
  customerType: string;
  emergency: string;
  message: string | null;
  pagePath: string | null;
  submissionId: number | null;
}

/**
 * The lead notification to the client.
 *
 * `Reply-To` is the customer's address, so hitting reply in the client's inbox
 * answers the customer rather than the no-reply sender (form checklist, §6).
 */
export async function sendOwnerEmail(lead: LeadEmail): Promise<void> {
  const to = env.siteOwnerEmail;
  if (!to) throw new Error('SITE_OWNER_EMAIL is not set (playbook §5.4)');

  const rows: [string, string][] = [
    ['Name', lead.name || '—'],
    ['Email', lead.email],
    ['Phone', lead.phone],
    ['New customer?', lead.customerType],
    ['Emergency?', lead.emergency],
    ['Message', lead.message || '—'],
    ['Submitted from', lead.pagePath || '—'],
    ['Reference', lead.submissionId ? `#${lead.submissionId}` : 'not stored'],
  ];

  // The subject leads with the emergency answer because that is the one field
  // that changes how fast this has to be read.
  const urgent = /^yes/i.test(lead.emergency);
  const subject = `${urgent ? '[EMERGENCY] ' : ''}New appointment request — ${lead.name || lead.email}`;

  await send({
    to,
    subject,
    replyTo: lead.email,
    textBody: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
    htmlBody:
      `<h2 style="font:600 18px/1.3 system-ui,sans-serif;margin:0 0 16px">${escape(SITE_NAME)} — appointment request</h2>` +
      '<table style="border-collapse:collapse;font:14px/1.5 system-ui,sans-serif">' +
      rows.map(([k, v]) =>
        `<tr><th align="left" style="padding:4px 16px 4px 0;vertical-align:top;color:#555;font-weight:600">${escape(k)}</th>` +
        `<td style="padding:4px 0">${escape(v).replace(/\n/g, '<br>')}</td></tr>`).join('') +
      '</table>',
  });
}

/**
 * The optional acknowledgement to the customer. Off by default
 * (`SEND_EMAIL_TO_CUSTOMER`), because it needs copy the client has signed off.
 */
export async function sendCustomerEmail(lead: LeadEmail): Promise<void> {
  const text =
    `Thanks for getting in touch with ${SITE_NAME}.\n\n` +
    'We have your request and will call you back shortly. If this is an emergency, ' +
    'please call us on (615) 538-8579 rather than waiting for a reply.\n\n' +
    `What you sent us:\n  Phone: ${lead.phone}\n  Message: ${lead.message || '—'}\n`;

  await send({
    to: lead.email,
    subject: `We received your request — ${SITE_NAME}`,
    textBody: text,
    htmlBody:
      `<p style="font:14px/1.6 system-ui,sans-serif">Thanks for getting in touch with ${escape(SITE_NAME)}.</p>` +
      '<p style="font:14px/1.6 system-ui,sans-serif">We have your request and will call you back shortly. ' +
      'If this is an emergency, please call us on <a href="tel:6155388579">(615) 538-8579</a> rather than ' +
      'waiting for a reply.</p>' +
      `<p style="font:14px/1.6 system-ui,sans-serif;color:#555">Phone: ${escape(lead.phone)}<br>` +
      `Message: ${escape(lead.message || '—')}</p>`,
  });
}
