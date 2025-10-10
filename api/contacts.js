// api/contact.js
import nodemailer from "nodemailer";

// ---- Basic in-memory rate-limit (best-effort; resets per lambda instance) ----
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_PER_WINDOW = 5;
let hits = [];

function rateLimited(ip) {
  const now = Date.now();
  hits = hits.filter(h => now - h.time < WINDOW_MS);
  const count = hits.filter(h => h.ip === ip).length;
  if (count >= MAX_PER_WINDOW) return true;
  hits.push({ ip, time: now });
  return false;
}

// ---- Field guards ----
const MAX_MESSAGE_LEN = 5000;
const MAX_NAME_LEN = 120;
const MAX_ORG_LEN = 200;
const MAX_INTEREST_LEN = 80;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // Content-Type can be JSON or form-encoded
    let body = {};
    const ctype = (req.headers["content-type"] || "").toLowerCase();

    if (ctype.includes("application/json")) {
      body = req.body || {};
    } else if (ctype.includes("application/x-www-form-urlencoded") || ctype.includes("multipart/form-data")) {
      // Vercel parses urlencoded automatically only for pages/api in Next.js;
      // in this generic function we assume JSON from the client for simplicity.
      return res.status(400).json({ ok: false, error: "Send JSON body" });
    } else {
      // Try to parse anyway if runtime gave us an object
      body = req.body || {};
    }

    const {
      name = "",
      email = "",
      organization = "",
      interest = "",
      message = "",
      _gotcha = "" // honeypot
    } = body;

    // ---- Honeypot (hidden field): if filled, drop silently ----
    if (_gotcha && String(_gotcha).trim().length > 0) {
      return res.status(200).json({ ok: true }); // pretend success to avoid bot tuning
    }

    // ---- Rate limit by IP ----
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ ok: false, error: "Too many requests, try again later." });
    }

    // ---- Minimal validation ----
    const clean = (s) => String(s || "").trim();
    const vName = clean(name).slice(0, MAX_NAME_LEN);
    const vEmail = clean(email).toLowerCase();
    const vOrg = clean(organization).slice(0, MAX_ORG_LEN);
    const vInterest = clean(interest).slice(0, MAX_INTEREST_LEN);
    const vMessage = clean(message).slice(0, MAX_MESSAGE_LEN);

    if (!vName || !vEmail || !vMessage) {
      return res.status(400).json({ ok: false, error: "name, email and message are required." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(vEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email." });
    }

    // ---- Create SMTP transporter (Microsoft 365) ----
    // If your account uses MFA, use an "App Password" (preferred).
    const transporter = nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.M365_USER, // e.g., diego@susttech.com
        pass: process.env.M365_PASS  // mailbox password or app password
      },
      tls: {
        // Ensure STARTTLS
        ciphers: "TLSv1.2"
      }
    });

    // ---- Compose email ----
    const toAddress = process.env.CONTACT_TO || process.env.M365_USER;

    const subject = `Nuevo contacto — ${vName}`;
    const text = [
      `Nombre: ${vName}`,
      `Email: ${vEmail}`,
      `Organización: ${vOrg || "-"}`,
      `Interés: ${vInterest || "-"}`,
      "",
      `Mensaje:`,
      vMessage
    ].join("\n");

    const html = `
      <h2>Nuevo contacto (SustTech)</h2>
      <p><b>Nombre:</b> ${escapeHtml(vName)}</p>
      <p><b>Email:</b> ${escapeHtml(vEmail)}</p>
      <p><b>Organización:</b> ${escapeHtml(vOrg || "-")}</p>
      <p><b>Interés:</b> ${escapeHtml(vInterest || "-")}</p>
      <p><b>Mensaje:</b><br>${escapeHtml(vMessage).replace(/\n/g, "<br>")}</p>
      <hr>
      <p style="font-size:12px;color:#64748b">IP: ${escapeHtml(ip)}</p>
    `;

    await transporter.sendMail({
      from: `"SustTech Contact" <${process.env.M365_USER}>`,
      to: toAddress,
      replyTo: vEmail,
      subject,
      text,
      html
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Contact API error:", err);
    return res.status(500).json({ ok: false, error: "Email send failed." });
  }
}

// ---- tiny HTML escaper ----
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Optional: tell Vercel to keep default body size
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "100kb"
    }
  }
};
