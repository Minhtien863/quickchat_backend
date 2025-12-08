import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST,
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

export async function sendOtpMail({ to, code, purpose = 'register' }) {
  const subject =
    purpose === 'reset' ? 'Mã xác minh khôi phục mật khẩu' : 'Mã xác minh QuickChat';

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:auto;padding:20px">
    <h2 style="color:#0A84FF;margin-bottom:8px">QuickChat</h2>
    <p style="margin:8px 0 12px">Xin chào,</p>
    <p style="margin:0 0 12px">Mã xác minh của bạn là:</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:4px;background:#F5F7FB;border-radius:12px;padding:16px 20px;text-align:center;color:#111827">
      ${code}
    </div>
    <p style="margin:12px 0 8px;color:#374151">Mã sẽ hết hạn sau ${process.env.OTP_CODE_TTL_MIN || 10} phút.</p>
    <p style="margin:0;color:#6B7280">Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>
  </div>`;

  await transporter.sendMail({
    from: `"${process.env.BREVO_SENDER_NAME}" <${process.env.BREVO_SENDER_EMAIL}>`,
    to,
    subject,
    html,
  });
}


export async function verifyEmailTransport() {
  try {
    console.log('[email] Verifying SMTP transport...');
    await transporter.verify();
    console.log('[email] SMTP ready ');
  } catch (e) {
    console.error('[email] SMTP verify failed ', e);
    // gợi ý log giá trị đã load (ẩn bớt):
    console.error('[email] host=', process.env.BREVO_SMTP_HOST);
    console.error('[email] port=', process.env.BREVO_SMTP_PORT);
    console.error('[email] user=', process.env.BREVO_SMTP_USER);
    console.error('[email] key len=', (process.env.BREVO_SMTP_KEY || '').length);
  }
}