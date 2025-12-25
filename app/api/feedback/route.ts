// app/api/feedback/route.ts
import { NextResponse } from "next/server";
import { Resend } from "resend";

export const dynamic = "force-dynamic";

const resend = new Resend(process.env.RESEND_API_KEY);

// Keep these as env vars so you can change without redeploying
const FEEDBACK_TO = process.env.FEEDBACK_TO || "admin@weatherrecap.com";
const FEEDBACK_FROM = process.env.FEEDBACK_FROM || "Weather Recap <onboarding@resend.dev>"; 
// ^ For testing. Later, set this to a verified domain sender like:
//   "Weather Recap <admin@weatherrecap.com>" or "Weather Recap <noreply@weatherrecap.com>"

function isValidEmail(s: string) {
  // simple sanity check; not trying to be perfect RFC validator
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export async function POST(req: Request) {
  try {
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { status: "error", error: "missing-resend-api-key" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => null);
    const email = (body?.email ?? "").toString().trim();
    const message = (body?.message ?? "").toString().trim();

    if (!message || message.length < 3) {
      return NextResponse.json(
        { status: "bad-request", error: "message-required" },
        { status: 400 }
      );
    }

    if (message.length > 5000) {
      return NextResponse.json(
        { status: "bad-request", error: "message-too-long" },
        { status: 400 }
      );
    }

    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { status: "bad-request", error: "invalid-email" },
        { status: 400 }
      );
    }

    const subject = email
      ? `Weather Recap feedback (from ${email})`
      : "Weather Recap feedback";

    const text = [
      "New Weather Recap feedback submission",
      "",
      `Contact email: ${email || "(none provided)"}`,
      "",
      "Message:",
      message,
      "",
      "---",
      `Timestamp (UTC): ${new Date().toISOString()}`,
    ].join("\n");

    const { error } = await resend.emails.send({
      from: FEEDBACK_FROM,
      to: FEEDBACK_TO,
      subject,
      text,
      replyTo: email || undefined,
    });

    if (error) {
      return NextResponse.json(
        { status: "error", error: "resend-send-failed", detail: String(error?.message || error) },
        { status: 500 }
      );
    }

    return NextResponse.json({ status: "ok" });
  } catch (e: any) {
    return NextResponse.json(
      { status: "error", error: "unexpected", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}