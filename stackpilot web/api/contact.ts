// Vercel Serverless Function for Brevo Transactional Email Integration
export default async function handler(req: any, res: any) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { name, email, inquiryType, message } = body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!email || !email.trim() || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const brevoApiKey = process.env.BREVO_API_KEY;
    if (!brevoApiKey) {
      console.error('[Brevo Error] BREVO_API_KEY environment variable is not set');
      return res.status(500).json({
        error: 'Email backend is not configured yet. Please set the BREVO_API_KEY environment variable.'
      });
    }

    const receiverEmail = process.env.CONTACT_RECEIVER_EMAIL || 'adiroyboy2@gmail.com';
    const senderEmail = process.env.CONTACT_SENDER_EMAIL || receiverEmail;
    const topic = inquiryType || 'General Inquiry';

    const payload = {
      sender: {
        name: `StackPilot (${name})`,
        email: senderEmail
      },
      to: [
        {
          email: receiverEmail,
          name: 'StackPilot Team'
        }
      ],
      replyTo: {
        email: email,
        name: name
      },
      subject: `[StackPilot Contact] ${topic} from ${name}`,
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #09090b; color: #f4f4f5; margin: 0; padding: 24px; }
            .card { background-color: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 24px; max-width: 600px; margin: 0 auto; }
            .header { border-bottom: 1px solid #27272a; padding-bottom: 16px; margin-bottom: 20px; }
            .title { font-size: 18px; font-weight: 700; color: #ffffff; margin: 0; }
            .badge { display: inline-block; background-color: #27272a; color: #38bdf8; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 6px; margin-top: 8px; }
            .row { margin-bottom: 14px; font-size: 14px; }
            .label { color: #a1a1aa; font-weight: 500; }
            .value { color: #ffffff; font-weight: 600; }
            .message-box { background-color: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; margin-top: 16px; font-size: 14px; line-height: 1.6; color: #f4f4f5; white-space: pre-wrap; }
            .footer { margin-top: 24px; font-size: 12px; color: #71717a; text-align: center; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <h2 class="title">New StackPilot Contact Form Submission</h2>
              <span class="badge">${topic}</span>
            </div>
            <div class="row">
              <span class="label">Sender Name:</span> <span class="value">${name}</span>
            </div>
            <div class="row">
              <span class="label">Work Email:</span> <a href="mailto:${email}" style="color: #38bdf8; text-decoration: none;">${email}</a>
            </div>
            <div class="row">
              <span class="label">Topic:</span> <span class="value">${topic}</span>
            </div>
            <div class="message-box">${message}</div>
            <div class="footer">
              Sent via StackPilot Web &bull; Hit Reply in your email client to respond directly to ${name}.
            </div>
          </div>
        </body>
        </html>
      `,
      textContent: `New StackPilot Contact Form Submission\n\nTopic: ${topic}\nFrom: ${name} (${email})\n\nMessage:\n${message}\n\n---\nHit reply in your email client to respond directly to ${name}.`
    };

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const brevoData = await brevoRes.json().catch(() => ({}));

    if (!brevoRes.ok) {
      console.error('[Brevo Error]', brevoRes.status, brevoData);
      return res.status(brevoRes.status || 500).json({
        error: (brevoData as any)?.message || 'Failed to send email through Brevo'
      });
    }

    return res.status(200).json({
      success: true,
      messageId: (brevoData as any)?.messageId
    });
  } catch (error: any) {
    console.error('[Contact Error]', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
