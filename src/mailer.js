import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { one } from './db.js';
import { accessToken, appUrl, canEmail } from './auth.js';

// Material emails go out from the creator's own Gmail (gmail.send scope),
// with the file attached straight from the database.
export const materialUrl = (m) => `${appUrl()}/api/m/${m.id}/${encodeURIComponent(m.filename)}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderEmail({ campaign, delivery, viewer, downloadUrl, creatorName }) {
  const creator = creatorName;
  const body = esc(campaign.message).replace(/\n/g, '<br>');
  return `<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e4e4e7">
      <tr><td style="padding:22px 28px;border-bottom:1px solid #f0f0f2">
        <span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:#ef4444;vertical-align:middle"></span>
        <span style="font-weight:700;font-size:15px;vertical-align:middle;margin-left:8px">CommentDrop</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 6px;font-size:13px;color:#71717a">You commented <b style="color:#18181b">“${esc(delivery.comment_text)}”</b></p>
        <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3">Here's your ${esc(campaign.material_name)} 🎁</h1>
        <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#3f3f46">${body}</p>
        <a href="${esc(downloadUrl)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px">Download ${esc(campaign.material_name)}</a>
        <p style="margin:14px 0 0;font-size:12px;color:#a1a1aa">The PDF is also attached to this email.</p>
      </td></tr>
      <tr><td style="padding:18px 28px;background:#fafafa;border-top:1px solid #f0f0f2">
        <table cellpadding="0" cellspacing="0"><tr>
          ${campaign.video_thumb ? `<td style="padding-right:12px"><img src="${esc(campaign.video_thumb)}" width="96" style="border-radius:8px;display:block"></td>` : ''}
          <td style="font-size:12px;color:#71717a;line-height:1.5">From <b style="color:#18181b">${esc(creator)}</b><br>${esc(campaign.video_title)}<br><a href="https://youtu.be/${esc(campaign.video_id)}" style="color:#ef4444">Watch the video →</a></td>
        </tr></table>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#a1a1aa;margin:16px 0 0">Sent to ${esc(viewer.email)} because your YouTube account ${esc(viewer.youtube_handle || '')} is linked on CommentDrop.</p>
  </td></tr></table>
</body></html>`;
}

export async function sendMaterial({ creator, campaign, delivery, viewer }) {
  if (!canEmail(creator)) throw new Error('Creator has not allowed Gmail sending - sign in again');
  const material = await one('select id, filename, mime, data from materials where id = $1', [campaign.material_id]);
  if (!material) throw new Error('Material file is missing');
  const creatorName = creator.channel_title || creator.name || 'CommentDrop';
  const html = renderEmail({ campaign, delivery, viewer, downloadUrl: materialUrl(material), creatorName });
  const raw = await new MailComposer({
    from: `"${creatorName.replace(/"/g, '')} via CommentDrop" <${creator.email}>`,
    to: viewer.email,
    subject: campaign.subject,
    html,
    attachments: [{ filename: material.filename, content: Buffer.from(material.data), contentType: material.mime }],
  }).compile().build();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(creator)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `Gmail API ${res.status}`);
  return body.id;
}
