import type { PeInspectionReport } from './types.js';

/**
 * Phase 18: minimal, honest PE (Portable Executable) parser.
 * Validates that a build artifact is a genuine Windows executable by
 * parsing its DOS header, PE signature, COFF header and optional
 * header — the same structures Windows itself checks. It never
 * "approves" a file that does not parse.
 */
const MACHINE_TYPES: Record<number, string> = {
  0x014c: 'x86 (I386)',
  0x8664: 'x64 (AMD64)',
  0xaa64: 'ARM64',
  0x01c0: 'ARM',
  0x0200: 'IA64'
};

const SUBSYSTEMS: Record<number, string> = {
  2: 'Windows GUI',
  3: 'Windows Console',
  9: 'Windows CE GUI',
  10: 'EFI Application'
};

export class PeInspector {
  public static inspect(buffer: Buffer): PeInspectionReport {
    const errors: string[] = [];
    if (!buffer || buffer.length < 64) {
      return { isPeFile: false, errors: ['file too small to contain a DOS header'] };
    }
    // DOS header: 'MZ'
    if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      return { isPeFile: false, errors: ['missing MZ DOS signature'] };
    }
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset <= 0 || peOffset + 24 > buffer.length) {
      errors.push('PE header offset (e_lfanew) is out of range');
      return { isPeFile: false, errors };
    }
    // PE signature: 'PE\0\0'
    if (
      buffer[peOffset] !== 0x50 ||
      buffer[peOffset + 1] !== 0x45 ||
      buffer[peOffset + 2] !== 0x00 ||
      buffer[peOffset + 3] !== 0x00
    ) {
      errors.push('missing PE\\0\\0 signature at e_lfanew');
      return { isPeFile: false, errors };
    }
    const coff = peOffset + 4;
    const machine = buffer.readUInt16LE(coff);
    const sections = buffer.readUInt16LE(coff + 2);
    const optionalSize = buffer.readUInt16LE(coff + 16);
    let subsystem: string | undefined;
    let isGuiApp: boolean | undefined;
    if (optionalSize >= 70 && coff + 20 + 70 <= buffer.length) {
      const magic = buffer.readUInt16LE(coff + 20);
      // PE32+ (0x20b) subsystem lives at +68; PE32 (0x10b) at +68 as well for subsystem field offset 68.
      if (magic === 0x20b || magic === 0x10b) {
        const sub = buffer.readUInt16LE(coff + 20 + 68);
        subsystem = SUBSYSTEMS[sub] || `subsystem ${sub}`;
        isGuiApp = sub === 2;
      }
    }
    if (sections === 0) errors.push('COFF header declares zero sections');
    return {
      isPeFile: errors.length === 0,
      machine: MACHINE_TYPES[machine] || `unknown (0x${machine.toString(16)})`,
      subsystem,
      isGuiApp,
      sections,
      errors
    };
  }
}
