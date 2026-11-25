import { spawnSync } from 'child_process';

/**
 * Phase 23: Authenticode signing support — honest by construction.
 *
 * A PE file is "signed" only when a real signer (osslsigncode on
 * Linux/macOS, or Microsoft's signtool.exe from the Windows SDK) ran
 * successfully AND the output PE actually carries a certificate
 * table. This module detects a capable signer, runs it when a
 * certificate is provided, and verifies the result structurally.
 * When no capable signer exists it reports `unavailable` — it never
 * fabricates a signature. (Note: a bare `signtool` on Linux PATHs is
 * usually the Mozilla NSS tool, which cannot Authenticode-sign PEs,
 * so it is deliberately not accepted.)
 */

export type SigningStatus = 'signed' | 'unavailable' | 'not-requested' | 'failed';

export interface SigningOutcome {
  status: SigningStatus;
  tool?: string;
  detail: string;
}

export function detectSigningTool(): { tool: 'osslsigncode' | null; detail: string } {
  const probe = spawnSync('osslsigncode', ['--version'], { encoding: 'utf8' });
  if (!probe.error && probe.status !== undefined && probe.status !== null) {
    return { tool: 'osslsigncode', detail: `osslsigncode available: ${(probe.stdout || probe.stderr || '').trim().split('\n')[0]}` };
  }
  return {
    tool: null,
    detail: 'No Authenticode signer on this host (looked for osslsigncode; Microsoft signtool.exe requires the Windows SDK). Signing was not attempted and no signature is claimed.'
  };
}

/** Read the PE certificate table (security directory) location/size. */
export function peCertificateTable(buffer: Buffer): { offset: number; size: number } | null {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  const dataDirStart = optionalHeader + (magic === 0x20b ? 112 : 96); // PE32+ / PE32
  const securityEntry = dataDirStart + 4 * 8; // directory index 4 = certificate table
  if (securityEntry + 8 > buffer.length) return null;
  const offset = buffer.readUInt32LE(securityEntry);
  const size = buffer.readUInt32LE(securityEntry + 4);
  return { offset, size };
}

export function hasAuthenticodeSignature(buffer: Buffer): boolean {
  const table = peCertificateTable(buffer);
  return !!table && table.size >= 8 && table.offset > 0 && table.offset + table.size <= buffer.length + 8;
}

export async function signPeFile(
  filePath: string,
  certPath: string | undefined,
  certPassword: string | undefined
): Promise<SigningOutcome> {
  if (!certPath) {
    return { status: 'not-requested', detail: 'No signing certificate was provided with the release request.' };
  }
  const { tool, detail } = detectSigningTool();
  if (!tool) {
    return { status: 'unavailable', detail };
  }
  const args = ['sign', '-pkcs12', certPath, '-in', filePath, '-out', `${filePath}.signed`];
  if (certPassword) args.push('-pass', certPassword);
  const run = spawnSync(tool, args, { encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    return { status: 'failed', tool, detail: `Signer failed: ${(run.stderr || run.stdout || String(run.error)).trim().split('\n')[0]}` };
  }
  const fs = await import('fs');
  const signed = fs.readFileSync(`${filePath}.signed`);
  if (!hasAuthenticodeSignature(signed)) {
    return { status: 'failed', tool, detail: 'Signer exited 0 but the output PE has no certificate table — signature NOT claimed.' };
  }
  fs.copyFileSync(`${filePath}.signed`, filePath);
  fs.rmSync(`${filePath}.signed`, { force: true });
  return { status: 'signed', tool, detail: 'Signed with osslsigncode and verified: the PE certificate table is present.' };
}
