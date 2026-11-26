import type { ElfInspectionReport } from './types.js';

/**
 * Phase 36: minimal, honest ELF parser — the Linux counterpart of
 * PeInspector. Validates that a build artifact is a genuine Linux
 * executable by parsing the ELF identification bytes and header
 * fields the Linux loader itself checks. It never "approves" a
 * file that does not parse.
 */
const MACHINE_TYPES: Record<number, string> = {
  0x00: 'No specific instruction set',
  0x03: 'x86 (Intel 80386)',
  0x28: 'ARM',
  0x3e: 'x86-64',
  0xb7: 'AArch64',
  0xf3: 'RISC-V'
};

const OBJECT_TYPES: Record<number, string> = {
  1: 'REL (relocatable file)',
  2: 'EXEC (executable file)',
  3: 'DYN (shared object / PIE executable)',
  4: 'CORE (core file)'
};

export class ElfInspector {
  public static inspect(buffer: Buffer): ElfInspectionReport {
    if (!buffer || buffer.length < 20) {
      return { isElfFile: false, errors: ['file too small to contain an ELF header'] };
    }
    // e_ident magic: 0x7F 'E' 'L' 'F'
    if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
      return { isElfFile: false, errors: ['missing ELF magic (0x7F E L F)'] };
    }
    const errors: string[] = [];
    const elfClassByte = buffer[4];
    if (elfClassByte !== 1 && elfClassByte !== 2) {
      errors.push(`invalid EI_CLASS ${elfClassByte} (expected 1=32-bit or 2=64-bit)`);
      return { isElfFile: false, errors };
    }
    const elfClass = elfClassByte === 2 ? '64-bit' : '32-bit';
    const dataByte = buffer[5];
    if (dataByte !== 1 && dataByte !== 2) {
      errors.push(`invalid EI_DATA ${dataByte} (expected 1=little-endian or 2=big-endian)`);
      return { isElfFile: false, errors };
    }
    const littleEndian = dataByte === 1;
    const endianness = littleEndian ? 'little-endian' : 'big-endian';
    // The version byte must be the current ELF version.
    if (buffer[6] !== 1) errors.push(`unsupported EI_VERSION ${buffer[6]} (expected 1)`);

    // e_type (offset 16) and e_machine (offset 18) use the declared endianness.
    const readU16 = (offset: number) =>
      littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const objectTypeCode = readU16(16);
    const machineCode = readU16(18);
    const objectType = OBJECT_TYPES[objectTypeCode] || `unknown (0x${objectTypeCode.toString(16)})`;
    const machine = MACHINE_TYPES[machineCode] || `unknown (0x${machineCode.toString(16)})`;
    if (objectTypeCode !== 2 && objectTypeCode !== 3) {
      errors.push(`e_type ${objectType} is not an executable (expected EXEC or DYN)`);
    }
    // A 64-bit header is 64 bytes; a 32-bit header is 52 bytes.
    const headerSize = elfClassByte === 2 ? 64 : 52;
    if (buffer.length < headerSize) {
      errors.push(`file truncated: ${buffer.length} bytes, smaller than the ${headerSize}-byte ELF header`);
    }
    return {
      isElfFile: errors.length === 0,
      elfClass,
      endianness,
      machine,
      objectType,
      errors
    };
  }
}
