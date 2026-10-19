import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { emailService } from '../server/email.js';
import { 
  hashPassword, 
  verifyPassword, 
  generateVerificationCode,
  generateSessionToken 
} from '../server/crypto.js';
import { User } from '../server/types.js';

describe('SquadForge Secure 6-Digit Email OTP Password Reset System', () => {
  const testEmail = 'dev.engineer@squadforge.test';
  const initialPassword = 'InitialSecurePass#2026';
  const newPassword = 'NewSecretPassword#2027!';
  let testUser: User;

  beforeEach(async () => {
    db.resetTestClock();
    emailService.setTestDeliveryHandler(null);
    db.passwordResetCodes.clear();
    db.passwordResetAuths.clear();

    const passwordHash = await hashPassword(initialPassword);
    testUser = {
      id: `usr_otp_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      email: testEmail,
      name: 'Dev Engineer',
      passwordHash,
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    };
    db.createUser(testUser);
  });

  afterEach(() => {
    db.resetTestClock();
    emailService.setTestDeliveryHandler(null);
    db.passwordResetCodes.clear();
    db.passwordResetAuths.clear();
  });

  test('1. Successful end-to-end password reset with 6-digit OTP', async () => {
    const code = generateVerificationCode();
    assert.equal(/^\d{6}$/.test(code), true, 'Verification code must be exactly 6 numeric digits');

    // Issue code
    const issueResult = db.createPasswordResetCode(testEmail, code);
    assert.equal(issueResult.success, true);
    assert.ok(issueResult.record);
    assert.equal(issueResult.record?.attempts, 0);
    assert.equal(issueResult.record?.consumed, false);
    assert.equal(issueResult.record?.invalidated, false);

    // Verify code
    const verifyResult = db.verifyPasswordResetCode(testEmail, code);
    assert.equal(verifyResult.success, true);
    assert.ok(verifyResult.resetAuthToken, 'Must issue a single-use server-side reset authorization token');

    // Complete password reset
    const resetResult = await db.completePasswordReset(verifyResult.resetAuthToken!, newPassword);
    assert.equal(resetResult.success, true);

    // Verify new password works and old password is rejected
    const updatedUser = db.getUser(testUser.id);
    assert.ok(updatedUser);
    const oldPassValid = await verifyPassword(initialPassword, updatedUser!.passwordHash!);
    assert.equal(oldPassValid, false, 'Old password must no longer be valid');

    const newPassValid = await verifyPassword(newPassword, updatedUser!.passwordHash!);
    assert.equal(newPassValid, true, 'New password must verify successfully');
  });

  test('2. Incorrect verification codes decrement attempts without consuming the code', async () => {
    const code = '582914';
    db.createPasswordResetCode(testEmail, code);

    // Incorrect attempt
    const failResult = db.verifyPasswordResetCode(testEmail, '111111');
    assert.equal(failResult.success, false);
    assert.equal(failResult.attemptsRemaining, 4);
    assert.ok(failResult.error?.includes('4 attempts remaining'));

    // Check database record reflects attempt count
    const active = db.getActiveResetCode(testEmail);
    assert.ok(active);
    assert.equal(active?.attempts, 1);
    assert.equal(active?.consumed, false);

    // Correct code still works afterwards
    const successResult = db.verifyPasswordResetCode(testEmail, code);
    assert.equal(successResult.success, true);
  });

  test('3. Expiration at exactly 300 seconds using controllable test clock', () => {
    let mockTime = 1_700_000_000_000;
    db.setTestClock(() => mockTime);

    const code = '492817';
    const issueRes = db.createPasswordResetCode(testEmail, code);
    assert.equal(issueRes.success, true);
    assert.equal(issueRes.record?.expiresAt, mockTime + 300_000);

    // Advance clock to 299 seconds (still valid)
    mockTime += 299_000;
    const verify299 = db.verifyPasswordResetCode(testEmail, code);
    assert.equal(verify299.success, true, 'Code must be accepted before expiration at 299 seconds');

    // Reset and test exact 300s expiration boundary
    mockTime = 1_700_000_000_000;
    db.createPasswordResetCode(testEmail, '839201');

    // Advance clock to exactly 300 seconds
    mockTime += 300_000;
    const verify300 = db.verifyPasswordResetCode(testEmail, '839201');
    assert.equal(verify300.success, false, 'Code must be rejected at exactly 300 seconds expiration');
    assert.ok(verify300.error?.includes('expired'));

    // Advance clock to 301 seconds
    mockTime += 1_000;
    const verify301 = db.verifyPasswordResetCode(testEmail, '839201');
    assert.equal(verify301.success, false, 'Code must be rejected after 300 seconds expiration');
  });

  test('4. Code reuse and reset authorization token reuse prevention', async () => {
    const code = '729104';
    db.createPasswordResetCode(testEmail, code);

    // First verification succeeds
    const firstVerify = db.verifyPasswordResetCode(testEmail, code);
    assert.equal(firstVerify.success, true);
    const authToken = firstVerify.resetAuthToken!;
    assert.ok(authToken);

    // Second verification of the same code fails (already consumed)
    const secondVerify = db.verifyPasswordResetCode(testEmail, code);
    assert.equal(secondVerify.success, false, 'Code cannot be verified twice');

    // Complete password reset with authorization token
    const firstReset = await db.completePasswordReset(authToken, newPassword);
    assert.equal(firstReset.success, true);

    // Replay attack: attempting to use the same reset authorization token a second time fails
    const secondReset = await db.completePasswordReset(authToken, 'AnotherPassword#2028!');
    assert.equal(secondReset.success, false, 'Reset authorization token cannot be reused');
  });

  test('5. Resend invalidates the previous code and creates a new one', () => {
    let mockTime = 1_700_000_000_000;
    db.setTestClock(() => mockTime);

    const codeA = '112233';
    const issueA = db.createPasswordResetCode(testEmail, codeA);
    assert.equal(issueA.success, true);

    // Advance past the 60-second cooldown
    mockTime += 65_000;

    const codeB = '445566';
    const issueB = db.createPasswordResetCode(testEmail, codeB);
    assert.equal(issueB.success, true);

    // Code A is invalidated by the resend
    const verifyA = db.verifyPasswordResetCode(testEmail, codeA);
    assert.equal(verifyA.success, false, 'Previous code must be invalidated upon resend');

    // Code B is valid
    const verifyB = db.verifyPasswordResetCode(testEmail, codeB);
    assert.equal(verifyB.success, true, 'New code must be active and valid');
  });

  test('6. Server-side cooldown rate limit prevents rapid code generation requests', () => {
    let mockTime = 1_700_000_000_000;
    db.setTestClock(() => mockTime);

    const codeA = '123456';
    const firstRes = db.createPasswordResetCode(testEmail, codeA);
    assert.equal(firstRes.success, true);

    // Attempting a second code after only 15 seconds must be blocked
    mockTime += 15_000;
    const secondRes = db.createPasswordResetCode(testEmail, '654321');
    assert.equal(secondRes.success, false, 'Must reject code request within 60s cooldown');
    assert.equal(secondRes.cooldownRemaining, 45, 'Must report remaining 45 seconds of cooldown');

    // Advancing past 60s cooldown allows request
    mockTime += 46_000;
    const thirdRes = db.createPasswordResetCode(testEmail, '987654');
    assert.equal(thirdRes.success, true, 'Request permitted after cooldown expires');
  });

  test('7. Excessive attempts: code is locked and invalidated after 5 incorrect attempts', () => {
    const validCode = '882299';
    db.createPasswordResetCode(testEmail, validCode);

    // 4 failed attempts
    for (let i = 1; i <= 4; i++) {
      const res = db.verifyPasswordResetCode(testEmail, '000000');
      assert.equal(res.success, false);
      assert.equal(res.attemptsRemaining, 5 - i);
    }

    // 5th failed attempt locks and invalidates code
    const fifthAttempt = db.verifyPasswordResetCode(testEmail, '000000');
    assert.equal(fifthAttempt.success, false);
    assert.equal(fifthAttempt.attemptsRemaining, 0);
    assert.equal(fifthAttempt.codeExpiredOrInvalid, true);
    assert.ok(fifthAttempt.error?.includes('Maximum verification attempts (5)'));

    // Even if the user now enters the valid code, it is rejected
    const validAfterLock = db.verifyPasswordResetCode(testEmail, validCode);
    assert.equal(validAfterLock.success, false, 'Code must remain invalidated after 5 failed attempts');
  });

  test('8. Email delivery verification, required environment variables and failure handling', async () => {
    // 8a. When unconfigured, reports required environment variables
    emailService.setTestDeliveryHandler(null);
    const origSmtp = process.env.SMTP_HOST;
    const origResend = process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;

    const unconfiguredRes = await emailService.sendPasswordResetCode({
      to: testEmail,
      code: '123456'
    });
    assert.equal(unconfiguredRes.success, false);
    assert.equal(unconfiguredRes.missingConfig, true);
    assert.ok(unconfiguredRes.requiredEnv?.includes('RESEND_API_KEY'));
    assert.ok(unconfiguredRes.requiredEnv?.includes('SMTP_HOST'));

    // Restore env
    if (origSmtp) process.env.SMTP_HOST = origSmtp;
    if (origResend) process.env.RESEND_API_KEY = origResend;

    // 8b. Delivery failure handling: never pretend an email was sent if delivery failed
    emailService.setTestDeliveryHandler(async () => {
      return { success: false, error: 'SMTP connection refused on port 587' };
    });

    const failedDelivery = await emailService.sendPasswordResetCode({
      to: testEmail,
      code: '654321'
    });
    assert.equal(failedDelivery.success, false);
    assert.equal(failedDelivery.error, 'SMTP connection refused on port 587');

    // 8c. Successful delivery verification: must contain 6-digit code, 5-minute expiry, and ignore instructions
    let deliveredMail: any = null;
    emailService.setTestDeliveryHandler(async (mail) => {
      deliveredMail = mail;
      return { success: true };
    });

    const deliverySuccess = await emailService.sendPasswordResetCode({
      to: testEmail,
      code: '948210'
    });
    assert.equal(deliverySuccess.success, true);
    assert.ok(deliveredMail);
    assert.equal(deliveredMail.to, testEmail);

    // Verify content requirements
    assert.ok(deliveredMail.text.includes('948210'), 'Plain text must contain 6-digit code');
    assert.ok(deliveredMail.html.includes('948210'), 'HTML must contain 6-digit code');
    assert.ok(deliveredMail.text.includes('five minutes') || deliveredMail.text.includes('300 seconds'), 'Must state 5-minute expiration');
    assert.ok(deliveredMail.text.toLowerCase().includes('ignore'), 'Must state instructions to ignore if not requested');
    assert.ok(deliveredMail.html.toLowerCase().includes('ignore'), 'HTML must state ignore instructions');
  });

  test('9. Session revocation: all existing user sessions are revoked upon password reset', async () => {
    // Create 3 active user sessions across devices
    const sessionToken1 = generateSessionToken();
    const sessionToken2 = generateSessionToken();
    const sessionToken3 = generateSessionToken();

    db.createSession(testUser.id, sessionToken1, '192.168.1.10', 'Desktop');
    db.createSession(testUser.id, sessionToken2, '192.168.1.11', 'Mobile');
    db.createSession(testUser.id, sessionToken3, '192.168.1.12', 'Tablet');

    assert.ok(db.getSession(sessionToken1), 'Session 1 should be active');
    assert.ok(db.getSession(sessionToken2), 'Session 2 should be active');
    assert.ok(db.getSession(sessionToken3), 'Session 3 should be active');

    // Perform password reset flow
    const code = '334455';
    db.createPasswordResetCode(testEmail, code);
    const verifyRes = db.verifyPasswordResetCode(testEmail, code);
    assert.equal(verifyRes.success, true);

    const resetRes = await db.completePasswordReset(verifyRes.resetAuthToken!, 'RevokeAllSessions#2026!');
    assert.equal(resetRes.success, true);

    // All 3 sessions must now be revoked
    assert.equal(db.getSession(sessionToken1), undefined, 'Session 1 must be revoked');
    assert.equal(db.getSession(sessionToken2), undefined, 'Session 2 must be revoked');
    assert.equal(db.getSession(sessionToken3), undefined, 'Session 3 must be revoked');
  });
});
