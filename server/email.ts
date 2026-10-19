import nodemailer from 'nodemailer';

export interface EmailDeliveryResult {
  success: boolean;
  provider?: 'resend' | 'smtp' | 'test';
  error?: string;
  missingConfig?: boolean;
  requiredEnv?: string[];
}

export interface PasswordResetEmailPayload {
  to: string;
  code: string; // 6-digit verification code
}

// Optional test delivery interceptor for automated testing & CI
type TestDeliveryHandler = (mail: {
  to: string;
  code: string;
  subject: string;
  text: string;
  html: string;
}) => Promise<{ success: boolean; error?: string }>;

class EmailService {
  private testDeliveryHandler: TestDeliveryHandler | null = null;

  public setTestDeliveryHandler(handler: TestDeliveryHandler | null) {
    this.testDeliveryHandler = handler;
  }

  public getRequiredEnvVars(): string[] {
    return [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
      'RESEND_API_KEY'
    ];
  }

  public isConfigured(): boolean {
    if (this.testDeliveryHandler) return true;
    if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim().length > 0) return true;
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return true;
    return false;
  }

  /**
   * Dispatches a secure 6-digit verification code email.
   * Never logs the verification code or credentials.
   */
  public async sendPasswordResetCode(payload: PasswordResetEmailPayload): Promise<EmailDeliveryResult> {
    const { to, code } = payload;
    const normalizedTo = to.toLowerCase().trim();

    // 1. Check if a test handler is installed (e.g. in test suite)
    if (this.testDeliveryHandler) {
      try {
        const textContent = this.generatePlainText(code);
        const htmlContent = this.generateHtml(code);
        const res = await this.testDeliveryHandler({
          to: normalizedTo,
          code,
          subject: 'SquadForge - Verification Code for Password Reset',
          text: textContent,
          html: htmlContent
        });
        if (res.success) {
          return { success: true, provider: 'test' };
        } else {
          return { success: false, provider: 'test', error: res.error || 'Test email delivery simulated failure' };
        }
      } catch (err: any) {
        return { success: false, provider: 'test', error: err.message || 'Test delivery handler threw error' };
      }
    }

    // 2. Check Resend Provider
    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    if (resendApiKey) {
      try {
        const fromAddress = process.env.SMTP_FROM || 'SquadForge Security <security@squadforge.dev>';
        const textContent = this.generatePlainText(code);
        const htmlContent = this.generateHtml(code);

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: fromAddress,
            to: [normalizedTo],
            subject: 'SquadForge - Verification Code for Password Reset',
            text: textContent,
            html: htmlContent
          })
        });

        if (response.ok) {
          console.log(`[EMAIL] Password reset code successfully dispatched via Resend to ${normalizedTo}`);
          return { success: true, provider: 'resend' };
        } else {
          const errData: any = await response.json().catch(() => ({}));
          console.error('[EMAIL] Resend delivery failed with status:', response.status);
          return {
            success: false,
            provider: 'resend',
            error: errData.message || `Resend API error (${response.status})`
          };
        }
      } catch (err: any) {
        console.error('[EMAIL] Resend network error:', err.message);
        return { success: false, provider: 'resend', error: 'Failed to contact Resend delivery service' };
      }
    }

    // 3. Check SMTP Provider
    const smtpHost = process.env.SMTP_HOST?.trim();
    const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
    const smtpUser = process.env.SMTP_USER?.trim();
    const smtpPass = process.env.SMTP_PASS?.trim();
    const smtpFrom = process.env.SMTP_FROM?.trim() || 'SquadForge Security <security@squadforge.dev>';

    if (smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: {
            user: smtpUser,
            pass: smtpPass
          }
        });

        const textContent = this.generatePlainText(code);
        const htmlContent = this.generateHtml(code);

        await transporter.sendMail({
          from: smtpFrom,
          to: normalizedTo,
          subject: 'SquadForge - Verification Code for Password Reset',
          text: textContent,
          html: htmlContent
        });

        console.log(`[EMAIL] Password reset code successfully dispatched via SMTP to ${normalizedTo}`);
        return { success: true, provider: 'smtp' };
      } catch (err: any) {
        console.error('[EMAIL] SMTP transport error:', err.message);
        return {
          success: false,
          provider: 'smtp',
          error: `SMTP delivery failed: ${err.message}`
        };
      }
    }

    // 4. No delivery provider is configured
    console.warn('[EMAIL] Neither RESEND_API_KEY nor SMTP configuration (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) is available.');
    return {
      success: false,
      missingConfig: true,
      requiredEnv: this.getRequiredEnvVars(),
      error: 'Email delivery service is not configured. To send verification codes, configure RESEND_API_KEY or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.'
    };
  }

  private generatePlainText(code: string): string {
    return [
      'SquadForge Security Verification',
      '================================',
      '',
      `Your six-digit password reset verification code is: ${code}`,
      '',
      'IMPORTANT:',
      '• This verification code expires in exactly five minutes (300 seconds).',
      '• Each code can be used only once.',
      '• If you did not request a password reset, you can safely ignore this email. Your SquadForge account remains secure.',
      '',
      '-- SquadForge Autonomous Software Engineering Platform'
    ].join('\n');
  }

  private generateHtml(code: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SquadForge Password Reset</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f5f5f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 520px; background-color: #171717; border: 1px solid #262626; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 20px; border-bottom: 1px solid #262626; text-align: center;">
              <div style="display: inline-block; width: 44px; height: 44px; line-height: 44px; background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); border-radius: 12px; font-size: 20px; color: #fbbf24; margin-bottom: 12px;">
                ⚡
              </div>
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">SquadForge Security</h1>
              <p style="margin: 6px 0 0; font-size: 13px; color: #a3a3a3; font-family: monospace;">Password Reset Verification</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6; color: #d4d4d4;">
                A password reset request was initiated for your SquadForge account. Enter the verification code below to proceed:
              </p>

              <!-- Code Box -->
              <div style="background-color: #0a0a0a; border: 1px solid #f59e0b; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
                <span style="font-family: 'JetBrains Mono', monospace, Courier; font-size: 36px; font-weight: 700; letter-spacing: 10px; color: #fbbf24; display: inline-block;">
                  ${code}
                </span>
              </div>

              <!-- Expiry Alert -->
              <div style="background: rgba(245, 158, 11, 0.08); border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 13px; color: #fbbf24; font-weight: 500;">
                  ⏱ This code expires in exactly five minutes (300 seconds).
                </p>
                <p style="margin: 4px 0 0; font-size: 12px; color: #a3a3a3;">
                  For security, each code can only be used once and allows up to five verification attempts.
                </p>
              </div>

              <!-- Ignore Notice -->
              <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #737373;">
                If you did not request a password reset, you can safely ignore this email. No changes will be made to your account.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px; background-color: #0d0d0d; border-top: 1px solid #262626; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #525252; font-family: monospace;">
                SquadForge · Autonomous Multi-AI Parallel Swarm Engineering
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}

export const emailService = new EmailService();
