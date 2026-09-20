import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      {
        name: 'brevo-contact-dev-server',
        configureServer(server) {
          server.middlewares.use('/api/contact', async (req, res) => {
            if (req.method === 'OPTIONS') {
              res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
              });
              res.end();
              return;
            }

            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Method Not Allowed' }));
              return;
            }

            let body = '';
            req.on('data', (chunk) => {
              body += chunk;
            });

            req.on('end', async () => {
              try {
                const parsed = JSON.parse(body || '{}');
                const { name, email, inquiryType, message } = parsed;

                if (!name || !name.trim()) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Name is required' }));
                  return;
                }
                if (!email || !email.trim() || !/^\S+@\S+\.\S+$/.test(email)) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'A valid email address is required' }));
                  return;
                }
                if (!message || !message.trim()) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Message cannot be empty' }));
                  return;
                }

                const brevoApiKey = env.BREVO_API_KEY || process.env.BREVO_API_KEY;
                if (!brevoApiKey) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error:
                        'BREVO_API_KEY is not set in stackpilot web/.env.local. Please add your Brevo API key to test sending.',
                    })
                  );
                  return;
                }

                const receiverEmail =
                  env.CONTACT_RECEIVER_EMAIL ||
                  process.env.CONTACT_RECEIVER_EMAIL ||
                  'adiroyboy2@gmail.com';
                const senderEmail =
                  env.CONTACT_SENDER_EMAIL ||
                  process.env.CONTACT_SENDER_EMAIL ||
                  receiverEmail;
                const topic = inquiryType || 'General Inquiry';

                const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
                  method: 'POST',
                  headers: {
                    accept: 'application/json',
                    'api-key': brevoApiKey,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({
                    sender: {
                      name: `StackPilot (${name})`,
                      email: senderEmail,
                    },
                    to: [
                      {
                        email: receiverEmail,
                        name: 'StackPilot Team',
                      },
                    ],
                    replyTo: {
                      email: email,
                      name: name,
                    },
                    subject: `[StackPilot Contact] ${topic} from ${name}`,
                    htmlContent: `
                      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; border-radius: 8px;">
                        <h2 style="color: #18181b; margin-top: 0;">New StackPilot Contact Message</h2>
                        <p><strong>Name:</strong> ${name}</p>
                        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
                        <p><strong>Topic:</strong> ${topic}</p>
                        <div style="margin-top: 16px; padding: 14px; background-color: #f4f4f5; border-radius: 6px;">
                          <p style="margin: 0; white-space: pre-wrap; color: #27272a;">${message}</p>
                        </div>
                        <p style="margin-top: 20px; font-size: 12px; color: #71717a;">
                          Reply directly to this email to respond to ${name}.
                        </p>
                      </div>
                    `,
                    textContent: `From: ${name} (${email})\nTopic: ${topic}\n\nMessage:\n${message}`,
                  }),
                });

                const brevoData = await brevoRes.json().catch(() => ({}));
                if (!brevoRes.ok) {
                  res.writeHead(brevoRes.status || 500, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error: (brevoData as any)?.message || 'Brevo API rejected the request',
                    })
                  );
                  return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, messageId: (brevoData as any)?.messageId }));
              } catch (err: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
              }
            });
          });
        },
      },
    ],
    server: {
      port: 3005,
      host: '127.0.0.1',
    },
    resolve: {
      alias: {
        'motion/react': 'framer-motion',
        motion: 'framer-motion',
      },
    },
    optimizeDeps: {
      include: ['gsap', 'gsap/ScrollTrigger', 'lenis', 'ogl', 'framer-motion'],
    },
  };
});
