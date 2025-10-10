// api/contact.js
import nodemailer from "nodemailer";

// ---- simple in-memory rate limit ----
const WINDOW_MS = 60 * 1000;
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

// ---- field guards ----
const MAX_MESSAGE_LEN = 5000;
const MAX_NAME_LEN = 120;
const MAX_ORG_LEN = 200;
const MAX_INTEREST_LEN = 80;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    if (!ctype.includes("application/json")) {
      return res.status(400).json({ ok: false, error: "Send JSON body" });
    }
    const body = req.body || {};

    const {
      name = "",
      email = "",
      organization = "",
      interest = "",
      org = "",
      topic = "",
      message = "",
      _gotcha = ""
    } = body;

    if (_gotcha && String(_gotcha).trim()) {
      return res.status(200).json({ ok: true });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.socket?.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ ok: false, error: "Too many requests, try again later." });
    }

    const clean = s => String(s || "").trim();
    const vName = clean(name).slice(0, MAX_NAME_LEN);
    const vEmail = clean(email).toLowerCase();
    const vOrg = clean(organization || org).slice(0, MAX_ORG_LEN);
    const vInterest = clean(interest || topic).slice(0, MAX_INTEREST_LEN);
    const vMessage = clean(message).slice(0, MAX_MESSAGE_LEN);

    if (!vName || !vEmail || !vMessage) {
      return res.status(400).json({ ok: false, error: "name, email and message are required." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(vEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email." });
    }

    // ---- env mapping: prefer generic SMTP_* ; fallback to M365_* ----
    const SMTP_HOST   = process.env.SMTP_HOST   || "smtp.office365.com";
    const SMTP_PORT   = Number(process.env.SMTP_PORT || 587);
    const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
    const SMTP_USER   = process.env.SMTP_USER   || process.env.M365_USER;
    const SMTP_PASS   = process.env.SMTP_PASS   || process.env.M365_PASS;
    const SMTP_FROM   = process.env.SMTP_FROM   || process.env.M365_USER || SMTP_USER;
    const CONTACT_TO  = process.env.CONTACT_TO  || process.env.SMTP_TO   || SMTP_USER;

    if (!SMTP_USER || !SMTP_PASS) {
      return res.status(500).json({ ok: false, error: "SMTP credentials missing." });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE, // false for STARTTLS on 587
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { ciphers: "TLSv1.2" }
    });

    const subject = `Nuevo contacto — ${vName}`;
    const text = [
      `Nombre: ${vName}`,
      `Email: ${vEmail}`,
      `Organización: ${vOrg || "-"}`,
      `Interés: ${vInterest || "-"}`,
      "",
      "Mensaje:",
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
      from: `"SustTech Contact" <${SMTP_FROM}>`,
      to: CONTACT_TO,
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const config = {
  api: { bodyParser: { sizeLimit: "100kb" } }
};
