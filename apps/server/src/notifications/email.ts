export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(message: EmailMessage) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[email] ${message.subject} -> ${message.to}`);
    }
    return { delivered: false };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, ...message }),
  });
  if (!response.ok) {
    throw new Error(`Email delivery failed with status ${response.status}`);
  }
  return { delivered: true };
}
